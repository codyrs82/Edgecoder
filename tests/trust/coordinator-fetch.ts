import type { createPeerKeys } from "../../src/mesh/peer.js";
import type { IdentityFetch } from "../../src/trust/pinned-keys.js";
import { answerIdentityChallenge } from "../../src/trust/identity-challenge.js";

type Keys = ReturnType<typeof createPeerKeys>;

/**
 * A fake coordinator for the agent's trust check: answers POST /identity/challenge with a real
 * signature (or not, per options) and GET /identity with its public identity.
 */
export function coordinatorFetch(
  keys: Keys,
  opts: {
    /** false: an older coordinator without the challenge route (404). */
    challenge?: boolean;
    /** Sign with these keys instead (an impostor that only knows the public identity). */
    signWith?: Keys;
    /** Replace the challenge answer body (e.g. a replayed one). */
    challengeBody?: unknown;
    /** Replace the GET /identity body. */
    identityBody?: unknown;
    status?: number;
  } = {}
): IdentityFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const status = opts.status ?? 200;
    if (url.endsWith("/identity/challenge")) {
      if (opts.challenge === false) return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
      const signer = opts.signWith ?? keys;
      const answer =
        opts.challengeBody ??
        { ...answerIdentityChallenge(JSON.parse(init?.body ?? "{}"), { peerId: keys.peerId, publicKeyPem: keys.publicKeyPem, privateKeyPem: signer.privateKeyPem, publicUrl: "https://coord.example" }), publicKeyPem: keys.publicKeyPem };
      return { ok: status < 300, status, json: async () => answer };
    }
    return { ok: status < 300, status, json: async () => opts.identityBody ?? { peerId: keys.peerId, publicKeyPem: keys.publicKeyPem } };
  }) as IdentityFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
