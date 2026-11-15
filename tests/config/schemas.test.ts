import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, isSecretEnvName, loadConfig, loadConfigOrExit } from "../../src/common/config.js";
import { schemaVariableNames, SERVICE_SCHEMAS, type ServiceName } from "../../src/config/index.js";
import { portalProductionProblems } from "../../src/portal/config.js";

// #15: every service's schema fails fast with a message that names the variable, and never prints a secret.

const root = fileURLToPath(new URL("../../", import.meta.url));
const services = Object.keys(SERVICE_SCHEMAS) as ServiceName[];

/** The variables a service refuses to start without, in every environment. */
const REQUIRED: Record<ServiceName, Record<string, string>> = {
  coordinator: {},
  portal: {},
  inference: { INFERENCE_AUTH_TOKEN: "i".repeat(32) },
  "control-plane": { ADMIN_API_TOKEN: "a".repeat(32) },
  "anchor-proxy": { ANCHOR_PROXY_TOKEN: "proxy-token", BITCOIND_RPC_URL: "http://127.0.0.1:8332", BITCOIND_RPC_USER: "rpc", BITCOIND_RPC_PASSWORD: "rpc-password" },
  worker: {},
  "ide-provider": {},
  "all-in-one": {},
  launcher: {}
};

const load = (service: ServiceName, env: Record<string, string>) => loadConfig(service, SERVICE_SCHEMAS[service], { ...REQUIRED[service], ...env });

function problemsOf(service: ServiceName, env: Record<string, string>): string[] {
  try {
    loadConfig(service, SERVICE_SCHEMAS[service], env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  return [];
}

describe("service schemas: a valid minimal environment", () => {
  for (const service of services) {
    it(`${service} loads with only its required variables, and the result is frozen`, () => {
      const config = load(service, {}) as Record<string, unknown>;
      expect(Object.isFrozen(config)).toBe(true);
      expect(() => {
        config.HOST = "0.0.0.0";
      }).toThrow(TypeError);
    });

    it(`${service} ignores variables it does not declare`, () => {
      const config = load(service, { PATH: "/usr/bin", SOME_OTHER_TOOLS_SETTING: "not a number" }) as Record<string, unknown>;
      expect(config.SOME_OTHER_TOOLS_SETTING).toBeUndefined();
    });
  }

  it("keeps the defaults the services had before", () => {
    expect(load("all-in-one", {})).toMatchObject({ INFERENCE_PORT: 4302, COORDINATOR_PORT: 4301, CONTROL_PLANE_PORT: 4303, LOCAL_FORWARD_PORT: 4305, AGENT_MODE: "swarm-only", AGENT_OS: "macos" });
    expect(load("anchor-proxy", {})).toMatchObject({ ANCHOR_PROXY_PORT: 4311, BITCOIN_NETWORK: "signet", BITCOIND_WALLET_NAME: "", MAX_BROADCASTS_PER_MINUTE: 10, MAX_RECONCILE_CALLS_PER_MINUTE: 30 });
    expect(load("ide-provider", {})).toMatchObject({ IDE_PROVIDER_PORT: 4304 });
    expect(load("worker", {})).toMatchObject({ AGENT_MODE: "swarm-only", AGENT_CLIENT_TYPE: "edgecoder-native", COORDINATOR_HTTP_TIMEOUT_MS: 15_000, COORDINATOR_POST_RETRIES: 2, MAX_CONCURRENT_TASKS: 1 });
    // No default here: an unset COORDINATOR_URL is what turns coordinator discovery on.
    expect(load("worker", {}).COORDINATOR_URL).toBeUndefined();
  });

  it("treats an empty value as unset", () => {
    expect(load("all-in-one", { COORDINATOR_PORT: "", INFERENCE_PORT: "  " })).toMatchObject({ COORDINATOR_PORT: 4301, INFERENCE_PORT: 4302 });
  });
});

describe("service schemas: fail fast on a malformed value", () => {
  const cases: [ServiceName, string, string, string][] = [
    // non-numeric and out-of-range ports
    ["all-in-one", "COORDINATOR_PORT", "abc", 'COORDINATOR_PORT: must be an integer, got "abc"'],
    ["all-in-one", "INFERENCE_PORT", "70000", "INFERENCE_PORT: must be <= 65535"],
    ["all-in-one", "CONTROL_PLANE_PORT", "-1", "CONTROL_PLANE_PORT: must be >= 0"],
    ["anchor-proxy", "ANCHOR_PROXY_PORT", "43x1", 'ANCHOR_PROXY_PORT: must be an integer, got "43x1"'],
    ["ide-provider", "IDE_PROVIDER_PORT", "4304.5", 'IDE_PROVIDER_PORT: must be an integer, got "4304.5"'],
    ["ide-provider", "IDE_PREVIEW_PORT", "preview", 'IDE_PREVIEW_PORT: must be an integer, got "preview"'],
    ["worker", "LOCAL_FORWARD_PORT", "http", 'LOCAL_FORWARD_PORT: must be an integer, got "http"'],
    // bad URLs
    ["all-in-one", "AGENT_NETWORK_COORDINATOR_URL", "coordinator.local", "AGENT_NETWORK_COORDINATOR_URL: must be an http(s) URL"],
    ["anchor-proxy", "BITCOIND_RPC_URL", "bitcoind:8332", "BITCOIND_RPC_URL: is required and must be an http(s) URL"],
    ["worker", "COORDINATOR_URL", "localhost:4301", "COORDINATOR_URL: must be an http(s) URL"],
    ["worker", "PORTAL_URL", "ftp://portal.example", "PORTAL_URL: must be an http(s) URL"],
    ["ide-provider", "SWARM_VIA_LOCAL_AGENT_URL", "agent", "SWARM_VIA_LOCAL_AGENT_URL: must be an http(s) URL"],
    ["coordinator", "PORTAL_SERVICE_URL", "portal", "PORTAL_SERVICE_URL: must be an http(s) URL"],
    ["portal", "PORTAL_PUBLIC_URL", "edgecoder.io", "PORTAL_PUBLIC_URL: must be an http(s) URL"],
    ["inference", "OLLAMA_HOST", "ollama", "OLLAMA_HOST: must be an http(s) URL"],
    ["control-plane", "OLLAMA_HOST", "ollama", "OLLAMA_HOST: must be an http(s) URL"],
    // invalid enums
    ["all-in-one", "AGENT_MODE", "fast", "AGENT_MODE: must be one of swarm-only, ide-enabled"],
    ["anchor-proxy", "BITCOIN_NETWORK", "mainnet", "BITCOIN_NETWORK: must be one of bitcoin, testnet, signet, regtest"],
    ["worker", "SNAPSHOT_ENFORCEMENT", "loose", "SNAPSHOT_ENFORCEMENT: must be one of strict, warn, off"],
    ["worker", "LOCAL_MODEL_PROVIDER", "openai", "LOCAL_MODEL_PROVIDER: must be one of edgecoder-local, ollama-local"],
    ["coordinator", "LIGHTNING_PROVIDER", "paypal", "LIGHTNING_PROVIDER: must be one of lnd, cln, mock"],
    ["coordinator", "BITCOIN_ANCHOR_PROVIDER", "esplora", "BITCOIN_ANCHOR_PROVIDER: must be one of anchor-proxy, bitcoind, mock, blockstream"],
    ["coordinator", "NETWORK_MODE", "private", "NETWORK_MODE: must be one of public_mesh, enterprise_overlay"],
    ["coordinator", "LOG_LEVEL", "loud", "LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace, silent"],
    ["portal", "PORTAL_EDGE", "akamai", "PORTAL_EDGE: must be one of cloudflare, none"],
    ["portal", "PORTAL_DISCOVERY", "random", "PORTAL_DISCOVERY: must be one of selector, ordered"],
    // negative and non-numeric limits
    ["anchor-proxy", "MAX_BROADCASTS_PER_MINUTE", "-1", "MAX_BROADCASTS_PER_MINUTE: must be >= 0"],
    ["anchor-proxy", "MAX_RECONCILE_CALLS_PER_MINUTE", "many", 'MAX_RECONCILE_CALLS_PER_MINUTE: must be a number, got "many"'],
    ["worker", "MAX_CONCURRENT_TASKS", "-2", "MAX_CONCURRENT_TASKS: must be >= 0"],
    ["worker", "COORDINATOR_HTTP_TIMEOUT_MS", "soon", 'COORDINATOR_HTTP_TIMEOUT_MS: must be a number, got "soon"'],
    ["coordinator", "PAYOUT_MIN_SATS", "-5", "PAYOUT_MIN_SATS: must be >= 0"],
    ["portal", "PORTAL_EXTERNAL_HTTP_TIMEOUT_MS", "0", "PORTAL_EXTERNAL_HTTP_TIMEOUT_MS: must be >= 100"],
    // flags
    ["all-in-one", "DISABLE_SELF_AGENT", "maybe", "DISABLE_SELF_AGENT: must be one of 1, 0, true, false, yes, no, on, off"]
  ];

  for (const [service, name, value, problem] of cases) {
    it(`${service}: ${name}=${value}`, () => {
      expect(problemsOf(service, { ...REQUIRED[service], [name]: value })).toEqual([problem]);
    });
  }

  it("names the service and lists every problem in one error", () => {
    expect(() => load("all-in-one", { COORDINATOR_PORT: "abc", AGENT_MODE: "fast" })).toThrow(
      '[all-in-one] invalid configuration:\n  - COORDINATOR_PORT: must be an integer, got "abc"\n  - AGENT_MODE: must be one of swarm-only, ide-enabled'
    );
  });
});

describe("service schemas: missing variables that were already required", () => {
  it("anchor proxy: token and bitcoind RPC settings", () => {
    expect(problemsOf("anchor-proxy", {})).toEqual([
      "ANCHOR_PROXY_TOKEN: is required",
      "BITCOIND_RPC_URL: is required and must be an http(s) URL",
      "BITCOIND_RPC_USER: is required",
      "BITCOIND_RPC_PASSWORD: is required"
    ]);
    for (const name of Object.keys(REQUIRED["anchor-proxy"])) {
      const { [name]: _omitted, ...rest } = REQUIRED["anchor-proxy"];
      expect(problemsOf("anchor-proxy", rest).join("\n"), name).toContain(`${name}: is required`);
    }
  });

  it("inference and control plane: their tokens", () => {
    expect(problemsOf("inference", {})).toEqual(["INFERENCE_AUTH_TOKEN: is required"]);
    expect(problemsOf("control-plane", {})).toEqual(["ADMIN_API_TOKEN: is required"]);
  });

  it("requires nothing new of the services that had no required variables", () => {
    for (const service of ["coordinator", "portal", "worker", "ide-provider", "all-in-one", "launcher"] as const) {
      expect(problemsOf(service, {}), service).toEqual([]);
    }
  });
});

describe("config errors never print a secret", () => {
  it("knows which variable names are secrets", () => {
    for (const name of ["MESH_AUTH_TOKEN", "ADMIN_API_TOKEN", "BITCOIND_RPC_PASSWORD", "LND_MACAROON_HEX", "COORDINATOR_PRIVATE_KEY_PEM", "DATABASE_URL", "RESEND_API_KEY", "OAUTH_STATE_SECRET", "PAYMENT_WEBHOOK_SECRET", "NOSTR_SECRET_KEY_HEX", "WALLET_SECRET_PEPPER", "SENTRY_DSN"]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of ["MOBILE_OAUTH_TOKEN_TTL_MS", "COORDINATOR_PORT", "OLLAMA_HOST", "PAYOUT_MIN_SATS"]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("redacts a secret pasted into the wrong variable", () => {
    const token = "s3cr3t-proxy-token";
    const problems = problemsOf("anchor-proxy", { ...REQUIRED["anchor-proxy"], ANCHOR_PROXY_TOKEN: token, ANCHOR_PROXY_PORT: token });
    expect(problems).toEqual(['ANCHOR_PROXY_PORT: must be an integer, got "[redacted]"']);
  });

  it("does not echo a long value, which is more likely a credential than a number", () => {
    const pasted = "eyJhbGciOiJIUzI1NiJ9.e30.4f1g23a12aa";
    const [problem] = problemsOf("all-in-one", { COORDINATOR_PORT: pasted });
    expect(problem).toBe(`COORDINATOR_PORT: must be an integer, got a ${pasted.length}-character value`);
  });

  it("does not print an invalid secret's own value", () => {
    const weak = "changeme-admin";
    const message = (() => {
      try {
        load("control-plane", { NODE_ENV: "production", ADMIN_API_TOKEN: weak });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).toContain("ADMIN_API_TOKEN");
    expect(message).not.toContain(weak);
  });

  // Every variable of every schema set to a distinct wrong value: whatever the schema reports, no secret value is in it.
  for (const service of services) {
    it(`${service}: no secret value in the error when every variable is wrong`, () => {
      const env: Record<string, string> = {};
      const secrets: string[] = [];
      schemaVariableNames(service).forEach((name, i) => {
        env[name] = `zq${i}-wrong-value`;
        if (isSecretEnvName(name)) secrets.push(env[name]);
      });
      const message = problemsOf(service, env).join("\n");
      for (const secret of secrets) expect(message).not.toContain(secret);
      if (service !== "launcher") expect(message).not.toBe("");
    });
  }
});

describe("loadConfigOrExit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the problems and exits with code 1", () => {
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void printed.push(line));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => loadConfigOrExit("all-in-one", SERVICE_SCHEMAS["all-in-one"], { COORDINATOR_PORT: "abc" })).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(printed).toEqual(['FATAL [all-in-one] invalid configuration:\n  - COORDINATOR_PORT: must be an integer, got "abc"']);
  });

  it("returns the config when the environment is valid", () => {
    expect(loadConfigOrExit("all-in-one", SERVICE_SCHEMAS["all-in-one"], { COORDINATOR_PORT: "5301" }).COORDINATOR_PORT).toBe(5301);
  });
});

/*
 * The environments this repository ships: Fly app configs, compose files and the installers'
 * env templates. A schema that rejected one of them would stop that service on its next deploy.
 */
function shippedEnv(file: string): Record<string, string> {
  const text = readFileSync(join(root, file), "utf8");
  const env: Record<string, string> = {};
  const add = (name: string, raw: string) => {
    const value = raw.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
    // Compose interpolation and <placeholders> are filled in at deploy time.
    if (value === "" || value.includes("${") || /^<.*>$/.test(value)) return;
    env[name] = value;
  };
  if (file.endsWith(".toml")) {
    const section = /^\[env\]\n([\s\S]*?)(?=^\[)/m.exec(text)?.[1] ?? "";
    for (const m of section.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm)) add(m[1], m[2]);
  } else if (file.endsWith(".yml")) {
    for (const m of text.matchAll(/^\s*-\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)) add(m[1], m[2]);
    for (const m of text.matchAll(/^\s{4,}([A-Z][A-Z0-9_]*):\s+(.+)$/gm)) add(m[1], m[2]);
  } else {
    for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) add(m[1], m[2]);
  }
  return env;
}

const SHIPPED: [string, ServiceName[]][] = [
  ["deploy/fly/fly.anchor-proxy.toml", ["anchor-proxy"]],
  ["deploy/fly/fly.portal.toml", ["portal"]],
  ["deploy/fly/fly.seed-node.toml", ["all-in-one", "coordinator", "inference", "control-plane", "launcher"]],
  ["deploy/fly/fly.seed-eu.toml", ["all-in-one", "coordinator", "inference", "control-plane", "launcher"]],
  [".env.example", services],
  ["docker-compose.yml", services],
  ["deploy/infra/.env.example", services],
  ["deploy/infra/docker-compose.yml", services],
  ["tests/e2e/docker-compose.e2e.yml", services],
  ["tests/e2e/docker-compose.scale.yml", services],
  ["scripts/linux/systemd/agent.env.example", ["worker", "launcher"]],
  ["scripts/linux/systemd/coordinator.env.example", ["coordinator", "launcher"]],
  ["scripts/linux/systemd/seed.env.example", ["all-in-one", "coordinator", "inference", "control-plane", "worker", "ide-provider", "launcher"]],
  ["scripts/linux/payload/etc/edgecoder/edgecoder.env.example", services],
  ["scripts/macos/payload/etc/edgecoder/edgecoder.env.example", services]
];

describe("the environments shipped in this repository validate", () => {
  for (const [file, against] of SHIPPED) {
    it(file, () => {
      expect(existsSync(join(root, file)), `${file} is missing`).toBe(true);
      const env = shippedEnv(file);
      expect(Object.keys(env).length).toBeGreaterThan(0);
      for (const service of against) {
        // Secrets are set outside these files (fly secrets, the operator's env file).
        expect(problemsOf(service, { ...REQUIRED[service], ...env }), service).toEqual([]);
      }
    });
  }

  it("fly.portal.toml plus its secrets passes the portal's production rules", () => {
    const env = { ...shippedEnv("deploy/fly/fly.portal.toml"), PORTAL_SERVICE_TOKEN: "t".repeat(32), RESEND_API_KEY: "re_test_key" };
    const config = loadConfig("portal", SERVICE_SCHEMAS.portal, env);
    expect(config.NODE_ENV).toBe("production");
    expect(portalProductionProblems(config, Boolean(env.COORDINATOR_DISCOVERY_URLS))).toEqual([]);
  });
});
