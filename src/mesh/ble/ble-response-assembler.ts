// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** Largest BLE task response we buffer (the peer announces the length in the first notify). */
export const MAX_BLE_RESPONSE_BYTES = 1024 * 1024;

export type BleAssembleResult =
  | { state: "pending" }
  | { state: "complete"; data: Buffer }
  | { state: "error"; reason: string };

/**
 * Reassembles a chunked BLE task response: the first notify starts with a 4-byte big-endian
 * length, then data; later notifies are continuations. The announced length and the bytes
 * buffered are both capped, so a peer cannot make us hold an unbounded amount of memory.
 */
export class BleResponseAssembler {
  private expectedLength = -1;
  private readonly chunks: Buffer[] = [];
  private receivedBytes = 0;
  private failed = false;

  constructor(private readonly maxBytes = MAX_BLE_RESPONSE_BYTES) {}

  push(data: Buffer): BleAssembleResult {
    if (this.failed) return { state: "error", reason: "already_failed" };
    let payload = data;
    if (this.expectedLength < 0) {
      if (data.length < 4) return this.fail("short_header");
      this.expectedLength = data.readUInt32BE(0);
      if (this.expectedLength > this.maxBytes) return this.fail(`response_too_large:${this.expectedLength}`);
      payload = data.subarray(4);
    }
    const room = this.expectedLength - this.receivedBytes;
    if (payload.length > room) payload = payload.subarray(0, room);
    this.chunks.push(payload);
    this.receivedBytes += payload.length;
    if (this.receivedBytes >= this.expectedLength) return { state: "complete", data: Buffer.concat(this.chunks) };
    return { state: "pending" };
  }

  get received(): number {
    return this.receivedBytes;
  }

  get expected(): number {
    return this.expectedLength;
  }

  private fail(reason: string): BleAssembleResult {
    this.failed = true;
    this.chunks.length = 0;
    return { state: "error", reason };
  }
}
