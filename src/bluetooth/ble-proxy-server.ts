/**
 * BLE Proxy Server — bridges HTTP (localhost:11435) ↔ CoreBluetooth (phone peripheral)
 *
 * This module manages the companion Swift process (`edgecoder-ble-proxy`) that:
 *  - Acts as a CoreBluetooth Central on macOS
 *  - Scans for a nearby iPhone advertising the EdgeCoder BLE service
 *  - Exposes a local HTTP API on 127.0.0.1:11435 that the IntelligentRouter calls:
 *
 *      GET  /status        → { connected: bool, deviceName: string, batteryPct: number, modelState: string }
 *      POST /api/generate  → { prompt, maxTokens } → { response, durationMs, ok }
 *
 * The Swift binary is compiled separately and placed at one of:
 *  - /opt/edgecoder/bin/edgecoder-ble-proxy   (production install)
 *  - ./bin/edgecoder-ble-proxy                (dev/local)
 *
 * If the binary is not found, bluetooth-local routing is silently disabled.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "undici";

const BLE_PROXY_PORT = Number(process.env.BT_PROXY_PORT ?? "11435");
const BLE_PROXY_HOST = process.env.BT_PROXY_HOST ?? "127.0.0.1";
const BLE_PROXY_URL = `http://${BLE_PROXY_HOST}:${BLE_PROXY_PORT}`;

const BINARY_SEARCH_PATHS = [
  "/opt/edgecoder/bin/edgecoder-ble-proxy",
  `${process.env.HOME ?? "/tmp"}/.edgecoder/bin/edgecoder-ble-proxy`,
  "./bin/edgecoder-ble-proxy",
  "../bin/edgecoder-ble-proxy"
];

// ---------------------------------------------------------------------------
// BLE Proxy Manager
// ---------------------------------------------------------------------------

export class BleProxyManager {
  private proc: ChildProcess | null = null;
  private binaryPath: string | null = null;
  private _started = false;

  constructor() {
    this.binaryPath = BINARY_SEARCH_PATHS.find((p) => existsSync(p)) ?? null;
  }

  get isAvailable(): boolean {
    return this.binaryPath !== null;
  }

  get proxyUrl(): string {
    return BLE_PROXY_URL;
  }

  get statusUrl(): string {
    return `${BLE_PROXY_URL}/status`;
  }

  /** Start the Swift BLE proxy companion process. */
  async start(): Promise<void> {
    if (!this.binaryPath) {
      console.log("[ble-proxy] Binary not found — bluetooth-local routing disabled.");
      return;
    }
    if (this._started && this.proc && !this.proc.killed) {
      console.log("[ble-proxy] Already running.");
      return;
    }

    console.log(`[ble-proxy] Starting ${this.binaryPath} on port ${BLE_PROXY_PORT}...`);
    this.proc = spawn(this.binaryPath, ["--port", String(BLE_PROXY_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });

    this.proc.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(`[ble-proxy] ${d.toString()}`);
    });
    this.proc.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[ble-proxy] ${d.toString()}`);
    });
    this.proc.on("exit", (code) => {
      console.log(`[ble-proxy] Process exited (code=${code}). Will restart on next request.`);
      this._started = false;
      this.proc = null;
    });

    this._started = true;

    // Wait up to 5s for proxy to be ready
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (await this.ping()) return;
    }
    console.warn("[ble-proxy] Proxy didn't respond within 5s — continuing anyway.");
  }

  async stop(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this._started = false;
  }

  /** Quick liveness check. */
  async ping(): Promise<boolean> {
    try {
      const res = await request(this.statusUrl, {
        method: "GET",
        headersTimeout: 1000,
        bodyTimeout: 1000
      });
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  /** Get current BLE connection status from the proxy. */
  async getStatus(): Promise<BleStatus | null> {
    try {
      const res = await request(this.statusUrl, {
        method: "GET",
        headersTimeout: 2000,
        bodyTimeout: 2000
      });
      if (res.statusCode !== 200) return null;
      return (await res.body.json()) as BleStatus;
    } catch {
      return null;
    }
  }

  /** Submit an inference request to the phone via BLE. */
  async generate(prompt: string, maxTokens = 512): Promise<BleGenerateResult | null> {
    // Auto-restart proxy if it died
    if (this.binaryPath && (!this._started || !this.proc || this.proc.killed)) {
      await this.start();
    }
    try {
      const res = await request(`${BLE_PROXY_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, maxTokens, stream: false }),
        headersTimeout: 10_000,
        bodyTimeout: 90_000
      });
      if (res.statusCode < 200 || res.statusCode >= 300) return null;
      return (await res.body.json()) as BleGenerateResult;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BleStatus {
  connected: boolean;
  scanning: boolean;
  deviceName?: string;
  deviceId?: string;
  batteryPct?: number;
  modelState?: string;
  rssi?: number;
  lastSeenMs?: number;
}

export interface BleGenerateResult {
  response?: string;
  text?: string;
  ok: boolean;
  durationMs: number;
  deviceName?: string;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const bleProxy = new BleProxyManager();
