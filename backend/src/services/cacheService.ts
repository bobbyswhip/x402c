/**
 * App State Cache Service
 *
 * Maintains a hot in-memory cache of all on-chain read data.
 * - Polls hub protocol fees every 5s (single cheap RPC call)
 * - Full refresh only when fees change or every 30s max
 * - All routes serve from cache — zero RPC latency for reads
 */

import { formatUnits, parseAbi, createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

import { getHubStats, getEndpoints, getAgentStats, getEthPrice, getPricingSnapshot, scanRecentRequests, RequestStatus } from './hubService.js';
import { getStakingGlobalStats, getStakingAccountInfo } from './stakingService.js';
import { getNames } from '@coinbase/onchainkit/identity';
import { getLockerStats, getLockerPositions } from './lockerService.js';
import { privateKeyToAccount } from 'viem/accounts';
import { getGovernorInfo, getTimelockInfo, getLeaderboard, scanProposals } from './governanceService.js';
import { getDisputeGlobalStats, getRecentDisputes } from './disputeService.js';
import { getBazaarResources } from './bazaarService.js';
import { isZKReady } from './zkProver.js';
import { broadcastAppState, broadcastPricingUpdate, seedRingBuffer, reconcileRingBuffer } from './wsBroadcast.js';

// ── KeepAlive stats ─────────────────────────────────────────────

const KEEPALIVE_DETAIL_ABI = [
  {
    type: 'function' as const, name: 'getStats' as const, stateMutability: 'view' as const,
    inputs: [], outputs: [
      { name: 'volume', type: 'uint256' as const },
      { name: 'protocolFees', type: 'uint256' as const },
      { name: 'pendingFees', type: 'uint256' as const },
      { name: 'subCount', type: 'uint256' as const },
      { name: 'fulfillments', type: 'uint256' as const },
    ],
  },
  {
    type: 'function' as const, name: 'getSubscriptionCount' as const, stateMutability: 'view' as const,
    inputs: [], outputs: [{ name: '', type: 'uint256' as const }],
  },
  {
    type: 'function' as const, name: 'subscriptionIds' as const, stateMutability: 'view' as const,
    inputs: [{ name: 'index', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'bytes32' as const }],
  },
  {
    type: 'function' as const, name: 'getSubscription' as const, stateMutability: 'view' as const,
    inputs: [{ name: 'id', type: 'bytes32' as const }],
    outputs: [{
      name: '', type: 'tuple' as const, components: [
        { name: 'consumer', type: 'address' as const },
        { name: 'callbackTarget', type: 'address' as const },
        { name: 'callbackGasLimit', type: 'uint256' as const },
        { name: 'intervalSeconds', type: 'uint256' as const },
        { name: 'feePerCycle', type: 'uint256' as const },
        { name: 'estimatedGasCostWei', type: 'uint256' as const },
        { name: 'maxFulfillments', type: 'uint256' as const },
        { name: 'fulfillmentCount', type: 'uint256' as const },
        { name: 'lastFulfilled', type: 'uint256' as const },
        { name: 'active', type: 'bool' as const },
      ],
    }],
  },
  {
    type: 'function' as const, name: 'getSubscriptionCost' as const, stateMutability: 'view' as const,
    inputs: [{ name: 'id', type: 'bytes32' as const }],
    outputs: [
      { name: 'fee', type: 'uint256' as const },
      { name: 'markup', type: 'uint256' as const },
      { name: 'gasReimbursement', type: 'uint256' as const },
      { name: 'total', type: 'uint256' as const },
    ],
  },
] as const;

async function fetchKeepAliveStats() {
  const keepAliveAddr = process.env.X402C_KEEPALIVE_CONTRACT as `0x${string}` | undefined;
  if (!keepAliveAddr) return null;

  const client = getClient();
  const abi = KEEPALIVE_DETAIL_ABI;

  const [statsResult, countResult] = await Promise.allSettled([
    client.readContract({ address: keepAliveAddr, abi, functionName: 'getStats' }),
    client.readContract({ address: keepAliveAddr, abi, functionName: 'getSubscriptionCount' }),
  ]);

  const stats = statsResult.status === 'fulfilled'
    ? statsResult.value as readonly [bigint, bigint, bigint, bigint, bigint]
    : null;
  const totalSubs = countResult.status === 'fulfilled' ? Number(countResult.value as bigint) : 0;

  if (!stats) return null;

  const [volume, protocolFees, pendingFees, , fulfillments] = stats;

  // Fetch individual subscription details (cap at 50 to limit RPC calls)
  const subCount = Math.min(totalSubs, 50);
  const subscriptions: any[] = [];

  if (subCount > 0) {
    try {
      // Batch fetch subscription IDs
      const idPromises = Array.from({ length: subCount }, (_, i) =>
        client.readContract({ address: keepAliveAddr, abi, functionName: 'subscriptionIds', args: [BigInt(i)] })
      );
      const idResults = await Promise.allSettled(idPromises);
      const subIds: `0x${string}`[] = [];
      for (const r of idResults) {
        if (r.status === 'fulfilled') subIds.push(r.value as `0x${string}`);
      }

      // Batch fetch subscription details + costs (5 at a time)
      const BATCH = 5;
      for (let i = 0; i < subIds.length; i += BATCH) {
        const batch = subIds.slice(i, i + BATCH);
        const detailResults = await Promise.allSettled(
          batch.map(async (id) => {
            const [sub, cost] = await Promise.all([
              client.readContract({ address: keepAliveAddr, abi, functionName: 'getSubscription', args: [id] }),
              client.readContract({ address: keepAliveAddr, abi, functionName: 'getSubscriptionCost', args: [id] }),
            ]);
            return { id, sub, cost };
          })
        );

        for (const r of detailResults) {
          if (r.status !== 'fulfilled') continue;
          const { id, sub, cost } = r.value;
          const s = sub as any;
          if (!s.active) continue; // Only aggregate active subscriptions
          const c = cost as readonly [bigint, bigint, bigint, bigint];
          const lastFulfilled = Number(s.lastFulfilled);
          const intervalSec = Number(s.intervalSeconds);
          const nextDue = lastFulfilled > 0 ? lastFulfilled + intervalSec : 0;

          subscriptions.push({
            id,
            consumer: s.consumer,
            callbackTarget: s.callbackTarget,
            callbackGasLimit: s.callbackGasLimit.toString(),
            intervalSeconds: intervalSec,
            intervalFormatted: intervalSec >= 86400 ? `${(intervalSec / 86400).toFixed(1)}d`
              : intervalSec >= 3600 ? `${(intervalSec / 3600).toFixed(1)}h`
              : `${(intervalSec / 60).toFixed(0)}m`,
            feePerCycle: s.feePerCycle.toString(),
            feePerCycleUsd: (Number(s.feePerCycle) / 1_000_000).toFixed(4),
            estimatedGasCostWei: s.estimatedGasCostWei.toString(),
            maxFulfillments: Number(s.maxFulfillments),
            fulfillmentCount: Number(s.fulfillmentCount),
            lastFulfilled,
            lastFulfilledDate: lastFulfilled > 0 ? new Date(lastFulfilled * 1000).toISOString() : null,
            nextDue,
            nextDueDate: nextDue > 0 ? new Date(nextDue * 1000).toISOString() : null,
            active: s.active,
            costPerCycleUsd: (Number(c[3]) / 1_000_000).toFixed(4),
            costBreakdown: {
              fee: (Number(c[0]) / 1_000_000).toFixed(4),
              markup: (Number(c[1]) / 1_000_000).toFixed(4),
              gasReimbursement: (Number(c[2]) / 1_000_000).toFixed(4),
              total: (Number(c[3]) / 1_000_000).toFixed(4),
            },
          });
        }
      }
    } catch (err) {
      console.warn('[Cache] KeepAlive subscription detail fetch failed:', (err as Error).message);
    }
  }

  return {
    keepAliveContract: keepAliveAddr,
    volumeUsdc: volume.toString(),
    volumeUsd: (Number(volume) / 1_000_000).toFixed(4),
    protocolFeesUsdc: protocolFees.toString(),
    protocolFeesUsd: (Number(protocolFees) / 1_000_000).toFixed(4),
    pendingFeesUsdc: pendingFees.toString(),
    pendingFeesUsd: (Number(pendingFees) / 1_000_000).toFixed(4),
    totalSubscriptions: subscriptions.length,
    totalFulfillments: Number(fulfillments),
    subscriptions,
  };
}

const POLL_INTERVAL = 5_000;       // check for changes every 5s
const MAX_STALE_MS = 30_000;       // force full refresh every 30s regardless
const HUB_CONTRACT = () => (process.env.X402C_HUB_CONTRACT || '0x09C0c3A8d60BEB10c117C3C2cf21Ba254f957A52') as `0x${string}`;

function getDeployerAddress(): string {
  const pk = process.env.ADMIN_WALLET;
  if (!pk) return '0x0000000000000000000000000000000000000000';
  const formatted = pk.startsWith('0x') ? pk : `0x${pk}`;
  return privateKeyToAccount(formatted as `0x${string}`).address;
}

let cachedState: Record<string, unknown> | null = null;
let lastRefreshMs = 0;
let lastProtocolFees = '0';
let lastRequestsServed = '0';
let refreshing = false;

function getClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
  });
}

// ── Quick delta check — single RPC call ──────────────────────────

async function checkDelta(): Promise<boolean> {
  try {
    const client = getClient();
    const abi = parseAbi([
      'function protocolFeesAccumulated() view returns (uint256)',
      'function requestCounter() view returns (uint256)',
    ]);
    const hub = HUB_CONTRACT();
    const [fees, requests] = await Promise.all([
      client.readContract({ address: hub, abi, functionName: 'protocolFeesAccumulated' }),
      client.readContract({ address: hub, abi, functionName: 'requestCounter' }),
    ]);
    const feesStr = fees.toString();
    const reqStr = requests.toString();
    const changed = feesStr !== lastProtocolFees || reqStr !== lastRequestsServed;
    lastProtocolFees = feesStr;
    lastRequestsServed = reqStr;
    return changed;
  } catch {
    return false;
  }
}

// ── Buyback stats (split mode: 50/50 staking + hook) ─────────────

async function fetchBuybackV2Stats() {
  const buybackV2 = (process.env.X402C_BUYBACK_V2 || '0xa5Fcf30dcf47B684ecaCBB521316bFD2C50A6A26') as `0x${string}`;
  const client = getClient();
  const abi = parseAbi([
    'function getStats() view returns (uint256 usdcConverted, uint256 ethConverted, uint256 tokensDistributed, uint256 pendingUSDC, uint256 pendingETH)',
  ]);
  const result = await client.readContract({ address: buybackV2, abi, functionName: 'getStats' }) as readonly [bigint, bigint, bigint, bigint, bigint];
  const [usdcConverted, ethConverted, tokensDistributed, pendingUSDC, pendingETH] = result;
  return {
    buybackV2Contract: buybackV2,
    usdcConvertedFormatted: `$${parseFloat(formatUnits(usdcConverted, 6)).toFixed(2)}`,
    ethConvertedFormatted: `${parseFloat(formatUnits(ethConverted, 18)).toFixed(4)} ETH`,
    tokensDistributedFormatted: `${parseFloat(formatUnits(tokensDistributed, 18)).toFixed(2)} X402C`,
    pendingUSDCFormatted: `$${parseFloat(formatUnits(pendingUSDC, 6)).toFixed(2)}`,
    pendingETHFormatted: `${parseFloat(formatUnits(pendingETH, 18)).toFixed(4)} ETH`,
    splitDescription: '50% staking + 50% hook donate',
  };
}

// ── Per-Endpoint Fulfilled Counts (event log cross-reference) ────

async function countEndpointFulfillments(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const hub = HUB_CONTRACT();
  const client = getClient();
  const CHUNK = 1000n; // RPC providers limit getLogs to 1000 blocks per call
  const LOOKBACK = 100_000n; // ~55 hours on Base at 2s/block

  const createdEvent = {
    type: 'event' as const, name: 'RequestCreated' as const,
    inputs: [
      { name: 'requestId', type: 'bytes32' as const, indexed: true },
      { name: 'endpointId', type: 'bytes32' as const, indexed: true },
      { name: 'requester', type: 'address' as const, indexed: true },
      { name: 'endpointOwner', type: 'address' as const, indexed: false },
      { name: 'costUnits', type: 'uint256' as const, indexed: false },
      { name: 'gasReimbursement', type: 'uint256' as const, indexed: false },
      { name: 'createdAt', type: 'uint256' as const, indexed: false },
    ],
  };
  const fulfilledEvent = {
    type: 'event' as const, name: 'RequestFulfilled' as const,
    inputs: [
      { name: 'requestId', type: 'bytes32' as const, indexed: true },
      { name: 'agent', type: 'address' as const, indexed: true },
      { name: 'sessionId', type: 'bytes32' as const, indexed: false },
    ],
  };

  try {
    const currentBlock = await client.getBlockNumber();
    const startBlock = currentBlock > LOOKBACK ? currentBlock - LOOKBACK : 0n;

    // Build block ranges
    const ranges: { from: bigint; to: bigint }[] = [];
    for (let from = startBlock; from <= currentBlock; from += CHUNK) {
      const to = from + CHUNK - 1n > currentBlock ? currentBlock : from + CHUNK - 1n;
      ranges.push({ from, to });
    }

    // Collect all logs — run 5 chunks at a time (10 RPC calls) to avoid rate limits
    const allCreated: any[] = [];
    const allFulfilled: any[] = [];
    const BATCH = 5;

    for (let i = 0; i < ranges.length; i += BATCH) {
      const batch = ranges.slice(i, i + BATCH).map(({ from, to }) =>
        Promise.all([
          client.getLogs({ address: hub, event: createdEvent, fromBlock: from, toBlock: to }),
          client.getLogs({ address: hub, event: fulfilledEvent, fromBlock: from, toBlock: to }),
        ]).then(([created, fulfilled]) => ({ created, fulfilled }))
      );
      const results = await Promise.all(batch);
      for (const { created, fulfilled } of results) {
        allCreated.push(...created);
        allFulfilled.push(...fulfilled);
      }
    }

    // Cross-reference: requestId → endpointId from created events
    const requestToEndpoint: Record<string, string> = {};
    for (const log of allCreated) {
      const args = log.args as any;
      requestToEndpoint[args.requestId] = args.endpointId;
    }

    // Count fulfilled per endpoint
    for (const log of allFulfilled) {
      const args = log.args as any;
      const endpointId = requestToEndpoint[args.requestId];
      if (endpointId) {
        counts[endpointId] = (counts[endpointId] || 0) + 1;
      }
    }

    console.log(`[Cache] Endpoint fulfillments: scanned ${ranges.length} chunks, found ${allFulfilled.length} fulfilled events`);
  } catch (err) {
    console.warn('[Cache] countEndpointFulfillments failed:', (err as Error).message);
  }

  return counts;
}

// ── Owner Profile Resolution ────────────────────────────────────

interface OwnerProfile {
  name: string | null;
  reputation: string;
  fulfillCount: number;
  stakedFormatted: string;
}

async function resolveOwnerProfiles(endpoints: any[]): Promise<Record<string, OwnerProfile>> {
  const profiles: Record<string, OwnerProfile> = {};
  const uniqueOwners = [...new Set(endpoints.map((ep: any) => ep.owner as string))];
  if (uniqueOwners.length === 0) return profiles;

  // Batch resolve basenames
  let nameMap: Record<string, string | null> = {};
  try {
    const addresses = uniqueOwners.map(a => a as `0x${string}`);
    const names = await getNames({ addresses, chain: base });
    for (let i = 0; i < uniqueOwners.length; i++) {
      nameMap[uniqueOwners[i]] = names[i] ?? null;
    }
  } catch (err) {
    console.warn('[Cache] getNames failed, continuing without basenames:', (err as Error).message);
    for (const addr of uniqueOwners) nameMap[addr] = null;
  }

  // Batch fetch agent + staking stats
  const results = await Promise.allSettled(
    uniqueOwners.map(async (addr) => {
      const [agent, staking] = await Promise.allSettled([
        getAgentStats(addr),
        getStakingAccountInfo(addr),
      ]);
      const agentData = agent.status === 'fulfilled' ? agent.value : null;
      const stakingData = staking.status === 'fulfilled' ? staking.value : null;
      return {
        addr,
        fulfillCount: agentData ? Number(agentData.fulfillCount) : 0,
        reputation: stakingData?.reputation ?? '0',
        stakedFormatted: stakingData?.stakedFormatted ?? '0 X402C',
      };
    })
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { addr, fulfillCount, reputation, stakedFormatted } = r.value;
    profiles[addr] = {
      name: nameMap[addr] ?? null,
      reputation,
      fulfillCount,
      stakedFormatted,
    };
  }

  return profiles;
}

// ── Formatters ───────────────────────────────────────────────────

function formatHubV2Stats(stats: any) {
  return {
    hubContract: process.env.X402C_HUB_CONTRACT || 'not configured',
    buybackModule: process.env.X402C_BUYBACK_MODULE || 'not configured',
    totalVolumeUSDC: stats.volume.toString(),
    totalVolumeUsd: (Number(stats.volume) / 1_000_000).toFixed(2),
    totalProtocolFeesUSDC: stats.protocolFees.toString(),
    totalProtocolFeesUsd: (Number(stats.protocolFees) / 1_000_000).toFixed(2),
    pendingFeesUSDC: stats.pendingFees.toString(),
    pendingFeesUsd: (Number(stats.pendingFees) / 1_000_000).toFixed(2),
    endpointCount: Number(stats.endpointCount),
    totalRequestsServed: Number(stats.requestsServed),
  };
}

function formatEndpoints(
  endpoints: any[],
  ownerProfiles: Record<string, OwnerProfile> = {},
  epFulfillCounts: Record<string, number> = {},
  ethPriceUsdc: bigint | null = null,
) {
  const active = endpoints.filter((ep: any) => ep.active !== false);
  return {
    count: active.length,
    endpoints: active.map((ep: any) => {
      const baseCost = Number(ep.baseCostUnits);
      const markup = Math.min(baseCost * 0.1, 1_000_000);
      const maxBytes = Number(ep.maxResponseBytes ?? 0);
      const estimatedGasCostWei = BigInt(ep.estimatedGasCostWei ?? 0n);
      // Compute gas reimbursement via oracle: (gasCostWei * ethPrice) / 1e18
      const gasReimb = ethPriceUsdc
        ? Number((estimatedGasCostWei * ethPriceUsdc) / BigInt(1e18))
        : 0;
      const profile = ownerProfiles[ep.owner];
      return {
        id: ep.id,
        url: ep.url,
        inputFormat: ep.inputFormat,
        outputFormat: ep.outputFormat,
        baseCostUnits: ep.baseCostUnits.toString(),
        baseCostUsd: (baseCost / 1_000_000).toFixed(4),
        maxResponseBytes: maxBytes,
        estimatedGasCostWei: estimatedGasCostWei.toString(),
        gasReimbursementComputed: gasReimb,
        gasReimbursementUsd: (gasReimb / 1_000_000).toFixed(4),
        callbackGasLimit: (ep.callbackGasLimit ?? 0n).toString(),
        totalCost: (baseCost + markup).toFixed(0) + ' units',
        totalCostWithCallback: (baseCost + markup + gasReimb).toFixed(0) + ' units',
        owner: ep.owner,
        ownerName: profile?.name ?? null,
        ownerReputation: profile?.reputation ?? '0',
        ownerFulfillCount: profile?.fulfillCount ?? 0,
        ownerStaked: profile?.stakedFormatted ?? '0 X402C',
        endpointFulfilledCount: epFulfillCounts[ep.id] ?? 0,
        active: ep.active,
      };
    }),
  };
}

// ── Full refresh ─────────────────────────────────────────────────

async function refreshCache() {
  if (refreshing) return;
  refreshing = true;
  const start = Date.now();

  try {
    const [
      hubStats, endpoints, staking, locker, lockerPositions,
      governor, timelock, leaderboard, proposals,
      disputes, recentDisputes, bazaar, buybackV2, ethPrice,
      keepAliveStats,
    ] = await Promise.allSettled([
      getHubStats(),
      getEndpoints(),
      getStakingGlobalStats(),
      getLockerStats(),
      getLockerPositions(getDeployerAddress()),
      getGovernorInfo(),
      getTimelockInfo(),
      getLeaderboard(100),
      scanProposals(),
      getDisputeGlobalStats(),
      getRecentDisputes(20),
      getBazaarResources(),
      fetchBuybackV2Stats(),
      getEthPrice(),
      fetchKeepAliveStats(),
    ]);

    const val = <T,>(r: PromiseSettledResult<T>): T | null =>
      r.status === 'fulfilled' ? r.value : null;

    // Resolve owner basenames + agent stats + per-endpoint fulfilled counts + recent requests
    const rawEndpoints = val(endpoints) as any[] | null;
    const rawEthPrice = val(ethPrice) as bigint | null;
    let ownerProfiles: Record<string, OwnerProfile> = {};
    let epFulfillCounts: Record<string, number> = {};
    let recentRequestsList: any[] = [];
    if (rawEndpoints) {
      // scanRecentRequests replaces countEndpointFulfillments — single event scan for both
      const [profiles, reqScan] = await Promise.allSettled([
        resolveOwnerProfiles(rawEndpoints),
        scanRecentRequests(50_000n),
      ]);
      if (profiles.status === 'fulfilled') ownerProfiles = profiles.value;
      else console.warn('[Cache] Owner profile resolution failed:', (profiles.reason as Error).message);
      if (reqScan.status === 'fulfilled') {
        // Derive per-endpoint fulfilled counts from scanned requests
        for (const r of reqScan.value) {
          if (r.status === RequestStatus.FULFILLED) {
            epFulfillCounts[r.endpointId] = (epFulfillCounts[r.endpointId] || 0) + 1;
          }
        }
        recentRequestsList = reqScan.value.map(r => ({
          requestId: r.requestId,
          endpointId: r.endpointId,
          requester: r.requester,
          status: RequestStatus[r.status],
          totalCostUnits: r.totalCostUnits.toString(),
          createdAt: new Date(Number(r.createdAt) * 1000).toISOString(),
          fulfilledBy: r.fulfilledBy,
          sessionId: r.sessionId !== '0x' + '0'.repeat(64) ? r.sessionId : null,
        }));
        // Seed the SSE ring buffer with historical events (only if empty)
        seedRingBuffer(recentRequestsList);
        // Reconcile stale routing/pending events with on-chain status
        reconcileRingBuffer(recentRequestsList);
      } else console.warn('[Cache] Request scan failed:', (reqScan.reason as Error).message);
    }

    cachedState = {
      health: {
        status: 'ok',
        zkReady: isZKReady(),
        contractConfigured: !!process.env.ZK_VERIFIER_CONTRACT,
        hubConfigured: !!process.env.X402C_HUB_CONTRACT,
        paymentEnabled: process.env.X402_ENABLED !== 'false',
        network: process.env.X402_NETWORK || 'base',
      },
      hubV2Stats: val(hubStats) ? formatHubV2Stats(val(hubStats)) : null,
      hubGasPricing: rawEthPrice ? {
        ethPriceUsdc: rawEthPrice.toString(),
        ethPriceUsd: (Number(rawEthPrice) / 1_000_000).toFixed(2),
        formula: 'gasReimbursement = oracle.estimateGasCostUsdc(endpoint.estimatedGasCostWei)',
        source: 'Uniswap V2 (WETH/USDC on Base)',
      } : null,
      hubEndpoints: rawEndpoints ? formatEndpoints(rawEndpoints, ownerProfiles, epFulfillCounts, rawEthPrice) : null,
      hubRequests: { count: recentRequestsList.length, requests: recentRequestsList },
      staking: val(staking),
      locker: val(locker),
      lockerPositions: val(lockerPositions) ?? [],
      governor: val(governor),
      timelock: val(timelock),
      leaderboard: val(leaderboard),
      proposals: val(proposals) ?? [],
      disputes: val(disputes),
      recentDisputes: val(recentDisputes),
      bazaar: val(bazaar),
      buybackV2: val(buybackV2),
      keepAlive: val(keepAliveStats),
      timestamp: new Date().toISOString(),
      cacheAgeMs: 0,
    };

    lastRefreshMs = Date.now();
    console.log(`[Cache] Full refresh in ${Date.now() - start}ms`);

    // Push full state to all connected SSE/WS clients
    broadcastAppState({ ...cachedState, cacheAgeMs: 0 } as Record<string, unknown>);
  } finally {
    refreshing = false;
  }
}

// ── Poll loop — check delta, refresh if changed ─────────────────

async function pollAndRefresh() {
  const stale = Date.now() - lastRefreshMs > MAX_STALE_MS;
  if (stale) {
    await refreshCache();
    return;
  }
  const changed = await checkDelta();
  if (changed) {
    console.log('[Cache] Delta detected — refreshing');
    await refreshCache();
  }
}

// ── Lightweight Pricing Broadcast ─────────────────────────────────
// Sends just ethPriceUsdc + per-endpoint gas params (~300 bytes).
// Clients recalculate costs locally. Used on config events instead of full refresh.

export async function broadcastPricingOnly(): Promise<void> {
  try {
    const snapshot = await getPricingSnapshot();
    if (!snapshot) return;
    broadcastPricingUpdate(snapshot as unknown as Record<string, unknown>);
    console.log(`[Cache] Pricing broadcast: ETH=$${(Number(snapshot.ethPriceUsdc) / 1_000_000).toFixed(2)}, ${Object.keys(snapshot.endpoints).length} endpoints`);
  } catch (err) {
    console.error('[Cache] broadcastPricingOnly failed:', err);
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Full bundled state — used by GET /app/state */
export function getCachedState(): Record<string, unknown> | null {
  if (!cachedState) return null;
  return { ...cachedState, cacheAgeMs: Date.now() - lastRefreshMs };
}

/** Get a single cached key — used by individual routes */
export function getCached<T = any>(key: string): T | null {
  if (!cachedState) return null;
  return (cachedState[key] as T) ?? null;
}

/** Force immediate refresh (after write operations like buyback flush) */
export async function forceRefresh() {
  await refreshCache();
}

export function startCacheRefresh() {
  // Initial full fetch
  refreshCache().catch((err) => console.error('[Cache] Initial refresh failed:', err));
  // Poll every 5s — cheap delta check, full refresh only when needed
  setInterval(() => {
    pollAndRefresh().catch((err) => console.error('[Cache] Poll failed:', err));
  }, POLL_INTERVAL);
  console.log(`[Cache] Started — polling every ${POLL_INTERVAL / 1000}s, full refresh on change or every ${MAX_STALE_MS / 1000}s`);
}
