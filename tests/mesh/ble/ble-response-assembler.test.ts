import { describe, expect, it } from "vitest";
import { BleResponseAssembler } from "../../../src/mesh/ble/ble-response-assembler.js";

function header(len: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(len, 0);
  return b;
}

describe("BLE response reassembly", () => {
  it("reassembles a chunked response", () => {
    const a = new BleResponseAssembler();
    expect(a.push(Buffer.concat([header(10), Buffer.from("hello")])).state).toBe("pending");
    const done = a.push(Buffer.from("world"));
    expect(done).toEqual({ state: "complete", data: Buffer.from("helloworld") });
  });

  it("refuses an announced length over the cap without buffering", () => {
    const a = new BleResponseAssembler(1024);
    const r = a.push(Buffer.concat([header(0xfffffff0), Buffer.from("x")]));
    expect(r.state).toBe("error");
    expect(a.push(Buffer.from("more")).state).toBe("error");
  });

  it("reads the length as unsigned and rejects a short header", () => {
    expect(new BleResponseAssembler().push(Buffer.from([0x80, 0, 0, 0, 1])).state).toBe("error");
    expect(new BleResponseAssembler().push(Buffer.from([0, 1])).state).toBe("error");
  });

  it("never buffers past the announced length", () => {
    const a = new BleResponseAssembler();
    const r = a.push(Buffer.concat([header(3), Buffer.from("abcdef")]));
    expect(r).toEqual({ state: "complete", data: Buffer.from("abc") });
  });
});
