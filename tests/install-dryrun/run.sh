#!/usr/bin/env bash
# tests/install-dryrun/run.sh — the Linux one-line installer, end to end, in a systemd container
# with 8 simulated NVIDIA RTX 6000 Ada cards (fake nvidia-smi) and a fake Docker daemon.
#
#   bash tests/install-dryrun/run.sh                 # Ubuntu 24.04
#   BASE=debian:12 bash tests/install-dryrun/run.sh  # Debian 12
#   KEEP=1 bash tests/install-dryrun/run.sh          # leave the container running to inspect
#
# Installs the real thing inside the container (Node, Ollama, NVIDIA container toolkit, the agent
# from this checkout's committed HEAD) but points the agents at a dead local coordinator, so nothing
# joins the network. Checks: 8 agents + 8 Ollama servers active, per-GPU env, `edgecoder-install
# status`. Not covered: real GPUs/CUDA, a real Docker daemon, x86_64 when run on Apple silicon,
# model pulls, enrolment against a live portal. Needs Docker (Colima works).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASE="${BASE:-ubuntu:24.04}"
NAME="ec-install-dryrun-$$"
IMAGE="ec-install-dryrun:$(echo "$BASE" | tr ':/' '--')"
REF="$(git -C "$REPO" rev-parse HEAD)"

docker build -q -t "$IMAGE" --build-arg BASE="$BASE" "$HERE" >/dev/null
cleanup() { [ "${KEEP:-}" = 1 ] && echo "kept container $NAME" || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" --hostname gpubox --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v "$REPO":/repo:ro "$IMAGE" >/dev/null
sleep 3
docker cp "$HERE/fakes/nvidia-smi" "$NAME":/usr/bin/nvidia-smi
docker cp "$HERE/fakes/docker" "$NAME":/usr/bin/docker
docker cp "$HERE/fakes/docker.service" "$NAME":/etc/systemd/system/docker.service
docker exec "$NAME" bash -c 'systemctl daemon-reload && systemctl enable --now docker >/dev/null 2>&1; mkdir -p /root && printf "[safe]\n\tdirectory = *\n" > /root/.gitconfig'

echo "Installing $REF on $BASE (8 simulated RTX 6000 Ada)..."
docker exec -e EDGECODER_REPO_URL=file:///repo -e EDGECODER_REPO_REF="$REF" "$NAME" bash -c \
  'bash /repo/deploy/install.sh --mesh-token test-mesh-token --coordinator-url http://127.0.0.1:4301 --portal-url http://127.0.0.1:4310 --token test-reg-token' \
  > "/tmp/$NAME.log" 2>&1 || { tail -40 "/tmp/$NAME.log"; echo "FAIL: installer exited non-zero (log /tmp/$NAME.log)"; exit 1; }

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
docker exec "$NAME" edgecoder-install status >/dev/null || { echo "edgecoder-install status failed"; fail=1; }
[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAIL (installer log /tmp/$NAME.log)"; exit 1; }
