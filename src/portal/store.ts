// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { Pool } from "pg";

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
};

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
  constructor(private readonly pool: Pool) {}

  static fromEnv(): PortalStore | null {
    const url = process.env.PORTAL_DATABASE_URL;
    if (!url) return null;
    return new PortalStore(new Pool({ connectionString: url }));
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
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
    await this.migratePayoutDestinations();
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
  }): Promise<PortalUser> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO portal_users (
        user_id, email, email_verified, ui_theme, password_hash, display_name, created_at_ms, verified_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.userId,
        input.email,
        input.emailVerified,
        input.uiTheme ?? "warm",
        input.passwordHash ?? null,
        input.displayName ?? null,
        now,
        input.emailVerified ? now : null
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

  async createEmailVerification(input: {
    tokenId: string;
    userId: string;
    tokenHash: string;
    expiresAtMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_email_verifications (
        token_id, user_id, token_hash, expires_at_ms, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5)`,
      [input.tokenId, input.userId, input.tokenHash, input.expiresAtMs, Date.now()]
    );
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
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_oauth_states (state_id, provider, redirect_uri, expires_at_ms, created_at_ms, native_redirect, link_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.stateId, input.provider, input.redirectUri, input.expiresAtMs, Date.now(), input.nativeRedirect ?? null, input.linkUserId ?? null]
    );
  }

  async consumeOauthState(stateId: string): Promise<{ provider: string; redirectUri: string; nativeRedirect?: string; linkUserId?: string } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `DELETE FROM portal_oauth_states
       WHERE state_id = $1 AND expires_at_ms > $2
       RETURNING provider, redirect_uri, native_redirect, link_user_id`,
      [stateId, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      provider: row.provider,
      redirectUri: row.redirect_uri,
      ...(row.native_redirect ? { nativeRedirect: row.native_redirect } : {}),
      ...(row.link_user_id ? { linkUserId: row.link_user_id } : {})
    };
  }

  /** One-time code a native app redeems for a session after OAuth (stored hashed, single use). */
  async issueMobileOauthToken(tokenHash: string, userId: string, expiresAtMs: number): Promise<void> {
    await this.pool.query(`DELETE FROM portal_mobile_oauth_tokens WHERE expires_at_ms <= $1`, [Date.now()]);
    await this.pool.query(
      `INSERT INTO portal_mobile_oauth_tokens (token_hash, user_id, expires_at_ms) VALUES ($1,$2,$3)`,
      [tokenHash, userId, expiresAtMs]
    );
  }

  /** Redeem a mobile OAuth code; the DELETE ... RETURNING makes it single-use across instances. */
  async consumeMobileOauthToken(tokenHash: string): Promise<string | null> {
    const result = await this.pool.query(
      `DELETE FROM portal_mobile_oauth_tokens WHERE token_hash = $1 AND expires_at_ms > $2 RETURNING user_id`,
      [tokenHash, Date.now()]
    );
    return result.rows[0]?.user_id ?? null;
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
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE node_id = $1`,
      [nodeId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapNodeRow(row);
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
    limit?: number;
  }): Promise<NodeEnrollment[]> {
    const limit = Math.max(1, Math.min(500, options?.limit ?? 200));
    const args: Array<string | number> = [limit];
    let where = "WHERE node_approved = FALSE";
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
  }): Promise<void> {
    await this.pool.query(
      `UPDATE portal_node_enrollments
       SET last_seen_ms = $2,
           last_ip = COALESCE($3, last_ip),
           last_country_code = COALESCE($4, last_country_code),
           last_vpn_detected = COALESCE($5, last_vpn_detected),
           updated_at_ms = $2
       WHERE node_id = $1`,
      [input.nodeId, Date.now(), input.sourceIp ?? null, input.countryCode ?? null, input.vpnDetected ?? null]
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

  async listActiveCoordinators(): Promise<NodeEnrollment[]> {
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, dns_hostname, dns_status, dns_ip, dns_last_updated_ms,
        created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE node_kind = 'coordinator'
         AND active = TRUE
         AND dns_status = 'active'
         AND dns_ip IS NOT NULL
       ORDER BY last_seen_ms DESC NULLS LAST`
    );
    return result.rows.map((row: any) => this.mapNodeRow(row));
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

  async consumeWalletSendMfaChallenge(challengeId: string): Promise<{
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
         AND consumed_at_ms IS NULL
         AND expires_at_ms > $2
       RETURNING challenge_id, user_id, account_id, destination, amount_sats, note, email_code_hash, passkey_challenge, expires_at_ms`,
      [challengeId, now]
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
  }): Promise<void> {
    await this.pool.query(
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
        last_used_at_ms = EXCLUDED.last_used_at_ms`,
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
      [input.conversationId, input.userId, input.title ?? "New chat", now, now]
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
      title: r.title,
      createdAtMs: Number(r.created_at_ms),
      updatedAtMs: Number(r.updated_at_ms)
    }));
  }

  /** The user_id that owns a conversation, or null if it does not exist. Used for authz checks. */
  async getConversationOwner(conversationId: string): Promise<string | null> {
    const r = await this.pool.query(`SELECT user_id FROM portal_conversations WHERE conversation_id = $1`, [conversationId]);
    return r.rows[0]?.user_id ?? null;
  }

  async getConversationMessages(conversationId: string): Promise<PortalMessage[]> {
    const result = await this.pool.query(
      `SELECT message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms
       FROM portal_messages WHERE conversation_id = $1
       ORDER BY created_at_ms ASC`,
      [conversationId]
    );
    return result.rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
      tokensUsed: Number(r.tokens_used),
      creditsSpent: Number(r.credits_spent),
      createdAtMs: Number(r.created_at_ms)
    }));
  }

  async addMessage(input: {
    messageId: string;
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    tokensUsed?: number;
    creditsSpent?: number;
  }): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO portal_messages (message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.messageId, input.conversationId, input.role, input.content, input.tokensUsed ?? 0, input.creditsSpent ?? 0, now]
    );
    await this.pool.query(
      `UPDATE portal_conversations SET updated_at_ms = $1 WHERE conversation_id = $2`,
      [now, input.conversationId]
    );
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    await this.pool.query(
      `UPDATE portal_conversations SET title = $1, updated_at_ms = $2 WHERE conversation_id = $3`,
      [title, Date.now(), conversationId]
    );
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

