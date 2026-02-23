import { describe, it, expect } from "vitest";
import {
  BLE_SERVICE_UUID,
  BLE_CHAR_PEER_IDENTITY,
  BLE_CHAR_CAPABILITIES,
  BLE_CHAR_TASK_REQUEST,
  BLE_CHAR_TASK_RESPONSE,
  BLE_CHAR_LEDGER_SYNC,
  encodeChunks,
  decodeChunks,
  BLEPeerEntry,
  BLETaskRequest,
  BLETaskResponse,
  BLECreditTransaction
} from "../../../src/mesh/ble/protocol.js";

describe("BLE protocol constants", () => {
  it("exports service and characteristic UUIDs", () => {
    expect(BLE_SERVICE_UUID).toBeDefined();
    expect(BLE_CHAR_PEER_IDENTITY).toBeDefined();
    expect(BLE_CHAR_CAPABILITIES).toBeDefined();
    expect(BLE_CHAR_TASK_REQUEST).toBeDefined();
    expect(BLE_CHAR_TASK_RESPONSE).toBeDefined();
    expect(BLE_CHAR_LEDGER_SYNC).toBeDefined();
  });
});

describe("chunk encoding/decoding", () => {
  it("round-trips a small payload in one chunk", () => {
    const data = Buffer.from(JSON.stringify({ hello: "world" }));
    const chunks = encodeChunks(data, 512);
    expect(chunks).toHaveLength(1);
    const reassembled = decodeChunks(chunks);
    expect(reassembled.toString()).toBe(data.toString());
  });

  it("round-trips a large payload across multiple chunks", () => {
    const data = Buffer.from("x".repeat(2000));
    const chunks = encodeChunks(data, 512);
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = decodeChunks(chunks);
    expect(reassembled.toString()).toBe(data.toString());
  });

  it("handles exact MTU boundary", () => {
    // 4 bytes header per chunk, so 508 bytes data per chunk at MTU 512
    const data = Buffer.from("y".repeat(508));
    const chunks = encodeChunks(data, 512);
    expect(chunks).toHaveLength(1);
    const reassembled = decodeChunks(chunks);
    expect(reassembled.toString()).toBe(data.toString());
  });
});
