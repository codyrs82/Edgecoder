import type { InviteRecord, InviteStore } from "../../src/portal/invites.js";

/** In-memory InviteStore with the same rules as PortalStore's SQL (for route tests). */
export function memoryInviteStore() {
  const codes = new Map<string, InviteRecord & { codeHash: string }>();
  const redemptions: Array<{ codeId: string; userId: string }> = [];
  const live = (c: InviteRecord, now: number) => c.revokedAtMs === null && (c.expiresAtMs === null || c.expiresAtMs > now) && c.uses < c.maxUses;
  const byHash = (h: string) => [...codes.values()].find((c) => c.codeHash === h);
  const store: InviteStore = {
    async createInviteCode(i) {
      codes.set(i.codeId, { ...i, uses: 0, revokedAtMs: null });
    },
    async listInviteCodes(limit) {
      return [...codes.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit).map(({ codeHash: _h, ...r }) => ({ ...r }));
    },
    async revokeInviteCode(codeId, now) {
      const c = codes.get(codeId);
      if (!c || c.revokedAtMs !== null) return false;
      c.revokedAtMs = now;
      return true;
    },
    async inviteCodeRedeemable(h, now) {
      const c = byHash(h);
      return Boolean(c && live(c, now));
    },
    async redeemInviteCode(h, userId, now) {
      const c = byHash(h);
      if (!c || !live(c, now)) return false;
      c.uses += 1;
      redemptions.push({ codeId: c.codeId, userId });
      return true;
    }
  };
  return { store, codes, redemptions };
}
