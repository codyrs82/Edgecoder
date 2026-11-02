import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASE_SERVICES,
  INFRA_DEFAULTS,
  INFRA_ENV_VARS,
  INFRA_NETWORKS,
  MIN_PRUNE_MIB,
  SECRET_VARS,
  TEMPLATE_PLACEHOLDERS,
  networkDerived,
  parseEnvFile,
  renderInfraEnv,
  rpcauthLine,
  servicesFromCompose,
  validateInfraOptions,
  type InfraEnvOptions
} from "../../src/install/infra-role.js";

const repo = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(repo(rel), "utf8");
const VAR_NAMES = INFRA_ENV_VARS.map((v) => v.name);

/** Deterministic "random": n bytes -> n repetitions of "ab". */
const fakeRandom = (bytes: number) => "ab".repeat(bytes);
const base: InfraEnvOptions = { network: "signet", coordinatorPublicUrl: "https://infra.example:4301", random: fakeRandom };

describe("infra role: networks and services", () => {
  it("derives chain, lnd network and P2P port per network", () => {
    expect(networkDerived("bitcoin")).toEqual({ chain: "main", lndNetwork: "mainnet", p2pPort: 8333 });
    expect(networkDerived("testnet")).toEqual({ chain: "test", lndNetwork: "testnet", p2pPort: 18333 });
    expect(networkDerived("signet")).toEqual({ chain: "signet", lndNetwork: "signet", p2pPort: 38333 });
  });

  it("servicesFromCompose declares the base services plus electrs for the indexer profile", () => {
    expect(servicesFromCompose([])).toEqual([...BASE_SERVICES]);
    expect(servicesFromCompose(["indexer"])).toEqual(["coordinator", "bitcoind", "lightning", "electrs"]);
    expect(() => servicesFromCompose(["gpu"])).toThrow(/unknown compose profile/);
  });
});

describe("infra role: renderInfraEnv", () => {
  it("renders every variable once, with derived values and generated secrets", () => {
    const text = renderInfraEnv({ ...base, profiles: ["indexer"], accountId: "acct_1", lightningAddress: "ops@infra.example", lndExternalIp: "203.0.113.9" });
    const env = parseEnvFile(text);
    expect(Object.keys(env)).toEqual(VAR_NAMES);
    for (const name of VAR_NAMES) expect(text.match(new RegExp(`^${name}=`, "gm"))).toHaveLength(1);
    expect(env).toMatchObject({
      BITCOIN_NETWORK: "signet",
      BITCOIN_CHAIN: "signet",
      LND_NETWORK: "signet",
      BITCOIN_P2P_PORT: "38333",
      BITCOIN_PRUNE: "0",
      BITCOIN_DBCACHE: String(INFRA_DEFAULTS.dbcacheMib),
      COMPOSE_PROFILES: "indexer",
      INFRA_HOST_SERVICES: "coordinator,bitcoind,lightning,electrs",
      INFRA_HOST_ACCOUNT_ID: "acct_1",
      INFRA_HOST_LIGHTNING_ADDRESS: "ops@infra.example",
      LND_EXTERNAL_IP: "203.0.113.9",
      ECONOMY_PAYMENTS_ENABLED: "false",
      PORTAL_SERVICE_URL: INFRA_DEFAULTS.portalServiceUrl,
      COORDINATOR_BOOTSTRAP_URLS: INFRA_DEFAULTS.coordinatorBootstrapUrls.join(",")
    });
    expect(env.MESH_AUTH_TOKEN).toBe("ab".repeat(32));
    expect(env.BITCOIND_RPCAUTH_SALT).toBe("ab".repeat(16));
    expect(env.BITCOIND_RPC_PASSWORD).toBe("ab".repeat(24));
    expect(text.includes("$")).toBe(false);
  });

  it("keeps secrets it is given and maps mainnet with pruning", () => {
    const env = parseEnvFile(renderInfraEnv({ ...base, network: "bitcoin", pruneMib: 50000, paymentsEnabled: true, secrets: { MESH_AUTH_TOKEN: "keep-me", POSTGRES_PASSWORD: " pg " } }));
    expect(env.MESH_AUTH_TOKEN).toBe("keep-me");
    expect(env.POSTGRES_PASSWORD).toBe("pg");
    expect(env.ADMIN_API_TOKEN).toBe("ab".repeat(32));
    expect(env).toMatchObject({ BITCOIN_NETWORK: "bitcoin", BITCOIN_CHAIN: "main", LND_NETWORK: "mainnet", BITCOIN_P2P_PORT: "8333", BITCOIN_PRUNE: "50000", ECONOMY_PAYMENTS_ENABLED: "true", INFRA_HOST_SERVICES: "coordinator,bitcoind,lightning" });
  });

  it("rejects bad networks, prune targets, profiles and URLs", () => {
    expect(() => validateInfraOptions({ ...base, network: "regtest" as never })).toThrow(/network must be one of/);
    expect(() => validateInfraOptions({ ...base, pruneMib: 100 })).toThrow(new RegExp(`at least ${MIN_PRUNE_MIB}`));
    expect(() => validateInfraOptions({ ...base, pruneMib: 1.5 })).toThrow(/whole number/);
    expect(() => validateInfraOptions({ ...base, pruneMib: 1000, profiles: ["indexer"] })).toThrow(/unpruned/);
    expect(() => validateInfraOptions({ ...base, profiles: ["nope"] })).toThrow(/unknown compose profile/);
    expect(() => validateInfraOptions({ ...base, dbcacheMib: 1 })).toThrow(/dbcache/);
    expect(() => validateInfraOptions({ ...base, lndExternalIp: "1.2.3.4 5" })).toThrow(/external ip/);
    expect(() => validateInfraOptions({ ...base, coordinatorPublicUrl: "infra.example" })).toThrow(/not a URL/);
    expect(() => validateInfraOptions({ ...base, coordinatorPublicUrl: "ftp://x" })).toThrow(/http/);
    expect(() => validateInfraOptions({ ...base, pruneMib: MIN_PRUNE_MIB })).not.toThrow();
    for (const network of INFRA_NETWORKS) expect(() => validateInfraOptions({ ...base, network })).not.toThrow();
  });

  it("refuses values compose would interpolate and bad random sources", () => {
    expect(() => renderInfraEnv({ ...base, lndAlias: "pay$me" })).toThrow(/must not contain '\$'/);
    expect(() => renderInfraEnv({ ...base, random: () => "zz" })).toThrow(/hex/);
  });
});

describe("infra role: rpcauth", () => {
  const salt = "0123456789abcdef0123456789abcdef";

  it("builds user:salt$hmac like share/rpcauth/rpcauth.py", () => {
    const line = rpcauthLine("edgecoder", "hunter2", salt);
    const mac = createHmac("sha256", salt).update("hunter2").digest("hex");
    expect(line).toBe(`edgecoder:${salt}$${mac}`);
    expect(() => rpcauthLine("u", "p", "abc")).toThrow(/salt/);
  });

  const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!hasOpenssl)("matches the openssl pipeline scripts/infra-bootstrap.sh uses", () => {
    const shell = execFileSync("bash", ["-c", `printf '%s' "$1" | openssl dgst -sha256 -hmac "$2" | awk '{ print $NF }'`, "_", "hunter2", salt], { encoding: "utf8" }).trim();
    expect(rpcauthLine("edgecoder", "hunter2", salt)).toBe(`edgecoder:${salt}$${shell}`);
  });
});

describe("infra role: deploy files stay in step with the variable table", () => {
  it(".env.example lists exactly the variables the module knows, in order", () => {
    const example = read("deploy/infra/.env.example");
    const keys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(keys).toEqual(VAR_NAMES);
    // Secrets and derived values are filled by the bootstrap: the example leaves secrets empty.
    const env = parseEnvFile(example);
    for (const s of SECRET_VARS) expect(env[s], s).toBe("");
    expect(env.INFRA_HOST_SERVICES).toBe(servicesFromCompose([]).join(","));
    expect(networkDerived(env.BITCOIN_NETWORK as never)).toMatchObject({ chain: env.BITCOIN_CHAIN, lndNetwork: env.LND_NETWORK, p2pPort: Number(env.BITCOIN_P2P_PORT) });
  });

  it("docker-compose.yml only interpolates known variables and wires the providers", () => {
    const compose = read("deploy/infra/docker-compose.yml");
    const refs = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)[^}]*\}/g)].map((m) => m[1]));
    for (const r of refs) expect(VAR_NAMES, `compose references ${r}`).toContain(r);
    for (const name of ["BITCOIN_NETWORK", "BITCOIND_RPC_USER", "BITCOIND_RPC_PASSWORD", "INFRA_HOST_SERVICES", "INFRA_HOST_ACCOUNT_ID", "INFRA_HOST_LIGHTNING_ADDRESS", "MESH_AUTH_TOKEN"]) {
      expect(refs, `compose uses ${name}`).toContain(name);
    }
    expect(compose).toMatch(/BITCOIN_ANCHOR_PROVIDER: bitcoind/);
    expect(compose).toMatch(/LIGHTNING_PROVIDER: lnd/);
    expect(compose).toMatch(/LND_REST_URL: https:\/\/lnd:8080/);
    expect(compose).toMatch(/EDGE_RUNTIME_MODE: all-in-one/);
    expect(compose).toMatch(/profiles: \["indexer"\]/);
    // Images are pinned (no :latest, no floating tags).
    const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1]);
    expect(images.length).toBeGreaterThanOrEqual(5);
    for (const img of images) expect(img, img).not.toMatch(/:latest$|^[^:]+$/);
  });

  it("config templates use exactly the placeholders the bootstrap substitutes", () => {
    for (const [file, expected] of Object.entries(TEMPLATE_PLACEHOLDERS)) {
      const found = new Set([...read(`deploy/infra/${file}`).matchAll(/__([A-Z][A-Z0-9_]*)__/g)].map((m) => m[1]));
      expect([...found].sort(), file).toEqual([...expected].sort());
    }
    expect(read("deploy/infra/bitcoin.conf.template")).toMatch(/rpcallowip=172\.30\.0\.0\/24/);
    expect(read("deploy/infra/docker-compose.yml")).toMatch(/subnet: 172\.30\.0\.0\/24/);
  });

  it("the bootstrap script sets every derived and secret variable and avoids GNU-only tools", () => {
    const script = read("scripts/infra-bootstrap.sh");
    for (const v of INFRA_ENV_VARS.filter((x) => x.kind === "derived" || x.kind === "secret")) {
      expect(script, `bootstrap sets ${v.name}`).toMatch(new RegExp(`(set_env|ensure_secret) ${v.name}\\b`));
    }
    for (const placeholders of Object.values(TEMPLATE_PLACEHOLDERS)) {
      for (const p of placeholders) expect(script, `bootstrap substitutes ${p}`).toContain(`"${p}=`);
    }
    for (const gnuOnly of [/\bsed -i\b/, /readlink -f/, /\btimeout \d/, /\bmapfile\b/, /declare -A/, /\$\{[a-z_]+,,\}/, /date -d/, /grep -P/, /base64 -w/, /\bgrep -o[A-Za-z]*P/]) {
      expect(script, `uses ${gnuOnly}`).not.toMatch(gnuOnly);
    }
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("docs/infra-node.md documents the fee-pool weights and the commands", () => {
    const doc = read("docs/infra-node.md");
    expect(doc).toContain("scripts/infra-bootstrap.sh");
    expect(doc).toContain("deploy/infra/docker-compose.yml");
    for (const w of ["coordinator", "bitcoind", "lightning", "electrs"]) expect(doc).toContain(w);
    expect(doc).toMatch(/50%/);
    for (const name of ["INFRA_HOST_ACCOUNT_ID", "INFRA_HOST_LIGHTNING_ADDRESS", "INFRA_HOST_SERVICES"]) expect(doc).toContain(name);
  });
});
