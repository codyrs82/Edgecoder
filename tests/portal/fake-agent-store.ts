/** In-memory stand-in for the PortalStore methods the agent and hosted routes use. */
export function fakeStore() {
  const keys = new Map<string, { userId: string; revoked: boolean }>();
  const challenges = new Map<string, { keyType: string; publicKey: string; expiresAtMs: number }>();
  const identities = new Map<string, string>();
  const users = new Map<string, { kind: string; email: string; displayName?: string }>();
  return {
    keys,
    users,
    challenges,
    userForApiKeyHash: async (h: string) => (keys.get(h) && !keys.get(h)!.revoked ? keys.get(h)!.userId : null),
    createApiKey: async (k: { keyHash: string; userId: string }) => void keys.set(k.keyHash, { userId: k.userId, revoked: false }),
    countApiKeys: async () => keys.size,
    listApiKeys: async () => [],
    revokeApiKey: async () => true,
    setDisplayName: async () => undefined,
    revokeAllApiKeys: async (userId: string) => {
      let n = 0;
      for (const k of keys.values()) if (k.userId === userId && !k.revoked) (k.revoked = true), n++;
      return n;
    },
    createAgentChallenge: async (c: { nonceHash: string; keyType: string; publicKey: string; expiresAtMs: number }) => void challenges.set(c.nonceHash, c),
    consumeAgentChallenge: async (h: string) => {
      const c = challenges.get(h);
      challenges.delete(h);
      return c ?? null;
    },
    userForAgentKey: async (t: string, p: string) => identities.get(`${t}:${p}`) ?? null,
    createAgentAccount: async (a: { userId: string; keyType: string; publicKey: string; displayName?: string }) => {
      const id = `${a.keyType}:${a.publicKey}`;
      if (identities.has(id)) return identities.get(id)!;
      identities.set(id, a.userId);
      users.set(a.userId, { kind: "agent", email: `agent-${a.userId}@agents.invalid`, displayName: a.displayName });
      return a.userId;
    },
  };
}

