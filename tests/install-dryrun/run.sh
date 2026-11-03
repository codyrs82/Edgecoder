#!/usr/bin/env bash
# tests/install-dryrun/run.sh — the Linux one-line installer, end to end, in a systemd container
# with 8 simulated NVIDIA RTX 6000 Ada cards (fake nvidia-smi) and a fake Docker daemon.
#
#   bash tests/install-dryrun/run.sh                 # Ubuntu 24.04
#   BASE=debian:12 bash tests/install-dryrun/run.sh  # Debian 12
#   KEEP=1 bash tests/install-dryrun/run.sh          # leave the container running to inspect
#
# Installs the real thing inside the container (pinned Node and Ollama, NVIDIA container toolkit,
# and a signed agent release built from this checkout's HEAD, as committed) but points the agents
# at a dead local coordinator, so nothing joins the network. The release is a local fixture: the
# tarball is built in a node container by scripts/release/package-agent.sh (as CI does), and
# SHA256SUMS is signed with a throwaway key generated here, which install.sh accepts only through
# EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY (docs/install.md). Checks (--per-gpu layout): 8 agents
# + 8 Ollama servers active, per-GPU env, `edgecoder-install status`. Not covered: real
# GPUs/CUDA, a real Docker daemon, x86_64 when run on Apple silicon, model pulls, enrolment
# against a live portal. Needs Docker (Colima works) and node on the host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASE="${BASE:-ubuntu:24.04}"
NAME="ec-install-dryrun-$$"
BUILDER="ec-install-dryrun-build-$$"
IMAGE="ec-install-dryrun:$(echo "$BASE" | tr ':/' '--')"
TAG="agent-v0.0.0-dryrun"
NODE_VERSION="$(sed -n 's/^NODE_VERSION=//p' "$REPO/deploy/install.sh")"
case "$(docker info --format '{{.Architecture}}')" in
  x86_64|amd64) TARGET=linux-x64 ;;
  aarch64|arm64) TARGET=linux-arm64 ;;
  *) echo "unsupported docker architecture"; exit 1 ;;
esac
WORK="$(mktemp -d)"
LOG="${TMPDIR:-/tmp}/$NAME.log"   # outside WORK, so it survives the cleanup

cleanup() {
  docker rm -f "$BUILDER" >/dev/null 2>&1 || true
  if [ "${KEEP:-}" = 1 ]; then echo "kept container $NAME and $WORK (log $LOG)"
  else docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; fi
}
trap cleanup EXIT

echo "Building the $TARGET release tarball from HEAD ($(git -C "$REPO" rev-parse --short HEAD)) with Node $NODE_VERSION..."
docker run -d --name "$BUILDER" "node:$NODE_VERSION-bookworm" sleep infinity >/dev/null
docker exec "$BUILDER" mkdir -p /src /out
git -C "$REPO" archive HEAD | docker exec -i "$BUILDER" tar -x -C /src
docker exec "$BUILDER" bash /src/scripts/release/package-agent.sh "$TAG" "$TARGET" /out > "$WORK/build.log" 2>&1 \
  || { tail -30 "$WORK/build.log"; echo "FAIL: package-agent.sh"; exit 1; }
mkdir -p "$WORK/release/$TAG"
docker cp "$BUILDER:/out/edgecoder-agent-$TAG-$TARGET.tar.gz" "$WORK/release/$TAG/"

echo "Signing the fixture release with a throwaway test key..."
KEY_JSON="$(node "$REPO/scripts/release/minisign.mjs" keygen)"
TEST_PUBKEY="$(printf '%s' "$KEY_JSON" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).publicKey))')"
(cd "$WORK/release/$TAG" && node -e 'const c=require("crypto"),f=require("fs");for(const n of process.argv.slice(1))console.log(c.createHash("sha256").update(f.readFileSync(n)).digest("hex")+"  "+n)' "edgecoder-agent-$TAG-$TARGET.tar.gz" > SHA256SUMS)
AGENT_RELEASE_SIGNING_KEY="$(printf '%s' "$KEY_JSON" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).secretKeyPem))')" \
  node "$REPO/scripts/release/minisign.mjs" sign "$WORK/release/$TAG/SHA256SUMS" "tag:$TAG file:SHA256SUMS"
unset KEY_JSON

docker build -q -t "$IMAGE" --build-arg BASE="$BASE" "$HERE" >/dev/null
docker run -d --name "$NAME" --hostname gpubox --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw "$IMAGE" >/dev/null
sleep 3
docker cp "$HERE/fakes/nvidia-smi" "$NAME":/usr/bin/nvidia-smi
docker cp "$HERE/fakes/docker" "$NAME":/usr/bin/docker
docker cp "$HERE/fakes/docker.service" "$NAME":/etc/systemd/system/docker.service
docker cp "$WORK/release" "$NAME":/release
git -C "$REPO" show HEAD:deploy/install.sh > "$WORK/install.sh"
docker cp "$WORK/install.sh" "$NAME":/root/install.sh
docker exec "$NAME" bash -c 'systemctl daemon-reload && systemctl enable --now docker >/dev/null 2>&1'

echo "Installing $TAG on $BASE (8 simulated RTX 6000 Ada)..."
docker exec -e EDGECODER_RELEASE_BASE_URL=file:///release -e EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY="$TEST_PUBKEY" "$NAME" bash -c \
  "bash /root/install.sh --version $TAG --per-gpu --mesh-token test-mesh-token --coordinator-url http://127.0.0.1:4301 --portal-url http://127.0.0.1:4310 --token test-reg-token" \
  > "$LOG" 2>&1 || { tail -40 "$LOG"; echo "FAIL: installer exited non-zero (log $LOG)"; exit 1; }
grep -q "verified edgecoder-agent-$TAG-$TARGET.tar.gz" "$LOG" || { echo "FAIL: the installer did not verify the release (log $LOG)"; exit 1; }

# A tampered release must be refused: flip the tarball and re-run.
docker exec "$NAME" bash -c "printf x >> /release/$TAG/edgecoder-agent-$TAG-$TARGET.tar.gz"
if docker exec -e EDGECODER_RELEASE_BASE_URL=file:///release -e EDGECODER_INSECURE_TEST_ONLY_RELEASE_PUBKEY="$TEST_PUBKEY" "$NAME" \
  bash /root/install.sh --version "$TAG" --per-gpu > "$WORK/tampered.log" 2>&1; then
  echo "FAIL: a tampered release was installed"; exit 1
fi
grep -q "CHECKSUM MISMATCH" "$WORK/tampered.log" || { cat "$WORK/tampered.log"; echo "FAIL: tampered release not refused for its checksum"; exit 1; }
echo "tampered release refused: $(grep -o 'CHECKSUM MISMATCH[^(]*' "$WORK/tampered.log")"

sleep 8
fail=0
agents=$(docker exec "$NAME" bash -c 'systemctl list-units --no-legend "edgecoder-agent-*" --state=active | wc -l')
ollamas=$(docker exec "$NAME" bash -c 'systemctl list-units --no-legend "edgecoder-ollama-*" --state=active | wc -l')
echo "active: $agents agents, $ollamas ollama servers"
[ "$agents" -eq 8 ] && [ "$ollamas" -eq 8 ] || fail=1
for n in 0 7; do
  env="$(docker exec "$NAME" bash -c "cat /etc/edgecoder/agent-$n.env 2>/dev/null || true")"
  echo "$env" | grep -q "CUDA_VISIBLE_DEVICES=$n" || { echo "agent-$n: CUDA_VISIBLE_DEVICES not $n"; fail=1; }
  echo "$env" | grep -q "SANDBOX_MODE=docker" || { echo "agent-$n: no SANDBOX_MODE=docker"; fail=1; }
done
for unit in edgecoder-agent-0 edgecoder-ollama-7; do
  props="$(docker exec "$NAME" systemctl show -p User -p NoNewPrivileges -p ProtectSystem "$unit")"
  echo "$props" | grep -qx "User=edgecoder" || { echo "$unit: not running as edgecoder"; fail=1; }
  echo "$props" | grep -qx "NoNewPrivileges=yes" || { echo "$unit: NoNewPrivileges not set"; fail=1; }
  echo "$props" | grep -qx "ProtectSystem=strict" || { echo "$unit: ProtectSystem not strict"; fail=1; }
done
docker exec "$NAME" edgecoder-install status >/dev/null || { echo "edgecoder-install status failed"; fail=1; }
[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAIL (installer log $LOG)"; exit 1; }
