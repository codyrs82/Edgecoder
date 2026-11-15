# EdgeCoder stress / chaos harness

Many simulated agents and buyers in one Node process, speaking the real protocol (signed
`/register`, `/heartbeat`, `/pull`, `/result`, `/inference/chunks` with each agent's own Ed25519
key; portal API keys for enrolment, top-ups, inference and reservations; LND for money), against
either a local docker cluster or a deployed network. After each scenario an invariant checker
looks at the ledger, Lightning and the coordinators' own reconciliation, and a report lists
latency, errors, the saturation point, invariant results and findings with evidence.

Nothing here is wired into CI.

## Layout

| path | what |
|---|---|
| `cluster.sh` | the local cluster (plain `docker run`, no compose plugin needed): Postgres, portal, inference (decompose fallback), coordinators `coord-a` and `coord-b` (NODE_ENV=production, peered by key with `MESH_PEER_ALLOWLIST` @url pins), bitcoind + LND hub + LND payee on regtest from `deploy/lnd-test` |
| `up.sh` / `down.sh` | bring the cluster up (secrets, channel payee→hub with push, accounts, API keys) / remove every `ec-stress-*` container, volume and network |
| `reconfigure.sh` | restart both coordinators with new `STRESS_*` settings (payout caps, hold, verification) keeping DB, LND and accounts |
| `run.ts` | entry point: `--target <profile> --scenario <name>`; writes `results.json`, `report.json`, `report.md` |
| `report.ts` | merge results from several load generators (regions) into one report |
| `bundle.sh` | single-file ESM bundle of `run.ts` / `report.ts` (esbuild from node_modules) + `remote/stress-run.sh` wrapper + target profiles |
| `remote-smoke.sh` | the remote path end to end against the local cluster (bundle in two containers, URLs only, merged report) |
| `remote/fly-loadgen.sh` | operator helper for the live phase: load-generator machines per Fly region (prints the flyctl commands unless `DRY_RUN=0`) |
| `repro/dup-execution.ts` | minimal reproduction of the cross-coordinator duplicate execution finding |
| `targets/*.json` | target profiles: `local`, `remote-local`, `live-regtest` |
| `lib/` | agents, buyers, LND client, metrics, invariants, scenarios, report |

Run artifacts and per-run secrets go to `.stress-runs/` (gitignored).

## Local quick start

```sh
scripts/stress/up.sh                       # ~3 min first time (builds ec-stress-app:local from deploy/docker/Dockerfile.agent)
npx tsx scripts/stress/run.ts --target scripts/stress/targets/local.json --scenario smoke
open .stress-runs/<run>-smoke/report.md
scripts/stress/down.sh
```

`up.sh` knobs (env): `STRESS_PROVIDERS` (4), `STRESS_BUYERS` (3), `STRESS_VERIFICATION_RATE` (0.3),
`STRESS_EARNINGS_HOLD_MS` (60000), `STRESS_PAYOUT_MIN_SATS` (10), `STRESS_PAYOUT_MAX_SINGLE_SATS` (300),
`STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS` (600), `STRESS_PAYOUT_MAX_GLOBAL_DAILY_SATS` (1500),
`STRESS_REBUILD=1` to rebuild the images from the current tree. Host ports 56001/56002 (coordinators),
56010 (Postgres), 56020 (portal), 56030/56031 (LND hub/payee REST), all on 127.0.0.1.

Local load ceiling: from the host the cluster is reached through the docker VM's port
forwarder. On colima/lima that is one ssh master with a 256-file limit; past ~130 tasks/s
(≈ 500 req/s with 300 agents) it died and took every forward with it, including the docker socket.
The harness caps sockets per origin (`STRESS_HTTP_CONNECTIONS`, 64). For more load run the bundled
generator inside the docker network (`remote-smoke.sh` does this), which bypasses the forwarder.

Accounts: providers and buyers sign up through the portal; their email is marked verified in SQL,
standing in for clicking the emailed link (the same shortcut as `scripts/e2e/scale-nonroot.sh` and
`tests/e2e/setup/global-setup.ts`). Nothing else is relaxed: coordinators run with production rules.

### Smoke mode (CI-like)

```sh
scripts/stress/up.sh && npx tsx scripts/stress/run.ts --target scripts/stress/targets/local.json --scenario smoke; rc=$?; scripts/stress/down.sh; exit $rc
```

About 30 s of load (6 agents, 2 buyers) plus setup; exit code 0 only when the scenario finished and
no invariant failed. `scripts/stress/remote-smoke.sh` does the same through the bundled load generator.

## Scenarios

`npx tsx scripts/stress/run.ts --list`. Scale is set per scenario and overridable by env:
`STRESS_AGENTS`, `STRESS_BUYERS`, `STRESS_DURATION_SEC`, `STRESS_RATE` (units/s offered, open loop),
`STRESS_INFERENCE_SHARE`, `STRESS_MALICIOUS_FRACTION`, `STRESS_FAILURE_RATE`, `STRESS_LATENCY_MS`,
`STRESS_LATENCY_SIGMA` (log-normal simulated work time), `STRESS_NO_SANDBOX_SHARE` (inference-only
agents), `STRESS_TOPUP_SATS`, plus `STRESS_RAMP_MAX_RATE`, `STRESS_CHURN_FRACTION`,
`STRESS_KILL_MODE=stop|kill`, `STRESS_DOWN_SEC`, `STRESS_LOCK_SEC`, `STRESS_PAUSE_SEC`,
`STRESS_WITHDRAWALS_PER_ACCOUNT`, `STRESS_NUDGE=1` (agents hold a signed-bind mesh WebSocket and pull
at once on a `work_available` nudge, as current workers do; unset = poll-only agents, for a
before/after of pickup time: the coordinators' `/metrics` report `edgecoder_dispatch_pickup_p50_ms` /
`_p90_ms`, reset by `reconfigure.sh`).

| scenario | local | remote | what it does |
|---|---|---|---|
| smoke | yes | yes | every flow once: top-up, code tasks on both coordinators, inference, market order, reservation + reserved inference + cancel |
| ramp | yes | yes | offered rate doubles every step until two steps saturate; saturation = completed < 90% of offered, errors > 5% or task p95 > 30 s |
| soak | yes | yes | constant load; latency drift, coordinator RSS / event-loop lag / queue depth (metrics token) |
| churn | yes | yes | 15% of agents go dark every 10 s for 10-30 s, 60% of them abandoning the claim in hand |
| coordinator-kill | yes (docker stop/start or kill) | prints the `fly machine stop/start` commands only | load, kill coord-a after 40 s, restart after 20 s |
| db-slowdown | yes | refused | `LOCK TABLE credit_transactions IN ACCESS EXCLUSIVE MODE` for 15 s, then `docker pause` Postgres 10 s |
| payout-storm | yes | refused | datacenter-GPU agents earn, then withdrawals inside the earnings hold, over payable, over caps, the same bolt11 to both coordinators ×3, and during an admin pause |
| malicious | yes | yes | 25% of agents: wrong output, replayed signed result, duplicate result, result for another agent's subtask, oversized body |
| market-burst | yes | yes | standing-order burst, racing reservations on the same agents, double cancels, reserved inference, 1 msat/credit bids |

Simulated agents never execute code. An honest agent returns `stress-ok <sha256(input)[:24]>`, so
two honest executions agree under the verifier's comparator (exit status + normalized stdout,
`src/swarm/verification.ts`); a wrong output is a genuine mismatch. Work time is log-normal with a
median of ≥ 1.2 s by default. The coordinator's BHV001 rule measures claim to result receipt
itself; three results faster than 300 ms (code) or 100 ms (inference) send the agent's results to
verification (docs/economy-compute-trust-model.md, "BHV001").

## Invariants

SQL (local targets only, read-only, against the shared Postgres; plus the hub LND node):

- **credits conserved** — Σ balances = P − O − Σ R_t − Σ R_r + X, residual must be 0.000000, where
  P = Σ `quoted_credits` of settled `payment_intents`; O = what payouts took (paid: amount + fee;
  pending: amount + max(fee, fee cap)) from the `payouts` table; R_t = per task, reserve
  (`task_reserve`/`inference_reserve` spends) − work (`compute_contribution` + `network_fee:<task>`
  earns) − refund (`task_submit_refund:<task>`); R_r the same per reservation; X = rows in no class.
  P and O come from other tables than the credit rows, so a purchase credited twice or without a
  settled intent, or a payout debit that does not match its payout, shows as a residual.
- no task pays out more than it reserved (R_t ≥ 0, whole ledger); settled tasks retain nothing (warn)
- no negative balance; each subtask credited once (earnings_accrual, work receipts, earn rows vs reports)
- each settled top-up credited exactly once and backed by a SETTLED hub invoice for its amount;
  no purchase credit without a settled intent; paid-but-unsettled invoices flagged
- no payout paid twice (payment hash / bolt11 unique, one SUCCEEDED LND payment per paid row, no
  LND payment without a row, preimage matches); payouts within earnings matured past the hold at
  the time they were made; caps (single, per-account 24 h, global 24 h) replayed in creation order
- wrong-output agents end up blacklisted (VRF001 strikes, `blacklist_events`)
- no reservation active past its end; ended leases pay out + refund exactly their prepayment

HTTP (every target): `/health/runtime`; with the admin token `/ledger/verify` (#115 reconciliation)
and `/admin/payouts/reconciliation` (ledger vs Lightning node) and the pause state; `/capacity` with
the mesh token an agent receives at `/register`; each harness account's balance via `/v1/account`;
and what the load generator saw itself: attacks accepted, a subtask answered "credited" twice,
top-ups paid but never settled.

What HTTP cannot show on a remote target: per-task reserve accounting (R_t), duplicate execution
across coordinators unless one load generator saw both answers, the earnings hold and caps replay,
and the LND-side matching — `/ledger/verify` checks accruals, fees, projections and negative
balances but not task reserves vs payouts, and without the admin token none of the ledger checks
run. Those gaps are reported as `skipped` invariants.

## Remote targets

A run is pointed at a deployment by its target profile; credentials are a separate file that is read
and never printed or copied into results:

```json
{ "accounts": [ { "role": "provider", "accountId": "acct-<userId>", "apiKey": "eck_..." },
                { "role": "buyer",    "accountId": "acct-<userId>", "apiKey": "eck_..." } ],
  "tokens":   { "admin": "<optional: enables /ledger/verify and payout reconciliation>" },
  "lnd":      { "payee": { "restUrl": "https://...:8080", "macaroonHex": "...", "tlsCertBase64": "..." } } }
```

Provider accounts must have a verified email (the portal approves enrolled nodes only then); the
harness never works around that. Several provider accounts are needed for result verification to
find a replica executor on another account; with one, sampled results wait for the verification
timeout and are then accepted unverified. Buyer accounts top up through `/v1/account/topup`,
paid by the payee node. Withdrawals are not automated on remote targets: the portal sends an
emailed code first (by design).

## Live phase (operator)

Nothing in this repo contacts Fly or edgecoder.io by itself. The live run is driven with
`remote/fly-loadgen.sh`, which prints every flyctl command unless `DRY_RUN=0`:

```sh
scripts/stress/bundle.sh                                   # .stress-runs/bundle/
export LG_APP=ec-stress-loadgen LG_ORG=<org> REGIONS="fra iad sin"
export IMAGE=registry.fly.io/<app>@sha256:<digest>          # the agent image the seed runs: fly image show -a edgecoder-seed
export CREDS=/secure/credentials.json                      # see "Remote targets"
scripts/stress/remote/fly-loadgen.sh setup                 # review, then: DRY_RUN=0 scripts/stress/remote/fly-loadgen.sh setup
STRESS_AGENTS=20 STRESS_BUYERS=2 STRESS_RUN_ID=$(date -u +%y%m%d%H%M) DRY_RUN=0 scripts/stress/remote/fly-loadgen.sh run smoke
DRY_RUN=0 scripts/stress/remote/fly-loadgen.sh collect <run-id>   # .stress-runs/live/<run-id>/merged/report.md
DRY_RUN=0 scripts/stress/remote/fly-loadgen.sh teardown
```

Check `targets/live-regtest.json` first (coordinator and portal URLs, limits). `coordinator-kill`
on live prints the `fly machine stop/start` commands for the operator; `db-slowdown` and
`payout-storm` are refused. Agents enrolled during a live run stay listed under the owner's
account in the portal (node ids `stress-<run>-<region>-a<n>`).
