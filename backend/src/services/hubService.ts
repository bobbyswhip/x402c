/**
 * Hub Service
 *
 * Handles interaction with the X402CHubContract on Base Mainnet.
 * Agents use this to poll for pending requests and submit fulfillments.
 *
 * Oracle-based gas pricing — uses X402CPriceOracle (Uniswap V2) to convert
 * ETH gas costs to USDC at current market rate. Admin sets estimatedGasCostWei
 * per endpoint based on observed fulfill TX costs.
 *
 * NOTE: Pure JSON ABI throughout — parseAbi cannot handle named tuple returns.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { withTxMutex } from './txQueue.js';
import { broadcast } from './wsBroadcast.js';
import { loadCursor, saveCursor } from './blockCursor.js';

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Read dynamically — same lesson as blockchain.ts (avoid module-level const)
function getHubAddress(): Address | undefined {
  return process.env.X402C_HUB_CONTRACT as Address | undefined;
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

// Pure JSON ABI for X402CHubContract
const HUB_ABI = [
  // ── Events ──────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'RequestCreated',
    inputs: [
      { name: 'requestId',    type: 'bytes32', indexed: true  },
      { name: 'endpointId',   type: 'bytes32', indexed: true  },
      { name: 'requester',    type: 'address', indexed: true  },
      { name: 'endpointOwner',type: 'address', indexed: false },
      { name: 'costUnits',    type: 'uint256', indexed: false },
      { name: 'gasReimbursement', type: 'uint256', indexed: false },
      { name: 'createdAt',    type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RequestFulfilled',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'agent',     type: 'address', indexed: true },
      { name: 'sessionId', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CallbackExecuted',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true  },
      { name: 'success',   type: 'bool',    indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RequestCancelled',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'agent',     type: 'address', indexed: true },
    ],
  },

  // ── Read functions ───────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'getEndpointCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'endpointIds',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getEndpoint',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'url',                   type: 'string'  },
      { name: 'inputFormat',           type: 'string'  },
      { name: 'outputFormat',          type: 'string'  },
      { name: 'baseCostUnits',         type: 'uint256' },
      { name: 'maxResponseBytes_',     type: 'uint256' },
      { name: 'callbackGasLimit',      type: 'uint256' },
      { name: 'estimatedGasCostWei_',  type: 'uint256' },
      { name: 'endpointOwner',         type: 'address' },
      { name: 'active',                type: 'bool'    },
      { name: 'registeredAt',          type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getEthPrice',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'estimateGasReimbursement',
    stateMutability: 'view',
    inputs: [{ name: 'gasCostWei', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getEndpointPrice',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'total',             type: 'uint256' },
      { name: 'totalWithCallback', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'protocolFeesAccumulator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRequest',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'endpointId',            type: 'bytes32' },
        { name: 'requester',             type: 'address' },
        { name: 'totalCostUnits',        type: 'uint256' },
        { name: 'baseCostUnits',         type: 'uint256' },
        { name: 'markupUnits',           type: 'uint256' },
        { name: 'gasReimbursementUnits', type: 'uint256' },
        { name: 'createdAt',             type: 'uint256' },
        { name: 'status',                type: 'uint8'   },
        { name: 'responseData',          type: 'bytes'   },
        { name: 'sessionId',             type: 'bytes32' },
        { name: 'fulfilledBy',           type: 'address' },
        { name: 'params',                type: 'bytes'   },
        { name: 'hasCallback',           type: 'bool'    },
      ],
    }],
  },
  {
    type: 'function',
    name: 'getCallback',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'gasLimit', type: 'uint256' },
        { name: 'executed', type: 'bool'    },
        { name: 'success',  type: 'bool'    },
      ],
    }],
  },
  {
    type: 'function',
    name: 'getAgentStats',
    stateMutability: 'view',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [
      { name: 'earnings',     type: 'uint256' },
      { name: 'fulfillCount', type: 'uint256' },
      { name: 'isRegistered', type: 'bool'    },
    ],
  },
  {
    type: 'function',
    name: 'getHubStats',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'volume',         type: 'uint256' },
      { name: 'protocolFees',   type: 'uint256' },
      { name: 'pendingFees',    type: 'uint256' },
      { name: 'endpointCount',  type: 'uint256' },
      { name: 'requestsServed', type: 'uint256' },
    ],
  },

  // ── Write functions ──────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'depositUSDC',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'endpointId', type: 'bytes32' },
      { name: 'params',     type: 'bytes'   },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'createRequestWithCallback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'endpointId', type: 'bytes32' },
      { name: 'params',     type: 'bytes'   },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'fulfillRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId',   type: 'bytes32' },
      { name: 'responseData',type: 'bytes'   },
      { name: 'sessionId',   type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelRequest',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'flushProtocolFeesToBuyback',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const;

// RequestCreated event ABI fragment for getLogs
const REQUEST_CREATED_EVENT = {
  type: 'event',
  name: 'RequestCreated',
  inputs: [
    { name: 'requestId',    type: 'bytes32', indexed: true  },
    { name: 'endpointId',   type: 'bytes32', indexed: true  },
    { name: 'requester',    type: 'address', indexed: true  },
    { name: 'endpointOwner',type: 'address', indexed: false },
    { name: 'costUnits',    type: 'uint256', indexed: false },
    { name: 'gasReimbursement', type: 'uint256', indexed: false },
    { name: 'createdAt',    type: 'uint256', indexed: false },
  ],
} as const;

// RequestStatus enum matching Solidity
export enum RequestStatus {
  PENDING   = 0,
  FULFILLED = 1,
  CANCELLED = 2,
}

export interface HubRequest {
  requestId: string;
  endpointId: string;
  requester: string;
  totalCostUnits: bigint;
  baseCostUnits: bigint;
  markupUnits: bigint;
  gasReimbursementUnits: bigint;
  createdAt: bigint;
  status: RequestStatus;
  responseData: string;
  sessionId: string;
  fulfilledBy: string;
  params: string;
  hasCallback: boolean;
}

export interface EndpointSpec {
  id: string;
  url: string;
  inputFormat: string;
  outputFormat: string;
  baseCostUnits: bigint;
  maxResponseBytes: bigint;
  callbackGasLimit: bigint;
  estimatedGasCostWei: bigint;
  owner: string;
  active: boolean;
  registeredAt: bigint;
}

export interface AgentStats {
  earnings: bigint;
  fulfillCount: bigint;
  isRegistered: boolean;
}

export interface HubStats {
  volume: bigint;
  protocolFees: bigint;
  pendingFees: bigint;
  endpointCount: bigint;
  requestsServed: bigint;
}

export interface CallbackInfo {
  gasLimit: bigint;
  executed: boolean;
  success: boolean;
}

// Callback type for event-based request watching
export type RequestCreatedCallback = (log: {
  requestId: string;
  endpointId: string;
  requester: string;
  endpointOwner: string;
  costUnits: bigint;
  gasReimbursement: bigint;
  createdAt: bigint;
}) => void;

let walletClient: ReturnType<typeof createWalletClient> | null = null;

/**
 * Initialize the hub wallet client.
 * Called from agentRunner after backend starts.
 */
export function initHubClient(): void {
  const privateKey = process.env.ADMIN_WALLET;
  const hubAddress = getHubAddress();

  if (!privateKey) {
    console.warn('[Hub] ADMIN_WALLET not set — hub writes disabled');
    return;
  }
  if (!hubAddress) {
    console.warn('[Hub] X402C_HUB_CONTRACT not set — hub writes disabled');
    return;
  }

  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(formattedKey as `0x${string}`);

  walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(BASE_RPC_URL),
  });

  console.log(`[Hub] Client initialized for ${account.address}`);
  console.log(`[Hub] X402CHubContract at ${hubAddress}`);
}

/**
 * Poll for RequestCreated events, chunked at 1000 blocks to stay within RPC limits.
 * Uses a persistent block cursor so we resume from where we left off across restarts.
 * Returns requests that are still PENDING status.
 *
 * @param cursorLabel — cursor name to load/save (e.g. 'hub-fallback', 'hub-sweeper')
 * @param maxLookbackBlocks — fallback lookback if no cursor exists (default 1000)
 */
export async function pollPendingRequests(cursorLabel: string, maxLookbackBlocks = 1000n): Promise<HubRequest[]> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return [];

  const CHUNK = 1000n;

  try {
    const latestBlock = await publicClient.getBlockNumber();

    // Resume from cursor, or fall back to maxLookbackBlocks from current
    let savedBlock = loadCursor(cursorLabel);
    const fromBlock = savedBlock > 0n
      ? savedBlock + 1n
      : (latestBlock > maxLookbackBlocks ? latestBlock - maxLookbackBlocks : 0n);

    if (fromBlock > latestBlock) {
      return [];
    }

    // Chunk the range to stay within RPC provider limits
    const allLogs: any[] = [];
    for (let start = fromBlock; start <= latestBlock; start += CHUNK) {
      const end = start + CHUNK - 1n > latestBlock ? latestBlock : start + CHUNK - 1n;
      const logs = await publicClient.getLogs({
        address: hubAddress,
        event: REQUEST_CREATED_EVENT,
        fromBlock: start,
        toBlock: end,
      });
      allLogs.push(...logs);
    }

    // Save cursor after successful scan
    saveCursor(cursorLabel, latestBlock);

    // Look up current status — only return PENDING
    const requests: HubRequest[] = [];
    for (const log of allLogs) {
      const requestId = (log.args as any).requestId as string;
      const req = await getRequest(requestId);
      if (req && req.status === RequestStatus.PENDING) {
        requests.push(req);
      }
    }

    return requests;
  } catch (error) {
    console.error('[Hub] Failed to poll requests:', error);
    return [];
  }
}

/**
 * Get full request details by ID.
 */
export async function getRequest(requestId: string): Promise<HubRequest | null> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return null;

  try {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getRequest',
      args: [requestId as `0x${string}`],
    }) as any;

    return {
      requestId,
      endpointId:            result.endpointId,
      requester:             result.requester,
      totalCostUnits:        result.totalCostUnits,
      baseCostUnits:         result.baseCostUnits,
      markupUnits:           result.markupUnits,
      gasReimbursementUnits: result.gasReimbursementUnits,
      createdAt:             result.createdAt,
      status:                Number(result.status) as RequestStatus,
      responseData:          result.responseData,
      sessionId:             result.sessionId,
      fulfilledBy:           result.fulfilledBy,
      params:                result.params,
      hasCallback:           result.hasCallback,
    };
  } catch {
    return null;
  }
}

/**
 * Get all registered endpoints from the hub.
 */
export async function getEndpoints(): Promise<EndpointSpec[]> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return [];

  try {
    const count = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getEndpointCount',
    }) as bigint;

    const endpoints: EndpointSpec[] = [];

    for (let i = 0n; i < count; i++) {
      const id = await publicClient.readContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'endpointIds',
        args: [i],
      }) as string;

      const spec = await publicClient.readContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'getEndpoint',
        args: [id as `0x${string}`],
      }) as any;

      endpoints.push({
        id,
        url:                 spec[0] ?? spec.url,
        inputFormat:         spec[1] ?? spec.inputFormat,
        outputFormat:        spec[2] ?? spec.outputFormat,
        baseCostUnits:       spec[3] ?? spec.baseCostUnits,
        maxResponseBytes:    spec[4] ?? spec.maxResponseBytes_ ?? 0n,
        callbackGasLimit:    spec[5] ?? spec.callbackGasLimit ?? 0n,
        estimatedGasCostWei: spec[6] ?? spec.estimatedGasCostWei_ ?? 0n,
        owner:               spec[7] ?? spec.endpointOwner,
        active:              spec[8] ?? spec.active,
        registeredAt:        spec[9] ?? spec.registeredAt ?? 0n,
      });
    }

    return endpoints;
  } catch (error) {
    console.error('[Hub] Failed to get endpoints:', error);
    throw error;
  }
}

/**
 * Get USDC balance for a consumer contract address.
 */
export async function getContractBalance(address: string): Promise<bigint> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return 0n;

  try {
    return await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getBalance',
      args: [address as `0x${string}`],
    }) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * Get accumulated protocol fees (pending in accumulator).
 */
export async function getProtocolFees(): Promise<bigint> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return 0n;

  try {
    return await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'protocolFeesAccumulator',
    }) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * Get per-agent earnings and fulfillment count.
 */
export async function getAgentStats(agent: string): Promise<AgentStats | null> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return null;

  try {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getAgentStats',
      args: [agent as `0x${string}`],
    }) as any;

    return {
      earnings:     result[0] ?? result.earnings,
      fulfillCount: result[1] ?? result.fulfillCount,
      isRegistered: result[2] ?? result.isRegistered,
    };
  } catch {
    return null;
  }
}

/**
 * Get global hub stats (volume, fees, endpoint count, requests served).
 * Everything is USDC — no ETH in the hub.
 */
export async function getHubStats(): Promise<HubStats | null> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return null;

  try {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getHubStats',
    }) as any;

    return {
      volume:         result[0] ?? result.volume,
      protocolFees:   result[1] ?? result.protocolFees,
      pendingFees:    result[2] ?? result.pendingFees,
      endpointCount:  result[3] ?? result.endpointCount,
      requestsServed: result[4] ?? result.requestsServed,
    };
  } catch {
    return null;
  }
}

/**
 * Get callback info for a request.
 * No ethDeposit — callbacks are USDC-reimbursed.
 */
export async function getCallbackInfo(requestId: string): Promise<CallbackInfo | null> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return null;

  try {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getCallback',
      args: [requestId as `0x${string}`],
    }) as any;

    return {
      gasLimit: result[0] ?? result.gasLimit,
      executed: result[1] ?? result.executed,
      success:  result[2] ?? result.success,
    };
  } catch {
    return null;
  }
}

/**
 * Get current ETH price from the oracle (USDC per 1 ETH, 6 decimals).
 */
export async function getEthPrice(): Promise<bigint | null> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return null;

  try {
    return await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getEthPrice',
    }) as bigint;
  } catch {
    return null;
  }
}

/**
 * Lightweight pricing snapshot — just ETH price + per-endpoint gas config.
 * ~300 bytes vs ~20KB for full app_state. Clients recalculate costs locally.
 */
export interface PricingSnapshot {
  ethPriceUsdc: string;
  endpoints: Record<string, { estimatedGasCostWei: string; baseCostUnits: string }>;
  timestamp: string;
}

export async function getPricingSnapshot(): Promise<PricingSnapshot | null> {
  try {
    const [ethPrice, endpoints] = await Promise.all([
      getEthPrice(),
      getEndpoints(),
    ]);
    if (!ethPrice) return null;

    const epMap: Record<string, { estimatedGasCostWei: string; baseCostUnits: string }> = {};
    for (const ep of endpoints) {
      if (ep.active !== false) {
        epMap[ep.id] = {
          estimatedGasCostWei: ep.estimatedGasCostWei.toString(),
          baseCostUnits: ep.baseCostUnits.toString(),
        };
      }
    }

    return {
      ethPriceUsdc: ethPrice.toString(),
      endpoints: epMap,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Hub] getPricingSnapshot failed:', err);
    return null;
  }
}

/**
 * Flush accumulated protocol USDC fees to the buyback module.
 */
export async function flushProtocolFeesToBuyback(): Promise<string | null> {
  const hubAddress = getHubAddress();
  if (!walletClient || !hubAddress) return null;

  return withTxMutex(async () => {
    try {
      const account = walletClient!.account;
      if (!account) throw new Error('No wallet account');

      const txHash = await walletClient!.writeContract({
        address: hubAddress!,
        abi: HUB_ABI,
        functionName: 'flushProtocolFeesToBuyback',
        account,
        chain: base,
      });

      console.log(`[Hub] flushProtocolFeesToBuyback TX: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === 'reverted') {
        console.error(`[Hub] flushProtocolFeesToBuyback TX reverted`);
        return null;
      }
      return txHash;
    } catch (error) {
      console.error('[Hub] Failed to flush fees to buyback:', error);
      return null;
    }
  });
}

/**
 * Submit a fulfillment for a pending request.
 * Agent must have called the x402 relay and obtained a valid sessionId.
 */
export async function fulfillRequestOnChain(
  requestId: string,
  responseData: string,
  sessionId: string
): Promise<string | null> {
  const hubAddress = getHubAddress();
  if (!walletClient || !hubAddress) {
    console.warn('[Hub] Cannot fulfill — wallet/hub not configured');
    return null;
  }

  return withTxMutex(async () => {
    try {
      const account = walletClient!.account;
      if (!account) throw new Error('No wallet account');

      // Pre-flight: verify request is still PENDING before submitting TX
      const req = await getRequest(requestId);
      if (!req || req.status !== RequestStatus.PENDING) {
        console.log(`[Hub] Skipping fulfillRequest — request ${requestId.slice(0, 10)}... is no longer PENDING`);
        return null;
      }

      // Encode responseData as hex bytes for the contract's `bytes` parameter
      const responseHex = ('0x' + Buffer.from(responseData, 'utf8').toString('hex')) as `0x${string}`;

      const callArgs = [
        requestId as `0x${string}`,
        responseHex,
        sessionId as `0x${string}`,
      ] as const;

      // Pre-flight gas estimate — simulate the TX to get accurate gas usage.
      // This accounts for actual responseData size (SSTORE costs scale with bytes),
      // callback execution, USDC transfer, and all state changes.
      let estimatedGas: bigint;
      try {
        estimatedGas = await publicClient.estimateGas({
          account: account.address,
          to: hubAddress!,
          data: (await import('viem')).encodeFunctionData({
            abi: HUB_ABI,
            functionName: 'fulfillRequest',
            args: callArgs,
          }),
        });
        // 20% buffer over estimate for safety (L1 data costs can vary)
        estimatedGas = estimatedGas * 120n / 100n;
        console.log(`[Hub] Gas estimate: ${estimatedGas} (with 20% buffer)`);
      } catch (simErr: any) {
        // Simulation failed — the TX would revert on-chain. Skip it.
        const reason = simErr?.message?.slice(0, 150) || 'unknown';
        console.error(`[Hub] Gas simulation failed (TX would revert): ${reason}`);
        return null;
      }

      // Profitability check: compare gas reimbursement to estimated TX cost.
      // On Base L2, total TX cost = L2 gas + L1 data posting.
      // We use gasPrice * estimatedGas as rough cost, then compare to reimbursement.
      try {
        const gasPrice = await publicClient.getGasPrice();
        const estimatedCostWei = estimatedGas * gasPrice;
        const reimbursementUnits = req.gasReimbursementUnits; // USDC units (6 decimals)
        const ethPrice = await getEthPrice(); // USDC per 1 ETH (6 decimals)
        if (ethPrice && ethPrice > 0n) {
          const estimatedCostUsdc = (estimatedCostWei * ethPrice) / BigInt(1e18);
          const profitUsdc = Number(reimbursementUnits) - Number(estimatedCostUsdc);
          console.log(`[Hub] Cost check: est=$${(Number(estimatedCostUsdc) / 1e6).toFixed(6)} reimb=$${(Number(reimbursementUnits) / 1e6).toFixed(6)} profit=$${(profitUsdc / 1e6).toFixed(6)}`);
          if (profitUsdc < -5000) { // allow $0.005 loss tolerance (L1 data costs are approximate)
            console.warn(`[Hub] Skipping unprofitable fulfill — would lose $${(Math.abs(profitUsdc) / 1e6).toFixed(4)}`);
            return null;
          }
        }
      } catch {
        // Gas price or eth price lookup failed — proceed anyway
      }

      const txHash = await walletClient!.writeContract({
        address: hubAddress!,
        abi: HUB_ABI,
        functionName: 'fulfillRequest',
        args: callArgs,
        account,
        chain: base,
        gas: estimatedGas,
      });

      console.log(`[Hub] fulfillRequest TX: ${txHash}`);

      // Wait for receipt — FULFILLED is terminal success
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === 'reverted') {
        console.error(`[Hub] fulfillRequest TX reverted`);
        return null;
      }

      const actualGasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.effectiveGasPrice;
      const actualCostWei = actualGasUsed * effectiveGasPrice;
      console.log(`[Hub] fulfillRequest confirmed (block ${receipt.blockNumber}, gas=${actualGasUsed}, cost=${actualCostWei} wei)`);

      broadcast({
        type: 'request_fulfilled',
        requestId,
        timestamp: Date.now(),
        data: {
          txHash,
          sessionId,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: actualGasUsed.toString(),
          txCostWei: actualCostWei.toString(),
        },
      });
      return txHash;
    } catch (error) {
      console.error('[Hub] Failed to fulfill request:', error);
      return null;
    }
  });
}

/**
 * Cancel a timed-out request. Any authorized agent earns 50% of markup.
 */
export async function cancelRequestOnChain(requestId: string): Promise<string | null> {
  const hubAddress = getHubAddress();
  if (!walletClient || !hubAddress) return null;

  return withTxMutex(async () => {
    try {
      const account = walletClient!.account;
      if (!account) throw new Error('No wallet account');

      const txHash = await walletClient!.writeContract({
        address: hubAddress!,
        abi: HUB_ABI,
        functionName: 'cancelRequest',
        args: [requestId as `0x${string}`],
        account,
        chain: base,
      });

      console.log(`[Hub] cancelRequest TX: ${txHash}`);
      broadcast({
        type: 'request_cancelled',
        requestId,
        timestamp: Date.now(),
        data: { txHash },
      });
      return txHash;
    } catch (error) {
      console.error('[Hub] Failed to cancel request:', error);
      return null;
    }
  });
}

/**
 * Watch for RequestCreated events using getLogs-based polling.
 * CDP RPC doesn't support eth_newFilter, so we poll getLogs directly.
 * Polls every 2s (Base block time), only checks new blocks since last poll.
 * Auto-reconnects on persistent failures with exponential backoff.
 * Returns an unwatch function to stop listening.
 */
export function watchRequestCreated(callback: RequestCreatedCallback): (() => void) | null {
  const hubAddress = getHubAddress();
  if (!hubAddress) {
    console.warn('[Hub] Cannot watch events — hub address not configured');
    return null;
  }

  // Resume from cursor so we don't miss events during downtime
  let lastBlock = loadCursor('hub-watcher');
  let stopped = false;
  let consecutiveErrors = 0;
  let intervalId: ReturnType<typeof setInterval>;
  let currentPollMs = 2_000;
  const MAX_BACKOFF_MS = 30_000;
  const HEARTBEAT_INTERVAL = 100; // Log heartbeat every 100 successful polls (~200s)
  let pollCount = 0;
  const CHUNK = 1000n;

  const poll = async () => {
    if (stopped) return;
    try {
      const currentBlock = await publicClient.getBlockNumber();

      // First run with no cursor: start from current block
      if (lastBlock === 0n) {
        lastBlock = currentBlock;
        saveCursor('hub-watcher', currentBlock);
        consecutiveErrors = 0;
        return;
      }

      // No new blocks since last poll
      if (currentBlock <= lastBlock) {
        consecutiveErrors = 0;
        return;
      }

      const fromBlock = lastBlock + 1n;

      // Chunk to stay within RPC 1000-block limit (gap can be large after restart)
      for (let start = fromBlock; start <= currentBlock; start += CHUNK) {
        const end = start + CHUNK - 1n > currentBlock ? currentBlock : start + CHUNK - 1n;
        const logs = await publicClient.getLogs({
          address: hubAddress,
          event: REQUEST_CREATED_EVENT,
          fromBlock: start,
          toBlock: end,
        });

        for (const log of logs) {
          const args = log.args as any;
          callback({
            requestId: args.requestId,
            endpointId: args.endpointId,
            requester: args.requester,
            endpointOwner: args.endpointOwner,
            costUnits: args.costUnits,
            gasReimbursement: args.gasReimbursement,
            createdAt: args.createdAt,
          });
        }
      }

      lastBlock = currentBlock;
      saveCursor('hub-watcher', currentBlock);

      // Reset error counter on success
      if (consecutiveErrors > 0) {
        console.log(`[Hub] Event watcher recovered after ${consecutiveErrors} errors`);
        consecutiveErrors = 0;
        // Restore normal polling interval if it was backed off
        if (currentPollMs > 2_000) {
          clearInterval(intervalId);
          currentPollMs = 2_000;
          intervalId = setInterval(poll, currentPollMs);
          console.log('[Hub] Event watcher restored to 2s polling');
        }
      }

      // Periodic heartbeat
      pollCount++;
      if (pollCount % HEARTBEAT_INTERVAL === 0) {
        console.log(`[Hub] Event watcher alive — block ${currentBlock}, ${pollCount} polls`);
      }
    } catch (error: any) {
      consecutiveErrors++;
      const msg = error?.message?.slice(0, 100) || 'Unknown error';
      console.error(`[Hub] Event poll error (${consecutiveErrors}x): ${msg}`);

      // Exponential backoff on persistent failures
      if (consecutiveErrors >= 3 && !stopped) {
        const newInterval = Math.min(currentPollMs * 2, MAX_BACKOFF_MS);
        if (newInterval !== currentPollMs) {
          clearInterval(intervalId);
          currentPollMs = newInterval;
          intervalId = setInterval(poll, currentPollMs);
          console.warn(`[Hub] Event watcher backing off to ${currentPollMs / 1000}s interval`);
        }
      }

      // Reset lastBlock on extended failures so we don't skip a huge range
      if (consecutiveErrors >= 10) {
        console.warn('[Hub] Event watcher resetting lastBlock after 10 consecutive errors');
        lastBlock = 0n;
      }
    }
  };

  intervalId = setInterval(poll, currentPollMs);
  poll(); // Initial poll to set lastBlock

  return () => {
    stopped = true;
    clearInterval(intervalId);
  };
}

// ── Config Event Definitions ──────────────────────────────────────

const PRICE_ORACLE_UPDATED_EVENT = {
  type: 'event' as const, name: 'PriceOracleUpdated' as const,
  inputs: [
    { name: 'oracle', type: 'address' as const, indexed: true },
  ],
} as const;

const ENDPOINT_UPDATED_EVENT = {
  type: 'event' as const, name: 'EndpointUpdated' as const,
  inputs: [
    { name: 'endpointId', type: 'bytes32' as const, indexed: true },
    { name: 'owner',      type: 'address' as const, indexed: true },
  ],
} as const;

const ENDPOINT_GAS_CONFIG_UPDATED_EVENT = {
  type: 'event' as const, name: 'EndpointGasConfigUpdated' as const,
  inputs: [
    { name: 'endpointId',         type: 'bytes32' as const, indexed: true },
    { name: 'estimatedGasCostWei', type: 'uint256' as const, indexed: false },
    { name: 'callbackGasLimit',    type: 'uint256' as const, indexed: false },
  ],
} as const;

export type ConfigEventCallback = (eventName: string) => void;

/**
 * Watch for hub config change events (gas pricing, endpoint updates).
 * Same polling pattern as watchRequestCreated — 2s interval with backoff.
 */
export function watchConfigEvents(callback: ConfigEventCallback): (() => void) | null {
  const hubAddress = getHubAddress();
  if (!hubAddress) return null;

  let lastBlock = 0n;
  let stopped = false;
  let consecutiveErrors = 0;
  let intervalId: ReturnType<typeof setInterval>;
  let currentPollMs = 2_000;
  const MAX_BACKOFF_MS = 30_000;

  const poll = async () => {
    if (stopped) return;
    try {
      const currentBlock = await publicClient.getBlockNumber();
      if (lastBlock === 0n) { lastBlock = currentBlock; return; }
      if (currentBlock <= lastBlock) return;

      const fromBlock = lastBlock + 1n;
      lastBlock = currentBlock;

      // Fetch all three event types in parallel
      const [oracleLogs, endpointLogs, gasConfigLogs] = await Promise.all([
        publicClient.getLogs({ address: hubAddress, event: PRICE_ORACLE_UPDATED_EVENT, fromBlock, toBlock: currentBlock }),
        publicClient.getLogs({ address: hubAddress, event: ENDPOINT_UPDATED_EVENT, fromBlock, toBlock: currentBlock }),
        publicClient.getLogs({ address: hubAddress, event: ENDPOINT_GAS_CONFIG_UPDATED_EVENT, fromBlock, toBlock: currentBlock }),
      ]);

      for (const _log of oracleLogs) callback('PriceOracleUpdated');
      for (const _log of endpointLogs) callback('EndpointUpdated');
      for (const _log of gasConfigLogs) callback('EndpointGasConfigUpdated');

      if (consecutiveErrors > 0) {
        consecutiveErrors = 0;
        if (currentPollMs > 2_000) {
          clearInterval(intervalId);
          currentPollMs = 2_000;
          intervalId = setInterval(poll, currentPollMs);
        }
      }
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= 3 && !stopped) {
        const newInterval = Math.min(currentPollMs * 2, MAX_BACKOFF_MS);
        if (newInterval !== currentPollMs) {
          clearInterval(intervalId);
          currentPollMs = newInterval;
          intervalId = setInterval(poll, currentPollMs);
        }
      }
      if (consecutiveErrors >= 10) lastBlock = 0n;
    }
  };

  intervalId = setInterval(poll, currentPollMs);
  poll();

  return () => { stopped = true; clearInterval(intervalId); };
}

/**
 * Get the publicClient for external use (e.g. watching events from routes).
 */
export function getPublicClient() {
  return publicClient;
}

/**
 * Get the HUB_ABI for external use.
 */
export function getHubAbi() {
  return HUB_ABI;
}

/**
 * Scan recent RequestCreated events and look up current status for each.
 * Returns ALL requests (pending, fulfilled, cancelled) — not just pending.
 * Used by the cache to populate the request feed.
 */
export async function scanRecentRequests(lookbackBlocks = 100_000n): Promise<HubRequest[]> {
  const hubAddress = getHubAddress();
  if (!hubAddress) return [];

  const CHUNK = 1000n;
  const requests: HubRequest[] = [];

  try {
    const currentBlock = await publicClient.getBlockNumber();
    const startBlock = currentBlock > lookbackBlocks ? currentBlock - lookbackBlocks : 0n;

    // Build block ranges
    const ranges: { from: bigint; to: bigint }[] = [];
    for (let from = startBlock; from <= currentBlock; from += CHUNK) {
      const to = from + CHUNK - 1n > currentBlock ? currentBlock : from + CHUNK - 1n;
      ranges.push({ from, to });
    }

    // Collect RequestCreated logs in batches of 5
    const allLogs: any[] = [];
    const BATCH = 5;
    for (let i = 0; i < ranges.length; i += BATCH) {
      const batch = ranges.slice(i, i + BATCH).map(({ from, to }) =>
        publicClient.getLogs({
          address: hubAddress,
          event: REQUEST_CREATED_EVENT,
          fromBlock: from,
          toBlock: to,
        })
      );
      const results = await Promise.all(batch);
      for (const logs of results) allLogs.push(...logs);
    }

    // Look up current status for each request (parallel, max 10 at a time)
    const REQUEST_BATCH = 10;
    for (let i = 0; i < allLogs.length; i += REQUEST_BATCH) {
      const slice = allLogs.slice(i, i + REQUEST_BATCH);
      const details = await Promise.all(
        slice.map(log => getRequest((log.args as any).requestId as string))
      );
      for (const req of details) {
        if (req) requests.push(req);
      }
    }

    console.log(`[Hub] scanRecentRequests: found ${requests.length} requests in ${ranges.length} chunks`);
  } catch (error) {
    console.error('[Hub] scanRecentRequests failed:', error);
  }

  return requests;
}
