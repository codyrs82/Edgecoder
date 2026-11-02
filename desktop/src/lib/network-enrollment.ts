import { coordinatorUrl, portalUrl } from "./endpoints";
import { loadSessionToken } from "./api";

/**
 * Join this machine to the EdgeCoder network once its user is signed in: enroll it with the portal
 * (POST /nodes/enroll) and hand the registration token to the app, which restarts the bundled agent
 * so its worker registers with the network coordinator. Earnings go to the signed-in account.
 */
export type EnrollmentStatus =
  | { state: "enrolled"; nodeId: string; coordinatorUrl: string }
  | { state: "needs_verified_email" }
  | { state: "error"; message: string }
  | { state: "unavailable" };

export interface EnrollmentDeps {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  fetch: typeof fetch;
  portal: string;
  coordinator: string;
  sessionToken: string | null;
}

async function defaultDeps(): Promise<EnrollmentDeps | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { invoke, fetch: (...a) => fetch(...a), portal: portalUrl(), coordinator: coordinatorUrl(), sessionToken: loadSessionToken() };
  } catch {
    return null; // Not running inside Tauri (dev / web build).
  }
}

export async function ensureNetworkEnrollment(user: { emailVerified: boolean }, deps?: EnrollmentDeps): Promise<EnrollmentStatus> {
  const d = deps ?? (await defaultDeps());
  if (!d) return { state: "unavailable" };
  try {
    const existing = await d.invoke<{ nodeId: string; coordinatorUrl: string } | null>("get_network_enrollment");
    if (existing) return { state: "enrolled", ...existing };
    // The portal only approves agents of verified accounts; enrolling earlier would leave a pending node.
    if (!user.emailVerified) return { state: "needs_verified_email" };
    const nodeId = await d.invoke<string>("get_network_node_id");
    const portal = d.portal.replace(/\/+$/, "");
    const res = await d.fetch(`${portal}/nodes/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(d.sessionToken ? { Authorization: `Bearer ${d.sessionToken}` } : {}) },
      credentials: "include",
      body: JSON.stringify({ nodeId, nodeKind: "agent" }),
    });
    const body = (await res.json().catch(() => ({}))) as { registrationToken?: string; nodeId?: string; error?: string };
    if (!res.ok || !body.registrationToken) return { state: "error", message: body.error ?? `enroll_failed_${res.status}` };
    const saved = await d.invoke<{ nodeId: string; coordinatorUrl: string }>("save_network_enrollment", {
      enrollment: { nodeId: body.nodeId ?? nodeId, registrationToken: body.registrationToken, coordinatorUrl: d.coordinator, portalUrl: portal },
    });
    return { state: "enrolled", ...saved };
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
