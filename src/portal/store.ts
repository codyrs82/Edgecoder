// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { HostApprovalRecord, HostApprovalSource, HostKind, HostRequestRecord, HostRequestStatus, ComputeHardware } from "./host-requests.js";
import type { SecurityResearchEntitlement } from "./security-research.js";
import type { Pool } from "pg";
import { createPgPool } from "../db/pool.js";
import { migrateCloudBots } from "./cloud-bots/store.js";
import { migrateCoordinatorRegistry } from "./coordinator-registry-store.js";
import { migrateCoordinatorCredentials } from "./coordinator-credentials.js";
import { RATE_LIMIT_SCHEMA_SQL } from "./rate-limit-store.js";
import { compactReplyUsage, type ReplyUsage } from "./reply-usage.js";
import { ChatCipher, messageAad, titleAad } from "./chat-crypto.js";
import { randomUUID } from "node:crypto";
import {
  USER_DELETE_PLAN,
  PENDING_BOTS_KEY_PREFIX,
  deleteStatement,
  emailHash,
  maskEmail,
  type AdminAuditEntry,
  type AdminUserSummary,
  type DeleteAccountInput,
  type DeleteAccountResult
} from "./account-admin.js";

export type PortalUser = {
  userId: string;
  email: string;
  emailVerified: boolean;
  uiTheme: "warm" | "midnight" | "emerald";
  role: "user" | "admin";
  passwordHash?: string;
  displayName?: string;
  createdAtMs: number;
  verifiedAtMs?: number;
};

/** Which legal document versions an account accepted, and when (null = not accepted). */
export type LegalAcceptance = {
  termsVersion: string | null;
  termsAcceptedAtMs: number | null;
  hostAgreementVersion: string | null;
  hostAgreementAcceptedAtMs: number | null;
};

export type NodeEnrollment = {
  nodeId: string;
  deviceId?: string;
  nodeKind: "agent" | "coordinator";
  ownerUserId: string;
  ownerEmail: string;
  registrationTokenHash: string;
  emailVerified: boolean;
  nodeApproved: boolean;
  active: boolean;
  lastSeenMs?: number;
  lastIp?: string;
  lastCountryCode?: string;
  lastVpnDetected?: boolean;
  dnsHostname?: string;
  dnsStatus?: "pending" | "active" | "nat" | "error" | "stale";
  dnsIp?: string;
  dnsLastUpdatedMs?: number;
  /** Enrolled node id of the coordinator whose coordinator-token validate call last saw this node (scopes /internal/nodes/lookup). */
  lastValidatedByCoordinator?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PayoutDestinationRecord = {
  userId: string;
  accountId: string;
  kind: string;
  destination: string;
  network: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PayoutDestinationChallenge = {
  challengeId: string;
  userId: string;
  kind: string;
  destination: string;
  emailCodeHash: string;
  expiresAtMs: number;
};

/** Emailed one-time code for one withdrawal, bound to the exact invoice (by hash) and amount. */
export type WithdrawChallenge = {
  challengeId: string;
  userId: string;
  bolt11Hash: string;
  amountMsat: number;
  emailCodeHash: string;
  expiresAtMs: number;
};

export type PortalConversation = {
  conversationId: string;
  userId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PortalMessage = {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  tokensUsed: number;
  creditsSpent: number;
  createdAtMs: number;
  /** The reply footer's usage (where it ran, model, tokens, timings, per-call cSats); absent on older messages. */
  usageMeta?: ReplyUsage;
};

/** A message shared for improving EdgeCoder: only from users who opted in (listSharedChatMessages). */
export type SharedChatMessage = {
  userId: string;
  conversationId: string;
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAtMs: number;
};

export type SharedChatCursor = { createdAtMs: number; messageId: string };

export type OauthPendingLink = { userId: string; provider: string; providerSubject: string; tenantId?: string; email: string; browserHash?: string };
function pendingLinkFromRow(row: Record<string, unknown>): OauthPendingLink {
  return {
    userId: String(row.user_id),
    provider: String(row.provider),
    providerSubject: String(row.provider_subject),
    ...(row.tenant_id ? { tenantId: String(row.tenant_id) } : {}),
    email: String(row.email),
    ...(row.browser_hash ? { browserHash: String(row.browser_hash) } : {})
  };
}

/** Agent accounts have no email; the NOT NULL UNIQUE column holds `agent-<userId>@agents.invalid` (RFC 2606, never delivered). */
export const AGENT_EMAIL_DOMAIN = "agents.invalid";
export const isAgentPlaceholderEmail = (email: string | undefined | null) => (email ?? "").toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ui_theme TEXT NOT NULL DEFAULT 'warm',
  password_hash TEXT,
  display_name TEXT,
  created_at_ms BIGINT NOT NULL,
  verified_at_ms BIGINT
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_email_verifications (
  token_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_oauth_links (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email_snapshot TEXT,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS portal_oauth_states (
  state_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_github_tokens (
  user_id TEXT PRIMARY KEY REFERENCES portal_users(user_id),
  access_token TEXT NOT NULL,
  github_login TEXT,
  github_avatar_url TEXT,
  scopes TEXT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_node_enrollments (
  node_id TEXT PRIMARY KEY,
  device_id TEXT,
  node_kind TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  registration_token_hash TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  node_approved BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_ms BIGINT,
  last_ip TEXT,
  last_country_code TEXT,
  last_vpn_detected BOOLEAN,
  dns_hostname TEXT,
  dns_status TEXT,
  dns_ip TEXT,
  dns_last_updated_ms BIGINT,
  last_validated_by_coordinator TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_wallet_onboarding (
  user_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  seed_phrase_hash TEXT NOT NULL,
  encrypted_private_key_ref TEXT NOT NULL,
  derived_address TEXT,
  created_at_ms BIGINT NOT NULL,
  acknowledged_at_ms BIGINT
);

CREATE TABLE IF NOT EXISTS portal_wallet_send_mfa_challenges (
  challenge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  amount_sats BIGINT NOT NULL,
  note TEXT,
  email_code_hash TEXT NOT NULL,
  passkey_challenge TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_wallet_send_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  amount_sats BIGINT NOT NULL,
  note TEXT,
  status TEXT NOT NULL,
  mfa_challenge_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  webauthn_user_id TEXT NOT NULL,
  public_key_b64url TEXT NOT NULL,
  counter BIGINT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  transports_json JSONB,
  created_at_ms BIGINT NOT NULL,
  last_used_at_ms BIGINT
);

CREATE TABLE IF NOT EXISTS portal_passkey_challenges (
  challenge_id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT,
  challenge TEXT NOT NULL,
  flow_type TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_conversations (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES portal_conversations(conversation_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  credits_spent INTEGER NOT NULL DEFAULT 0,
  created_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_messages_conv ON portal_messages(conversation_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_portal_conversations_user ON portal_conversations(user_id, updated_at_ms DESC);
`;

export class PortalStore {
  /** Also handed to the shared rate-limit store (security.ts) before routes are declared. */
  /** chatCipher seals chat content and titles at rest (src/portal/chat-crypto.ts, PORTAL_CHAT_KEY). */
  constructor(readonly pool: Pool, private readonly chatCipher: ChatCipher = ChatCipher.fromEnv()) {}

  static fromEnv(): PortalStore | null {
    const url = process.env.PORTAL_DATABASE_URL;
    if (!url) return null;
    return new PortalStore(createPgPool(url, "portal"));
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(RATE_LIMIT_SCHEMA_SQL);
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS ui_theme TEXT NOT NULL DEFAULT 'warm'`);
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`);
    await this.pool.query(`ALTER TABLE portal_node_enrollments ADD COLUMN IF NOT EXISTS device_id TEXT`);
    // Native-app OAuth hand-off lives in Postgres: Cloudflare spreads one sign-in across portal instances.
    await this.pool.query(`ALTER TABLE portal_oauth_states ADD COLUMN IF NOT EXISTS native_redirect TEXT`);
    // Connect-from-Settings flows record the signed-in user; Microsoft links record the tenant.
    await this.pool.query(`ALTER TABLE portal_oauth_states ADD COLUMN IF NOT EXISTS link_user_id TEXT`);
    await this.pool.query(`ALTER TABLE portal_oauth_links ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_mobile_oauth_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at_ms BIGINT NOT NULL)`
    );
    // A native app's sign-in can be bound to the app that started it (S256 of an app-held verifier).
    await this.pool.query(`ALTER TABLE portal_oauth_states ADD COLUMN IF NOT EXISTS app_challenge TEXT`);
    await this.pool.query(`ALTER TABLE portal_mobile_oauth_tokens ADD COLUMN IF NOT EXISTS app_challenge TEXT`);
    // API keys for the hosted model endpoint (/v1): only a hash is kept.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_api_keys (
         key_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
         created_at_ms BIGINT NOT NULL, last_used_ms BIGINT, revoked_at_ms BIGINT)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_api_keys_user_idx ON portal_api_keys (user_id)`);
    // AI agents sign up with a public key instead of an email (routes/agents.ts).
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS account_kind TEXT NOT NULL DEFAULT 'person'`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_agent_identities (
         key_type TEXT NOT NULL, public_key TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE, created_at_ms BIGINT NOT NULL,
         PRIMARY KEY (key_type, public_key))`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_agent_challenges (
         nonce_hash TEXT PRIMARY KEY, key_type TEXT NOT NULL, public_key TEXT NOT NULL, expires_at_ms BIGINT NOT NULL)`
    );
    // Password reset links: only the SHA-256 of the token is kept; single use, short expiry.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_password_resets (
         token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at_ms BIGINT NOT NULL,
         used_at_ms BIGINT, created_at_ms BIGINT NOT NULL)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_password_resets_user_idx ON portal_password_resets (user_id)`);
    // Expired sign-in rows are deleted as new ones are written (pruneExpired below).
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_sessions_expires_idx ON portal_sessions (expires_at_ms)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_oauth_states_expires_idx ON portal_oauth_states (expires_at_ms)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_passkey_challenges_expires_idx ON portal_passkey_challenges (expires_at_ms)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_email_verifications_expires_idx ON portal_email_verifications (expires_at_ms)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_email_verifications_user_idx ON portal_email_verifications (user_id, created_at_ms)`);
    // Connecting a sign-in provider by email confirmation (oauth-pending-link.ts): only the token's
    // SHA-256 is kept; single use; bound to provider + subject + email (+ the starting browser).
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_oauth_pending_links (
         token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL,
         provider_subject TEXT NOT NULL, tenant_id TEXT, email TEXT NOT NULL, browser_hash TEXT, ip_hash TEXT,
         expires_at_ms BIGINT NOT NULL, consumed_at_ms BIGINT, created_at_ms BIGINT NOT NULL)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_oauth_pending_links_user_idx ON portal_oauth_pending_links (user_id, created_at_ms)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_oauth_pending_links_ip_idx ON portal_oauth_pending_links (ip_hash, created_at_ms)`);
    await this.pool.query(`ALTER TABLE portal_oauth_states ADD COLUMN IF NOT EXISTS pending_link_hash TEXT`);
    await this.pool.query(
      `UPDATE portal_node_enrollments
       SET device_id = regexp_replace(lower(node_id), '^(ios-|iphone-)', '')
       WHERE device_id IS NULL
         AND node_id ~* '^(ios-|iphone-)'`
    );
    await this.pool.query(`ALTER TABLE portal_node_enrollments ADD COLUMN IF NOT EXISTS dns_hostname TEXT`);
    await this.pool.query(`ALTER TABLE portal_node_enrollments ADD COLUMN IF NOT EXISTS dns_status TEXT`);
    await this.pool.query(`ALTER TABLE portal_node_enrollments ADD COLUMN IF NOT EXISTS dns_ip TEXT`);
    await this.pool.query(`ALTER TABLE portal_node_enrollments ADD COLUMN IF NOT EXISTS dns_last_updated_ms BIGINT`);
    // The coordinator (by its enrolled node id) whose coordinator-token call last validated this node;
    // NULL when the last validation came with the platform service token. Scopes /internal/nodes/lookup.
    await this.pool.query(`ALTER TABLE portal_node_enrollments ADD COLUMN IF NOT EXISTS last_validated_by_coordinator TEXT`);
    // Owner-approved 2026-11-17: the web chat reply footer survives a reload (nullable; old rows show cost only).
    await this.pool.query(`ALTER TABLE portal_messages ADD COLUMN IF NOT EXISTS usage_meta JSONB`);
    // Consent to share chat context to improve EdgeCoder (opt-in, default off; chat stays encrypted either way).
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS share_chat_for_improvement BOOLEAN NOT NULL DEFAULT FALSE`);
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS share_chat_updated_at_ms BIGINT`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_node_enrollments_token_idx ON portal_node_enrollments (registration_token_hash)`);
    await this.migrateInviteCodes();
    await this.migratePayoutDestinations();
    await this.migrateHostRequests();
    await this.migrateAccountAdmin();
    await this.migrateLegalAcceptance();
    await this.migrateSecurityResearch();
    await this.migrateOnboarding();
    // Cloud bots (src/portal/cloud-bots/store.ts): bots, their conversations and their runs. New tables, owner approval needed.
    await migrateCloudBots(this.pool);
    // The signed coordinator registry's members and append-only audit chain (coordinator-registry-store.ts).
    await migrateCoordinatorRegistry(this.pool);
    // Per-coordinator portal credentials and their single-use nonces (coordinator-credentials.ts). Owner-approved 2026-11-26.
    await migrateCoordinatorCredentials(this.pool);
  }

  /**
   * Getting started (src/common/onboarding.ts): one row per account with the wizard's progress,
   * stored as the normalised JSON state.
   */
  async migrateOnboarding(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_onboarding (
         user_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at_ms BIGINT NOT NULL)`
    );
  }

  async getOnboardingState(userId: string): Promise<unknown | null> {
    const r = await this.pool.query(`SELECT state_json FROM portal_onboarding WHERE user_id = $1`, [userId]);
    const raw = r.rows[0]?.state_json;
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * New bots from the web that no Mac has made yet (routes/bots.ts PendingBot). Kept in
   * portal_onboarding under the key PENDING_BOTS_KEY_PREFIX + userId (no new table or migration);
   * the onboarding code reads only rows keyed by a bare user id, and an account delete removes this
   * row too (USER_DELETE_PLAN). The row's updated_at_ms is its version: a save names the version it
   * read and is refused when another portal machine saved since.
   */
  async getPendingBots(userId: string): Promise<{ list: any[]; version: number }> {
    const r = await this.pool.query(`SELECT state_json, updated_at_ms FROM portal_onboarding WHERE user_id = $1`, [PENDING_BOTS_KEY_PREFIX + userId]);
    const row = r.rows[0];
    if (!row) return { list: [], version: 0 };
    try {
      const parsed = JSON.parse(String(row.state_json));
      return { list: Array.isArray(parsed?.pending) ? parsed.pending : [], version: Number(row.updated_at_ms) };
    } catch {
      return { list: [], version: Number(row.updated_at_ms) };
    }
  }

  async savePendingBots(userId: string, list: unknown[], version: number, nowMs: number): Promise<boolean> {
    const key = PENDING_BOTS_KEY_PREFIX + userId;
    if (!list.length) {
      const r = await this.pool.query(`DELETE FROM portal_onboarding WHERE user_id = $1 AND updated_at_ms = $2`, [key, version]);
      return (r.rowCount ?? 0) > 0 || version === 0;
    }
    const next = Math.max(nowMs, version + 1);
    const json = JSON.stringify({ v: 1, pending: list });
    if (version === 0) {
      const r = await this.pool.query(`INSERT INTO portal_onboarding (user_id, state_json, updated_at_ms) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`, [key, json, next]);
      return (r.rowCount ?? 0) > 0;
    }
    const r = await this.pool.query(`UPDATE portal_onboarding SET state_json = $2, updated_at_ms = $3 WHERE user_id = $1 AND updated_at_ms = $4`, [key, json, next, version]);
    return (r.rowCount ?? 0) > 0;
  }

  async listPendingBotOwners(limit: number): Promise<string[]> {
    const r = await this.pool.query(`SELECT user_id FROM portal_onboarding WHERE user_id LIKE $1 ORDER BY updated_at_ms LIMIT $2`, [`${PENDING_BOTS_KEY_PREFIX}%`, limit]);
    return r.rows.map((row) => String(row.user_id).slice(PENDING_BOTS_KEY_PREFIX.length)).filter(Boolean);
  }

  async saveOnboardingState(userId: string, state: unknown, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_onboarding (user_id, state_json, updated_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at_ms = EXCLUDED.updated_at_ms`,
      [userId, JSON.stringify(state), nowMs]
    );
  }

  /**
   * Keyed JSON rows in portal_onboarding (no schema change): account security state
   * (src/portal/account-security.ts) lives under `acctsec:<userId>`. updated_at_ms is the row's
   * version for an optimistic compare-and-set, so two concurrent writers cannot both win.
   */
  async getKeyedRow(key: string): Promise<{ state: unknown; version: number } | null> {
    const r = await this.pool.query(`SELECT state_json, updated_at_ms FROM portal_onboarding WHERE user_id = $1`, [key]);
    const row = r.rows[0];
    if (!row || typeof row.state_json !== "string") return null;
    try {
      return { state: JSON.parse(row.state_json), version: Number(row.updated_at_ms) };
    } catch {
      return null;
    }
  }

  /** Writes the row only if its version is still `expectedVersion` (null: only if absent). Returns the new version, or null on a conflict. */
  async compareAndSetKeyedRow(key: string, expectedVersion: number | null, state: unknown, nowMs: number): Promise<number | null> {
    const version = expectedVersion === null ? nowMs : Math.max(nowMs, expectedVersion + 1);
    const r =
      expectedVersion === null
        ? await this.pool.query(
            `INSERT INTO portal_onboarding (user_id, state_json, updated_at_ms) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING RETURNING updated_at_ms`,
            [key, JSON.stringify(state), version]
          )
        : await this.pool.query(
            `UPDATE portal_onboarding SET state_json = $2, updated_at_ms = $3 WHERE user_id = $1 AND updated_at_ms = $4 RETURNING updated_at_ms`,
            [key, JSON.stringify(state), version, expectedVersion]
          );
    return r.rows[0] ? Number(r.rows[0].updated_at_ms) : null;
  }

  /** Keyed rows whose key starts with `prefix` (the sweeps that activate payout destinations and list locked accounts). */
  async listKeyedRows(prefix: string, limit = 5000): Promise<Array<{ key: string; state: unknown; version: number }>> {
    const r = await this.pool.query(
      `SELECT user_id, state_json, updated_at_ms FROM portal_onboarding WHERE user_id LIKE $1 ORDER BY updated_at_ms DESC LIMIT $2`,
      [`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit]
    );
    const out: Array<{ key: string; state: unknown; version: number }> = [];
    for (const row of r.rows) {
      try {
        out.push({ key: row.user_id, state: JSON.parse(row.state_json), version: Number(row.updated_at_ms) });
      } catch {
        // skip a row that is not JSON
      }
    }
    return out;
  }

  /** Whether a host request was sent from this email (any status). */
  async hasHostRequestFrom(email: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM portal_host_requests WHERE lower(email) = lower($1) LIMIT 1`, [email]);
    return r.rows.length > 0;
  }

  /**
   * Hosting by request (src/portal/host-requests.ts). portal_host_approvals is keyed by email.
   * The first time it is created, the owners of every node approved at that moment are
   * grandfathered into it, so existing hosts keep taking network work when the gate comes on.
   * Returns how many emails were grandfathered (0 on every later start).
   */
  async migrateHostRequests(nowMs = Date.now()): Promise<number> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_host_requests (
         request_id TEXT PRIMARY KEY, created_at_ms BIGINT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
         organisation TEXT, host_kinds TEXT NOT NULL, compute_hardware TEXT, hardware_details TEXT, region TEXT, message TEXT,
         status TEXT NOT NULL DEFAULT 'new', notes TEXT, updated_at_ms BIGINT NOT NULL, updated_by TEXT, invite_code_id TEXT, ip_hash TEXT)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_host_requests_email_idx ON portal_host_requests (email, created_at_ms)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_host_requests_ip_idx ON portal_host_requests (ip_hash, created_at_ms)`);
    const existed = await this.pool.query(`SELECT to_regclass('portal_host_approvals') IS NOT NULL AS present`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_host_approvals (
         email TEXT PRIMARY KEY, approved_at_ms BIGINT NOT NULL, approved_by TEXT NOT NULL, source TEXT NOT NULL, note TEXT)`
    );
    if (existed.rows[0]?.present) return 0;
    const r = await this.pool.query(
      `INSERT INTO portal_host_approvals (email, approved_at_ms, approved_by, source, note)
       SELECT DISTINCT lower(u.email), $1::bigint, 'migration', 'grandfathered', 'Approved node before host approval was required'
       FROM portal_node_enrollments n JOIN portal_users u ON u.user_id = n.owner_user_id
       WHERE n.node_approved = TRUE
       ON CONFLICT (email) DO NOTHING`,
      [nowMs]
    );
    return r.rowCount ?? 0;
  }

  // ── Hosting by request (src/portal/host-requests.ts) ──

  async createHostRequest(r: HostRequestRecord & { ipHash: string | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_host_requests (request_id, created_at_ms, name, email, organisation, host_kinds, compute_hardware, hardware_details, region, message, status, notes, updated_at_ms, updated_by, invite_code_id, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [r.requestId, r.createdAtMs, r.name, r.email, r.organisation, r.hostKinds.join(","), r.computeHardware, r.hardwareDetails, r.region, r.message, r.status, r.notes, r.updatedAtMs, r.updatedBy, null, r.ipHash]
    );
  }

  async countHostRequestsSince(input: { email: string; ipHash: string | null; sinceMs: number }): Promise<{ byEmail: number; byIp: number }> {
    const r = await this.pool.query(
      `SELECT count(*) FILTER (WHERE email = $1) AS by_email, count(*) FILTER (WHERE $2::text IS NOT NULL AND ip_hash = $2) AS by_ip
       FROM portal_host_requests WHERE created_at_ms > $3 AND (email = $1 OR ip_hash = $2)`,
      [input.email, input.ipHash, input.sinceMs]
    );
    return { byEmail: Number(r.rows[0]?.by_email ?? 0), byIp: Number(r.rows[0]?.by_ip ?? 0) };
  }

  private hostRequestFromRow(row: Record<string, any>): HostRequestRecord {
    return {
      requestId: row.request_id,
      createdAtMs: Number(row.created_at_ms),
      name: row.name,
      email: row.email,
      organisation: row.organisation ?? null,
      hostKinds: String(row.host_kinds ?? "").split(",").filter(Boolean) as HostKind[],
      computeHardware: (row.compute_hardware ?? null) as ComputeHardware | null,
      hardwareDetails: row.hardware_details ?? null,
      region: row.region ?? null,
      message: row.message ?? null,
      status: row.status as HostRequestStatus,
      notes: row.notes ?? null,
      updatedAtMs: Number(row.updated_at_ms),
      updatedBy: row.updated_by ?? null
    };
  }

  async listHostRequests(limit: number): Promise<HostRequestRecord[]> {
    const r = await this.pool.query(`SELECT * FROM portal_host_requests ORDER BY created_at_ms DESC LIMIT $1`, [limit]);
    return r.rows.map((row) => this.hostRequestFromRow(row));
  }

  async getHostRequest(requestId: string): Promise<HostRequestRecord | null> {
    const r = await this.pool.query(`SELECT * FROM portal_host_requests WHERE request_id = $1`, [requestId]);
    return r.rows[0] ? this.hostRequestFromRow(r.rows[0]) : null;
  }

  async updateHostRequest(requestId: string, patch: { status?: HostRequestStatus; notes?: string | null; updatedAtMs: number; updatedBy: string }): Promise<HostRequestRecord | null> {
    const r = await this.pool.query(
      `UPDATE portal_host_requests SET
         status = COALESCE($2, status),
         notes = CASE WHEN $3::boolean THEN $4 ELSE notes END,
         updated_at_ms = $5, updated_by = $6
       WHERE request_id = $1 RETURNING *`,
      [requestId, patch.status ?? null, patch.notes !== undefined, patch.notes ?? null, patch.updatedAtMs, patch.updatedBy]
    );
    return r.rows[0] ? this.hostRequestFromRow(r.rows[0]) : null;
  }

  private hostApprovalFromRow(row: Record<string, any>): HostApprovalRecord {
    return { email: row.email, approvedAtMs: Number(row.approved_at_ms), approvedBy: row.approved_by, source: row.source as HostApprovalSource, note: row.note ?? null };
  }

  async getHostApproval(email: string): Promise<HostApprovalRecord | null> {
    const r = await this.pool.query(`SELECT * FROM portal_host_approvals WHERE email = lower($1)`, [email]);
    return r.rows[0] ? this.hostApprovalFromRow(r.rows[0]) : null;
  }

  async listHostApprovals(limit: number): Promise<HostApprovalRecord[]> {
    const r = await this.pool.query(`SELECT * FROM portal_host_approvals ORDER BY approved_at_ms DESC LIMIT $1`, [limit]);
    return r.rows.map((row) => this.hostApprovalFromRow(row));
  }

  async approveHost(h: HostApprovalRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_host_approvals (email, approved_at_ms, approved_by, source, note) VALUES (lower($1),$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET approved_at_ms = EXCLUDED.approved_at_ms, approved_by = EXCLUDED.approved_by, source = EXCLUDED.source, note = EXCLUDED.note`,
      [h.email, h.approvedAtMs, h.approvedBy, h.source, h.note]
    );
  }

  async revokeHost(email: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM portal_host_approvals WHERE email = lower($1)`, [email]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Account deletion (src/portal/account-admin.ts): a tombstone per deleted account (the email's
   * hash, so the address can sign up again and old ids stay resolvable in audits) and the admin
   * audit log.
   */
  async migrateAccountAdmin(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_deleted_accounts (
         user_id TEXT PRIMARY KEY, email_hash TEXT NOT NULL, account_kind TEXT NOT NULL, deleted_at_ms BIGINT NOT NULL,
         deleted_by TEXT NOT NULL, reason TEXT)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_deleted_accounts_email_idx ON portal_deleted_accounts (email_hash)`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_admin_audit (
         audit_id TEXT PRIMARY KEY, at_ms BIGINT NOT NULL, actor_user_id TEXT NOT NULL, actor_email TEXT NOT NULL, action TEXT NOT NULL,
         target_user_id TEXT, target_email_hash TEXT, target_email_hint TEXT, detail JSONB NOT NULL)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_admin_audit_at_idx ON portal_admin_audit (at_ms DESC)`);
  }

  // ── Settings > Admin > Users (src/portal/account-admin.ts) ──

  private static readonly SUMMARY_SQL = `
    SELECT u.user_id, u.email, u.email_verified, u.role, u.account_kind, u.display_name, u.created_at_ms, u.verified_at_ms,
      EXISTS (SELECT 1 FROM portal_agent_identities a WHERE a.user_id = u.user_id) AS has_agent_key,
      (SELECT MAX(s.created_at_ms) FROM portal_sessions s WHERE s.user_id = u.user_id) AS last_session_ms,
      (SELECT COUNT(*) FROM portal_sessions s WHERE s.user_id = u.user_id AND s.expires_at_ms > $1) AS active_sessions,
      (SELECT COUNT(*) FROM portal_node_enrollments n WHERE n.owner_user_id = u.user_id) AS machines,
      (SELECT COUNT(*) FROM portal_node_enrollments n WHERE n.owner_user_id = u.user_id AND n.node_approved) AS approved_machines,
      (SELECT MAX(n.last_seen_ms) FROM portal_node_enrollments n WHERE n.owner_user_id = u.user_id) AS machine_seen_ms,
      (SELECT COUNT(*) FROM portal_api_keys k WHERE k.user_id = u.user_id AND k.revoked_at_ms IS NULL) AS api_keys,
      (SELECT MAX(GREATEST(k.created_at_ms, COALESCE(k.last_used_ms, 0))) FROM portal_api_keys k WHERE k.user_id = u.user_id) AS key_used_ms,
      (SELECT MAX(c.updated_at_ms) FROM portal_conversations c WHERE c.user_id = u.user_id) AS chat_ms,
      (SELECT MAX(COALESCE(p.last_used_at_ms, p.created_at_ms)) FROM portal_passkey_credentials p WHERE p.user_id = u.user_id) AS passkey_ms
    FROM portal_users u`;

  private mapSummaryRow(row: any): AdminUserSummary {
    const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
    const lastSessionMs = row.last_session_ms === null || row.last_session_ms === undefined ? null : Number(row.last_session_ms);
    return {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name ?? undefined,
      role: (row.role ?? "user") as "user" | "admin",
      emailVerified: Boolean(row.email_verified),
      accountKind: row.account_kind ?? "person",
      agentKey: Boolean(row.has_agent_key) || row.account_kind === "agent" || isAgentPlaceholderEmail(row.email),
      createdAtMs: Number(row.created_at_ms),
      lastSessionMs,
      activeSessions: n(row.active_sessions),
      machines: n(row.machines),
      approvedMachines: n(row.approved_machines),
      apiKeys: n(row.api_keys),
      lastActivityMs: Math.max(n(row.created_at_ms), n(row.verified_at_ms), n(lastSessionMs), n(row.machine_seen_ms), n(row.key_used_ms), n(row.chat_ms), n(row.passkey_ms))
    };
  }

  async listAdminUserSummaries(nowMs: number): Promise<AdminUserSummary[]> {
    const r = await this.pool.query(`${PortalStore.SUMMARY_SQL} ORDER BY u.created_at_ms`, [nowMs]);
    return r.rows.map((row) => this.mapSummaryRow(row));
  }

  async getAdminUserSummary(userId: string, nowMs: number): Promise<AdminUserSummary | null> {
    const r = await this.pool.query(`${PortalStore.SUMMARY_SQL} WHERE u.user_id = $2`, [nowMs, userId]);
    return r.rows[0] ? this.mapSummaryRow(r.rows[0]) : null;
  }

  /**
   * Deletes every portal row of an account (USER_DELETE_PLAN) in one transaction, then writes the
   * tombstone and the audit entry in the same transaction. Sessions and API keys are cut first,
   * outside it, so access ends even if the deletion fails. Refuses (rolls back) when the account is
   * gone, is an admin, or has a machine enrolled by the time the row lock is held.
   */
  async deleteUserAccount(input: DeleteAccountInput): Promise<DeleteAccountResult> {
    const counts: Record<string, number> = {};
    const add = (table: string, n: number | null | undefined) => (counts[table] = (counts[table] ?? 0) + Number(n ?? 0));
    const nowMs = Date.now();
    add("portal_sessions", (await this.pool.query(`DELETE FROM portal_sessions WHERE user_id = $1`, [input.userId])).rowCount);
    const revoked = await this.pool.query(`UPDATE portal_api_keys SET revoked_at_ms = $2 WHERE user_id = $1 AND revoked_at_ms IS NULL`, [input.userId, nowMs]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT email, role FROM portal_users WHERE user_id = $1 FOR UPDATE`, [input.userId]);
      const row = locked.rows[0];
      const refuse = async (error: string, detail: string): Promise<DeleteAccountResult> => {
        await client.query("ROLLBACK");
        return { deleted: false, error, detail };
      };
      if (!row) return await refuse("user_not_found", "The account no longer exists.");
      if (row.role === "admin") return await refuse("cannot_delete_admin", "The account is an admin.");
      const machines = await client.query(`SELECT COUNT(*) AS n FROM portal_node_enrollments WHERE owner_user_id = $1`, [input.userId]);
      if (Number(machines.rows[0]?.n ?? 0) > 0) return await refuse("has_machines", "A machine was enrolled meanwhile. Remove it first.");
      const email: string = row.email;
      for (const step of USER_DELETE_PLAN) {
        const { sql, params } = deleteStatement(step, input.userId, email);
        add(step.table, (await client.query(sql, params)).rowCount);
      }
      await client.query(
        `INSERT INTO portal_deleted_accounts (user_id, email_hash, account_kind, deleted_at_ms, deleted_by, reason) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id) DO NOTHING`,
        [input.userId, emailHash(email), input.accountKind, nowMs, input.actorUserId, input.reason || null]
      );
      const auditId = randomUUID();
      const detail = { counts, apiKeysRevoked: Number(revoked.rowCount ?? 0), force: input.force, reason: input.reason, balances: input.balances ?? null, bulk: Boolean(input.bulk), accountKind: input.accountKind };
      await client.query(
        `INSERT INTO portal_admin_audit (audit_id, at_ms, actor_user_id, actor_email, action, target_user_id, target_email_hash, target_email_hint, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [auditId, nowMs, input.actorUserId, input.actorEmail, "account.delete", input.userId, emailHash(email), maskEmail(email), JSON.stringify(detail)]
      );
      await client.query("COMMIT");
      return { deleted: true, counts, auditId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async appendAdminAudit(e: Omit<AdminAuditEntry, "auditId" | "atMs">): Promise<string> {
    const auditId = randomUUID();
    await this.pool.query(
      `INSERT INTO portal_admin_audit (audit_id, at_ms, actor_user_id, actor_email, action, target_user_id, target_email_hash, target_email_hint, detail)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)`,
      [auditId, Date.now(), e.actorUserId, e.actorEmail, e.action, e.targetUserId, e.targetEmailHint, JSON.stringify(e.detail)]
    );
    return auditId;
  }

  async listAdminAudit(limit: number): Promise<AdminAuditEntry[]> {
    const r = await this.pool.query(
      `SELECT audit_id, at_ms, actor_user_id, actor_email, action, target_user_id, target_email_hint, detail FROM portal_admin_audit ORDER BY at_ms DESC LIMIT $1`,
      [limit]
    );
    return r.rows.map((row) => ({
      auditId: row.audit_id,
      atMs: Number(row.at_ms),
      actorUserId: row.actor_user_id,
      actorEmail: row.actor_email,
      action: row.action,
      targetUserId: row.target_user_id ?? null,
      targetEmailHint: row.target_email_hint ?? null,
      detail: typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail ?? {}
    }));
  }

  /**
   * Legal acceptance (src/common/legal-notices.ts): the version of the Terms / Privacy Policy /
   * Acceptable Use Policy each account accepted at sign-up, and of the Host Agreement accepted on
   * the Install agent page, with the time. NULL = never accepted (accounts created before this).
   */
  async migrateLegalAcceptance(): Promise<void> {
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS terms_version TEXT`);
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS terms_accepted_at_ms BIGINT`);
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS host_agreement_version TEXT`);
    await this.pool.query(`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS host_agreement_accepted_at_ms BIGINT`);
    // Single sign-on sign-ups carry the accepted Terms version from /start to the callback.
    await this.pool.query(`ALTER TABLE portal_oauth_states ADD COLUMN IF NOT EXISTS terms_version TEXT`);
  }

  async recordTermsAcceptance(userId: string, version: string, atMs: number): Promise<void> {
    await this.pool.query(`UPDATE portal_users SET terms_version = $2, terms_accepted_at_ms = $3 WHERE user_id = $1`, [userId, version, atMs]);
  }

  async recordHostAgreementAcceptance(userId: string, version: string, atMs: number): Promise<void> {
    await this.pool.query(`UPDATE portal_users SET host_agreement_version = $2, host_agreement_accepted_at_ms = $3 WHERE user_id = $1`, [userId, version, atMs]);
  }

  async getLegalAcceptance(userId: string): Promise<LegalAcceptance | null> {
    const r = await this.pool.query(
      `SELECT terms_version, terms_accepted_at_ms, host_agreement_version, host_agreement_accepted_at_ms FROM portal_users WHERE user_id = $1`,
      [userId]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      termsVersion: row.terms_version ?? null,
      termsAcceptedAtMs: row.terms_accepted_at_ms === null || row.terms_accepted_at_ms === undefined ? null : Number(row.terms_accepted_at_ms),
      hostAgreementVersion: row.host_agreement_version ?? null,
      hostAgreementAcceptedAtMs: row.host_agreement_accepted_at_ms === null || row.host_agreement_accepted_at_ms === undefined ? null : Number(row.host_agreement_accepted_at_ms)
    };
  }

  /** Security research access (src/portal/security-research.ts): one row per account and kind. */
  async migrateSecurityResearch(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_security_research_entitlements (
         user_id TEXT NOT NULL, kind TEXT NOT NULL, org_name TEXT NOT NULL, verification_notes TEXT NOT NULL,
         agreement_ref TEXT NOT NULL, agreement_accepted_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL,
         granted_by TEXT NOT NULL, granted_at_ms BIGINT NOT NULL, status TEXT NOT NULL,
         status_changed_by TEXT, status_changed_at_ms BIGINT, PRIMARY KEY (user_id, kind))`
    );
  }

  // ── Security research access (src/portal/security-research.ts) ──

  private securityResearchRow(row: Record<string, unknown>): SecurityResearchEntitlement {
    return {
      userId: String(row.user_id),
      kind: row.kind as SecurityResearchEntitlement["kind"],
      orgName: String(row.org_name),
      verificationNotes: String(row.verification_notes),
      agreementRef: String(row.agreement_ref),
      agreementAcceptedAtMs: Number(row.agreement_accepted_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
      grantedBy: String(row.granted_by),
      grantedAtMs: Number(row.granted_at_ms),
      status: row.status as SecurityResearchEntitlement["status"],
      statusChangedBy: row.status_changed_by === null || row.status_changed_by === undefined ? null : String(row.status_changed_by),
      statusChangedAtMs: row.status_changed_at_ms === null || row.status_changed_at_ms === undefined ? null : Number(row.status_changed_at_ms),
    };
  }

  /** A new grant (or a re-grant) replaces the account's row for that kind. */
  async upsertRestrictedEntitlement(r: SecurityResearchEntitlement): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_security_research_entitlements (user_id, kind, org_name, verification_notes, agreement_ref, agreement_accepted_at_ms,
         expires_at_ms, granted_by, granted_at_ms, status, status_changed_by, status_changed_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, kind) DO UPDATE SET org_name = EXCLUDED.org_name, verification_notes = EXCLUDED.verification_notes,
         agreement_ref = EXCLUDED.agreement_ref, agreement_accepted_at_ms = EXCLUDED.agreement_accepted_at_ms, expires_at_ms = EXCLUDED.expires_at_ms,
         granted_by = EXCLUDED.granted_by, granted_at_ms = EXCLUDED.granted_at_ms, status = EXCLUDED.status,
         status_changed_by = EXCLUDED.status_changed_by, status_changed_at_ms = EXCLUDED.status_changed_at_ms`,
      [r.userId, r.kind, r.orgName, r.verificationNotes, r.agreementRef, r.agreementAcceptedAtMs, r.expiresAtMs, r.grantedBy, r.grantedAtMs, r.status, r.statusChangedBy, r.statusChangedAtMs]
    );
  }

  async getRestrictedEntitlement(userId: string, kind: SecurityResearchEntitlement["kind"]): Promise<SecurityResearchEntitlement | null> {
    const r = await this.pool.query(`SELECT * FROM portal_security_research_entitlements WHERE user_id = $1 AND kind = $2`, [userId, kind]);
    return r.rows[0] ? this.securityResearchRow(r.rows[0]) : null;
  }

  async listRestrictedEntitlements(limit: number): Promise<SecurityResearchEntitlement[]> {
    const r = await this.pool.query(`SELECT * FROM portal_security_research_entitlements ORDER BY granted_at_ms DESC LIMIT $1`, [limit]);
    return r.rows.map((row) => this.securityResearchRow(row));
  }

  async setRestrictedEntitlementStatus(userId: string, kind: SecurityResearchEntitlement["kind"], status: SecurityResearchEntitlement["status"], by: string, nowMs: number): Promise<SecurityResearchEntitlement | null> {
    const r = await this.pool.query(
      `UPDATE portal_security_research_entitlements SET status = $3, status_changed_by = $4, status_changed_at_ms = $5
       WHERE user_id = $1 AND kind = $2 AND status <> 'revoked' RETURNING *`,
      [userId, kind, status, by, nowMs]
    );
    return r.rows[0] ? this.securityResearchRow(r.rows[0]) : null;
  }

  /**
   * Tables of the removed soft-launch invite codes. No code reads or writes them any more; they are
   * still created so existing rows and account deletion (account-admin.ts) keep working. Dropping
   * them is a separate, owner-approved migration.
   */
  async migrateInviteCodes(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_invite_codes (
         code_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, label TEXT,
         max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, expires_at_ms BIGINT,
         created_by TEXT NOT NULL, created_at_ms BIGINT NOT NULL, revoked_at_ms BIGINT)`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_invite_redemptions (
         code_id TEXT NOT NULL, user_id TEXT NOT NULL, redeemed_at_ms BIGINT NOT NULL, PRIMARY KEY (code_id, user_id))`
    );
    // Unused column of the removed invite flow, kept for existing databases.
    await this.pool.query(`ALTER TABLE portal_oauth_states ADD COLUMN IF NOT EXISTS invite_code_hash TEXT`);
  }

  /**
   * Payout destinations the user supplies from their own wallet (routes/payout-destination.ts), and
   * the retirement of the old server-generated seed wallets: those addresses were derived from a
   * seed the portal generated and no longer returns, so nobody can spend from them. Every
   * portal_wallet_onboarding row came from that flow; each is marked invalid (kept for audit) and
   * the user is asked for a destination. Returns how many rows were newly invalidated.
   */
  async migratePayoutDestinations(): Promise<number> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_payout_destinations (
         user_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, destination TEXT NOT NULL,
         network TEXT NOT NULL, created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL)`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_payout_destination_challenges (
         challenge_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, destination TEXT NOT NULL,
         email_code_hash TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, consumed_at_ms BIGINT, created_at_ms BIGINT NOT NULL)`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS portal_withdraw_challenges (
         challenge_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bolt11_hash TEXT NOT NULL, amount_msat BIGINT NOT NULL,
         email_code_hash TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, consumed_at_ms BIGINT, approved_at_ms BIGINT,
         released_at_ms BIGINT, created_at_ms BIGINT NOT NULL)`
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS portal_withdraw_challenges_user_idx ON portal_withdraw_challenges (user_id, created_at_ms)`);
    await this.pool.query(`ALTER TABLE portal_wallet_onboarding ADD COLUMN IF NOT EXISTS invalidated_at_ms BIGINT`);
    const res = await this.pool.query(
      `UPDATE portal_wallet_onboarding SET invalidated_at_ms = $1
       WHERE invalidated_at_ms IS NULL AND (seed_phrase_hash IS NOT NULL OR encrypted_private_key_ref LIKE 'seed-sha256:%')`,
      [Date.now()]
    );
    return Number(res.rowCount ?? 0);
  }

  async getPayoutDestination(userId: string): Promise<PayoutDestinationRecord | null> {
    const r = await this.pool.query(
      `SELECT user_id, account_id, kind, destination, network, created_at_ms, updated_at_ms FROM portal_payout_destinations WHERE user_id = $1`,
      [userId]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      accountId: row.account_id,
      kind: row.kind,
      destination: row.destination,
      network: row.network,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async upsertPayoutDestination(input: { userId: string; accountId: string; kind: string; destination: string; network: string }): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO portal_payout_destinations (user_id, account_id, kind, destination, network, created_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT (user_id) DO UPDATE SET account_id = EXCLUDED.account_id, kind = EXCLUDED.kind,
         destination = EXCLUDED.destination, network = EXCLUDED.network, updated_at_ms = EXCLUDED.updated_at_ms`,
      [input.userId, input.accountId, input.kind, input.destination, input.network, now]
    );
  }

  async createPayoutDestinationChallenge(input: { challengeId: string; userId: string; kind: string; destination: string; emailCodeHash: string; expiresAtMs: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_payout_destination_challenges (challenge_id, user_id, kind, destination, email_code_hash, expires_at_ms, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.challengeId, input.userId, input.kind, input.destination, input.emailCodeHash, input.expiresAtMs, Date.now()]
    );
  }

  /** Single use: marks the challenge consumed and returns it, or null when unknown, used or expired. */
  async consumePayoutDestinationChallenge(challengeId: string): Promise<PayoutDestinationChallenge | null> {
    const now = Date.now();
    const r = await this.pool.query(
      `UPDATE portal_payout_destination_challenges SET consumed_at_ms = $2
       WHERE challenge_id = $1 AND consumed_at_ms IS NULL AND expires_at_ms > $2
       RETURNING challenge_id, user_id, kind, destination, email_code_hash, expires_at_ms`,
      [challengeId, now]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      challengeId: row.challenge_id,
      userId: row.user_id,
      kind: row.kind,
      destination: row.destination,
      emailCodeHash: row.email_code_hash,
      expiresAtMs: Number(row.expires_at_ms)
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapNodeRow(row: any): NodeEnrollment {
    return {
      nodeId: row.node_id,
      deviceId: row.device_id ?? undefined,
      nodeKind: row.node_kind,
      ownerUserId: row.owner_user_id,
      ownerEmail: row.owner_email,
      registrationTokenHash: row.registration_token_hash,
      emailVerified: Boolean(row.email_verified),
      nodeApproved: Boolean(row.node_approved),
      active: Boolean(row.active),
      lastSeenMs: row.last_seen_ms ? Number(row.last_seen_ms) : undefined,
      lastIp: row.last_ip ?? undefined,
      lastCountryCode: row.last_country_code ?? undefined,
      lastVpnDetected: row.last_vpn_detected === null ? undefined : Boolean(row.last_vpn_detected),
      dnsHostname: row.dns_hostname ?? undefined,
      dnsStatus: row.dns_status ?? undefined,
      dnsIp: row.dns_ip ?? undefined,
      dnsLastUpdatedMs: row.dns_last_updated_ms ? Number(row.dns_last_updated_ms) : undefined,
      lastValidatedByCoordinator: row.last_validated_by_coordinator ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  async getUserByEmail(email: string): Promise<PortalUser | null> {
    const result = await this.pool.query(
      `SELECT user_id, email, email_verified, ui_theme, role, password_hash, display_name, created_at_ms, verified_at_ms
       FROM portal_users WHERE lower(email) = lower($1)`,
      [email]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      uiTheme: (row.ui_theme ?? "warm") as "warm" | "midnight" | "emerald",
      role: (row.role ?? "user") as "user" | "admin",
      passwordHash: row.password_hash ?? undefined,
      displayName: row.display_name ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      verifiedAtMs: row.verified_at_ms ? Number(row.verified_at_ms) : undefined
    };
  }

  async getUserById(userId: string): Promise<PortalUser | null> {
    const result = await this.pool.query(
      `SELECT user_id, email, email_verified, ui_theme, role, password_hash, display_name, created_at_ms, verified_at_ms
       FROM portal_users WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      uiTheme: (row.ui_theme ?? "warm") as "warm" | "midnight" | "emerald",
      role: (row.role ?? "user") as "user" | "admin",
      passwordHash: row.password_hash ?? undefined,
      displayName: row.display_name ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      verifiedAtMs: row.verified_at_ms ? Number(row.verified_at_ms) : undefined
    };
  }

  async createUser(input: {
    userId: string;
    email: string;
    uiTheme?: "warm" | "midnight" | "emerald";
    passwordHash?: string;
    displayName?: string;
    emailVerified: boolean;
    /** The Terms / Privacy / AUP version accepted at sign-up (src/common/legal-notices.ts). */
    termsVersion?: string;
    termsAcceptedAtMs?: number;
  }): Promise<PortalUser> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO portal_users (
        user_id, email, email_verified, ui_theme, password_hash, display_name, created_at_ms, verified_at_ms, terms_version, terms_accepted_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.userId,
        input.email,
        input.emailVerified,
        input.uiTheme ?? "warm",
        input.passwordHash ?? null,
        input.displayName ?? null,
        now,
        input.emailVerified ? now : null,
        input.termsVersion ?? null,
        input.termsVersion ? (input.termsAcceptedAtMs ?? now) : null
      ]
    );
    return {
      userId: input.userId,
      email: input.email,
      emailVerified: input.emailVerified,
      uiTheme: input.uiTheme ?? "warm",
      role: "user",
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      createdAtMs: now,
      verifiedAtMs: input.emailVerified ? now : undefined
    };
  }

  async setUserTheme(userId: string, theme: "warm" | "midnight" | "emerald"): Promise<void> {
    await this.pool.query(`UPDATE portal_users SET ui_theme = $2 WHERE user_id = $1`, [userId, theme]);
  }

  async setDisplayName(userId: string, displayName: string | null): Promise<void> {
    await this.pool.query(`UPDATE portal_users SET display_name = $2 WHERE user_id = $1`, [userId, displayName]);
  }

  // ── API keys (hosted /v1 endpoint) ──
  async createApiKey(k: { keyId: string; userId: string; name: string; keyHash: string; prefix: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_api_keys (key_id, user_id, name, key_hash, prefix, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6)`,
      [k.keyId, k.userId, k.name, k.keyHash, k.prefix, Date.now()]
    );
  }

  async listApiKeys(userId: string): Promise<Array<{ keyId: string; name: string; prefix: string; createdAtMs: number; lastUsedMs?: number }>> {
    const r = await this.pool.query(
      `SELECT key_id, name, prefix, created_at_ms, last_used_ms FROM portal_api_keys WHERE user_id = $1 AND revoked_at_ms IS NULL ORDER BY created_at_ms DESC`,
      [userId]
    );
    return r.rows.map((row) => ({ keyId: row.key_id, name: row.name, prefix: row.prefix, createdAtMs: Number(row.created_at_ms), ...(row.last_used_ms ? { lastUsedMs: Number(row.last_used_ms) } : {}) }));
  }

  async countApiKeys(userId: string): Promise<number> {
    const r = await this.pool.query(`SELECT count(*)::int AS n FROM portal_api_keys WHERE user_id = $1 AND revoked_at_ms IS NULL`, [userId]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const r = await this.pool.query(`UPDATE portal_api_keys SET revoked_at_ms = $3 WHERE key_id = $1 AND user_id = $2 AND revoked_at_ms IS NULL`, [keyId, userId, Date.now()]);
    return (r.rowCount ?? 0) > 0;
  }

  /** The owner of a live key (and marks it used, at most once a minute). */
  async userForApiKeyHash(keyHash: string): Promise<string | null> {
    const r = await this.pool.query(`SELECT key_id, user_id, last_used_ms FROM portal_api_keys WHERE key_hash = $1 AND revoked_at_ms IS NULL`, [keyHash]);
    const row = r.rows[0];
    if (!row) return null;
    const now = Date.now();
    if (!row.last_used_ms || now - Number(row.last_used_ms) > 60_000) await this.pool.query(`UPDATE portal_api_keys SET last_used_ms = $2 WHERE key_id = $1`, [row.key_id, now]);
    return row.user_id as string;
  }

  /** Revokes every live API key of a user (an agent rotating its key); returns how many. */
  async revokeAllApiKeys(userId: string): Promise<number> {
    const r = await this.pool.query(`UPDATE portal_api_keys SET revoked_at_ms = $2 WHERE user_id = $1 AND revoked_at_ms IS NULL`, [userId, Date.now()]);
    return r.rowCount ?? 0;
  }

  // ── AI agent accounts (public-key signup) ──

  /** Stores a signup challenge (only a hash of the nonce) and drops long-expired ones. */
  async createAgentChallenge(c: { nonceHash: string; keyType: string; publicKey: string; expiresAtMs: number }): Promise<void> {
    await this.pool.query(`DELETE FROM portal_agent_challenges WHERE expires_at_ms < $1`, [Date.now() - 3_600_000]);
    await this.pool.query(`INSERT INTO portal_agent_challenges (nonce_hash, key_type, public_key, expires_at_ms) VALUES ($1,$2,$3,$4)`, [
      c.nonceHash,
      c.keyType,
      c.publicKey,
      c.expiresAtMs,
    ]);
  }

  /** Takes a challenge out (single use: a second call for the same nonce returns null). Expiry is checked by the caller. */
  async consumeAgentChallenge(nonceHash: string): Promise<{ keyType: string; publicKey: string; expiresAtMs: number } | null> {
    const r = await this.pool.query(`DELETE FROM portal_agent_challenges WHERE nonce_hash = $1 RETURNING key_type, public_key, expires_at_ms`, [nonceHash]);
    const row = r.rows[0];
    return row ? { keyType: row.key_type, publicKey: row.public_key, expiresAtMs: Number(row.expires_at_ms) } : null;
  }

  async userForAgentKey(keyType: string, publicKey: string): Promise<string | null> {
    const r = await this.pool.query(`SELECT user_id FROM portal_agent_identities WHERE key_type = $1 AND public_key = $2`, [keyType, publicKey]);
    return (r.rows[0]?.user_id as string | undefined) ?? null;
  }

  /**
   * A portal user for an agent: no password, no deliverable email (a reserved `.invalid`
   * placeholder keeps the email column's NOT NULL UNIQUE), never email-verified, kind "agent".
   * Returns the owning user id (an existing one when the key raced another signup).
   */
  async createAgentAccount(a: { userId: string; keyType: string; publicKey: string; displayName?: string }): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      const claimed = await client.query(
        `INSERT INTO portal_agent_identities (key_type, public_key, user_id, created_at_ms) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key_type, public_key) DO NOTHING RETURNING user_id`,
        [a.keyType, a.publicKey, a.userId, now]
      );
      if (!claimed.rows[0]) {
        await client.query("ROLLBACK");
        return (await this.userForAgentKey(a.keyType, a.publicKey)) as string;
      }
      await client.query(
        `INSERT INTO portal_users (user_id, email, email_verified, ui_theme, password_hash, display_name, created_at_ms, verified_at_ms, account_kind)
         VALUES ($1,$2,false,'warm',NULL,$3,$4,NULL,'agent')`,
        [a.userId, `agent-${a.userId}@${AGENT_EMAIL_DOMAIN}`, a.displayName ?? null, now]
      );
      await client.query("COMMIT");
      return a.userId;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async setUserRole(userId: string, role: "user" | "admin"): Promise<void> {
    await this.pool.query(`UPDATE portal_users SET role = $2 WHERE user_id = $1`, [userId, role]);
  }

  async listAdminUsers(): Promise<PortalUser[]> {
    const result = await this.pool.query(
      `SELECT user_id, email, email_verified, ui_theme, role, password_hash, display_name, created_at_ms, verified_at_ms
       FROM portal_users WHERE role = 'admin' ORDER BY created_at_ms`
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      uiTheme: (row.ui_theme ?? "warm") as "warm" | "midnight" | "emerald",
      role: (row.role ?? "user") as "user" | "admin",
      passwordHash: row.password_hash ?? undefined,
      displayName: row.display_name ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      verifiedAtMs: row.verified_at_ms ? Number(row.verified_at_ms) : undefined
    }));
  }

  async listAllUsers(): Promise<PortalUser[]> {
    const result = await this.pool.query(
      `SELECT user_id, email, email_verified, ui_theme, role, password_hash, display_name, created_at_ms, verified_at_ms
       FROM portal_users ORDER BY created_at_ms`
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      uiTheme: (row.ui_theme ?? "warm") as "warm" | "midnight" | "emerald",
      role: (row.role ?? "user") as "user" | "admin",
      passwordHash: row.password_hash ?? undefined,
      displayName: row.display_name ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      verifiedAtMs: row.verified_at_ms ? Number(row.verified_at_ms) : undefined
    }));
  }

  async markUserEmailVerified(userId: string): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `UPDATE portal_users
       SET email_verified = TRUE, verified_at_ms = COALESCE(verified_at_ms, $2)
       WHERE user_id = $1`,
      [userId, now]
    );
    await this.pool.query(
      `UPDATE portal_node_enrollments
       SET email_verified = TRUE, active = node_approved, updated_at_ms = $2
       WHERE owner_user_id = $1`,
      [userId, now]
    );
  }

  async linkOauthIdentity(input: {
    provider: "google" | "apple" | "microsoft" | "github";
    providerSubject: string;
    userId: string;
    emailSnapshot?: string;
    /** Microsoft: the Entra tenant (tid) of the identity. */
    tenantId?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_oauth_links (provider, provider_subject, user_id, email_snapshot, created_at_ms, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider, provider_subject) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         email_snapshot = EXCLUDED.email_snapshot,
         tenant_id = COALESCE(EXCLUDED.tenant_id, portal_oauth_links.tenant_id)`,
      [input.provider, input.providerSubject, input.userId, input.emailSnapshot ?? null, Date.now(), input.tenantId ?? null]
    );
  }

  /** The sign-in providers connected to a user (Settings, Connected sign-ins). */
  async listOauthLinksForUser(userId: string): Promise<Array<{ provider: string; providerSubject: string; emailSnapshot?: string; tenantId?: string; createdAtMs: number }>> {
    const result = await this.pool.query(
      `SELECT provider, provider_subject, email_snapshot, tenant_id, created_at_ms FROM portal_oauth_links WHERE user_id = $1 ORDER BY created_at_ms`,
      [userId]
    );
    return result.rows.map((row) => ({
      provider: row.provider,
      providerSubject: row.provider_subject,
      ...(row.email_snapshot ? { emailSnapshot: row.email_snapshot } : {}),
      ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  /** Remove one connected provider of this user; false when there was no such link. */
  async deleteOauthLink(userId: string, provider: string, providerSubject: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM portal_oauth_links WHERE user_id = $1 AND provider = $2 AND provider_subject = $3`,
      [userId, provider, providerSubject]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createOauthPendingLink(input: {
    tokenHash: string;
    kind: "link" | "claim_notice";
    userId: string;
    provider: string;
    providerSubject: string;
    tenantId?: string;
    email: string;
    browserHash?: string;
    ipHash?: string;
    expiresAtMs: number;
  }): Promise<void> {
    // Kept a day past expiry so the hourly per-account / per-address counts still see them.
    await this.pool.query(`DELETE FROM portal_oauth_pending_links WHERE expires_at_ms < $1`, [Date.now() - 24 * 60 * 60 * 1000]);
    await this.pool.query(
      `INSERT INTO portal_oauth_pending_links (token_hash, kind, user_id, provider, provider_subject, tenant_id, email, browser_hash, ip_hash, expires_at_ms, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.tokenHash, input.kind, input.userId, input.provider, input.providerSubject, input.tenantId ?? null, input.email, input.browserHash ?? null, input.ipHash ?? null, input.expiresAtMs, Date.now()]
    );
  }

  async countRecentOauthPendingLinksForUser(userId: string, sinceMs: number): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::int AS n FROM portal_oauth_pending_links WHERE user_id = $1 AND created_at_ms >= $2`, [userId, sinceMs]);
    return Number(result.rows[0]?.n ?? 0);
  }

  async countRecentOauthPendingLinksFromIp(ipHash: string, sinceMs: number): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::int AS n FROM portal_oauth_pending_links WHERE ip_hash = $1 AND created_at_ms >= $2`, [ipHash, sinceMs]);
    return Number(result.rows[0]?.n ?? 0);
  }

  /** An unused, unexpired confirmation link (kind "link"), without using it up. */
  async findOauthPendingLink(tokenHash: string): Promise<OauthPendingLink | null> {
    const result = await this.pool.query(
      `SELECT user_id, provider, provider_subject, tenant_id, email, browser_hash FROM portal_oauth_pending_links
       WHERE token_hash = $1 AND kind = 'link' AND consumed_at_ms IS NULL AND expires_at_ms > $2`,
      [tokenHash, Date.now()]
    );
    return result.rows[0] ? pendingLinkFromRow(result.rows[0]) : null;
  }

  /** Uses the link up: atomic, so it completes at most once across instances. */
  async consumeOauthPendingLink(tokenHash: string): Promise<OauthPendingLink | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `UPDATE portal_oauth_pending_links SET consumed_at_ms = $2
       WHERE token_hash = $1 AND kind = 'link' AND consumed_at_ms IS NULL AND expires_at_ms > $2
       RETURNING user_id, provider, provider_subject, tenant_id, email, browser_hash`,
      [tokenHash, now]
    );
    return result.rows[0] ? pendingLinkFromRow(result.rows[0]) : null;
  }

  /** Password reset revokes every other way in, including links still waiting for confirmation. */
  async deleteOauthPendingLinksForUser(userId: string): Promise<void> {
    await this.pool.query(`UPDATE portal_oauth_pending_links SET consumed_at_ms = $2 WHERE user_id = $1 AND consumed_at_ms IS NULL`, [userId, Date.now()]);
  }

  /** Remove every OAuth identity linked to a user. */
  async deleteOauthLinksForUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM portal_oauth_links WHERE user_id = $1`, [userId]);
  }

  /** Remove every passkey registered to a user. */
  async deletePasskeysForUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM portal_passkey_credentials WHERE user_id = $1`, [userId]);
  }

  async findOauthIdentity(provider: string, providerSubject: string): Promise<{ userId: string } | null> {
    const result = await this.pool.query(
      `SELECT user_id FROM portal_oauth_links WHERE provider = $1 AND provider_subject = $2`,
      [provider, providerSubject]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { userId: row.user_id };
  }

  /**
   * Delete rows of a short-lived sign-in table whose expiry passed more than `graceMs` ago.
   * Called whenever a new row is written, so unauthenticated starts cannot grow the table forever.
   */
  private async pruneExpired(
    table: "portal_sessions" | "portal_oauth_states" | "portal_passkey_challenges" | "portal_email_verifications",
    graceMs = 0
  ): Promise<void> {
    await this.pool.query(`DELETE FROM ${table} WHERE expires_at_ms < $1`, [Date.now() - graceMs]);
  }

  async createEmailVerification(input: {
    tokenId: string;
    userId: string;
    tokenHash: string;
    expiresAtMs: number;
  }): Promise<void> {
    // Kept a day past expiry so the per-account resend count (last hour) still sees them.
    await this.pruneExpired("portal_email_verifications", 24 * 60 * 60 * 1000);
    await this.pool.query(
      `INSERT INTO portal_email_verifications (
        token_id, user_id, token_hash, expires_at_ms, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5)`,
      [input.tokenId, input.userId, input.tokenHash, input.expiresAtMs, Date.now()]
    );
  }

  /** The account an unused, unexpired verification link belongs to, without using the link up. */
  async findEmailVerification(tokenHash: string): Promise<{ userId: string } | null> {
    const result = await this.pool.query(
      `SELECT user_id FROM portal_email_verifications
       WHERE token_hash = $1 AND consumed_at_ms IS NULL AND expires_at_ms > $2`,
      [tokenHash, Date.now()]
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id } : null;
  }

  /** Verification links issued to a user since `sinceMs` (per-account resend cap). */
  async countRecentEmailVerifications(userId: string, sinceMs: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM portal_email_verifications WHERE user_id = $1 AND created_at_ms >= $2`,
      [userId, sinceMs]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async consumeEmailVerification(tokenHash: string): Promise<{ userId: string } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `UPDATE portal_email_verifications
       SET consumed_at_ms = $2
       WHERE token_hash = $1
         AND consumed_at_ms IS NULL
         AND expires_at_ms > $2
       RETURNING user_id`,
      [tokenHash, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { userId: row.user_id };
  }

  /** New reset token for a user; any older unused token for that user is invalidated in the same statement. */
  async createPasswordReset(input: { tokenHash: string; userId: string; expiresAtMs: number }): Promise<void> {
    const now = Date.now();
    await this.pool.query(`DELETE FROM portal_password_resets WHERE expires_at_ms < $1`, [now - 24 * 60 * 60 * 1000]);
    await this.pool.query(
      `WITH invalidated AS (
         UPDATE portal_password_resets SET used_at_ms = $4 WHERE user_id = $2 AND used_at_ms IS NULL
       )
       INSERT INTO portal_password_resets (token_hash, user_id, expires_at_ms, used_at_ms, created_at_ms)
       VALUES ($1, $2, $3, NULL, $4)`,
      [input.tokenHash, input.userId, input.expiresAtMs, now]
    );
  }

  /** Redeem a reset token: the conditional UPDATE ... RETURNING makes it single use across instances. */
  async consumePasswordReset(tokenHash: string): Promise<{ userId: string } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `UPDATE portal_password_resets SET used_at_ms = $2
       WHERE token_hash = $1 AND used_at_ms IS NULL AND expires_at_ms > $2
       RETURNING user_id`,
      [tokenHash, now]
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id } : null;
  }

  /** Mark every outstanding reset token for a user as used. */
  async invalidatePasswordResets(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE portal_password_resets SET used_at_ms = $2 WHERE user_id = $1 AND used_at_ms IS NULL`,
      [userId, Date.now()]
    );
  }

  /** Reset links issued to a user since `sinceMs` (per-email rate limit). */
  async countRecentPasswordResets(userId: string, sinceMs: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM portal_password_resets WHERE user_id = $1 AND created_at_ms >= $2`,
      [userId, sinceMs]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async setUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query(`UPDATE portal_users SET password_hash = $2 WHERE user_id = $1`, [userId, passwordHash]);
  }

  /** Sign a user out everywhere (sessions and pending native-app OAuth codes). */
  async deleteSessionsForUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM portal_sessions WHERE user_id = $1`, [userId]);
    await this.pool.query(`DELETE FROM portal_mobile_oauth_tokens WHERE user_id = $1`, [userId]);
  }

  async createSession(input: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    expiresAtMs: number;
  }): Promise<void> {
    await this.pruneExpired("portal_sessions");
    await this.pool.query(
      `INSERT INTO portal_sessions (session_id, user_id, token_hash, expires_at_ms, created_at_ms)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.sessionId, input.userId, input.tokenHash, input.expiresAtMs, Date.now()]
    );
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query(`DELETE FROM portal_sessions WHERE token_hash = $1`, [tokenHash]);
  }

  async getSessionByTokenHash(tokenHash: string): Promise<{ sessionId: string; userId: string; expiresAtMs: number } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `SELECT session_id, user_id, expires_at_ms
       FROM portal_sessions
       WHERE token_hash = $1 AND expires_at_ms > $2`,
      [tokenHash, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      expiresAtMs: Number(row.expires_at_ms)
    };
  }

  async createOauthState(input: {
    stateId: string;
    provider: "google" | "apple" | "microsoft" | "github";
    redirectUri: string;
    expiresAtMs: number;
    /** Deep link to hand the session back to a native app (desktop/iOS), if the flow started there. */
    nativeRedirect?: string;
    /** Set when a signed-in user connects this provider from Settings. */
    linkUserId?: string;
    /** Native flows: base64url sha256 of a verifier the app keeps; the mobile token is bound to it. */
    appChallenge?: string;
    /** The Terms version the person accepted on the Create account form, recorded if the callback creates the account. */
    termsVersion?: string;
    /** Re-authentication that completes an emailed link (oauth-pending-link.ts): the link token's hash. */
    pendingLinkHash?: string;
  }): Promise<void> {
    await this.pruneExpired("portal_oauth_states");
    await this.pool.query(
      `INSERT INTO portal_oauth_states (state_id, provider, redirect_uri, expires_at_ms, created_at_ms, native_redirect, link_user_id, app_challenge, terms_version, pending_link_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.stateId, input.provider, input.redirectUri, input.expiresAtMs, Date.now(), input.nativeRedirect ?? null, input.linkUserId ?? null, input.appChallenge ?? null, input.termsVersion ?? null, input.pendingLinkHash ?? null]
    );
  }

  async consumeOauthState(stateId: string): Promise<{ provider: string; redirectUri: string; nativeRedirect?: string; linkUserId?: string; appChallenge?: string; termsVersion?: string; pendingLinkHash?: string } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `DELETE FROM portal_oauth_states
       WHERE state_id = $1 AND expires_at_ms > $2
       RETURNING provider, redirect_uri, native_redirect, link_user_id, app_challenge, terms_version, pending_link_hash`,
      [stateId, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      provider: row.provider,
      redirectUri: row.redirect_uri,
      ...(row.native_redirect ? { nativeRedirect: row.native_redirect } : {}),
      ...(row.link_user_id ? { linkUserId: row.link_user_id } : {}),
      ...(row.app_challenge ? { appChallenge: row.app_challenge } : {}),
      ...(row.terms_version ? { termsVersion: row.terms_version } : {}),
      ...(row.pending_link_hash ? { pendingLinkHash: row.pending_link_hash } : {})
    };
  }

  /** One-time code a native app redeems for a session after OAuth (stored hashed, single use). */
  async issueMobileOauthToken(tokenHash: string, userId: string, expiresAtMs: number, appChallenge?: string): Promise<void> {
    await this.pool.query(`DELETE FROM portal_mobile_oauth_tokens WHERE expires_at_ms <= $1`, [Date.now()]);
    await this.pool.query(
      `INSERT INTO portal_mobile_oauth_tokens (token_hash, user_id, expires_at_ms, app_challenge) VALUES ($1,$2,$3,$4)`,
      [tokenHash, userId, expiresAtMs, appChallenge ?? null]
    );
  }

  /** Redeem a mobile OAuth code; the DELETE ... RETURNING makes it single-use across instances. */
  async consumeMobileOauthToken(tokenHash: string): Promise<{ userId: string; appChallenge?: string } | null> {
    const result = await this.pool.query(
      `DELETE FROM portal_mobile_oauth_tokens WHERE token_hash = $1 AND expires_at_ms > $2 RETURNING user_id, app_challenge`,
      [tokenHash, Date.now()]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { userId: row.user_id, ...(row.app_challenge ? { appChallenge: row.app_challenge } : {}) };
  }

  async createWithdrawChallenge(input: { challengeId: string; userId: string; bolt11Hash: string; amountMsat: number; emailCodeHash: string; expiresAtMs: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_withdraw_challenges (challenge_id, user_id, bolt11_hash, amount_msat, email_code_hash, expires_at_ms, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.challengeId, input.userId, input.bolt11Hash, input.amountMsat, input.emailCodeHash, input.expiresAtMs, Date.now()]
    );
  }

  /** Withdrawal codes issued to the user since `sinceMs` (caps how many emails one session can trigger). */
  async countWithdrawChallengesSince(userId: string, sinceMs: number): Promise<number> {
    const r = await this.pool.query(`SELECT COUNT(*)::int AS n FROM portal_withdraw_challenges WHERE user_id = $1 AND created_at_ms > $2`, [userId, sinceMs]);
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Single use: marks the challenge consumed and returns it, or null when unknown, used or expired. */
  async consumeWithdrawChallenge(challengeId: string): Promise<WithdrawChallenge | null> {
    const now = Date.now();
    const r = await this.pool.query(
      `UPDATE portal_withdraw_challenges SET consumed_at_ms = $2
       WHERE challenge_id = $1 AND consumed_at_ms IS NULL AND expires_at_ms > $2
       RETURNING challenge_id, user_id, bolt11_hash, amount_msat, email_code_hash, expires_at_ms`,
      [challengeId, now]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      challengeId: row.challenge_id,
      userId: row.user_id,
      bolt11Hash: row.bolt11_hash,
      amountMsat: Number(row.amount_msat),
      emailCodeHash: row.email_code_hash,
      expiresAtMs: Number(row.expires_at_ms)
    };
  }

  /** msat of the user's approved (and not released) withdrawals since `sinceMs`: the daily cap's running total. */
  async withdrawnMsatSince(userId: string, sinceMs: number): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(amount_msat), 0)::bigint AS total FROM portal_withdraw_challenges
       WHERE user_id = $1 AND approved_at_ms > $2 AND released_at_ms IS NULL`,
      [userId, sinceMs]
    );
    return Number(r.rows[0]?.total ?? 0);
  }

  /**
   * Counts a verified withdrawal against the daily cap. Atomic with the cap check, so two
   * concurrent confirmations cannot both fit under it. Returns false when it would exceed `capMsat`.
   */
  async approveWithdrawChallenge(input: { challengeId: string; userId: string; capMsat: number; sinceMs: number }): Promise<boolean> {
    const now = Date.now();
    const r = await this.pool.query(
      `UPDATE portal_withdraw_challenges c SET approved_at_ms = $3
       WHERE c.challenge_id = $1 AND c.user_id = $2 AND c.approved_at_ms IS NULL
         AND ($4::bigint <= 0 OR c.amount_msat + (
           SELECT COALESCE(SUM(o.amount_msat), 0) FROM portal_withdraw_challenges o
           WHERE o.user_id = $2 AND o.approved_at_ms > $5 AND o.released_at_ms IS NULL) <= $4::bigint)
       RETURNING challenge_id`,
      [input.challengeId, input.userId, now, input.capMsat, input.sinceMs]
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** The coordinator refused the payout: it no longer counts against the daily cap. */
  async releaseWithdrawChallenge(challengeId: string): Promise<void> {
    await this.pool.query(`UPDATE portal_withdraw_challenges SET released_at_ms = $2 WHERE challenge_id = $1`, [challengeId, Date.now()]);
  }

  async upsertNodeEnrollment(input: {
    nodeId: string;
    deviceId?: string;
    nodeKind: "agent" | "coordinator";
    ownerUserId: string;
    ownerEmail: string;
    registrationTokenHash: string;
    emailVerified: boolean;
  }): Promise<NodeEnrollment | null> {
    const now = Date.now();
    const normalizedDeviceId = input.deviceId?.trim().toLowerCase() || undefined;
    let targetNodeId = input.nodeId;
    if (normalizedDeviceId) {
      const existingByDevice = await this.getNodeEnrollmentByDeviceId(normalizedDeviceId);
      if (existingByDevice) {
        // The device's canonical node is used, but only for that node's owner (the upsert's WHERE
        // enforces it), and never when the requested node ID is someone else's enrollment.
        if (existingByDevice.ownerUserId !== input.ownerUserId) return null;
        if (existingByDevice.nodeId !== input.nodeId) {
          const requested = await this.getNodeEnrollment(input.nodeId);
          if (requested && requested.ownerUserId !== input.ownerUserId) return null;
        }
        targetNodeId = existingByDevice.nodeId;
      }
    }
    const result = await this.pool.query(
      `INSERT INTO portal_node_enrollments (
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, created_at_ms, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,FALSE,$8,$8)
      ON CONFLICT (node_id) DO UPDATE SET
        device_id = COALESCE(EXCLUDED.device_id, portal_node_enrollments.device_id),
        node_kind = EXCLUDED.node_kind,
        owner_user_id = EXCLUDED.owner_user_id,
        owner_email = EXCLUDED.owner_email,
        registration_token_hash = EXCLUDED.registration_token_hash,
        email_verified = EXCLUDED.email_verified,
        active = CASE
          WHEN portal_node_enrollments.node_approved = TRUE AND EXCLUDED.email_verified = TRUE THEN TRUE
          ELSE FALSE
        END,
        updated_at_ms = EXCLUDED.updated_at_ms
      -- Re-enrolling (token rotation) is the owner's alone; another user gets no row back.
      WHERE portal_node_enrollments.owner_user_id = EXCLUDED.owner_user_id
      RETURNING
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms`,
      [
        targetNodeId,
        normalizedDeviceId ?? null,
        input.nodeKind,
        input.ownerUserId,
        input.ownerEmail,
        input.registrationTokenHash,
        input.emailVerified,
        now
      ]
    );
    const row = result.rows[0];
    return row ? this.mapNodeRow(row) : null;
  }

  async getNodeEnrollment(nodeId: string): Promise<NodeEnrollment | null> {
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        last_validated_by_coordinator, created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE node_id = $1`,
      [nodeId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapNodeRow(row);
  }

  /** The enrollment a registration token belongs to (by its hash), or null. */
  async getNodeEnrollmentByRegistrationTokenHash(tokenHash: string): Promise<NodeEnrollment | null> {
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE registration_token_hash = $1
       LIMIT 1`,
      [tokenHash]
    );
    const row = result.rows[0];
    return row ? this.mapNodeRow(row) : null;
  }

  /** Node IDs of every coordinator enrollment (DNS label collision checks). */
  async listCoordinatorNodeIds(): Promise<string[]> {
    const result = await this.pool.query(`SELECT node_id FROM portal_node_enrollments WHERE node_kind = 'coordinator'`);
    return result.rows.map((row: any) => String(row.node_id));
  }

  /** Owner (user id and email) of each of these nodes that is enrolled (admin network view). */
  async listNodeOwnersByIds(nodeIds: string[]): Promise<Array<{ nodeId: string; ownerUserId: string; ownerEmail: string }>> {
    if (!nodeIds.length) return [];
    const result = await this.pool.query(
      `SELECT node_id, owner_user_id, owner_email FROM portal_node_enrollments WHERE node_id = ANY($1::text[])`,
      [nodeIds]
    );
    return result.rows.map((row: any) => ({ nodeId: String(row.node_id), ownerUserId: String(row.owner_user_id), ownerEmail: String(row.owner_email) }));
  }

  /** Email of each of these users that exists (admin network view). */
  async listUserEmailsByIds(userIds: string[]): Promise<Array<{ userId: string; email: string }>> {
    if (!userIds.length) return [];
    const result = await this.pool.query(`SELECT user_id, email FROM portal_users WHERE user_id = ANY($1::text[])`, [userIds]);
    return result.rows.map((row: any) => ({ userId: String(row.user_id), email: String(row.email) }));
  }

  async listNodesByOwner(userId: string): Promise<NodeEnrollment[]> {
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE owner_user_id = $1
       ORDER BY updated_at_ms DESC`,
      [userId]
    );
    return result.rows.map((row: any) => this.mapNodeRow(row));
  }

  async listPendingNodes(options?: {
    nodeKind?: "agent" | "coordinator";
    ownerUserId?: string;
    /** Only nodes this coordinator (enrolled node id) last validated. */
    validatedByCoordinator?: string;
    limit?: number;
  }): Promise<NodeEnrollment[]> {
    const limit = Math.max(1, Math.min(500, options?.limit ?? 200));
    const args: Array<string | number> = [limit];
    let where = "WHERE node_approved = FALSE";
    if (options?.validatedByCoordinator) {
      args.push(options.validatedByCoordinator);
      where += ` AND last_validated_by_coordinator = $${args.length}`;
    }
    if (options?.nodeKind) {
      args.push(options.nodeKind);
      where += ` AND node_kind = $${args.length}`;
    }
    if (options?.ownerUserId) {
      args.push(options.ownerUserId);
      where += ` AND owner_user_id = $${args.length}`;
    }
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       ${where}
       ORDER BY updated_at_ms DESC
       LIMIT $1`,
      args
    );
    return result.rows.map((row: any) => this.mapNodeRow(row));
  }

  async listApprovedNodes(options?: {
    nodeKind?: "agent" | "coordinator";
    ownerUserId?: string;
    activeOnly?: boolean;
    limit?: number;
  }): Promise<NodeEnrollment[]> {
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 500));
    const args: Array<string | number | boolean> = [limit];
    const whereParts = ["node_approved = TRUE"];
    if (options?.nodeKind) {
      args.push(options.nodeKind);
      whereParts.push(`node_kind = $${args.length}`);
    }
    if (options?.ownerUserId) {
      args.push(options.ownerUserId);
      whereParts.push(`owner_user_id = $${args.length}`);
    }
    if (options?.activeOnly === true) {
      whereParts.push("active = TRUE");
    }
    const where = `WHERE ${whereParts.join(" AND ")}`;
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       ${where}
       ORDER BY updated_at_ms DESC
       LIMIT $1`,
      args
    );
    return result.rows.map((row: any) => this.mapNodeRow(row));
  }

  async deleteNodeEnrollment(nodeId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM portal_node_enrollments WHERE node_id = $1`, [nodeId]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async setNodeApproval(nodeId: string, approved: boolean): Promise<NodeEnrollment | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `UPDATE portal_node_enrollments
       SET node_approved = $2,
           active = CASE WHEN $2 = TRUE AND email_verified = TRUE THEN TRUE ELSE FALSE END,
           updated_at_ms = $3
       WHERE node_id = $1
       RETURNING
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
         email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
         last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
         created_at_ms, updated_at_ms`,
      [nodeId, approved, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapNodeRow(row);
  }

  async touchNodeValidation(input: {
    nodeId: string;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
    /** The validating coordinator's enrolled node id; null (service token) clears it. Omitted keeps it. */
    validatedByCoordinator?: string | null;
  }): Promise<void> {
    const setValidator = input.validatedByCoordinator !== undefined;
    await this.pool.query(
      `UPDATE portal_node_enrollments
       SET last_seen_ms = $2,
           last_ip = COALESCE($3, last_ip),
           last_country_code = COALESCE($4, last_country_code),
           last_vpn_detected = COALESCE($5, last_vpn_detected),
           last_validated_by_coordinator = CASE WHEN $6::boolean THEN $7::text ELSE last_validated_by_coordinator END,
           updated_at_ms = $2
       WHERE node_id = $1`,
      [input.nodeId, Date.now(), input.sourceIp ?? null, input.countryCode ?? null, input.vpnDetected ?? null, setValidator, input.validatedByCoordinator ?? null]
    );
  }

  async getNodeEnrollmentByDeviceId(deviceId: string): Promise<NodeEnrollment | null> {
    const normalized = deviceId.trim().toLowerCase();
    if (!normalized) return null;
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE device_id IS NOT NULL
         AND (
           lower(device_id) = $1
           OR lower(device_id) LIKE ($1 || '%')
           OR $1 LIKE (lower(device_id) || '%')
         )
       ORDER BY updated_at_ms DESC
       LIMIT 1`,
      [normalized]
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapNodeRow(row);
  }

  async updateNodeDns(input: {
    nodeId: string;
    dnsHostname: string;
    dnsStatus: "pending" | "active" | "nat" | "error" | "stale";
    dnsIp: string | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE portal_node_enrollments
       SET dns_hostname = $2,
           dns_status = $3,
           dns_ip = $4,
           dns_last_updated_ms = $5,
           updated_at_ms = $5
       WHERE node_id = $1`,
      [input.nodeId, input.dnsHostname, input.dnsStatus, input.dnsIp, Date.now()]
    );
  }

  async markStaleCoordinatorDns(staleThresholdMs: number): Promise<number> {
    const cutoff = Date.now() - staleThresholdMs;
    const result = await this.pool.query(
      `UPDATE portal_node_enrollments
       SET dns_status = 'stale', dns_ip = NULL, updated_at_ms = $2
       WHERE node_kind = 'coordinator'
         AND dns_status = 'active'
         AND last_seen_ms < $1`,
      [cutoff, Date.now()]
    );
    return Number(result.rowCount ?? 0);
  }

  async getWalletOnboardingByUserId(userId: string): Promise<{
    userId: string;
    accountId: string;
    network: string;
    seedPhraseHash: string;
    encryptedPrivateKeyRef: string;
    derivedAddress?: string;
    createdAtMs: number;
    acknowledgedAtMs?: number;
    /** Set by migratePayoutDestinations: the derived address was server-generated and is never paid. */
    invalidatedAtMs?: number;
  } | null> {
    const result = await this.pool.query(
      `SELECT user_id, account_id, network, seed_phrase_hash, encrypted_private_key_ref, derived_address, created_at_ms, acknowledged_at_ms, invalidated_at_ms
       FROM portal_wallet_onboarding
       WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      accountId: row.account_id,
      network: row.network,
      seedPhraseHash: row.seed_phrase_hash,
      encryptedPrivateKeyRef: row.encrypted_private_key_ref,
      derivedAddress: row.derived_address ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      acknowledgedAtMs: row.acknowledged_at_ms ? Number(row.acknowledged_at_ms) : undefined,
      invalidatedAtMs: row.invalidated_at_ms ? Number(row.invalidated_at_ms) : undefined
    };
  }

  async createWalletSendMfaChallenge(input: {
    challengeId: string;
    userId: string;
    accountId: string;
    destination: string;
    amountSats: number;
    note?: string;
    emailCodeHash: string;
    passkeyChallenge: string;
    expiresAtMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_wallet_send_mfa_challenges (
        challenge_id, user_id, account_id, destination, amount_sats, note, email_code_hash,
        passkey_challenge, expires_at_ms, consumed_at_ms, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)`,
      [
        input.challengeId,
        input.userId,
        input.accountId,
        input.destination,
        input.amountSats,
        input.note ?? null,
        input.emailCodeHash,
        input.passkeyChallenge,
        input.expiresAtMs,
        Date.now()
      ]
    );
  }

  /**
   * Spends a send challenge, only for the user it was issued to: a guessed or leaked challenge id
   * used from another account matches nothing and leaves the owner's challenge intact.
   */
  async consumeWalletSendMfaChallenge(challengeId: string, userId: string): Promise<{
    challengeId: string;
    userId: string;
    accountId: string;
    destination: string;
    amountSats: number;
    note?: string;
    emailCodeHash: string;
    passkeyChallenge: string;
    expiresAtMs: number;
  } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `UPDATE portal_wallet_send_mfa_challenges
       SET consumed_at_ms = $2
       WHERE challenge_id = $1
         AND user_id = $3
         AND consumed_at_ms IS NULL
         AND expires_at_ms > $2
       RETURNING challenge_id, user_id, account_id, destination, amount_sats, note, email_code_hash, passkey_challenge, expires_at_ms`,
      [challengeId, now, userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      challengeId: row.challenge_id,
      userId: row.user_id,
      accountId: row.account_id,
      destination: row.destination,
      amountSats: Number(row.amount_sats),
      note: row.note ?? undefined,
      emailCodeHash: row.email_code_hash,
      passkeyChallenge: row.passkey_challenge,
      expiresAtMs: Number(row.expires_at_ms)
    };
  }

  async createWalletSendRequest(input: {
    requestId: string;
    userId: string;
    accountId: string;
    destination: string;
    amountSats: number;
    note?: string;
    status: "pending_manual_review" | "rejected" | "sent";
    mfaChallengeId: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_wallet_send_requests (
        request_id, user_id, account_id, destination, amount_sats, note, status, mfa_challenge_id, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.requestId,
        input.userId,
        input.accountId,
        input.destination,
        input.amountSats,
        input.note ?? null,
        input.status,
        input.mfaChallengeId,
        Date.now()
      ]
    );
  }

  async listWalletSendRequestsByUser(userId: string, limit = 25): Promise<Array<{
    requestId: string;
    accountId: string;
    destination: string;
    amountSats: number;
    note?: string;
    status: string;
    createdAtMs: number;
  }>> {
    const result = await this.pool.query(
      `SELECT request_id, account_id, destination, amount_sats, note, status, created_at_ms
       FROM portal_wallet_send_requests
       WHERE user_id = $1
       ORDER BY created_at_ms DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      requestId: row.request_id,
      accountId: row.account_id,
      destination: row.destination,
      amountSats: Number(row.amount_sats),
      note: row.note ?? undefined,
      status: row.status,
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  async createPasskeyChallenge(input: {
    challengeId: string;
    userId?: string;
    email?: string;
    challenge: string;
    flowType: "registration" | "authentication";
    expiresAtMs: number;
  }): Promise<void> {
    await this.pruneExpired("portal_passkey_challenges");
    await this.pool.query(
      `INSERT INTO portal_passkey_challenges (
        challenge_id, user_id, email, challenge, flow_type, expires_at_ms, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.challengeId,
        input.userId ?? null,
        input.email ?? null,
        input.challenge,
        input.flowType,
        input.expiresAtMs,
        Date.now()
      ]
    );
  }

  async consumePasskeyChallenge(challengeId: string): Promise<{
    userId?: string;
    email?: string;
    challenge: string;
    flowType: "registration" | "authentication";
  } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `DELETE FROM portal_passkey_challenges
       WHERE challenge_id = $1 AND expires_at_ms > $2
       RETURNING user_id, email, challenge, flow_type`,
      [challengeId, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id ?? undefined,
      email: row.email ?? undefined,
      challenge: row.challenge,
      flowType: row.flow_type
    };
  }

  async listPasskeysByUserId(userId: string): Promise<
    Array<{
      credentialId: string;
      userId: string;
      webauthnUserId: string;
      publicKeyB64Url: string;
      counter: number;
      deviceType: string;
      backedUp: boolean;
      transports?: string[];
      createdAtMs: number;
      lastUsedAtMs?: number;
    }>
  > {
    const result = await this.pool.query(
      `SELECT
         credential_id, user_id, webauthn_user_id, public_key_b64url, counter, device_type, backed_up,
         transports_json, created_at_ms, last_used_at_ms
       FROM portal_passkey_credentials
       WHERE user_id = $1
       ORDER BY created_at_ms DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
      credentialId: row.credential_id,
      userId: row.user_id,
      webauthnUserId: row.webauthn_user_id,
      publicKeyB64Url: row.public_key_b64url,
      counter: Number(row.counter),
      deviceType: row.device_type,
      backedUp: Boolean(row.backed_up),
      transports: Array.isArray(row.transports_json) ? row.transports_json : undefined,
      createdAtMs: Number(row.created_at_ms),
      lastUsedAtMs: row.last_used_at_ms ? Number(row.last_used_at_ms) : undefined
    }));
  }

  async findPasskeyByCredentialId(credentialId: string): Promise<{
    credentialId: string;
    userId: string;
    webauthnUserId: string;
    publicKeyB64Url: string;
    counter: number;
    deviceType: string;
    backedUp: boolean;
    transports?: string[];
  } | null> {
    const result = await this.pool.query(
      `SELECT
         credential_id, user_id, webauthn_user_id, public_key_b64url, counter, device_type, backed_up, transports_json
       FROM portal_passkey_credentials
       WHERE credential_id = $1`,
      [credentialId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      credentialId: row.credential_id,
      userId: row.user_id,
      webauthnUserId: row.webauthn_user_id,
      publicKeyB64Url: row.public_key_b64url,
      counter: Number(row.counter),
      deviceType: row.device_type,
      backedUp: Boolean(row.backed_up),
      transports: Array.isArray(row.transports_json) ? row.transports_json : undefined
    };
  }

  async upsertPasskeyCredential(input: {
    credentialId: string;
    userId: string;
    webauthnUserId: string;
    publicKeyB64Url: string;
    counter: number;
    deviceType: string;
    backedUp: boolean;
    transports?: string[];
  }): Promise<boolean> {
    // A credential ID already registered to another user is never re-assigned (returns false).
    const result = await this.pool.query(
      `INSERT INTO portal_passkey_credentials (
        credential_id, user_id, webauthn_user_id, public_key_b64url, counter, device_type, backed_up,
        transports_json, created_at_ms, last_used_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT (credential_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        webauthn_user_id = EXCLUDED.webauthn_user_id,
        public_key_b64url = EXCLUDED.public_key_b64url,
        counter = EXCLUDED.counter,
        device_type = EXCLUDED.device_type,
        backed_up = EXCLUDED.backed_up,
        transports_json = EXCLUDED.transports_json,
        last_used_at_ms = EXCLUDED.last_used_at_ms
      WHERE portal_passkey_credentials.user_id = EXCLUDED.user_id`,
      [
        input.credentialId,
        input.userId,
        input.webauthnUserId,
        input.publicKeyB64Url,
        input.counter,
        input.deviceType,
        input.backedUp,
        JSON.stringify(input.transports ?? []),
        Date.now()
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
    await this.pool.query(
      `UPDATE portal_passkey_credentials
       SET counter = $2, last_used_at_ms = $3
       WHERE credential_id = $1`,
      [credentialId, counter, Date.now()]
    );
  }

  async createConversation(input: {
    conversationId: string;
    userId: string;
    title?: string;
  }): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO portal_conversations (conversation_id, user_id, title, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.conversationId, input.userId, this.chatCipher.seal(input.title ?? "New chat", titleAad(input.conversationId)), now, now]
    );
  }

  async listConversations(userId: string, limit = 50): Promise<PortalConversation[]> {
    const result = await this.pool.query(
      `SELECT conversation_id, user_id, title, created_at_ms, updated_at_ms
       FROM portal_conversations WHERE user_id = $1
       ORDER BY updated_at_ms DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((r) => ({
      conversationId: r.conversation_id,
      userId: r.user_id,
      title: this.chatCipher.openOrPlaceholder(r.title, titleAad(r.conversation_id)),
      createdAtMs: Number(r.created_at_ms),
      updatedAtMs: Number(r.updated_at_ms)
    }));
  }

  /** The user_id that owns a conversation, or null if it does not exist. Used for authz checks. */
  async getConversationOwner(conversationId: string): Promise<string | null> {
    const r = await this.pool.query(`SELECT user_id FROM portal_conversations WHERE conversation_id = $1`, [conversationId]);
    return r.rows[0]?.user_id ?? null;
  }

  /** The most recent `limit` messages of a conversation, oldest first. */
  async getConversationMessages(conversationId: string, limit: number): Promise<PortalMessage[]> {
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms, usage_meta
         FROM portal_messages WHERE conversation_id = $1
         ORDER BY created_at_ms DESC LIMIT $2
       ) recent ORDER BY created_at_ms ASC`,
      [conversationId, Math.max(1, Math.floor(limit))]
    );
    return result.rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      role: r.role as "user" | "assistant" | "system",
      content: this.chatCipher.openOrPlaceholder(r.content, messageAad(r.conversation_id, r.message_id)),
      tokensUsed: Number(r.tokens_used),
      creditsSpent: Number(r.credits_spent),
      createdAtMs: Number(r.created_at_ms),
      ...(r.usage_meta ? { usageMeta: compactReplyUsage(r.usage_meta) } : {})
    }));
  }

  async addMessage(input: {
    messageId: string;
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    tokensUsed?: number;
    creditsSpent?: number;
    usageMeta?: ReplyUsage;
  }): Promise<void> {
    const now = Date.now();
    const usage = input.role === "assistant" ? compactReplyUsage(input.usageMeta) : undefined;
    await this.pool.query(
      `INSERT INTO portal_messages (message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms, usage_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.messageId, input.conversationId, input.role, this.chatCipher.seal(input.content, messageAad(input.conversationId, input.messageId)), wholeNumber(input.tokensUsed), wholeNumber(input.creditsSpent), now, usage ? JSON.stringify(usage) : null]
    );
    await this.pool.query(
      `UPDATE portal_conversations SET updated_at_ms = $1 WHERE conversation_id = $2`,
      [now, input.conversationId]
    );
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    await this.pool.query(
      `UPDATE portal_conversations SET title = $1, updated_at_ms = $2 WHERE conversation_id = $3`,
      [this.chatCipher.seal(title, titleAad(conversationId)), Date.now(), conversationId]
    );
  }

  /** Whether the user agreed to share chat context to improve EdgeCoder (default false). */
  async getChatSharing(userId: string): Promise<{ shareChatForImprovement: boolean; updatedAtMs: number | null }> {
    const r = await this.pool.query(
      `SELECT share_chat_for_improvement, share_chat_updated_at_ms FROM portal_users WHERE user_id = $1`,
      [userId]
    );
    const row = r.rows[0];
    return {
      shareChatForImprovement: row?.share_chat_for_improvement === true,
      updatedAtMs: row?.share_chat_updated_at_ms == null ? null : Number(row.share_chat_updated_at_ms)
    };
  }

  async setChatSharing(userId: string, share: boolean, atMs = Date.now()): Promise<void> {
    await this.pool.query(
      `UPDATE portal_users SET share_chat_for_improvement = $2, share_chat_updated_at_ms = $3 WHERE user_id = $1`,
      [userId, share, atMs]
    );
  }

  /**
   * The ONE place improvement tooling may read chat text from: decrypted messages of users who have
   * share_chat_for_improvement on right now (consent is checked at read time, so turning it off
   * withdraws earlier messages too). Messages that can't be decrypted are left out. Oldest first,
   * keyset-paged by (created_at_ms, message_id): pass `next` back as `after`; null when done.
   */
  async listSharedChatMessages(opts: { limit?: number; after?: SharedChatCursor } = {}): Promise<{ messages: SharedChatMessage[]; next: SharedChatCursor | null }> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 500)), 5000);
    const after = opts.after ?? { createdAtMs: -1, messageId: "" };
    const r = await this.pool.query(
      `SELECT c.user_id, m.conversation_id, m.message_id, m.role, m.content, m.created_at_ms
       FROM portal_messages m
       JOIN portal_conversations c ON c.conversation_id = m.conversation_id
       JOIN portal_users u ON u.user_id = c.user_id
       WHERE u.share_chat_for_improvement = TRUE
         AND (m.created_at_ms, m.message_id) > ($1::bigint, $2::text)
       ORDER BY m.created_at_ms, m.message_id
       LIMIT $3`,
      [after.createdAtMs, after.messageId, limit]
    );
    const out: SharedChatMessage[] = [];
    for (const row of r.rows) {
      let content: string;
      try {
        content = this.chatCipher.open(row.content, messageAad(row.conversation_id, row.message_id));
      } catch {
        continue;
      }
      out.push({
        userId: row.user_id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        role: row.role,
        content,
        createdAtMs: Number(row.created_at_ms)
      });
    }
    const last = r.rows.at(-1);
    return { messages: out, next: r.rows.length < limit || !last ? null : { createdAtMs: Number(last.created_at_ms), messageId: last.message_id } };
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM portal_conversations WHERE conversation_id = $1`,
      [conversationId]
    );
  }

  async saveGitHubToken(input: {
    userId: string;
    accessToken: string;
    githubLogin?: string;
    githubAvatarUrl?: string;
    scopes?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_github_tokens (user_id, access_token, github_login, github_avatar_url, scopes, updated_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         github_login = EXCLUDED.github_login,
         github_avatar_url = EXCLUDED.github_avatar_url,
         scopes = EXCLUDED.scopes,
         updated_at_ms = EXCLUDED.updated_at_ms`,
      [input.userId, input.accessToken, input.githubLogin ?? null, input.githubAvatarUrl ?? null, input.scopes ?? null, Date.now()]
    );
  }

  async getGitHubToken(userId: string): Promise<{ accessToken: string; githubLogin: string | null; githubAvatarUrl: string | null } | null> {
    const result = await this.pool.query(
      `SELECT access_token, github_login, github_avatar_url FROM portal_github_tokens WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      accessToken: row.access_token,
      githubLogin: row.github_login ?? null,
      githubAvatarUrl: row.github_avatar_url ?? null,
    };
  }

  async deleteGitHubToken(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM portal_github_tokens WHERE user_id = $1`, [userId]);
  }

  async getStatsCounts(): Promise<{
    users: { total: number; verified: number };
    nodes: { total: number; approved: number; active: number; agents: number; coordinators: number };
  }> {
    const [usersResult, nodesResult] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE email_verified) AS verified FROM portal_users`
      ),
      this.pool.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE node_approved) AS approved,
                COUNT(*) FILTER (WHERE active) AS active,
                COUNT(*) FILTER (WHERE node_kind = 'agent') AS agents,
                COUNT(*) FILTER (WHERE node_kind = 'coordinator') AS coordinators
         FROM portal_node_enrollments`
      )
    ]);
    const u = usersResult.rows[0];
    const n = nodesResult.rows[0];
    return {
      users: { total: Number(u.total), verified: Number(u.verified) },
      nodes: {
        total: Number(n.total),
        approved: Number(n.approved),
        active: Number(n.active),
        agents: Number(n.agents),
        coordinators: Number(n.coordinators)
      }
    };
  }
}

/**
 * portal_messages.tokens_used and credits_spent are INTEGER columns; a network chat reports a
 * fractional cSats cost (0.434). Rounded here (the coordinator's ledger keeps the exact amount):
 * the fraction made the insert throw after the reply had streamed (2026-11-17).
 */
export function wholeNumber(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
