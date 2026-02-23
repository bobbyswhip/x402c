/**
 * Swap Client
 *
 * Buy X402C tokens with ETH via the wASSOTC router.
 * Two-hop: ETH -> wASS (OTC hybrid) -> X402C (V4 pool)
 */

import type { Address, Hex } from 'viem';
import { WASSOTC_ABI } from '../abis/wassotc.js';
import { ADDRESSES, X402C_POOL_KEY, WASS_IS_TOKEN0 } from '../constants.js';
import type { ClientConfig, WassQuote, RouterStats } from '../types.js';
import { withTxMutex } from '../utils/txQueue.js';

export function createSwapClient(config: ClientConfig) {
  const { publicClient, walletClient } = config;
  const routerAddress = ADDRESSES.WASSOTC_ROUTER as Address;

  function requireWallet() {
    if (!walletClient) throw new Error('walletClient required for write operations');
    return walletClient;
  }

  // ── Read Functions ──────────────────────────────────────────────────────

  async function quoteEthToWass(ethAmount: bigint): Promise<WassQuote> {
    const result = await publicClient.readContract({
      address: routerAddress,
      abi: WASSOTC_ABI,
      functionName: 'quote',
      args: [ethAmount],
    }) as any;
    return {
      swapPortion: result[0] as bigint,
      otcPortion: result[1] as bigint,
      otcAvailable: result[2] as bigint,
      currentOtcBps: result[3] as bigint,
      currentOtcFeeBps: result[4] as bigint,
      hasOtc: result[5] as boolean,
    };
  }

  async function getRouterStats(): Promise<RouterStats> {
    const result = await publicClient.readContract({
      address: routerAddress,
      abi: WASSOTC_ABI,
      functionName: 'getStats',
    }) as any;
    return {
      otcBalance: result[0] as bigint,
      totalRevenue: result[1] as bigint,
      totalSwapVolume: result[2] as bigint,
      totalOtcVolume: result[3] as bigint,
      totalFeesCollected: result[4] as bigint,
      contractEthBalance: result[5] as bigint,
      contractWassBalance: result[6] as bigint,
    };
  }

  // ── Write Functions ─────────────────────────────────────────────────────

  async function buyX402C(params: {
    ethAmount: bigint;
    minWassOut?: bigint;
    minTokenOut?: bigint;
  }): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: routerAddress,
        abi: WASSOTC_ABI,
        functionName: 'swapToToken',
        args: [
          X402C_POOL_KEY,
          params.minWassOut ?? 0n,
          params.minTokenOut ?? 0n,
          WASS_IS_TOKEN0,
        ],
        value: params.ethAmount,
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function buyWass(params: {
    ethAmount: bigint;
    minWassOut?: bigint;
  }): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: routerAddress,
        abi: WASSOTC_ABI,
        functionName: 'swap',
        args: [params.minWassOut ?? 0n],
        value: params.ethAmount,
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  return {
    quoteEthToWass,
    getRouterStats,
    buyX402C,
    buyWass,
  };
}

export type SwapClient = ReturnType<typeof createSwapClient>;
