// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Infrastructure node bundle (architecture step 5): the one variable table behind
 * deploy/infra/docker-compose.yml, deploy/infra/.env.example and scripts/infra-bootstrap.sh.
 * The bootstrap script is plain POSIX shell (an infra host may have Docker and nothing else),
 * so this module is the source of truth rather than a runtime dependency:
 * tests/install/infra-role.test.ts fails when .env.example, the compose file or the config
 * templates mention a variable this table does not know, or forget one it does.
 *
 * Everything here is pure: no fs, no process.env.
 */
import { createHmac } from "node:crypto";
import { DEFAULT_COORDINATOR_URL, DEFAULT_PORTAL_URL } from "./options.js";

export const INFRA_NETWORKS = ["bitcoin", "testnet", "signet"] as const;
export type InfraNetwork = (typeof INFRA_NETWORKS)[number];

/** Compose profiles the bundle understands; every service outside a profile always runs. */
export const INFRA_PROFILES = ["indexer"] as const;
export type InfraProfile = (typeof INFRA_PROFILES)[number];

/** bitcoind refuses prune targets below 550 MiB. */
export const MIN_PRUNE_MIB = 550;

/** Services declared in INFRA_HOST_SERVICES that always run in the bundle (see payouts hostWeight). */
export const BASE_SERVICES = ["coordinator", "bitcoind", "lightning"] as const;

export interface NetworkDerived {
  /** bitcoind `chain=` value. */
  chain: "main" | "test" | "signet";
  /** lnd `bitcoin.<network>=1` key and the macaroon directory name. */
  lndNetwork: "mainnet" | "testnet" | "signet";
  /** Default P2P port bitcoind listens on for that chain (published on the host). */
  p2pPort: 8333 | 18333 | 38333;
}

export function networkDerived(network: InfraNetwork): NetworkDerived {
  switch (network) {
    case "bitcoin": return { chain: "main", lndNetwork: "mainnet", p2pPort: 8333 };
    case "testnet": return { chain: "test", lndNetwork: "testnet", p2pPort: 18333 };
    case "signet": return { chain: "signet", lndNetwork: "signet", p2pPort: 38333 };
  }
}

/**
 * INFRA_HOST_SERVICES for a set of compose profiles: the always-on services plus "electrs"
 * when the indexer profile is enabled. Order is stable so .env diffs stay quiet.
 */
export function servicesFromCompose(profiles: readonly string[]): string[] {
  const unknown = profiles.filter((p) => !(INFRA_PROFILES as readonly string[]).includes(p));
  if (unknown.length) throw new Error(`unknown compose profile(s): ${unknown.join(", ")} (known: ${INFRA_PROFILES.join(", ")})`);
  const services: string[] = [...BASE_SERVICES];
  if (profiles.includes("indexer")) services.push("electrs");
  return services;
}

export type InfraVarKind = "choice" | "value" | "secret" | "derived";

export interface InfraEnvVar {
  name: string;
  kind: InfraVarKind;
  description: string;
}

/** Every variable in deploy/infra/.env, in file order. */
export const INFRA_ENV_VARS: InfraEnvVar[] = [
  { name: "BITCOIN_NETWORK", kind: "choice", description: "bitcoin | testnet | signet. Read by the coordinator (anchor network) and electrs." },
  { name: "BITCOIN_CHAIN", kind: "derived", description: "bitcoind chain= value derived from BITCOIN_NETWORK (main | test | signet)." },
  { name: "LND_NETWORK", kind: "derived", description: "lnd network derived from BITCOIN_NETWORK (mainnet | testnet | signet); also the macaroon directory." },
  { name: "BITCOIN_P2P_PORT", kind: "derived", description: "bitcoind P2P port for the chain (8333 | 18333 | 38333); published on the host." },
  { name: "BITCOIN_PRUNE", kind: "value", description: "0 keeps the full chain (required for the indexer profile); otherwise a prune target in MiB, at least 550." },
  { name: "BITCOIN_DBCACHE", kind: "value", description: "bitcoind UTXO cache in MiB; larger is faster for the initial sync." },
  { name: "BITCOIND_RPC_USER", kind: "value", description: "RPC user for bitcoind; the coordinator, lnd and electrs all use it." },
  { name: "BITCOIND_RPC_PASSWORD", kind: "secret", description: "RPC password; the rpcauth line in bitcoin.conf is derived from it." },
  { name: "BITCOIND_RPCAUTH_SALT", kind: "secret", description: "16-byte hex salt for the rpcauth HMAC (kept so re-rendering bitcoin.conf is deterministic)." },
  { name: "BITCOIND_WALLET_NAME", kind: "value", description: "bitcoind wallet the coordinator anchors checkpoints from (created by the bootstrap)." },
  { name: "LND_ALIAS", kind: "value", description: "Node alias advertised on the Lightning network." },
  { name: "LND_EXTERNAL_IP", kind: "value", description: "Public IP or host[:port] to advertise for inbound channels; empty advertises nothing." },
  { name: "LND_REST_BIND", kind: "value", description: "Host address the lnd REST port (8080) is published on; keep it on 127.0.0.1." },
  { name: "COMPOSE_PROFILES", kind: "choice", description: "Comma list of compose profiles to run; \"indexer\" adds electrs. Empty runs the base bundle." },
  { name: "ELECTRS_BIND", kind: "value", description: "Host address the Electrum RPC (50001) is published on when the indexer profile runs." },
  { name: "POSTGRES_USER", kind: "value", description: "Postgres role for the coordinator database." },
  { name: "POSTGRES_PASSWORD", kind: "secret", description: "Postgres password; DATABASE_URL is assembled from it in the compose file." },
  { name: "POSTGRES_DB", kind: "value", description: "Postgres database name." },
  { name: "COORDINATOR_PUBLIC_URL", kind: "value", description: "URL agents and peers reach this coordinator on (port 4301, ideally behind TLS)." },
  { name: "PORTAL_SERVICE_URL", kind: "value", description: "Portal the coordinator reports to (default: the public EdgeCoder portal)." },
  { name: "PORTAL_SERVICE_TOKEN", kind: "value", description: "Service token issued by the portal for this coordinator; the portal operator provides it." },
  { name: "COORDINATOR_REGISTRATION_TOKEN", kind: "value", description: "Token that lets this coordinator join the existing mesh (from the network operator)." },
  { name: "COORDINATOR_BOOTSTRAP_URLS", kind: "value", description: "Comma list of coordinators to peer with at start." },
  { name: "MESH_AUTH_TOKEN", kind: "secret", description: "Shared secret agents present to this coordinator (x-mesh-token)." },
  { name: "ADMIN_API_TOKEN", kind: "secret", description: "Control-plane admin token (port 4303, local only)." },
  { name: "INFERENCE_AUTH_TOKEN", kind: "secret", description: "Inference service token (port 4302, local only)." },
  { name: "PAYMENT_WEBHOOK_SECRET", kind: "secret", description: "HMAC secret for payment webhooks." },
  { name: "ECONOMY_PAYMENTS_ENABLED", kind: "choice", description: "true once lnd has a funded channel; false keeps the coordinator from paying out." },
  { name: "INFRA_HOST_ACCOUNT_ID", kind: "value", description: "Portal account that earns this host's share of the network fee pool." },
  { name: "INFRA_HOST_LIGHTNING_ADDRESS", kind: "value", description: "Lightning address (user@domain) fee-pool payouts are sent to." },
  { name: "INFRA_HOST_SERVICES", kind: "derived", description: "Services this host declares in its heartbeat: coordinator,bitcoind,lightning[,electrs]." }
];

export const SECRET_VARS = INFRA_ENV_VARS.filter((v) => v.kind === "secret").map((v) => v.name);

/** `__NAME__` placeholders scripts/infra-bootstrap.sh substitutes into the config templates. */
export const TEMPLATE_PLACEHOLDERS = {
  "bitcoin.conf.template": ["BITCOIN_CHAIN", "BITCOIN_PRUNE", "BITCOIN_DBCACHE", "BITCOIND_RPCAUTH"],
  "lnd.conf.template": ["LND_ALIAS", "LND_NETWORK", "LND_EXTERNALIP_LINE", "BITCOIND_RPC_USER", "BITCOIND_RPC_PASSWORD"]
} as const;

export interface InfraEnvOptions {
  network: InfraNetwork;
  /** 0 = full node (default). Otherwise MiB >= 550. */
  pruneMib?: number;
  profiles?: string[];
  dbcacheMib?: number;
  coordinatorPublicUrl: string;
  portalServiceUrl?: string;
  portalServiceToken?: string;
  coordinatorRegistrationToken?: string;
  coordinatorBootstrapUrls?: string[];
  accountId?: string;
  lightningAddress?: string;
  lndAlias?: string;
  lndExternalIp?: string;
  lndRestBind?: string;
  electrsBind?: string;
  postgresUser?: string;
  postgresDb?: string;
  rpcUser?: string;
  walletName?: string;
  paymentsEnabled?: boolean;
  /** Pre-set secrets (e.g. from an existing .env); missing ones are generated with `random`. */
  secrets?: Partial<Record<string, string>>;
  /** Hex of `bytes` random bytes. Injected so tests are deterministic. */
  random: (bytes: number) => string;
}

export const INFRA_DEFAULTS = {
  dbcacheMib: 2000,
  portalServiceUrl: DEFAULT_PORTAL_URL,
  coordinatorBootstrapUrls: [DEFAULT_COORDINATOR_URL],
  lndAlias: "edgecoder-infra",
  lndRestBind: "127.0.0.1:8080",
  electrsBind: "127.0.0.1:50001",
  postgresUser: "edgecoder",
  postgresDb: "edgecoder",
  rpcUser: "edgecoder",
  walletName: "edgecoder-anchor"
} as const;

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Throws with a message naming the option when an option combination cannot run. */
export function validateInfraOptions(opts: Pick<InfraEnvOptions, "network" | "pruneMib" | "profiles" | "dbcacheMib" | "lndExternalIp" | "coordinatorPublicUrl">): void {
  if (!(INFRA_NETWORKS as readonly string[]).includes(opts.network)) {
    throw new Error(`network must be one of ${INFRA_NETWORKS.join(", ")} (got ${String(opts.network)})`);
  }
  const prune = opts.pruneMib ?? 0;
  if (!isPositiveInt(prune)) throw new Error("prune must be 0 or a whole number of MiB");
  if (prune > 0 && prune < MIN_PRUNE_MIB) throw new Error(`prune must be 0 (full node) or at least ${MIN_PRUNE_MIB} MiB (got ${prune})`);
  const profiles = opts.profiles ?? [];
  servicesFromCompose(profiles); // validates the profile names
  if (prune > 0 && profiles.includes("indexer")) throw new Error("the indexer profile (electrs) needs an unpruned node: set prune to 0 or drop the profile");
  if (opts.dbcacheMib !== undefined && (!isPositiveInt(opts.dbcacheMib) || opts.dbcacheMib < 4)) throw new Error("dbcache must be a whole number of MiB (at least 4)");
  if (opts.lndExternalIp !== undefined && /[\s,]/.test(opts.lndExternalIp)) throw new Error("lnd external ip must be a single host[:port] without spaces");
  let url: URL;
  try { url = new URL(opts.coordinatorPublicUrl); } catch { throw new Error(`coordinator public url is not a URL: ${opts.coordinatorPublicUrl}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("coordinator public url must be http(s)");
}

/**
 * Bitcoin Core's rpcauth line (share/rpcauth/rpcauth.py): `user:salt$hmac_sha256(salt, password)`.
 * The bootstrap script computes the same thing with openssl.
 */
export function rpcauthLine(user: string, password: string, saltHex: string): string {
  if (!/^[0-9a-f]{32}$/.test(saltHex)) throw new Error("rpcauth salt must be 16 bytes of lowercase hex");
  const mac = createHmac("sha256", saltHex).update(password).digest("hex");
  return `${user}:${saltHex}$${mac}`;
}

/** Parse KEY=value lines (no quoting, no interpolation: the compose .env dialect we write). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Render deploy/infra/.env. Validates first; every INFRA_ENV_VARS entry appears exactly once. */
export function renderInfraEnv(opts: InfraEnvOptions): string {
  validateInfraOptions(opts);
  const d = networkDerived(opts.network);
  const profiles = opts.profiles ?? [];
  const secrets = opts.secrets ?? {};
  const secret = (name: string, bytes: number) => {
    const existing = secrets[name];
    if (existing && existing.trim()) return existing.trim();
    const value = opts.random(bytes);
    if (!/^[0-9a-f]+$/.test(value) || value.length !== bytes * 2) throw new Error(`random(${bytes}) must return ${bytes * 2} hex characters`);
    return value;
  };
  const values: Record<string, string> = {
    BITCOIN_NETWORK: opts.network,
    BITCOIN_CHAIN: d.chain,
    LND_NETWORK: d.lndNetwork,
    BITCOIN_P2P_PORT: String(d.p2pPort),
    BITCOIN_PRUNE: String(opts.pruneMib ?? 0),
    BITCOIN_DBCACHE: String(opts.dbcacheMib ?? INFRA_DEFAULTS.dbcacheMib),
    BITCOIND_RPC_USER: opts.rpcUser ?? INFRA_DEFAULTS.rpcUser,
    BITCOIND_RPC_PASSWORD: secret("BITCOIND_RPC_PASSWORD", 24),
    BITCOIND_RPCAUTH_SALT: secret("BITCOIND_RPCAUTH_SALT", 16),
    BITCOIND_WALLET_NAME: opts.walletName ?? INFRA_DEFAULTS.walletName,
    LND_ALIAS: opts.lndAlias ?? INFRA_DEFAULTS.lndAlias,
    LND_EXTERNAL_IP: opts.lndExternalIp ?? "",
    LND_REST_BIND: opts.lndRestBind ?? INFRA_DEFAULTS.lndRestBind,
    ELECTRS_BIND: opts.electrsBind ?? INFRA_DEFAULTS.electrsBind,
    COMPOSE_PROFILES: profiles.join(","),
    POSTGRES_USER: opts.postgresUser ?? INFRA_DEFAULTS.postgresUser,
    POSTGRES_PASSWORD: secret("POSTGRES_PASSWORD", 24),
    POSTGRES_DB: opts.postgresDb ?? INFRA_DEFAULTS.postgresDb,
    COORDINATOR_PUBLIC_URL: opts.coordinatorPublicUrl,
    PORTAL_SERVICE_URL: opts.portalServiceUrl ?? INFRA_DEFAULTS.portalServiceUrl,
    PORTAL_SERVICE_TOKEN: opts.portalServiceToken ?? "",
    COORDINATOR_REGISTRATION_TOKEN: opts.coordinatorRegistrationToken ?? "",
    COORDINATOR_BOOTSTRAP_URLS: (opts.coordinatorBootstrapUrls ?? [...INFRA_DEFAULTS.coordinatorBootstrapUrls]).join(","),
    MESH_AUTH_TOKEN: secret("MESH_AUTH_TOKEN", 32),
    ADMIN_API_TOKEN: secret("ADMIN_API_TOKEN", 32),
    INFERENCE_AUTH_TOKEN: secret("INFERENCE_AUTH_TOKEN", 32),
    PAYMENT_WEBHOOK_SECRET: secret("PAYMENT_WEBHOOK_SECRET", 32),
    ECONOMY_PAYMENTS_ENABLED: opts.paymentsEnabled ? "true" : "false",
    INFRA_HOST_ACCOUNT_ID: opts.accountId ?? "",
    INFRA_HOST_LIGHTNING_ADDRESS: opts.lightningAddress ?? "",
    INFRA_HOST_SERVICES: servicesFromCompose(profiles).join(",")
  };
  const lines = [
    "# EdgeCoder infrastructure node: generated by scripts/infra-bootstrap.sh.",
    `# Network: ${opts.network}. Variables are documented in deploy/infra/.env.example.`,
    ""
  ];
  for (const v of INFRA_ENV_VARS) {
    const value = values[v.name];
    if (value === undefined) throw new Error(`renderInfraEnv: no value for ${v.name}`);
    if (/[\r\n]/.test(value)) throw new Error(`${v.name} must be a single line`);
    if (value.includes("$")) throw new Error(`${v.name} must not contain '$' (docker compose interpolates it)`);
    lines.push(`${v.name}=${value}`);
  }
  return lines.join("\n") + "\n";
}
