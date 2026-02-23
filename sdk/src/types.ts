/**
 * x402c SDK Types
 */

import type { Address, Hex, PublicClient, WalletClient } from 'viem';

// ── Enums ───────────────────────────────────────────────────────────────────

export enum RequestStatus {
  PENDING = 0,
  FULFILLED = 1,
  CANCELLED = 2,
}

// ── Client Config ───────────────────────────────────────────────────────────

export interface ClientConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

// ── Hub Types ───────────────────────────────────────────────────────────────

export interface HubRequest {
  endpointId: Hex;
  requester: Address;
  totalCostUnits: bigint;
  baseCostUnits: bigint;
  markupUnits: bigint;
  gasReimbursementUnits: bigint;
  createdAt: bigint;
  status: number;
  responseData: Hex;
  sessionId: Hex;
  fulfilledBy: Address;
  params: Hex;
  hasCallback: boolean;
}

export interface EndpointSpec {
  id: Hex;
  url: string;
  inputFormat: string;
  outputFormat: string;
  baseCostUnits: bigint;
  maxResponseBytes: bigint;
  callbackGasLimit: bigint;
  estimatedGasCostWei: bigint;
  owner: Address;
  active: boolean;
  registeredAt: bigint;
}

export interface CallbackInfo {
  gasLimit: bigint;
  executed: boolean;
  success: boolean;
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

export interface RequestCreatedEvent {
  requestId: Hex;
  endpointId: Hex;
  requester: Address;
  endpointOwner: Address;
  costUnits: bigint;
  gasReimbursement: bigint;
  createdAt: bigint;
}

// ── KeepAlive Types ─────────────────────────────────────────────────────────

export interface Subscription {
  consumer: Address;
  callbackTarget: Address;
  callbackGasLimit: bigint;
  intervalSeconds: bigint;
  feePerCycle: bigint;
  estimatedGasCostWei: bigint;
  maxFulfillments: bigint;
  fulfillmentCount: bigint;
  lastFulfilled: bigint;
  active: boolean;
}

export interface SubscriptionCost {
  fee: bigint;
  markup: bigint;
  gasReimbursement: bigint;
  total: bigint;
}

export interface SubscriptionCreatedEvent {
  subscriptionId: Hex;
  consumer: Address;
  callbackTarget: Address;
  callbackGasLimit: bigint;
  intervalSeconds: bigint;
  feePerCycle: bigint;
  estimatedGasCostWei: bigint;
  maxFulfillments: bigint;
}

export interface SubscriptionFulfilledEvent {
  subscriptionId: Hex;
  fulfiller: Address;
  cycleNumber: bigint;
  agentPayout: bigint;
  protocolFee: bigint;
  callbackSuccess: boolean;
}

// ── Staking Types ───────────────────────────────────────────────────────────

export interface StakeInfo {
  amount: bigint;
  pendingRewards: bigint;
  cooldownEnd: bigint;
  pendingUnstake: bigint;
  slashCount: bigint;
  totalSlashed: bigint;
  stakedSince: bigint;
}

// ── Swap Types ──────────────────────────────────────────────────────────────

export interface WassQuote {
  swapPortion: bigint;
  otcPortion: bigint;
  otcAvailable: bigint;
  currentOtcBps: bigint;
  currentOtcFeeBps: bigint;
  hasOtc: boolean;
}

export interface RouterStats {
  otcBalance: bigint;
  totalRevenue: bigint;
  totalSwapVolume: bigint;
  totalOtcVolume: bigint;
  totalFeesCollected: bigint;
  contractEthBalance: bigint;
  contractWassBalance: bigint;
}

// ── Profitability ───────────────────────────────────────────────────────────

export interface ProfitabilityResult {
  estimatedGas: bigint;
  estimatedCostWei: bigint;
  estimatedCostUsdc: bigint;
  reimbursementUsdc: bigint;
  profitUsdc: bigint;
  isProfitable: boolean;
}

// ── Utilities ───────────────────────────────────────────────────────────────

export type UnwatchFn = () => void;
