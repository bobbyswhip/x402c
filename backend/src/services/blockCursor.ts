/**
 * Block Cursor — persistent last-scanned-block tracking.
 *
 * Stores the last block we successfully scanned to a file.
 * On restart, we resume from that block instead of using a
 * fixed lookback that can exceed RPC provider limits (1000 blocks).
 *
 * File: backend/.last-block-{label}
 */

import * as fs from 'fs';
import * as path from 'path';

const CURSOR_DIR = path.resolve(process.cwd());

function cursorPath(label: string): string {
  return path.join(CURSOR_DIR, `.last-block-${label}`);
}

/** Read the last scanned block for a given label. Returns 0n if no cursor exists. */
export function loadCursor(label: string): bigint {
  try {
    const raw = fs.readFileSync(cursorPath(label), 'utf-8').trim();
    const val = BigInt(raw);
    return val > 0n ? val : 0n;
  } catch {
    return 0n;
  }
}

/** Save the last scanned block for a given label. */
export function saveCursor(label: string, block: bigint): void {
  try {
    fs.writeFileSync(cursorPath(label), block.toString(), 'utf-8');
  } catch (err) {
    console.error(`[BlockCursor] Failed to save cursor '${label}':`, err);
  }
}
