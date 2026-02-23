/**
 * TX Nonce Mutex
 *
 * Serializes all on-chain write transactions from the same wallet
 * to prevent nonce collisions on rapid-fire TXs.
 */

let txMutexPromise: Promise<void> = Promise.resolve();

export function withTxMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = txMutexPromise;
  let resolve: () => void;
  txMutexPromise = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}
