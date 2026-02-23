/**
 * Staking Client
 *
 * Stake X402C tokens to become an eligible agent, earn rewards,
 * and check reputation scores.
 */

import type { Address, Hex } from 'viem';
import { STAKING_ABI } from '../abis/staking.js';
import { ERC20_ABI } from '../abis/erc20.js';
import { ADDRESSES } from '../constants.js';
import type { ClientConfig, StakeInfo } from '../types.js';
import { withTxMutex } from '../utils/txQueue.js';

export function createStakingClient(config: ClientConfig) {
  const { publicClient, walletClient } = config;
  const stakingAddress = ADDRESSES.STAKING as Address;
  const tokenAddress = ADDRESSES.TOKEN as Address;

  function requireWallet() {
    if (!walletClient) throw new Error('walletClient required for write operations');
    return walletClient;
  }

  // ── Read Functions ──────────────────────────────────────────────────────

  async function getStakeInfo(account: Address): Promise<StakeInfo> {
    const result = await publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'getStakeInfo',
      args: [account],
    }) as any;
    return {
      amount: result[0] as bigint,
      pendingRewards: result[1] as bigint,
      cooldownEnd: result[2] as bigint,
      pendingUnstake: result[3] as bigint,
      slashCount: result[4] as bigint,
      totalSlashed: result[5] as bigint,
      stakedSince: result[6] as bigint,
    };
  }

  async function pendingRewards(account: Address): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'pendingRewards',
      args: [account],
    }) as Promise<bigint>;
  }

  async function totalStaked(): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'totalStaked',
    }) as Promise<bigint>;
  }

  async function totalSlashedGlobal(): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'totalSlashedGlobal',
    }) as Promise<bigint>;
  }

  async function getReputation(agent: Address): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'getReputation',
      args: [agent],
    }) as Promise<bigint>;
  }

  async function isEligibleAgent(agent: Address): Promise<boolean> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'isEligibleAgent',
      args: [agent],
    }) as Promise<boolean>;
  }

  async function minStakeForAgent(): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'minStakeForAgent',
    }) as Promise<bigint>;
  }

  async function cooldownPeriod(): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'cooldownPeriod',
    }) as Promise<bigint>;
  }

  async function slashBps(): Promise<bigint> {
    return publicClient.readContract({
      address: stakingAddress,
      abi: STAKING_ABI,
      functionName: 'slashBps',
    }) as Promise<bigint>;
  }

  // ── Write Functions ─────────────────────────────────────────────────────

  async function stake(amount: bigint): Promise<Hex> {
    const wc = requireWallet();
    const account = wc.account!;

    // Auto-approve X402C if needed
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, stakingAddress],
    }) as bigint;

    if (allowance < amount) {
      await withTxMutex(() =>
        wc.writeContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [stakingAddress, amount],
          account,
          chain: wc.chain,
        }),
      );
    }

    return withTxMutex(() =>
      wc.writeContract({
        address: stakingAddress,
        abi: STAKING_ABI,
        functionName: 'stake',
        args: [amount],
        account,
        chain: wc.chain,
      }),
    );
  }

  async function requestUnstake(amount: bigint): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: stakingAddress,
        abi: STAKING_ABI,
        functionName: 'requestUnstake',
        args: [amount],
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function withdraw(): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: stakingAddress,
        abi: STAKING_ABI,
        functionName: 'withdraw',
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function claimRewards(): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: stakingAddress,
        abi: STAKING_ABI,
        functionName: 'claimRewards',
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function compound(): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: stakingAddress,
        abi: STAKING_ABI,
        functionName: 'compound',
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  return {
    // Read
    getStakeInfo,
    pendingRewards,
    totalStaked,
    totalSlashedGlobal,
    getReputation,
    isEligibleAgent,
    minStakeForAgent,
    cooldownPeriod,
    slashBps,
    // Write
    stake,
    requestUnstake,
    withdraw,
    claimRewards,
    compound,
  };
}

export type StakingClient = ReturnType<typeof createStakingClient>;
