/**
 * KeepAlive Client
 *
 * Create and manage recurring on-chain subscriptions.
 * Agents use pollAndFulfill() to automatically fulfill ready subscriptions.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import { KEEPALIVE_ABI } from '../abis/keepAlive.js';
import { ERC20_ABI } from '../abis/erc20.js';
import { ADDRESSES } from '../constants.js';
import type {
  ClientConfig,
  Subscription,
  SubscriptionCost,
  SubscriptionCreatedEvent,
  SubscriptionFulfilledEvent,
  ProfitabilityResult,
  UnwatchFn,
} from '../types.js';
import { withTxMutex } from '../utils/txQueue.js';
import { checkTxProfitability } from '../utils/profitability.js';
import { createEventPoller } from '../utils/polling.js';

export function createKeepAliveClient(config: ClientConfig) {
  const { publicClient, walletClient } = config;
  const keepAliveAddress = ADDRESSES.KEEPALIVE as Address;
  const usdcAddress = ADDRESSES.USDC as Address;

  // In-flight tracking to prevent double-submission
  const inFlight = new Set<string>();

  // Cached subscription IDs — refresh every 60s or when explicitly invalidated
  let cachedSubIds: Hex[] = [];
  let subIdsCacheTime = 0;
  const SUB_IDS_CACHE_TTL_MS = 60_000;

  function requireWallet() {
    if (!walletClient) throw new Error('walletClient required for write operations');
    return walletClient;
  }

  function invalidateSubIdCache() {
    subIdsCacheTime = 0;
  }

  // ── Read Functions ──────────────────────────────────────────────────────

  async function getSubscriptionCount(): Promise<bigint> {
    return publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'getSubscriptionCount',
    }) as Promise<bigint>;
  }

  async function getSubscriptionIds(): Promise<Hex[]> {
    // Return cached IDs if still fresh
    if (cachedSubIds.length > 0 && Date.now() - subIdsCacheTime < SUB_IDS_CACHE_TTL_MS) {
      return cachedSubIds;
    }

    const count = await getSubscriptionCount();
    const ids: Hex[] = [];
    // Batch fetch in groups of 5 to reduce RPC pressure
    const BATCH = 5;
    for (let i = 0n; i < count; i += BigInt(BATCH)) {
      const batchPromises: Promise<Hex>[] = [];
      for (let j = i; j < count && j < i + BigInt(BATCH); j++) {
        batchPromises.push(
          publicClient.readContract({
            address: keepAliveAddress,
            abi: KEEPALIVE_ABI,
            functionName: 'subscriptionIds',
            args: [j],
          }) as Promise<Hex>,
        );
      }
      const batchResults = await Promise.allSettled(batchPromises);
      for (const r of batchResults) {
        if (r.status === 'fulfilled') ids.push(r.value);
      }
    }

    cachedSubIds = ids;
    subIdsCacheTime = Date.now();
    return ids;
  }

  async function getSubscription(id: Hex): Promise<Subscription> {
    const result = await publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'getSubscription',
      args: [id],
    }) as any;
    return {
      consumer: result.consumer,
      callbackTarget: result.callbackTarget,
      callbackGasLimit: result.callbackGasLimit,
      intervalSeconds: result.intervalSeconds,
      feePerCycle: result.feePerCycle,
      estimatedGasCostWei: result.estimatedGasCostWei,
      maxFulfillments: result.maxFulfillments,
      fulfillmentCount: result.fulfillmentCount,
      lastFulfilled: result.lastFulfilled,
      active: result.active,
    };
  }

  async function getSubscriptionCost(id: Hex): Promise<SubscriptionCost> {
    const result = await publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'getSubscriptionCost',
      args: [id],
    }) as any;
    return {
      fee: result[0] as bigint,
      markup: result[1] as bigint,
      gasReimbursement: result[2] as bigint,
      total: result[3] as bigint,
    };
  }

  async function isReady(id: Hex): Promise<boolean> {
    return publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'isReady',
      args: [id],
    }) as Promise<boolean>;
  }

  async function getBalance(account: Address): Promise<bigint> {
    return publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'getBalance',
      args: [account],
    }) as Promise<bigint>;
  }

  async function getEthPrice(): Promise<bigint> {
    return publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'getEthPrice',
    }) as Promise<bigint>;
  }

  async function getStats() {
    const result = await publicClient.readContract({
      address: keepAliveAddress,
      abi: KEEPALIVE_ABI,
      functionName: 'getStats',
    }) as any;
    return {
      volume: result[0] as bigint,
      protocolFees: result[1] as bigint,
      pendingFees: result[2] as bigint,
      subCount: result[3] as bigint,
      fulfillments: result[4] as bigint,
    };
  }

  async function getReadySubscriptions(): Promise<Hex[]> {
    const ids = await getSubscriptionIds();
    const ready: Hex[] = [];

    // Batch isReady checks in groups of 5 to limit concurrent RPC calls
    const BATCH = 5;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          const r = await isReady(id);
          return { id, ready: r };
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ready) {
          ready.push(r.value.id);
        }
      }
    }

    return ready;
  }

  // ── Event Watching ──────────────────────────────────────────────────────

  function watchSubscriptions(callbacks: {
    onCreated?: (event: SubscriptionCreatedEvent) => void;
    onFulfilled?: (event: SubscriptionFulfilledEvent) => void;
    onCancelled?: (event: { subscriptionId: Hex; consumer: Address; refunded: bigint }) => void;
  }): UnwatchFn {
    const events = KEEPALIVE_ABI.filter((e) => e.type === 'event');

    return createEventPoller({
      publicClient,
      address: keepAliveAddress,
      events,
      pollIntervalMs: 10000,
      onLogs: (eventName, args) => {
        if (eventName === 'SubscriptionCreated' && callbacks.onCreated) {
          callbacks.onCreated(args as SubscriptionCreatedEvent);
        } else if (eventName === 'SubscriptionFulfilled' && callbacks.onFulfilled) {
          callbacks.onFulfilled(args as SubscriptionFulfilledEvent);
        } else if (eventName === 'SubscriptionCancelled' && callbacks.onCancelled) {
          callbacks.onCancelled(args);
        }
      },
    });
  }

  // ── Write Functions ─────────────────────────────────────────────────────

  async function depositUSDC(amount: bigint): Promise<Hex> {
    const wc = requireWallet();
    const account = wc.account!;

    const allowance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, keepAliveAddress],
    }) as bigint;

    if (allowance < amount) {
      await withTxMutex(() =>
        wc.writeContract({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [keepAliveAddress, amount],
          account,
          chain: wc.chain,
        }),
      );
    }

    return withTxMutex(() =>
      wc.writeContract({
        address: keepAliveAddress,
        abi: KEEPALIVE_ABI,
        functionName: 'depositUSDC',
        args: [amount],
        account,
        chain: wc.chain,
      }),
    );
  }

  async function createSubscription(params: {
    callbackTarget: Address;
    callbackGasLimit: bigint;
    intervalSeconds: bigint;
    feePerCycle: bigint;
    estimatedGasCostWei: bigint;
    maxFulfillments: bigint;
  }): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: keepAliveAddress,
        abi: KEEPALIVE_ABI,
        functionName: 'createSubscription',
        args: [
          params.callbackTarget,
          params.callbackGasLimit,
          params.intervalSeconds,
          params.feePerCycle,
          params.estimatedGasCostWei,
          params.maxFulfillments,
        ],
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function cancelSubscription(subscriptionId: Hex): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: keepAliveAddress,
        abi: KEEPALIVE_ABI,
        functionName: 'cancelSubscription',
        args: [subscriptionId],
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function fulfill(
    subscriptionId: Hex,
    opts?: { skipProfitCheck?: boolean },
  ): Promise<Hex | null> {
    const wc = requireWallet();

    if (inFlight.has(subscriptionId)) return null;

    // Check readiness
    const ready = await isReady(subscriptionId);
    if (!ready) return null;

    // Get agent payout (fee + gasReimbursement)
    const cost = await getSubscriptionCost(subscriptionId);
    const agentPayout = cost.fee + cost.gasReimbursement;

    // Pre-flight gas estimation
    let estimatedGas: bigint;
    try {
      const data = encodeFunctionData({
        abi: KEEPALIVE_ABI,
        functionName: 'fulfill',
        args: [subscriptionId],
      });
      const raw = await publicClient.estimateGas({
        account: wc.account!.address,
        to: keepAliveAddress,
        data,
      });
      estimatedGas = raw * 120n / 100n;
    } catch {
      return null; // Simulation failed
    }

    // Profitability check
    if (!opts?.skipProfitCheck) {
      try {
        const gasPrice = await publicClient.getGasPrice();
        const estimatedCostWei = estimatedGas * gasPrice;
        const ethPrice = await getEthPrice();
        if (ethPrice > 0n) {
          const estimatedCostUsdc = (estimatedCostWei * ethPrice) / BigInt(1e18);
          const profitUsdc = Number(agentPayout) - Number(estimatedCostUsdc);
          if (profitUsdc < -5000) return null; // Would lose > $0.005
        }
      } catch {
        // Price check failed — proceed anyway
      }
    }

    // Submit TX
    inFlight.add(subscriptionId);
    try {
      return await withTxMutex(() =>
        wc.writeContract({
          address: keepAliveAddress,
          abi: KEEPALIVE_ABI,
          functionName: 'fulfill',
          args: [subscriptionId],
          account: wc.account!,
          chain: wc.chain,
          gas: estimatedGas,
        }),
      );
    } finally {
      inFlight.delete(subscriptionId);
    }
  }

  function pollAndFulfill(opts?: {
    intervalMs?: number;
    onFulfilled?: (subId: Hex, txHash: Hex) => void;
    onSkipped?: (subId: Hex, reason: string) => void;
    onError?: (error: unknown) => void;
  }): UnwatchFn {
    const intervalMs = opts?.intervalMs ?? 10000;
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (stopped) return;
      try {
        const readySubs = await getReadySubscriptions();
        for (const subId of readySubs) {
          if (stopped) break;
          try {
            const txHash = await fulfill(subId);
            if (txHash) {
              opts?.onFulfilled?.(subId, txHash);
              // Invalidate cache after fulfillment so next poll sees updated state
              invalidateSubIdCache();
            } else {
              opts?.onSkipped?.(subId, 'unprofitable or in-flight');
            }
          } catch (fulfillErr) {
            opts?.onError?.(fulfillErr);
          }
        }
      } catch (pollErr) {
        opts?.onError?.(pollErr);
      }
      // Schedule next poll AFTER current one completes (no overlap)
      if (!stopped) {
        timeoutId = setTimeout(poll, intervalMs);
      }
    };

    poll(); // Run immediately

    return () => {
      stopped = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }

  return {
    // Read
    getSubscriptionCount,
    getSubscriptionIds,
    getSubscription,
    getSubscriptionCost,
    isReady,
    getBalance,
    getEthPrice,
    getStats,
    getReadySubscriptions,
    // Events
    watchSubscriptions,
    // Write
    depositUSDC,
    createSubscription,
    cancelSubscription,
    fulfill,
    pollAndFulfill,
  };
}

export type KeepAliveClient = ReturnType<typeof createKeepAliveClient>;
