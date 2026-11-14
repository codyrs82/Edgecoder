#!/usr/bin/env bash
# #98: LND settlement acceptance test against a throwaway regtest network.
#   1. start bitcoind + two LND nodes (tests/e2e/docker-compose.lnd-regtest.yml) with RPC
#      credentials generated here,
#   2. fund bob and open a bob -> alice channel,
#   3. run tests/e2e/lnd-regtest.test.ts: alice creates an invoice through LndRestProvider, bob
#      pays it, and checkSettlement must report settled with a preimage that hashes to the hash.
# Needs Docker with the compose plugin, Node and the repo's node_modules. Takes 1-3 minutes.
# KEEP_STACK=1 leaves the containers running for debugging (tear down with `docker compose -f ... down -v`).
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE_FILE="tests/e2e/docker-compose.lnd-regtest.yml"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-edgecoder-lnd-regtest}"
WAIT_SECS="${WAIT_SECS:-180}"

# Throwaway credentials, generated per run and never written to disk.
export LND_REGTEST_RPC_USER="regtest"
export LND_REGTEST_RPC_PASS="$(openssl rand -hex 24)"
export LND_REGTEST_RPCAUTH="$(node -e '
const { createHmac, randomBytes } = require("node:crypto");
const [user, pass] = process.argv.slice(1);
const salt = randomBytes(16).toString("hex");
process.stdout.write(`${user}:${salt}$${createHmac("sha256", salt).update(pass).digest("hex")}`);
' "$LND_REGTEST_RPC_USER" "$LND_REGTEST_RPC_PASS")"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
fail() { echo "::error::$*"; exit 1; }
btc() { dc exec -T bitcoind bitcoin-cli -regtest -rpcuser="$LND_REGTEST_RPC_USER" -rpcpassword="$LND_REGTEST_RPC_PASS" "$@"; }
lncli() { local node="$1"; shift; dc exec -T "$node" lncli --network=regtest "$@"; }
jget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split("."))v=v?.[k];if(v===undefined)process.exit(1);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
mine() { btc generatetoaddress "$1" "$MINER_ADDR" >/dev/null; }
# wait_for <description> <command...>: retry until the command succeeds or WAIT_SECS pass.
wait_for() {
  local what="$1"; shift
  for _ in $(seq 1 "$WAIT_SECS"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then echo "--- last 80 log lines per service ---"; dc logs --no-color --tail 80 || true; fi
  if [ "${KEEP_STACK:-0}" != "1" ]; then dc down -v >/dev/null 2>&1 || true; fi
  exit "$rc"
}
trap cleanup EXIT

echo "=== LND regtest settlement test (#98) ==="
dc up -d --wait bitcoind || fail "bitcoind failed to start"
dc up -d alice bob || fail "LND nodes failed to start"

echo "[1/5] Waiting for both LND nodes..."
synced() { lncli "$1" getinfo | jget synced_to_chain | grep -qx true; }
wait_for "alice RPC" lncli alice getinfo
wait_for "bob RPC" lncli bob getinfo

echo "[2/5] Funding bob..."
MINER_ADDR=$(lncli bob newaddress p2wkh | jget address) || fail "bob newaddress failed"
mine 101
wait_for "bob synced" synced bob
wait_for "alice synced" synced alice
confirmed() { [ "$(lncli bob walletbalance | jget confirmed_balance)" -gt 0 ]; }
wait_for "bob's coinbase to confirm" confirmed

echo "[3/5] Opening a bob -> alice channel..."
ALICE_PUBKEY=$(lncli alice getinfo | jget identity_pubkey)
wait_for "bob to connect to alice" lncli bob connect "${ALICE_PUBKEY}@alice:9735"
lncli bob openchannel --node_key "$ALICE_PUBKEY" --local_amt 1000000 >/dev/null || fail "openchannel failed"
mine 6
active() { [ "$(lncli bob listchannels --active_only | jget channels | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')" -ge 1 ]; }
wait_for "the channel to become active" active
# Alice must also see the channel before bob can route to her invoice.
alice_active() { [ "$(lncli alice listchannels --active_only | jget channels | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')" -ge 1 ]; }
wait_for "alice to see the channel" alice_active

echo "[4/5] Collecting REST endpoints, macaroons and TLS certs..."
creds() {
  local node="$1"
  local port
  port=$(dc port "$node" 8080 | sed 's/.*://')
  [ -n "$port" ] || fail "no published REST port for $node"
  echo "https://127.0.0.1:${port}"
  dc exec -T "$node" cat /root/.lnd/data/chain/bitcoin/regtest/admin.macaroon | node -e 'const c=[];process.stdin.on("data",d=>c.push(d)).on("end",()=>console.log(Buffer.concat(c).toString("hex")))'
  dc exec -T "$node" cat /root/.lnd/tls.cert | node -e 'const c=[];process.stdin.on("data",d=>c.push(d)).on("end",()=>console.log(Buffer.concat(c).toString("base64")))'
}
{ read -r LND_REGTEST_ALICE_URL; read -r LND_REGTEST_ALICE_MACAROON; read -r LND_REGTEST_ALICE_TLS_CERT_BASE64; } < <(creds alice)
{ read -r LND_REGTEST_BOB_URL; read -r LND_REGTEST_BOB_MACAROON; read -r LND_REGTEST_BOB_TLS_CERT_BASE64; } < <(creds bob)
export LND_REGTEST_ALICE_URL LND_REGTEST_ALICE_MACAROON LND_REGTEST_ALICE_TLS_CERT_BASE64
export LND_REGTEST_BOB_URL LND_REGTEST_BOB_MACAROON LND_REGTEST_BOB_TLS_CERT_BASE64

echo "[5/5] Running the settlement test..."
LND_REGTEST=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/lnd-regtest.test.ts
echo "=== LND regtest settlement test passed ==="
