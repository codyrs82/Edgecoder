export const BLE_SERVICE_UUID = "e0d6ec00-0001-4c3a-9b5e-00ed6ec0de00";
export const BLE_CHAR_PEER_IDENTITY = "e0d6ec00-0002-4c3a-9b5e-00ed6ec0de00";
export const BLE_CHAR_CAPABILITIES = "e0d6ec00-0003-4c3a-9b5e-00ed6ec0de00";
export const BLE_CHAR_TASK_REQUEST = "e0d6ec00-0004-4c3a-9b5e-00ed6ec0de00";
export const BLE_CHAR_TASK_RESPONSE = "e0d6ec00-0005-4c3a-9b5e-00ed6ec0de00";
export const BLE_CHAR_LEDGER_SYNC = "e0d6ec00-0006-4c3a-9b5e-00ed6ec0de00";

export const DEFAULT_MTU = 512;
const CHUNK_HEADER_SIZE = 4; // 2 bytes seqNo + 2 bytes totalChunks

export type { BLEPeerEntry, BLETaskRequest, BLETaskResponse, BLECreditTransaction } from "../../common/types.js";

export function encodeChunks(data: Buffer, mtu: number = DEFAULT_MTU): Buffer[] {
  if (mtu <= CHUNK_HEADER_SIZE) {
    throw new RangeError(`MTU must be greater than ${CHUNK_HEADER_SIZE} (header size), got ${mtu}`);
  }
  const chunkDataSize = mtu - CHUNK_HEADER_SIZE;
  const totalChunks = Math.ceil(data.length / chunkDataSize);
  if (totalChunks > 0xFFFF) {
    throw new RangeError(`Payload too large: requires ${totalChunks} chunks (max 65535)`);
  }
  const chunks: Buffer[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const header = Buffer.alloc(CHUNK_HEADER_SIZE);
    header.writeUInt16BE(i, 0);
    header.writeUInt16BE(totalChunks, 2);
    const start = i * chunkDataSize;
    const end = Math.min(start + chunkDataSize, data.length);
    chunks.push(Buffer.concat([header, data.subarray(start, end)]));
  }
  return chunks;
}

export function decodeChunks(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  const sorted = [...chunks].sort((a, b) => a.readUInt16BE(0) - b.readUInt16BE(0));
  const expectedTotal = sorted[0].readUInt16BE(2);
  if (sorted.length !== expectedTotal) {
    throw new Error(`Expected ${expectedTotal} chunks but received ${sorted.length}`);
  }
  const dataParts = sorted.map((chunk) => chunk.subarray(CHUNK_HEADER_SIZE));
  return Buffer.concat(dataParts);
}
