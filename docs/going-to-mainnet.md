# Going to mainnet

Checklist for switching a coordinator from testnet/signet to real sats (`BITCOIN_NETWORK=bitcoin`).
Work through it per seed; both seeds share one database, so the shared items (pause flag,
caps, fee-pool lock) only need checking once. Mechanics are in
[economy-math.md](economy-math.md) section 5 ("Hot-wallet safeguards").

## Lightning node

- [ ] `LIGHTNING_PROVIDER=lnd` (or `cln`) with `LND_REST_URL` on a private network or loopback.
- [ ] TLS pinned: `LND_TLS_CERT_BASE64` is the node's own `tls.cert` (or `NODE_EXTRA_CA_CERTS` in
      the infra bundle), so the macaroon is never sent to anything else.
- [ ] Macaroon scoped to what the coordinator needs (invoices, payments, balance and payment
      reads: `lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write onchain:read info:read`),
      not `admin.macaroon`. Reconciliation needs `offchain:read` + `onchain:read`.
- [ ] The node is dedicated to the coordinator. Any other outgoing payment trips reconciliation
      (`unknown_payments`) and pauses payouts.
- [ ] Hot wallet holds only what a few days of payouts need; the rest sits in cold storage.
- [ ] Seed and `channel.backup` (SCB) backed up offline; restore rehearsed once on regtest
      (`deploy/lnd-test/`).
- [ ] `ECONOMY_PAYMENTS_ENABLED` is not `false`.

## Payout safeguards

- [ ] Caps reviewed. Unset on mainnet they are 100k sats per payout, 500k per account per 24 h,
      2M for the coordinator per 24 h. Set `PAYOUT_MAX_SINGLE_SATS`,
      `PAYOUT_MAX_ACCOUNT_DAILY_SATS`, `PAYOUT_MAX_GLOBAL_DAILY_SATS` explicitly; the global cap
      should not exceed what you can lose from the hot wallet in a day.
- [ ] `GET /admin/payouts/pause` shows `paused: false` and the limits you expect.
- [ ] Kill-switch drill: `POST /admin/payouts/pause {"paused": true, "reason": "drill"}`, confirm a
      withdrawal returns `503 payouts_paused` while a purchase invoice still settles, then resume
      with `{"paused": false}`. Both changes appear as security events and
      `payouts_pause_changed` ledger records.
- [ ] Know the break-glass path: `PAYOUTS_PAUSED=1` and a restart pauses an instance even if the
      admin token is compromised; it cannot be lifted over the API.
- [ ] Reconciliation runs: `GET /admin/payouts/reconciliation` shows a recent `status: "ok"` (not
      `unsupported` or `error`). `PAYOUT_RECONCILE_TOLERANCE_SATS` fits your routing-fee noise.
- [ ] `PAYOUT_ALERT_WEBHOOK_URL` points at an alerting channel someone watches; trigger one alert
      on a staging coordinator to see it arrive.
- [ ] Runbook for a trip: payouts stay paused until an admin resumes. Read the failed checks,
      compare `GET /economy/payouts/:accountId` and the node's payments, fix the cause, then resume.

## Secrets and access

- [ ] `ADMIN_API_TOKEN`, `PORTAL_SERVICE_TOKEN`, `MESH_AUTH_TOKEN`, `PAYMENT_WEBHOOK_SECRET` are
      long random values, set as platform secrets, distinct per purpose, never in git.
- [ ] `PAYMENT_WEBHOOK_SECRET` is set (production refuses unsigned payment webhooks).
- [ ] `MESH_PEER_ALLOWLIST` lists every peer with `@url` pins; `COORDINATOR_PRIVATE_KEY_PEM` is
      stable per seed.
- [ ] Account-scoped payout routes accept only the portal service token (not the mesh token).

## Database and operations

- [ ] Postgres backups (point-in-time if possible) cover `payouts`, `credit_transactions`,
      `payment_intents` and `payout_controls`; a restore has been tested.
- [ ] Both seeds point at the same `DATABASE_URL` (the fee-pool advisory lock and the global
      payout lock only coordinate instances that share a database).
- [ ] Logs with `security:payout_*` events are retained and searchable.

## Request signing and trust

- [ ] `DATABASE_URL` is set on every seed: signed-request nonces then live in `request_nonces`,
      survive restarts and are shared, so a request replayed to the other seed is refused. Watch
      for `nonce_store_degraded_to_memory` in the logs (database unreachable; replays are then
      only caught per instance until it recovers).
- [ ] `NODE_ENV=production` (forces `REQUIRE_SIGNED_AGENT_REQUESTS`). Signed requests are bound
      to the exact body bytes (`x-body-sha256` must hash the raw body), so a captured signature
      cannot carry a different body; `security:replay_attempt` with `body_hash_mismatch` means
      someone tried.
- [ ] Infrastructure hosts paid from this pool heartbeat with a signature from their mesh key
      (`INFRA_HOST_REPORT_URLS` on the host) and are allowlisted in `MESH_PEER_ALLOWLIST` with an
      `@url` pin; `GET /economy/hosts` shows `services` (attested) next to `declaredServices`.
      A declared service that is missing from `services` earns nothing until it answers the probe.
- [ ] `MESH_WS_REQUIRE_SIGNED=true` once every agent build signs its `/mesh/ws` bind (agents built
      after the body-binding change do). Until then unsigned binds still work but can never take
      over an authenticated connection.

### Switching agents to `EDGECODER_TRUST_MODE=strict`

`tofu` stays the default so new agents can onboard. Flip production agents to `strict` once the
coordinator keys are distributed:

1. Collect each seed's trust entry: `curl -s https://<seed>/identity | jq -r .trustEntry`
   (`peerId:fingerprint`, the sha256 of the key's SPKI DER). Check it out of band (the deploy
   pipeline's key, not just the live answer).
2. Publish the list (release notes, installer config) as
   `TRUSTED_COORDINATOR_KEYS=coord-a:<fp>,coord-b:<fp>`. Agent builds from before the fingerprint
   unification compare a PEM-text hash instead: for them use `legacyFingerprints[1]` from
   `/identity` (sha256 of the trimmed PEM plus a newline, what their trust files hold). New
   builds accept either form.
3. Roll `TRUSTED_COORDINATOR_KEYS` out with `EDGECODER_TRUST_MODE` still `tofu`, and confirm agents
   log no `pinned_mismatch` (a mismatch already refuses that coordinator in `tofu`).
4. Set `EDGECODER_TRUST_MODE=strict`. A strict agent with nothing listed refuses to start (it says
   so); one pointed at an unlisted coordinator backs off and fails over instead of exiting, and
   discovery skips announced coordinators whose key is not listed. A key mismatch for a listed
   id still stops the agent.
5. Key rotation from then on: add the new entry next to the old one, roll it out, rotate the
   coordinator, then remove the old entry.
6. Consider withholding the registration token from agents until their trust list is in place.
