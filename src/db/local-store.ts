import { SQLiteStore } from "./sqlite-store.js";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const dataDir = `${homedir()}/.edgecoder`;
mkdirSync(dataDir, { recursive: true });

/** Worker-local SQLite store for task history, BLE peers, heartbeats, and config. */
export const localStore = new SQLiteStore(`${dataDir}/worker.db`);
