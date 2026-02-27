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
  createdAtMs: number;
  updatedAtMs: number;
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
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_wallet_onboarding (
  user_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  seed_phrase_hash TEXT NOT NULL,
  encrypted_private_key_ref TEXT NOT NULL,
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
    await this.pool.query(
      `UPDATE portal_node_enrollments
       SET device_id = regexp_replace(lower(node_id), '^(ios-|iphone-)', '')
       WHERE device_id IS NULL
         AND node_id ~* '^(ios-|iphone-)'`
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
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
    provider: "google" | "apple" | "microsoft";
    providerSubject: string;
    userId: string;
    emailSnapshot?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_oauth_links (provider, provider_subject, user_id, email_snapshot, created_at_ms)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, provider_subject) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         email_snapshot = EXCLUDED.email_snapshot`,
      [input.provider, input.providerSubject, input.userId, input.emailSnapshot ?? null, Date.now()]
    );
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
    provider: "google" | "apple" | "microsoft";
    redirectUri: string;
    expiresAtMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_oauth_states (state_id, provider, redirect_uri, expires_at_ms, created_at_ms)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.stateId, input.provider, input.redirectUri, input.expiresAtMs, Date.now()]
    );
  }

  async consumeOauthState(stateId: string): Promise<{ provider: string; redirectUri: string } | null> {
    const now = Date.now();
    const result = await this.pool.query(
      `DELETE FROM portal_oauth_states
       WHERE state_id = $1 AND expires_at_ms > $2
       RETURNING provider, redirect_uri`,
      [stateId, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { provider: row.provider, redirectUri: row.redirect_uri };
  }

  async upsertNodeEnrollment(input: {
    nodeId: string;
    deviceId?: string;
    nodeKind: "agent" | "coordinator";
    ownerUserId: string;
    ownerEmail: string;
    registrationTokenHash: string;
    emailVerified: boolean;
  }): Promise<NodeEnrollment> {
    const now = Date.now();
    const normalizedDeviceId = input.deviceId?.trim().toLowerCase() || undefined;
    let targetNodeId = input.nodeId;
    if (normalizedDeviceId) {
      const existingByDevice = await this.getNodeEnrollmentByDeviceId(normalizedDeviceId);
      if (existingByDevice) {
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
      RETURNING
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, created_at_ms, updated_at_ms`,
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async getNodeEnrollment(nodeId: string): Promise<NodeEnrollment | null> {
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE node_id = $1`,
      [nodeId]
    );
    const row = result.rows[0];
    if (!row) return null;
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async listNodesByOwner(userId: string): Promise<NodeEnrollment[]> {
    const result = await this.pool.query(
      `SELECT
        node_id, device_id, node_kind, owner_user_id, owner_email, registration_token_hash,
        email_verified, node_approved, active, last_seen_ms, last_ip, last_country_code,
        last_vpn_detected, created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       WHERE owner_user_id = $1
       ORDER BY updated_at_ms DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }));
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
        last_vpn_detected, created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       ${where}
       ORDER BY updated_at_ms DESC
       LIMIT $1`,
      args
    );
    return result.rows.map((row) => ({
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }));
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
        last_vpn_detected, created_at_ms, updated_at_ms
       FROM portal_node_enrollments
       ${where}
       ORDER BY updated_at_ms DESC
       LIMIT $1`,
      args
    );
    return result.rows.map((row) => ({
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }));
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
         last_vpn_detected, created_at_ms, updated_at_ms`,
      [nodeId, approved, now]
    );
    const row = result.rows[0];
    if (!row) return null;
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
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
        last_vpn_detected, created_at_ms, updated_at_ms
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
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async getWalletOnboardingByUserId(userId: string): Promise<{
    userId: string;
    accountId: string;
    network: string;
    seedPhraseHash: string;
    encryptedPrivateKeyRef: string;
    createdAtMs: number;
    acknowledgedAtMs?: number;
  } | null> {
    const result = await this.pool.query(
      `SELECT user_id, account_id, network, seed_phrase_hash, encrypted_private_key_ref, created_at_ms, acknowledged_at_ms
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
      createdAtMs: Number(row.created_at_ms),
      acknowledgedAtMs: row.acknowledged_at_ms ? Number(row.acknowledged_at_ms) : undefined
    };
  }

  async createWalletOnboarding(input: {
    userId: string;
    accountId: string;
    network: string;
    seedPhraseHash: string;
    encryptedPrivateKeyRef: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_wallet_onboarding (
        user_id, account_id, network, seed_phrase_hash, encrypted_private_key_ref, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id) DO NOTHING`,
      [
        input.userId,
        input.accountId,
        input.network,
        input.seedPhraseHash,
        input.encryptedPrivateKeyRef,
        Date.now()
      ]
    );
  }

  async upsertWalletOnboardingSeed(input: {
    userId: string;
    accountId: string;
    network: string;
    seedPhraseHash: string;
    encryptedPrivateKeyRef: string;
  }): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO portal_wallet_onboarding (
        user_id, account_id, network, seed_phrase_hash, encrypted_private_key_ref, created_at_ms, acknowledged_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        network = EXCLUDED.network,
        seed_phrase_hash = EXCLUDED.seed_phrase_hash,
        encrypted_private_key_ref = EXCLUDED.encrypted_private_key_ref,
        created_at_ms = EXCLUDED.created_at_ms,
        acknowledged_at_ms = NULL`,
      [input.userId, input.accountId, input.network, input.seedPhraseHash, input.encryptedPrivateKeyRef, now]
    );
  }

  async acknowledgeWalletOnboarding(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE portal_wallet_onboarding
       SET acknowledged_at_ms = COALESCE(acknowledged_at_ms, $2)
       WHERE user_id = $1`,
      [userId, Date.now()]
    );
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

