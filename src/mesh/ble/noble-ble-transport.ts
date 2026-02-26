// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import {
  BLETransport,
  BLEAdvertisement,
  TaskRequestHandler,
} from "./ble-transport.js";
import {
  BLE_SERVICE_UUID,
  BLE_CHAR_PEER_IDENTITY,
  BLE_CHAR_CAPABILITIES,
  BLE_CHAR_TASK_REQUEST,
  BLE_CHAR_TASK_RESPONSE,
  BLEPeerEntry,
  BLETaskRequest,
  BLETaskResponse,
} from "./protocol.js";

/**
 * Real BLE transport using @abandonware/noble (central/scanning)
 * and @abandonware/bleno (peripheral/advertising) for macOS/Linux.
 *
 * Discovers iOS (and other) peers advertising the EdgeCoder GATT service,
 * reads their peer identity characteristic, and maintains a live peer list.
 * Supports task routing: write task requests to peers and receive responses.
 */
export class NobleBLETransport implements BLETransport {
  private advertisement: BLEAdvertisement | null = null;
  private scanning = false;
  private handler: TaskRequestHandler | null = null;
  private peers = new Map<string, BLEPeerEntry>();
  private noble: any = null;
  private bleno: any = null;
  private connectedPeripherals = new Map<string, any>();
  /** Peripheral references keyed by agentId, for reconnection during task routing */
  private peripheralsByAgentId = new Map<string, any>();
  /** Callback to push data on the task response notify characteristic */
  private taskResponseNotify: ((data: Buffer) => void) | null = null;

  constructor(private readonly localId: string) {}

  async init(): Promise<void> {
    try {
      const nobleModule = await import("@anthropic-ai/noble" as string).catch(
        () => import("@abandonware/noble" as string)
      );
      this.noble = nobleModule.default ?? nobleModule;
    } catch (e) {
      console.warn("[BLE] noble not available, scanning disabled:", String(e));
    }

    try {
      const blenoModule = await import("@anthropic-ai/bleno" as string).catch(
        () => import("@abandonware/bleno" as string)
      );
      this.bleno = blenoModule.default ?? blenoModule;
    } catch (e) {
      console.warn(
        "[BLE] bleno not available, advertising disabled:",
        String(e)
      );
    }

    if (this.noble) {
      this.noble.on("stateChange", (state: string) => {
        console.log(`[BLE] noble state: ${state}`);
        if (state === "poweredOn" && this.scanning) {
          this.doStartScanning();
        }
      });

      this.noble.on(
        "discover",
        (peripheral: any) => {
          this.handleDiscovery(peripheral);
        }
      );
    }

    if (this.bleno) {
      this.bleno.on("stateChange", (state: string) => {
        console.log(`[BLE] bleno state: ${state}`);
        if (state === "poweredOn" && this.advertisement) {
          this.doStartAdvertising();
        }
      });
    }
  }

  startAdvertising(advertisement: BLEAdvertisement): void {
    this.advertisement = advertisement;
    if (this.bleno?.state === "poweredOn") {
      this.doStartAdvertising();
    }
  }

  private doStartAdvertising(): void {
    if (!this.bleno || !this.advertisement) return;

    const Bleno = this.bleno;
    const ad = this.advertisement;

    const identityData = Buffer.from(
      JSON.stringify({
        agentId: ad.agentId,
        model: ad.model,
        modelParamSize: ad.modelParamSize,
        meshTokenHash: ad.meshTokenHash ?? "",
      })
    );

    const BlenoPrimaryService =
      Bleno.PrimaryService ?? Bleno.default?.PrimaryService;
    const BlenoCharacteristic =
      Bleno.Characteristic ?? Bleno.default?.Characteristic;

    if (!BlenoPrimaryService || !BlenoCharacteristic) {
      console.warn("[BLE] bleno PrimaryService/Characteristic not found");
      return;
    }

    const identityChar = new BlenoCharacteristic({
      uuid: BLE_CHAR_PEER_IDENTITY.replace(/-/g, ""),
      properties: ["read"],
      value: identityData,
    });

    const capabilitiesChar = new BlenoCharacteristic({
      uuid: BLE_CHAR_CAPABILITIES.replace(/-/g, ""),
      properties: ["read"],
      value: Buffer.from(
        JSON.stringify({
          memoryMB: ad.memoryMB,
          batteryPct: ad.batteryPct,
          currentLoad: ad.currentLoad,
          deviceType: ad.deviceType,
        })
      ),
    });

    // Task request characteristic — writable by remote peers
    const self = this;
    const taskRequestChar = new BlenoCharacteristic({
      uuid: BLE_CHAR_TASK_REQUEST.replace(/-/g, ""),
      properties: ["write", "writeWithoutResponse"],
      onWriteRequest(
        data: Buffer,
        _offset: number,
        _withoutResponse: boolean,
        callback: (result: number) => void
      ) {
        callback(0); // RESULT_SUCCESS
        self.handleIncomingTaskRequest(data);
      },
    });

    // Task response characteristic — notify to remote peers
    const taskResponseChar = new BlenoCharacteristic({
      uuid: BLE_CHAR_TASK_RESPONSE.replace(/-/g, ""),
      properties: ["notify"],
      onSubscribe(
        _maxValueSize: number,
        updateValueCallback: (data: Buffer) => void
      ) {
        console.log("[BLE] peer subscribed to task response notifications");
        self.taskResponseNotify = updateValueCallback;
      },
      onUnsubscribe() {
        console.log("[BLE] peer unsubscribed from task response");
        self.taskResponseNotify = null;
      },
    });

    const service = new BlenoPrimaryService({
      uuid: BLE_SERVICE_UUID.replace(/-/g, ""),
      characteristics: [
        identityChar,
        capabilitiesChar,
        taskRequestChar,
        taskResponseChar,
      ],
    });

    Bleno.setServices([service], (err: Error | null) => {
      if (err) {
        console.error("[BLE] failed to set services:", err);
        return;
      }
      const localName = `EC-${ad.agentId.substring(0, 8)}`;
      Bleno.startAdvertising(
        localName,
        [BLE_SERVICE_UUID.replace(/-/g, "")],
        (advErr: Error | null) => {
          if (advErr) {
            console.error("[BLE] advertising failed:", advErr);
          } else {
            console.log(`[BLE] advertising as ${localName}`);
          }
        }
      );
    });
  }

  /** Handle an incoming task request written to our GATT characteristic by a remote peer. */
  private async handleIncomingTaskRequest(data: Buffer): Promise<void> {
    if (!this.handler) {
      console.warn("[BLE] received task request but no handler registered");
      return;
    }
    try {
      const request: BLETaskRequest = JSON.parse(data.toString("utf8"));
      console.log(
        `[BLE] incoming task request ${request.requestId} from ${request.requesterId}`
      );
      const response = await this.handler(request);
      console.log(`[BLE] task ${request.requestId} completed: ${response.status}`);

      if (this.taskResponseNotify) {
        const responseData = Buffer.from(JSON.stringify(response));
        // Chunk with 4-byte length prefix, matching iOS chunking protocol
        const header = Buffer.alloc(4);
        header.writeUInt32BE(responseData.length, 0);
        const firstChunk = Buffer.concat([header, responseData]);
        this.taskResponseNotify(firstChunk);
        console.log(
          `[BLE] sent task response via notify (${responseData.length} bytes, with 4-byte header)`
        );
      } else {
        console.warn("[BLE] no subscriber for task response notify");
      }
    } catch (e) {
      console.error("[BLE] error handling incoming task request:", e);
    }
  }

  stopAdvertising(): void {
    this.advertisement = null;
    if (this.bleno) {
      this.bleno.stopAdvertising();
    }
  }

  startScanning(): void {
    this.scanning = true;
    if (this.noble?.state === "poweredOn") {
      this.doStartScanning();
    }
  }

  private doStartScanning(): void {
    if (!this.noble) return;
    const serviceUUIDs = [BLE_SERVICE_UUID.replace(/-/g, "")];
    this.noble.startScanning(serviceUUIDs, true, (err: Error | null) => {
      if (err) {
        console.error("[BLE] scan failed:", err);
      } else {
        console.log("[BLE] scanning for EdgeCoder peers...");
      }
    });
  }

  stopScanning(): void {
    this.scanning = false;
    if (this.noble) {
      this.noble.stopScanning();
    }
  }

  discoveredPeers(): BLEPeerEntry[] {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeenMs > 60_000) {
        this.peers.delete(id);
      }
    }
    return Array.from(this.peers.values());
  }

  onTaskRequest(handler: TaskRequestHandler): void {
    this.handler = handler;
  }

  /**
   * Send a task request to a discovered BLE peer.
   * Stops scanning to avoid connection races, connects to the peer's peripheral,
   * writes the task to BLE_CHAR_TASK_REQUEST, subscribes to BLE_CHAR_TASK_RESPONSE
   * for the result, and waits.
   */
  async sendTaskRequest(
    peerId: string,
    request: BLETaskRequest
  ): Promise<BLETaskResponse> {
    const peripheral = this.peripheralsByAgentId.get(peerId);
    if (!peripheral) {
      console.warn(`[BLE] sendTaskRequest: no peripheral found for ${peerId}`);
      return {
        requestId: request.requestId,
        providerId: peerId,
        status: "failed",
        cpuSeconds: 0,
        providerSignature: "",
      };
    }

    const fail = (): BLETaskResponse => ({
      requestId: request.requestId,
      providerId: peerId,
      status: "failed",
      cpuSeconds: 0,
      providerSignature: "",
    });

    // Stop scanning to prevent discovery connect/disconnect cycles from
    // interfering with the task connection. Noble discovery callbacks
    // call peripheral.connect() on every rediscovery, which races with
    // our task connection.
    const wasScanning = this.scanning;
    if (wasScanning && this.noble) {
      console.log(`[BLE] pausing scan for task ${request.requestId}`);
      this.noble.stopScanning();
    }

    // Wait briefly for any in-flight discovery connection to tear down
    await new Promise((r) => setTimeout(r, 500));

    // Ensure the peripheral is fully disconnected before we connect
    const peripheralState = peripheral.state;
    if (peripheralState === "connected" || peripheralState === "connecting") {
      console.log(`[BLE] peripheral ${peerId} in state '${peripheralState}', disconnecting first...`);
      try {
        peripheral.disconnect();
        await new Promise((r) => setTimeout(r, 300));
      } catch {}
    }

    return new Promise<BLETaskResponse>((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        // Resume scanning after task completes
        if (wasScanning && this.noble) {
          console.log(`[BLE] resuming scan after task ${request.requestId}`);
          this.doStartScanning();
        }
      };

      const timeout = setTimeout(() => {
        console.warn(`[BLE] sendTaskRequest: timeout for ${peerId}`);
        try {
          peripheral.disconnect();
        } catch {}
        cleanup();
        resolve(fail());
      }, 90_000);

      // Listen for unexpected disconnect during the task flow
      const onDisconnect = () => {
        console.warn(`[BLE] peripheral ${peerId} disconnected unexpectedly during task`);
        clearTimeout(timeout);
        cleanup();
        resolve(fail());
      };
      peripheral.once("disconnect", onDisconnect);

      console.log(`[BLE] connecting to peer ${peerId} for task ${request.requestId} (state: ${peripheral.state})...`);

      peripheral.connect((err: Error | null) => {
        if (err) {
          console.error(`[BLE] connect to ${peerId} failed:`, err);
          clearTimeout(timeout);
          peripheral.removeListener("disconnect", onDisconnect);
          cleanup();
          resolve(fail());
          return;
        }

        console.log(`[BLE] connected to ${peerId}, discovering services...`);

        const serviceUUIDs = [BLE_SERVICE_UUID.replace(/-/g, "")];
        const charUUIDs = [
          BLE_CHAR_TASK_REQUEST.replace(/-/g, ""),
          BLE_CHAR_TASK_RESPONSE.replace(/-/g, ""),
        ];

        peripheral.discoverSomeServicesAndCharacteristics(
          serviceUUIDs,
          charUUIDs,
          (
            discErr: Error | null,
            _services: any[],
            characteristics: any[]
          ) => {
            if (discErr || !characteristics?.length) {
              console.error(`[BLE] char discovery failed for ${peerId}:`, discErr);
              clearTimeout(timeout);
              peripheral.removeListener("disconnect", onDisconnect);
              peripheral.disconnect();
              cleanup();
              resolve(fail());
              return;
            }

            console.log(`[BLE] discovered ${characteristics.length} chars on ${peerId}: ${characteristics.map((c: any) => c.uuid).join(", ")}`);

            const taskReqChar = characteristics.find(
              (c: any) =>
                c.uuid === BLE_CHAR_TASK_REQUEST.replace(/-/g, "").toLowerCase()
            );
            const taskRespChar = characteristics.find(
              (c: any) =>
                c.uuid === BLE_CHAR_TASK_RESPONSE.replace(/-/g, "").toLowerCase()
            );

            if (!taskReqChar || !taskRespChar) {
              console.warn(
                `[BLE] task chars not found on ${peerId} (found: ${characteristics.map((c: any) => c.uuid).join(", ")})`
              );
              clearTimeout(timeout);
              peripheral.removeListener("disconnect", onDisconnect);
              peripheral.disconnect();
              cleanup();
              resolve(fail());
              return;
            }

            // Subscribe to task response notifications first
            taskRespChar.subscribe((subErr: Error | null) => {
              if (subErr) {
                console.error(`[BLE] subscribe to task response failed:`, subErr);
                clearTimeout(timeout);
                peripheral.removeListener("disconnect", onDisconnect);
                peripheral.disconnect();
                cleanup();
                resolve(fail());
                return;
              }

              console.log(`[BLE] subscribed to task response on ${peerId}`);

              // Chunked response reassembly: first notify has 4-byte big-endian
              // length prefix, followed by data. Subsequent notifies are continuations.
              let expectedLength = -1;
              let chunks: Buffer[] = [];
              let receivedBytes = 0;

              const processComplete = (fullData: Buffer) => {
                clearTimeout(timeout);
                peripheral.removeListener("disconnect", onDisconnect);
                try {
                  const response: BLETaskResponse = JSON.parse(
                    fullData.toString("utf8")
                  );
                  console.log(
                    `[BLE] received task response from ${peerId}: ${response.status} (${fullData.length} bytes)`
                  );
                  peripheral.disconnect();
                  cleanup();
                  resolve(response);
                } catch (e) {
                  console.error("[BLE] failed to parse task response:", e);
                  peripheral.disconnect();
                  cleanup();
                  resolve(fail());
                }
              };

              // Listen for the response notify (chunked)
              taskRespChar.on("data", (data: Buffer) => {
                if (expectedLength < 0) {
                  // First chunk: read 4-byte length header
                  expectedLength =
                    (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
                  const payload = data.subarray(4);
                  chunks.push(payload);
                  receivedBytes += payload.length;
                  console.log(`[BLE] response chunk 1: ${payload.length} bytes (expecting ${expectedLength} total)`);
                } else {
                  // Continuation chunk
                  chunks.push(data);
                  receivedBytes += data.length;
                  console.log(`[BLE] response chunk +${data.length} bytes (${receivedBytes}/${expectedLength})`);
                }

                if (receivedBytes >= expectedLength) {
                  processComplete(Buffer.concat(chunks));
                }
              });

              // Write the task request
              const requestData = Buffer.from(JSON.stringify(request));
              console.log(
                `[BLE] writing task request to ${peerId} (${requestData.length} bytes)...`
              );
              taskReqChar.write(requestData, false, (writeErr: Error | null) => {
                if (writeErr) {
                  console.error(`[BLE] write task request failed:`, writeErr);
                  clearTimeout(timeout);
                  peripheral.removeListener("disconnect", onDisconnect);
                  peripheral.disconnect();
                  cleanup();
                  resolve(fail());
                  return;
                }
                // Otherwise wait for response via notify
                console.log(`[BLE] task request written to ${peerId}, waiting for response...`);
              });
            });
          }
        );
      });
    });
  }

  updateAdvertisement(update: Partial<BLEAdvertisement>): void {
    if (this.advertisement) {
      this.advertisement = { ...this.advertisement, ...update };
      if (this.bleno?.state === "poweredOn") {
        this.doStartAdvertising();
      }
    }
  }

  currentAdvertisement(): BLEAdvertisement | null {
    return this.advertisement ?? null;
  }

  /** Set of peripheral IDs we've already read identity from — skip reconnecting. */
  private identifiedPeripherals = new Set<string>();

  private handleDiscovery(peripheral: any): void {
    const peripheralId = peripheral.id ?? peripheral.uuid;
    if (!peripheralId) return;

    // Always update the stored peripheral reference (noble gives fresh objects)
    // and update lastSeen/rssi for already-identified peers
    if (this.identifiedPeripherals.has(peripheralId)) {
      for (const [agentId, p] of this.peripheralsByAgentId) {
        if ((p.id ?? p.uuid) === peripheralId) {
          // Update to the latest peripheral reference from noble
          this.peripheralsByAgentId.set(agentId, peripheral);
          const existing = this.peers.get(agentId);
          if (existing) {
            existing.lastSeenMs = Date.now();
            existing.rssi = peripheral.rssi ?? -60;
          }
          break;
        }
      }
      return;
    }

    // Skip if already in the process of connecting for identity read
    if (this.connectedPeripherals.has(peripheralId)) return;

    // Connect to read identity characteristic (one-time)
    this.connectedPeripherals.set(peripheralId, peripheral);

    peripheral.connect((err: Error | null) => {
      if (err) {
        this.connectedPeripherals.delete(peripheralId);
        return;
      }

      const serviceUUIDs = [BLE_SERVICE_UUID.replace(/-/g, "")];
      const charUUIDs = [
        BLE_CHAR_PEER_IDENTITY.replace(/-/g, ""),
        BLE_CHAR_CAPABILITIES.replace(/-/g, ""),
      ];

      peripheral.discoverSomeServicesAndCharacteristics(
        serviceUUIDs,
        charUUIDs,
        (discErr: Error | null, _services: any[], characteristics: any[]) => {
          if (discErr || !characteristics?.length) {
            peripheral.disconnect();
            this.connectedPeripherals.delete(peripheralId);
            return;
          }

          const identityChar = characteristics.find(
            (c: any) =>
              c.uuid === BLE_CHAR_PEER_IDENTITY.replace(/-/g, "").toLowerCase()
          );

          if (identityChar) {
            identityChar.read(
              (readErr: Error | null, data: Buffer | null) => {
                if (!readErr && data) {
                  try {
                    const parsed = JSON.parse(data.toString("utf8"));
                    const agentId = parsed.agentId ?? peripheralId;
                    const peer: BLEPeerEntry = {
                      agentId,
                      meshTokenHash: parsed.meshTokenHash ?? "",
                      accountId: agentId,
                      model: parsed.model ?? "",
                      modelParamSize: parsed.modelParamSize ?? 0,
                      memoryMB: 0,
                      batteryPct: 0,
                      currentLoad: 0,
                      deviceType: "phone",
                      rssi: peripheral.rssi ?? -60,
                      lastSeenMs: Date.now(),
                    };
                    this.peers.set(agentId, peer);
                    // Store peripheral ref for task routing
                    this.peripheralsByAgentId.set(agentId, peripheral);
                    // Mark as identified so we never reconnect for identity again
                    this.identifiedPeripherals.add(peripheralId);
                    console.log(
                      `[BLE] discovered peer: ${peer.agentId} (model: ${peer.model}, rssi: ${peer.rssi})`
                    );
                  } catch {
                    // Malformed identity data
                  }
                }
                peripheral.disconnect();
                this.connectedPeripherals.delete(peripheralId);
              }
            );
          } else {
            peripheral.disconnect();
            this.connectedPeripherals.delete(peripheralId);
          }
        }
      );
    });
  }
}
