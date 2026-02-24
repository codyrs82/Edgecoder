import { networkInterfaces } from "node:os";

/** Return the first non-internal IPv4 address (typically the WiFi/LAN IP). */
export function getLocalIpAddress(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}
