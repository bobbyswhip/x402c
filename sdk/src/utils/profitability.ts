/**
 * Pre-flight Gas Estimation & Profitability Check
 *
 * Simulates a TX, estimates gas cost in USDC, and compares to agent payout.
 * Uses 20% gas buffer for Base L2 L1 data cost variance.
 */

import { encodeFunctionData, type Address, type PublicClient, type Hex } from 'viem';
import type { ProfitabilityResult } from '../types.js';

export async function checkTxProfitability(params: {
  publicClient: PublicClient;
  contractAddress: Address;
  abi: readonly any[];
  functionName: string;
  args: readonly any[];
  account: Address;
  reimbursementUsdc: bigint;
  getEthPrice: () => Promise<bigint>;
  lossToleranceUsdc?: bigint;
  gasBufferPct?: bigint;
  value?: bigint;
}): Promise<ProfitabilityResult> {
  const {
    publicClient,
    contractAddress,
    abi,
    functionName,
    args,
    account,
    reimbursementUsdc,
    getEthPrice,
    lossToleranceUsdc = 5000n, // $0.005
    gasBufferPct = 120n,       // 20% buffer
  } = params;

  // Step 1: Simulate TX to estimate gas
  const data = encodeFunctionData({ abi, functionName, args } as any) as Hex;
  const estimatedGasRaw = await publicClient.estimateGas({
    account,
    to: contractAddress,
    data,
    value: params.value,
  });

  // Step 2: Apply buffer
  const estimatedGas = estimatedGasRaw * gasBufferPct / 100n;

  // Step 3: Get gas price and compute cost in wei
  const gasPrice = await publicClient.getGasPrice();
  const estimatedCostWei = estimatedGas * gasPrice;

  // Step 4: Convert to USDC via oracle ETH price
  const ethPrice = await getEthPrice(); // USDC per 1 ETH (6 decimals)
  const estimatedCostUsdc = ethPrice > 0n
    ? (estimatedCostWei * ethPrice) / BigInt(1e18)
    : 0n;

  // Step 5: Profitability
  const profitUsdc = BigInt(Number(reimbursementUsdc)) - estimatedCostUsdc;
  const isProfitable = profitUsdc >= -lossToleranceUsdc;

  return {
    estimatedGas,
    estimatedCostWei,
    estimatedCostUsdc,
    reimbursementUsdc,
    profitUsdc,
    isProfitable,
  };
}
