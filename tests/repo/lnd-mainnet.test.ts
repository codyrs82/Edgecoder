import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// deploy/lnd-mainnet: the entrypoint's two chain-backend modes (README: "External Bitcoin node").
// The entrypoint runs for real against stub `lnd`/`bitcoind` binaries and a fake bitcoind RPC.
const root = resolve(__dirname, "../..");
const DIR = resolve(root, "deploy/lnd-mainnet");
const ENTRYPOINT = resolve(DIR, "entrypoint.sh");
const read = (p: string) => readFileSync(resolve(DIR, p), "utf8").replace(/\r\n/g, "\n");

const USER = "lnd-edgecoder";
const PASS = "s3cret-Pass_value-0123456789abcdef";
const WALLET = "wallet-pass-do-not-log-42";
const BTC_RPC = "bundled-rpc-pass-do-not-log-77";

type Run = { code: number | null; log: string; args: string[]; conf: string };

const listen = (s: HttpServer | TcpServer, host: string) =>
  new Promise<number>((ok, fail) => {
    s.once("error", fail);
    s.listen(0, host, () => ok((s.address() as { port: number }).port));
  });

type RpcOpts = { chain?: string; pruned?: boolean; forbid?: string[] };

function fakeRpc(opts: RpcOpts = {}) {
  return createHttpServer(async (req, res) => {
    const want = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    if (req.headers.authorization !== want) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const method = (JSON.parse(body || "{}") as { method?: string }).method ?? "";
    // Bitcoin Core's rpcwhitelist: 403 with an empty body.
    if (opts.forbid?.includes(method)) {
      res.writeHead(403).end();
      return;
    }
    // getinfo no longer exists in Bitcoin Core: an allowed call is "method not found".
    if (method === "getinfo") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: null, error: { code: -32601, message: "Method not found" }, id: "x" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        result: { chain: opts.chain ?? "main", blocks: 900000, headers: 900000, initialblockdownload: false, pruned: opts.pruned ?? false },
        error: null,
        id: "edgecoder-lnd",
      }),
    );
  });
}

describe.skipIf(process.platform === "win32")("deploy/lnd-mainnet entrypoint", () => {
  let tmp: string;
  let bin: string;
  const servers: (HttpServer | TcpServer)[] = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "lnd-mainnet-"));
    bin = join(tmp, "bin");
    mkdirSync(bin);
    // Stub daemons: record their argv and the config file they were given, then exit.
    for (const name of ["lnd", "bitcoind"]) {
      const p = join(bin, name);
      writeFileSync(
        p,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OUT/args"\nfor a; do case "$a" in --configfile=*) cp "${a#--configfile=}" "$OUT/conf" ;; -conf=*) cp "${a#-conf=}" "$OUT/conf" ;; esac; done\n',
      );
      chmodSync(p, 0o755);
    }
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    rmSync(tmp, { recursive: true, force: true });
  });

  async function serve(host: string, opts?: RpcOpts) {
    const rpc = fakeRpc(opts);
    const zb = createTcpServer((c) => c.end());
    const zt = createTcpServer((c) => c.end());
    servers.push(rpc, zb, zt);
    return { rpc: await listen(rpc, host), zb: await listen(zb, host), zt: await listen(zt, host) };
  }

  function run(arg: string, env: Record<string, string>, timeoutMs = 20000): Promise<Run> {
    const out = mkdtempSync(join(tmp, "run-"));
    return new Promise((done) => {
      const child = spawn("bash", [ENTRYPOINT, arg], {
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, OUT: out, LND_RUN_DIR: out, BITCOIND_WAIT_INTERVAL: "1", LND_WALLET_PASS: WALLET, ...env },
      });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(t);
        const f = (n: string) => (existsSync(join(out, n)) ? readFileSync(join(out, n), "utf8") : "");
        done({ code, log, args: f("args").split("\n").filter(Boolean), conf: f("conf") });
      });
    });
  }

  const external = (host: string, p: { rpc: number; zb: number; zt: number }, br = host) => ({
    BITCOIND_MODE: "external",
    BITCOIND_HOST: host,
    BITCOIND_RPC_PORT: String(p.rpc),
    BITCOIND_ZMQ_BLOCK: `tcp://${br}:${p.zb}`,
    BITCOIND_ZMQ_TX: `tcp://${br}:${p.zt}`,
    BITCOIND_RPC_USER: USER,
    BITCOIND_RPC_PASS: PASS,
  });

  it("parses (bash -n) and stops on errors", () => {
    execFileSync("bash", ["-n", ENTRYPOINT]);
    execFileSync("bash", ["-n", resolve(DIR, "check-backend.sh")]);
    expect(read("entrypoint.sh")).toMatch(/^set -euo pipefail$/m);
    expect(read("check-backend.sh")).toMatch(/^set -euo pipefail$/m);
  });

  it("external mode renders every bitcoind.* setting into the config file, none onto argv", async () => {
    const p = await serve("127.0.0.1");
    const r = await run("lnd", external("127.0.0.1", p));
    expect(r.code, r.log).toBe(0);
    expect(r.conf.split("\n").filter(Boolean)).toEqual([
      "[Bitcoind]",
      `bitcoind.rpchost=127.0.0.1:${p.rpc}`,
      `bitcoind.rpcuser=${USER}`,
      `bitcoind.rpcpass=${PASS}`,
      `bitcoind.zmqpubrawblock=tcp://127.0.0.1:${p.zb}`,
      `bitcoind.zmqpubrawtx=tcp://127.0.0.1:${p.zt}`,
      "bitcoind.estimatemode=ECONOMICAL",
    ]);
    expect(r.args).toContain("--bitcoin.mainnet");
    expect(r.args).toContain("--bitcoin.node=bitcoind");
    expect(r.args.filter((a) => a.startsWith("--bitcoind."))).toEqual([]);
    // An unpruned backend: none of the pruned-node workarounds.
    expect(r.args.join(" ")).not.toMatch(/assumechanvalid|prunednode|pruned/i);
    expect(r.conf).not.toMatch(/assumechanvalid|prunednode/i);
    expect(r.log).toMatch(/ocean-node RPC at 127\.0\.0\.1:\d+ is up: chain=main blocks=900000/);
  });

  it("brackets an IPv6 host and derives the ZMQ URLs from it", async () => {
    let p: { rpc: number; zb: number; zt: number };
    try {
      p = await serve("::1");
    } catch {
      return; // no IPv6 loopback on this runner
    }
    const env = { ...external("::1", p), BITCOIND_ZMQ_BLOCK: "", BITCOIND_ZMQ_TX: "" };
    delete (env as Record<string, string>).BITCOIND_ZMQ_BLOCK;
    delete (env as Record<string, string>).BITCOIND_ZMQ_TX;
    const r = await run("lnd", env);
    expect(r.code, r.log).toBe(0);
    expect(r.conf).toContain(`bitcoind.rpchost=[::1]:${p.rpc}\n`);
    expect(r.conf).toContain("bitcoind.zmqpubrawblock=tcp://[::1]:28332\n");
    expect(r.conf).toContain("bitcoind.zmqpubrawtx=tcp://[::1]:28333\n");
  });

  it("waits for the RPC with a clear log, never logging credentials", async () => {
    // Nothing listens on this port at first; the RPC appears after ~2 s.
    const probe = createTcpServer();
    const port = await listen(probe, "127.0.0.1");
    await new Promise((r) => probe.close(r));
    const zb = createTcpServer((c) => c.end());
    const zt = createTcpServer((c) => c.end());
    servers.push(zb, zt);
    const p = { rpc: port, zb: await listen(zb, "127.0.0.1"), zt: await listen(zt, "127.0.0.1") };
    const pending = run("lnd", external("127.0.0.1", p));
    await new Promise((r) => setTimeout(r, 2000));
    const rpc = fakeRpc();
    servers.push(rpc);
    await new Promise<void>((ok) => rpc.listen(port, "127.0.0.1", () => ok()));
    const r = await pending;
    expect(r.code, r.log).toBe(0);
    expect(r.log).toContain(`waiting for ocean-node RPC at 127.0.0.1:${port}`);
    for (const s of [PASS, USER, WALLET]) {
      expect(r.log).not.toContain(s);
      expect(r.args.join("\n")).not.toContain(s);
    }
  });

  it("keeps waiting (and says why) when the credentials are rejected", async () => {
    const p = await serve("127.0.0.1");
    const r = await run("lnd", { ...external("127.0.0.1", p), BITCOIND_RPC_PASS: "wrong-pass-zzz" }, 3500);
    expect(r.code).not.toBe(0); // killed by the test while still waiting
    expect(r.args).toEqual([]);
    expect(r.log).toMatch(/rejected BITCOIND_RPC_USER\/BITCOIND_RPC_PASS \(401\)/);
    expect(r.log).not.toContain("wrong-pass-zzz");
  });

  it("waits (does not start lnd) while the rpcwhitelist blocks methods lnd needs, naming them", async () => {
    const p = await serve("127.0.0.1", { forbid: ["getinfo", "getdeploymentinfo", "getmempoolinfo", "uptime", "getpeerinfo", "gettxspendingprevout"] });
    const r = await run("lnd", external("127.0.0.1", p), 3500);
    expect(r.code).not.toBe(0); // killed by the test while still waiting
    expect(r.args).toEqual([]);
    expect(r.log).toMatch(/rpcwhitelist blocks methods lnd needs: getinfo getdeploymentinfo getmempoolinfo uptime getpeerinfo gettxspendingprevout/);
    expect(r.log).not.toContain(PASS);
  });

  it("treats getinfo's \"method not found\" (404) as allowed and starts lnd", async () => {
    const p = await serve("127.0.0.1");
    const r = await run("lnd", external("127.0.0.1", p));
    expect(r.code, r.log).toBe(0);
    expect(r.log).not.toMatch(/rpcwhitelist blocks/);
  });

  it("refuses a backend that is not on mainnet", async () => {
    const p = await serve("127.0.0.1", { chain: "test" });
    const r = await run("lnd", external("127.0.0.1", p));
    expect(r.code).toBe(1);
    expect(r.args).toEqual([]);
    expect(r.log).toMatch(/not mainnet; refusing to start lnd/);
  });

  it("refuses missing settings, the placeholder host and multi-line values", async () => {
    const base = external("127.0.0.1", { rpc: 1, zb: 2, zt: 3 });
    for (const [env, msg] of [
      [{ ...base, BITCOIND_HOST: "" }, /BITCOIND_HOST is not set/],
      [{ ...base, BITCOIND_RPC_PASS: "" }, /BITCOIND_RPC_PASS is not set/],
      [{ ...base, BITCOIND_HOST: "REPLACE_WITH_OCEAN_NODE_6PN_ADDRESS" }, /placeholder/],
      [{ ...base, BITCOIND_RPC_USER: "a\nbitcoind.rpchost=evil" }, /BITCOIND_RPC_USER must be a single line/],
      [{ ...base, BITCOIND_MODE: "both" }, /BITCOIND_MODE must be external or bundled/],
    ] as const) {
      const r = await run("lnd", env as Record<string, string>);
      expect(r.code, r.log).not.toBe(0);
      expect(r.log).toMatch(msg);
      expect(r.args).toEqual([]);
    }
  });

  it("the bitcoind process still runs the pruned node in external mode (the stopped machine is the rollback)", async () => {
    const r = await run("bitcoind", { BITCOIND_MODE: "external", BTC_RPC_PASS: BTC_RPC });
    expect(r.code, r.log).toBe(0);
    expect(r.args).toContain("-prune=50000");
    expect(r.log).not.toContain(BTC_RPC);
  });

  it("check-backend.sh checks the ports and the limited user without printing the credentials", async () => {
    const p = await serve("127.0.0.1");
    const out = await new Promise<{ code: number | null; log: string }>((done) => {
      const child = spawn("bash", [resolve(DIR, "check-backend.sh")], {
        env: { PATH: process.env.PATH, FLY_MACHINE_ID: "test", ...external("127.0.0.1", p) },
      });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      child.on("close", (code) => done({ code, log }));
    });
    expect(out.code, out.log).toBe(0);
    expect(out.log).toMatch(/ok {4}getblockchaininfo: chain=main blocks=900000/);
    expect(out.log).toMatch(/ok {4}sendrawtransaction/);
    for (const m of ["getinfo", "getdeploymentinfo", "getmempoolinfo", "uptime", "getpeerinfo", "gettxspendingprevout"]) {
      expect(out.log).toMatch(new RegExp(`ok {4}${m}$`, "m"));
    }
    expect(out.log).toMatch(/PASS$/m);
    expect(out.log).not.toContain(PASS);
    expect(out.log).not.toContain(USER);
  });

  it("bundled mode starts lnd exactly as before", async () => {
    const r = await run("lnd", { BITCOIND_MODE: "bundled", BTC_RPC_PASS: BTC_RPC, FLY_APP_NAME: "edgecoder-lnd", LND_EXTERNAL_IP: "37.16.0.48" });
    expect(r.code, r.log).toBe(0);
    const btc = "bitcoind.process.edgecoder-lnd.internal";
    const run_ = r.args[0].slice("--configfile=".length, -"/lnd.conf".length);
    expect(r.args).toEqual([
      `--configfile=${run_}/lnd.conf`,
      "--lnddir=/data",
      "--alias=edgecoder",
      "--bitcoin.mainnet",
      "--bitcoin.node=bitcoind",
      `--bitcoind.rpchost=${btc}:8332`,
      `--bitcoind.zmqpubrawblock=tcp://${btc}:28332`,
      `--bitcoind.zmqpubrawtx=tcp://${btc}:28333`,
      "--bitcoind.estimatemode=ECONOMICAL",
      "--listen=0.0.0.0:9735",
      "--restlisten=[::]:8080",
      "--rpclisten=[::]:10009",
      "--tlsextradomain=lnd.process.edgecoder-lnd.internal",
      "--tlsextradomain=localhost",
      "--externalip=37.16.0.48:9735",
      `--wallet-unlock-password-file=${run_}/wallet.pass`,
      "--wallet-unlock-allow-create",
      "--minchansize=100000",
      "--coop-close-target-confs=6",
    ]);
    expect(r.conf).toBe(`[Bitcoind]\nbitcoind.rpcuser=edgecoder\nbitcoind.rpcpass=${BTC_RPC}\n`);
    expect(r.log).not.toContain(BTC_RPC);
    expect(r.log).not.toContain(WALLET);
  });

  it("bundled mode starts the pruned bitcoind exactly as before", async () => {
    const r = await run("bitcoind", { BITCOIND_MODE: "bundled", BTC_RPC_PASS: BTC_RPC });
    expect(r.code, r.log).toBe(0);
    expect(r.args.slice(1)).toEqual([
      "-datadir=/data",
      "-printtoconsole",
      "-server",
      "-prune=50000",
      "-dbcache=2000",
      "-rpcbind=127.0.0.1",
      "-rpcbind=[::]",
      "-rpcallowip=127.0.0.1",
      "-rpcallowip=fdaa::/16",
      "-zmqpubrawblock=tcp://[::]:28332",
      "-zmqpubrawtx=tcp://[::]:28333",
      "-listen=0",
      "-discover=0",
    ]);
    expect(r.conf).toBe(`rpcuser=edgecoder\nrpcpassword=${BTC_RPC}\n`);
  });
});

describe("deploy/lnd-mainnet fly config", () => {
  const ext = read("fly.toml");
  const host = "fdaa:ec:ae3e:a7b:9016:7eba:d6ac:1b02";

  it("is external mode against ocean-node's 6PN address, with IPv6 brackets in the ZMQ URLs", () => {
    expect(ext).toMatch(/^app = "edgecoder-lnd"$/m);
    expect(ext).toMatch(/^\s*BITCOIND_MODE = "external"$/m);
    expect(ext).toContain(`BITCOIND_HOST = "${host}"`);
    expect(ext).toMatch(/^\s*BITCOIND_RPC_PORT = "8332"$/m);
    expect(ext).toContain(`BITCOIND_ZMQ_BLOCK = "tcp://[${host}]:28332"`);
    expect(ext).toContain(`BITCOIND_ZMQ_TX = "tcp://[${host}]:28333"`);
    expect(ext).toMatch(/^\s*BITCOIND_ESTIMATEMODE = "ECONOMICAL"$/m);
    expect(ext).not.toMatch(/REPLACE_WITH/);
  });

  it("keeps the bitcoind process group, volume and size so no deploy can destroy that machine", () => {
    expect(ext).toMatch(/^\[processes\]\n\s+bitcoind = "bitcoind"\n\s+lnd = "lnd"\n/m);
    expect(ext).toMatch(/source = "btcdata"\n\s+destination = "\/data"\n\s+initial_size = "80gb"\n\s+processes = \["bitcoind"\]/);
    expect(ext).toMatch(/source = "lnddata"/);
    expect(ext).toMatch(/processes = \["bitcoind"\]\n\s+size = "shared-cpu-4x"/);
    // The first external-mode deploy keeps the current lnd size.
    expect(ext).toMatch(/size = "shared-cpu-2x"\n\s+memory = "2gb"/);
    expect(existsSync(resolve(DIR, "fly.bundled.toml"))).toBe(false);
  });

  it("holds no secrets", () => {
    expect(ext).not.toMatch(/^\s*(BITCOIND_RPC_USER|BITCOIND_RPC_PASS|LND_WALLET_PASS|BTC_RPC_PASS)\s*=/m);
  });

  it("the image ships the pre-flight script", () => {
    expect(read("Dockerfile")).toMatch(/^COPY --chmod=0755 check-backend\.sh \/usr\/local\/bin\/check-backend$/m);
    expect(ext).toMatch(/dockerfile = "Dockerfile"/);
  });

  it("check-backend.sh never echoes the credentials", () => {
    const code = read("check-backend.sh").split("\n").filter((l) => !/^\s*#/.test(l));
    for (const line of code.filter((l) => /\b(echo|ok|bad)\b/.test(l))) {
      expect(line).not.toMatch(/\$\{?BITCOIND_RPC_(USER|PASS)\b(?!:-\})/);
    }
  });
});
