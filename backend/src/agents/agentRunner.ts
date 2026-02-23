/**
 * Agent Runner
 *
 * Orchestrates fulfillment agents for the x402c hub.
 * - PRIMARY: watches RequestCreated events via viem getLogs (~2s latency)
 * - FALLBACK: polls hub every 30s for any missed events (5000 block lookback)
 * - SWEEPER: scans for stale PENDING requests every 5 min and cancels them
 * - Routes each request to the correct agent (Alchemy, OpenSea)
 * - Tracks in-progress requests to avoid double-fulfillment
 * - Cancels timed-out requests (> 5 minutes old), including unknown endpoints
 * - BUYBACK: checks fee accumulation every 60 min, triggers USDC→wASS conversion
 * - LOCKER: checks pending rewards every 5 min, triggers distributePending() (50/50 staking+hook)
 * - KEEPALIVE: polls subscriptions every 10s, fulfills ready ones with profitability check
 */

import {
  initHubClient,
  pollPendingRequests,
  cancelRequestOnChain,
  getRequest,
  watchRequestCreated,
  watchConfigEvents,
  RequestStatus,
  type HubRequest,
  type RequestCreatedCallback,
} from '../services/hubService.js';
import { ALCHEMY_ENDPOINT_IDS, fulfillAlchemyRequest } from './alchemyAgent.js';
import { OPENSEA_ENDPOINT_IDS, fulfillOpenSeaRequest } from './openseaAgent.js';
import { checkAndExecuteBuyback } from '../services/buybackService.js';
import { checkAndDistributeLocker } from '../services/lockerService.js';
import { checkAndManageHooks } from '../services/hookManagerService.js';
import { createKeepAliveClient } from 'x402c';
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { forceRefresh, broadcastPricingOnly } from '../services/cacheService.js';
import { broadcast } from '../services/wsBroadcast.js';

const FALLBACK_POLL_INTERVAL_MS = 30_000; // 30 seconds fallback
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUYBACK_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const LOCKER_DISTRIBUTE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HOOK_MANAGER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// In-memory set of request IDs currently being processed (avoids double-fulfillment)
const inProgress = new Set<string>();

/**
 * Route a hub request to the appropriate agent.
 */
async function routeRequest(req: HubRequest): Promise<void> {
  const { requestId, endpointId } = req;

  if (inProgress.has(requestId)) {
    return; // Already being handled
  }

  // Check for timeout — if request is stale, cancel regardless of endpoint
  const ageMs = Date.now() - Number(req.createdAt) * 1000;
  if (ageMs > TIMEOUT_MS) {
    console.log(`[AgentRunner] Request ${requestId.slice(0, 10)}... timed out (${Math.floor(ageMs / 1000)}s old) — cancelling`);
    broadcast({ type: 'request_timeout', requestId, endpointId, timestamp: Date.now(), data: {} });
    inProgress.add(requestId);
    try {
      await cancelRequestOnChain(requestId);
    } catch (err) {
      console.error(`[AgentRunner] Failed to cancel ${requestId.slice(0, 10)}...:`, err);
    } finally {
      inProgress.delete(requestId);
    }
    return;
  }

  // Route to correct agent
  inProgress.add(requestId);
  try {
    let agentType = 'unknown';
    if (ALCHEMY_ENDPOINT_IDS.has(endpointId)) {
      agentType = 'alchemy';
      console.log(`[AgentRunner] → Alchemy agent for ${requestId.slice(0, 10)}...`);
      broadcast({ type: 'request_routing', requestId, endpointId, timestamp: Date.now(), data: { agentType } });
      await fulfillAlchemyRequest(req);
    } else if (OPENSEA_ENDPOINT_IDS.has(endpointId as `0x${string}`)) {
      agentType = 'opensea';
      console.log(`[AgentRunner] → OpenSea agent for ${requestId.slice(0, 10)}...`);
      broadcast({ type: 'request_routing', requestId, endpointId, timestamp: Date.now(), data: { agentType } });
      await fulfillOpenSeaRequest(req);
    } else {
      console.warn(`[AgentRunner] No agent for endpoint ${endpointId.slice(0, 10)}... — cancelling immediately`);
      broadcast({ type: 'request_timeout', requestId, endpointId, timestamp: Date.now(), data: { reason: 'unknown_endpoint' } });
      try {
        await cancelRequestOnChain(requestId);
      } catch (cancelErr) {
        console.error(`[AgentRunner] Failed to cancel unknown endpoint request ${requestId.slice(0, 10)}...:`, cancelErr);
      }
    }
  } catch (error) {
    console.error(`[AgentRunner] Error fulfilling ${requestId.slice(0, 10)}...:`, error);
  } finally {
    inProgress.delete(requestId);
  }
}

/**
 * Handle a RequestCreated event in real-time.
 */
const onRequestCreated: RequestCreatedCallback = (log) => {
  const { requestId, endpointId } = log;
  const latency = Date.now();

  console.log(`[AgentRunner] EVENT RequestCreated: ${requestId.slice(0, 10)}... (endpoint: ${endpointId.slice(0, 10)}...)`);

  broadcast({
    type: 'request_created',
    requestId,
    endpointId,
    timestamp: Date.now(),
    data: { requester: log.endpointOwner },
  });

  getRequest(requestId).then((req) => {
    if (!req) {
      console.warn(`[AgentRunner] Could not fetch request ${requestId.slice(0, 10)}...`);
      return;
    }

    if (req.status !== RequestStatus.PENDING) {
      return;
    }

    const eventLatency = Date.now() - latency;
    console.log(`[AgentRunner] Routing request (event latency: ${eventLatency}ms)`);
    routeRequest(req);
  }).catch((err) => {
    console.error(`[AgentRunner] Error handling event for ${requestId.slice(0, 10)}...:`, err);
  });
};

/**
 * Fallback poll — catches any events missed by the watcher.
 * Uses persistent block cursor — resumes from last scanned block.
 * First run falls back to 1000 blocks if no cursor exists.
 */
async function fallbackPoll(): Promise<void> {
  try {
    const pending = await pollPendingRequests('hub-fallback', 1000n);
    if (pending.length > 0) {
      console.log(`[AgentRunner] Fallback poll found ${pending.length} pending request(s)`);
      await Promise.allSettled(pending.map(routeRequest));
    }
  } catch (error) {
    console.error('[AgentRunner] Fallback poll error:', error);
  }
}

/**
 * Stale request sweeper — scans for old PENDING requests and cancels them.
 * Uses persistent block cursor — resumes from last scanned block.
 * First run falls back to 1000 blocks if no cursor exists.
 */
async function sweepStaleRequests(): Promise<void> {
  try {
    const pending = await pollPendingRequests('hub-sweeper', 1000n);
    if (pending.length === 0) return;

    // Filter to only stale requests (> 5 min old)
    const stale = pending.filter(req => {
      const ageMs = Date.now() - Number(req.createdAt) * 1000;
      return ageMs > TIMEOUT_MS;
    });

    if (stale.length === 0) return;

    console.log(`[AgentRunner] Sweeper found ${stale.length} stale PENDING request(s) — cancelling`);

    for (const req of stale) {
      if (inProgress.has(req.requestId)) continue;

      const ageMin = Math.floor((Date.now() - Number(req.createdAt) * 1000) / 60000);
      console.log(`[AgentRunner] Sweeping ${req.requestId.slice(0, 10)}... (${ageMin}m old, endpoint: ${req.endpointId.slice(0, 10)}...)`);

      broadcast({ type: 'request_timeout', requestId: req.requestId, endpointId: req.endpointId, timestamp: Date.now(), data: {} });

      inProgress.add(req.requestId);
      try {
        await cancelRequestOnChain(req.requestId);
      } catch (err) {
        console.error(`[AgentRunner] Sweeper cancel failed for ${req.requestId.slice(0, 10)}...:`, err);
      } finally {
        inProgress.delete(req.requestId);
      }
    }
  } catch (error) {
    console.error('[AgentRunner] Sweeper error:', error);
  }
}

/**
 * Start the agent runner.
 */
export function startAgentRunner(): void {
  const hubAddress = process.env.X402C_HUB_CONTRACT;
  if (!hubAddress) {
    console.warn('[AgentRunner] X402C_HUB_CONTRACT not set — agent runner disabled');
    return;
  }

  initHubClient();

  console.log('[AgentRunner] Starting x402c agent runner');
  console.log(`[AgentRunner] Hub: ${hubAddress}`);
  console.log('[AgentRunner] Registered agents: Alchemy (token-price), OpenSea (lookup)');

  // PRIMARY: Event-based watching (~2s latency per Base block)
  const unwatch = watchRequestCreated(onRequestCreated);
  if (unwatch) {
    console.log('[AgentRunner] Event watcher started (pollingInterval: 2s)');
  } else {
    console.warn('[AgentRunner] Event watcher failed to start — using polling only');
  }

  // CONFIG: Watch for pricing/endpoint config changes → refresh cache + push pricing update
  const unwatchConfig = watchConfigEvents((eventName) => {
    console.log(`[AgentRunner] Config event: ${eventName} — refreshing cache + broadcasting pricing`);
    forceRefresh().catch(err => console.error('[AgentRunner] Config refresh error:', err));
  });
  if (unwatchConfig) {
    console.log('[AgentRunner] Config event watcher started');
  }

  // FALLBACK: Poll every 30s for missed events (cursor-based, chunked at 1000 blocks)
  console.log(`[AgentRunner] Fallback poll: every ${FALLBACK_POLL_INTERVAL_MS / 1000}s (cursor-based)`);
  fallbackPoll();
  setInterval(fallbackPoll, FALLBACK_POLL_INTERVAL_MS);

  // SWEEPER: Cancel stale PENDING requests every 5 min (cursor-based, chunked at 1000 blocks)
  console.log(`[AgentRunner] Stale sweeper: every ${SWEEPER_INTERVAL_MS / 1000}s (cursor-based)`);
  // Run immediately on startup to clean up any accumulated stale requests
  sweepStaleRequests().catch(err => {
    console.error('[AgentRunner] Sweeper initial run error:', err);
  });
  setInterval(() => {
    sweepStaleRequests().catch(err => {
      console.error('[AgentRunner] Sweeper error:', err);
    });
  }, SWEEPER_INTERVAL_MS);

  // BUYBACK: Check fee accumulation and trigger buyback every 60 min
  const buybackModule = process.env.X402C_BUYBACK_MODULE;
  if (buybackModule) {
    console.log(`[AgentRunner] Buyback scheduler: every 60m (module: ${buybackModule})`);
    setInterval(() => {
      checkAndExecuteBuyback().catch(err => {
        console.error('[AgentRunner] Buyback check error:', err);
      });
    }, BUYBACK_CHECK_INTERVAL_MS);
  } else {
    console.log('[AgentRunner] Buyback scheduler: disabled (X402C_BUYBACK_MODULE not set)');
  }

  // LOCKER DISTRIBUTE: Check for pending rewards every 5 min
  console.log(`[AgentRunner] Locker distribute scheduler: every ${LOCKER_DISTRIBUTE_INTERVAL_MS / 1000}s`);
  setInterval(() => {
    checkAndDistributeLocker().catch(err => {
      console.error('[AgentRunner] Locker distribute error:', err);
    });
  }, LOCKER_DISTRIBUTE_INTERVAL_MS);

  // HOOK MANAGER: Manage V4 hook pools every 60 min (claim fees, add liquidity, buyback)
  console.log(`[AgentRunner] Hook manager scheduler: every ${HOOK_MANAGER_INTERVAL_MS / 1000}s`);
  // Run once immediately on startup to catch up
  checkAndManageHooks().catch(err => {
    console.error('[AgentRunner] Hook manager initial run error:', err);
  });
  setInterval(() => {
    checkAndManageHooks().catch(err => {
      console.error('[AgentRunner] Hook manager error:', err);
    });
  }, HOOK_MANAGER_INTERVAL_MS);

  // KEEPALIVE: Use x402c SDK — polls subscriptions every 10s with profitability check
  const keepAliveContract = process.env.X402C_KEEPALIVE_CONTRACT;
  const adminKey = process.env.ADMIN_WALLET;
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (keepAliveContract && adminKey) {
    const formattedKey = (adminKey.startsWith('0x') ? adminKey : `0x${adminKey}`) as `0x${string}`;
    const agentAccount = privateKeyToAccount(formattedKey);

    const kaPublicClient = createPublicClient({ chain: base, transport: http(rpcUrl) }) as PublicClient;
    const kaWalletClient = createWalletClient({ account: agentAccount, chain: base, transport: http(rpcUrl) }) as unknown as WalletClient;

    const keepAlive = createKeepAliveClient({ publicClient: kaPublicClient, walletClient: kaWalletClient });

    console.log(`[AgentRunner] KeepAlive agent: ${agentAccount.address}`);
    console.log(`[AgentRunner] KeepAlive contract: ${keepAliveContract}`);

    // Auto-polling loop — finds and fulfills ready subscriptions every 10s
    const stopPolling = keepAlive.pollAndFulfill({
      intervalMs: 10_000,
      onFulfilled: (subId, txHash) => {
        console.log(`[KeepAlive] Fulfilled ${subId.slice(0, 10)}... TX: ${txHash}`);
        broadcast({
          type: 'keepalive_fulfilled',
          requestId: subId,
          timestamp: Date.now(),
          data: { txHash },
        });
      },
      onSkipped: (subId, reason) => {
        console.log(`[KeepAlive] Skipped ${subId.slice(0, 10)}...: ${reason}`);
      },
      onError: (err) => {
        console.error(`[KeepAlive] Poll error:`, (err as Error).message || err);
      },
    });

    // Event watcher — detects new/cancelled subscriptions in real-time
    const stopWatching = keepAlive.watchSubscriptions({
      onCreated: (event) => {
        console.log(`[KeepAlive] EVENT SubscriptionCreated: ${event.subscriptionId.slice(0, 10)}...`);
        broadcast({
          type: 'keepalive_subscription_created',
          requestId: event.subscriptionId,
          timestamp: Date.now(),
          data: {},
        });
      },
      onFulfilled: (event) => {
        console.log(`[KeepAlive] EVENT SubscriptionFulfilled: ${event.subscriptionId.slice(0, 10)}... cycle=${event.cycleNumber}`);
      },
      onCancelled: (event) => {
        console.log(`[KeepAlive] EVENT SubscriptionCancelled: ${event.subscriptionId.slice(0, 10)}...`);
        broadcast({
          type: 'keepalive_subscription_cancelled',
          requestId: event.subscriptionId,
          timestamp: Date.now(),
          data: {},
        });
      },
    });

    console.log('[AgentRunner] KeepAlive scheduler: started via x402c SDK (10s polling + event watcher)');
  } else {
    console.log('[AgentRunner] KeepAlive scheduler: disabled (X402C_KEEPALIVE_CONTRACT or ADMIN_WALLET not set)');
  }
}
