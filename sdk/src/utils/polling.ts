/**
 * Generic getLogs Event Poller
 *
 * Polls for contract events using getLogs (since many Base RPCs
 * don't support eth_newFilter). Matches Base's 2s block time.
 * Includes exponential backoff on errors.
 */

import type { Address, PublicClient } from 'viem';
import type { UnwatchFn } from '../types.js';

export interface PollConfig {
  publicClient: PublicClient;
  address: Address;
  events: readonly any[];
  onLogs: (eventName: string, args: any, log: any) => void;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
}

export function createEventPoller(config: PollConfig): UnwatchFn {
  const {
    publicClient,
    address,
    events,
    onLogs,
    pollIntervalMs = 2000,
    maxBackoffMs = 30000,
  } = config;

  let lastBlock = 0n;
  let errorCount = 0;
  let currentInterval = pollIntervalMs;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;

    try {
      const currentBlock = await publicClient.getBlockNumber();
      if (currentBlock <= lastBlock) return;

      const fromBlock = lastBlock === 0n
        ? (currentBlock > 100n ? currentBlock - 100n : 0n)
        : lastBlock + 1n;

      for (const event of events) {
        const logs = await publicClient.getLogs({
          address,
          event,
          fromBlock,
          toBlock: currentBlock,
        });

        for (const log of logs) {
          onLogs(event.name, (log as any).args, log);
        }
      }

      lastBlock = currentBlock;

      // Reset backoff on success
      if (errorCount > 0) {
        errorCount = 0;
        currentInterval = pollIntervalMs;
        restartInterval();
      }
    } catch {
      errorCount++;

      // Exponential backoff after 3 consecutive errors
      if (errorCount >= 3) {
        currentInterval = Math.min(
          pollIntervalMs * Math.pow(2, errorCount - 2),
          maxBackoffMs,
        );
        restartInterval();
      }

      // After 10 consecutive errors, reset lastBlock
      if (errorCount >= 10) {
        lastBlock = 0n;
      }
    }
  };

  const restartInterval = () => {
    if (stopped) return;
    if (intervalId !== null) clearInterval(intervalId);
    intervalId = setInterval(poll, currentInterval);
  };

  // Start
  intervalId = setInterval(poll, currentInterval);
  poll(); // Run immediately

  return () => {
    stopped = true;
    if (intervalId !== null) clearInterval(intervalId);
  };
}
