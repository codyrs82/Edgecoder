# Secret rotation runbook

How to rotate each shared secret without downtime. No values appear here; generate new ones on
an operator machine and set them with `fly secrets set` (or the host's env file). Never paste a
secret into a ticket, a commit or a chat.

Generate a token: `openssl rand -hex 32` (64 characters; production requires at least 32 for
`ADMIN_API_TOKEN`).

## How dual-accept works

Verifiers accept the current value and, during a rotation, the previous one:

| Secret | Previous-value variable | Who verifies it |
|---|---|---|
| `ADMIN_API_TOKEN` | `ADMIN_API_TOKEN_PREVIOUS` | coordinators, control plane |
| `MESH_AUTH_TOKEN` | `MESH_AUTH_TOKEN_PREVIOUS` | coordinators |
| `PORTAL_SERVICE_TOKEN` | `PORTAL_SERVICE_TOKEN_PREVIOUS` | coordinators, control plane, portal (`/internal/*`, origin lock) |
| `CONTROL_PLANE_ADMIN_TOKEN` (portal's copy of the control plane admin token) | `CONTROL_PLANE_ADMIN_TOKEN_PREVIOUS` | portal (`/internal/*` mutations) |
| `PORTAL_ACTION_SIGNING_KEY` | several keys in `PORTAL_ACTION_VERIFY_KEYS` | coordinators |

The previous value is accepted only until `TOKEN_PREVIOUS_UNTIL` (ISO 8601, at most 7 days
ahead; set it to "now + N hours", for example `date -u -v+24H +%Y-%m-%dT%H:%M:%SZ` on macOS or
`date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ` on Linux). Without it the previous value is ignored.
Senders always send the current value. One `TOKEN_PREVIOUS_UNTIL` per app covers every
`*_PREVIOUS` on that app.

General order for a shared token:

1. **Verifiers first**: on every app that checks the token, set the new value as the token and
   the old value as `<NAME>_PREVIOUS`, with `TOKEN_PREVIOUS_UNTIL`. Each app now accepts both and
   sends the new one.
2. **Senders**: any remaining holder (scripts, VMs, the operator machine) switches to the new value.
3. **Verify**: watch for 401s in the logs (`invalid_admin_token`, `mesh_unauthorized`,
   `portal_service_token_required`).
4. **Close the window**: unset `<NAME>_PREVIOUS` and `TOKEN_PREVIOUS_UNTIL` (it also closes on its
   own at `TOKEN_PREVIOUS_UNTIL`).

If a value leaked, skip the window: set the new value everywhere, no `_PREVIOUS`, and accept a
short refusal window while the apps restart.

`fly secrets set` restarts the app's machines. Stage several secrets with `--stage` and apply
them with one `fly secrets deploy` to restart once.

## ADMIN_API_TOKEN

Held by: `edgecoder-seed` and `edgecoder-seed-eu` (`ADMIN_API_TOKEN`, used by the coordinator and
the control plane in the same process); the portal (`COORDINATOR_ADMIN_TOKEN` and
`CONTROL_PLANE_ADMIN_TOKEN`); the operator machine (`~/.config/edgecoder/coordinator-admin-token`, for
scripts that call admin routes; the money-loop scripts now run admin calls inside the seed with the
seed's own token).

1. On both seeds: `ADMIN_API_TOKEN=<new>`, `ADMIN_API_TOKEN_PREVIOUS=<old>`,
   `TOKEN_PREVIOUS_UNTIL=<now + 24 h>`. Deploy one seed, check `/health/runtime`, then the other.
2. On the portal: `COORDINATOR_ADMIN_TOKEN=<new>`, `CONTROL_PLANE_ADMIN_TOKEN=<new>`,
   `CONTROL_PLANE_ADMIN_TOKEN_PREVIOUS=<old>`, `TOKEN_PREVIOUS_UNTIL=<same time>` (the control
   plane sends its admin token to the portal's `/internal/*`).
3. Update the operator machine's file.
4. Check Settings > Revenue and Settings > Network load in the portal.
5. Unset `ADMIN_API_TOKEN_PREVIOUS`, `CONTROL_PLANE_ADMIN_TOKEN_PREVIOUS` and
   `TOKEN_PREVIOUS_UNTIL` on all three apps.

## MESH_AUTH_TOKEN

Held by: both seeds, any other coordinator that peers with them (`COORDINATOR_MESH_TOKEN` is an
alias on the control plane), and operator tooling. Agents do not need it: they authenticate with
their own registered key. Where an agent host still has it (the GPU VM's
`/etc/edgecoder/agent-*.env`, or an older VM), remove it there rather than rotate it.

1. On both seeds: `MESH_AUTH_TOKEN=<new>`, `MESH_AUTH_TOKEN_PREVIOUS=<old>`,
   `TOKEN_PREVIOUS_UNTIL=<now + 24 h>`. Deploy one at a time; each accepts the other's old token
   while the second one restarts, so gossip and forwarded work continue.
2. Any other coordinator that peers with the seeds: set the new value.
3. The GPU VM: remove `MESH_AUTH_TOKEN` / `EDGECODER_MESH_TOKEN` from its agent env files and
   restart the agent service; confirm it re-registers (signed) in Settings > Network.
4. The old Chicago VM: its mesh token is empty. An empty token makes the mesh routes open when
   `NODE_ENV` is not `production` (and 503 when it is). Either stop the coordinator on it and remove
   it from the seeds' `MESH_PEER_ALLOWLIST` and discovery, or give it the new token and
   `NODE_ENV=production`. Do not leave it running with an empty token.
5. Unset `MESH_AUTH_TOKEN_PREVIOUS` and `TOKEN_PREVIOUS_UNTIL` on the seeds.

## PORTAL_SERVICE_TOKEN

Held by: the portal, both seeds (coordinator and control plane), and the backup-report job
(`scripts/ops/report-pg-backups.sh`). It is sent both ways (portal to seeds, seeds to the portal's
`/internal/*`), so the portal goes first and last:

1. Portal: `PORTAL_SERVICE_TOKEN=<old>`, `PORTAL_SERVICE_TOKEN_PREVIOUS=<new>`,
   `TOKEN_PREVIOUS_UNTIL=<now + 24 h>`. It accepts both and still sends the old one.
2. Both seeds: `PORTAL_SERVICE_TOKEN=<new>`, `PORTAL_SERVICE_TOKEN_PREVIOUS=<old>`,
   `TOKEN_PREVIOUS_UNTIL=<same time>`. They accept both and send the new one, which the portal accepts.
3. Portal: `PORTAL_SERVICE_TOKEN=<new>`, `PORTAL_SERVICE_TOKEN_PREVIOUS=<old>`.
4. Update the backup-report job's token.
5. Check: the wallet page, a chat, a node validation (`/internal/nodes/validate` from a seed).
6. Unset the `_PREVIOUS` values and `TOKEN_PREVIOUS_UNTIL` on all three apps.

`PORTAL_COORDINATOR_TOKEN` is deprecated (coordinators sign their calls; turn it off with
`PORTAL_COORDINATOR_TOKEN_ACCEPTED=false` on the portal). While it is still set it has no previous-value support. Rotate it by unsetting it on
the seeds first (they then send `PORTAL_SERVICE_TOKEN`, which the portal accepts), setting the new
value on the portal, then setting it on the seeds.

The withdraw and payout-destination routes do not trust this token alone once
`REQUIRE_PORTAL_ACTION_SIGNATURE=true`; see the next section.

## Portal action signing key (PORTAL_ACTION_SIGNING_KEY)

The portal signs each withdrawal and payout-destination request with an Ed25519 key; the
coordinators hold only public keys (`PORTAL_ACTION_VERIFY_KEYS`), so a coordinator's secrets
cannot forge an assertion.

Generate a key pair (prints the private key as PEM on stdout and the public key on stderr):

```sh
node -e 'const c=require("crypto");const {privateKey,publicKey}=c.generateKeyPairSync("ed25519");process.stdout.write(privateKey.export({type:"pkcs8",format:"pem"}));console.error(publicKey.export({type:"spki",format:"der"}).subarray(12).toString("base64"))'
```

First rollout:

1. Coordinators: `PORTAL_ACTION_VERIFY_KEYS=<public key>` (leave
   `REQUIRE_PORTAL_ACTION_SIGNATURE` unset). Deploy both seeds.
2. Portal: `PORTAL_ACTION_SIGNING_KEY=<private key PEM>`. Deploy.
3. Check the coordinator logs: withdrawals and destination changes log no
   `portal_action_unsigned_accepted` and no `portal_action_refused`.
4. Coordinators: `REQUIRE_PORTAL_ACTION_SIGNATURE=true`. From now on the service token alone cannot
   withdraw or change a destination.

Rotation:

1. Coordinators: `PORTAL_ACTION_VERIFY_KEYS=<old public>,<new public>`.
2. Portal: `PORTAL_ACTION_SIGNING_KEY=<new private>`.
3. After a few minutes (assertions live at most 2 minutes): coordinators
   `PORTAL_ACTION_VERIFY_KEYS=<new public>`.

The money-loop helper `seed-query.mjs withdraw` / `address` sends the service token without an
assertion, so it works only on coordinators with `REQUIRE_PORTAL_ACTION_SIGNATURE` off (test
networks).

## COORDINATOR_REGISTRATION_TOKEN

A per-node enrollment token: the portal stores only its hash, and peers check it through the
portal when this coordinator registers with them (at start and on re-registration). Existing
peering is not affected while it changes, so it needs no dual-accept window; the order matters:

1. In the portal, as the node's owner, re-enroll the coordinator's node ID (Settings > Nodes).
   The response shows the new token once; the old one stops validating now.
2. Immediately set it on that coordinator app: `fly secrets set COORDINATOR_REGISTRATION_TOKEN=<new>`
   (this restarts it, and it registers with its peers using the new token).
3. Check the peers' logs for `mesh_bootstrap_registered` from it.

If the coordinator restarts between steps 1 and 2 it is refused by its peers until step 2.

## Cloudflare API token

Used from the operator machine only (`scripts/cloudflare-bootstrap.sh`, DNS changes;
`~/.config/edgecoder/cloudflare.token` or `CLOUDFLARE_API_TOKEN`). Cloudflare tokens are
independent, so:

1. In the Cloudflare dashboard, create a new token with the same permissions (Zone Read, DNS Edit,
   and Pages Edit if used), scoped to the edgecoder zone only, with an IP filter for the operator's
   address if practical.
2. Replace the local file; run a read-only call (`curl -H "Authorization: Bearer ..." https://api.cloudflare.com/client/v4/user/tokens/verify`).
3. Roll the old token (delete it) in the dashboard.

## Test account API keys

The load-test and money-loop accounts (`~/.config/edgecoder/e2e/accounts/*.json`) hold API keys.
For each account: create a new key in the portal (Settings > API keys) or, for agent accounts,
sign up again with the same key (`POST /agents/signup` revokes the earlier keys), update the JSON
file, then revoke the old key. Nothing else holds them.

## Admin access after this change

Admin-token routes on the coordinators refuse requests that come through the public edge
(`ADMIN_ALLOWED_CIDRS` in site-docs/reference/environment-variables.md). Operator access:

- On the machine: `fly ssh console -a edgecoder-seed`, then `curl -H "x-admin-token: $ADMIN_API_TOKEN" http://127.0.0.1:4301/admin/payouts/pause`.
- From the portal: `COORDINATOR_ADMIN_URLS=http://edgecoder-seed.internal:<ADMIN_LISTEN_PORT>,http://edgecoder-seed-eu.internal:<ADMIN_LISTEN_PORT>`
  with `ADMIN_LISTEN_PORT` set on the seeds (a port in no `fly.toml` service).
- From an operator machine: `fly proxy <local>:<ADMIN_LISTEN_PORT> -a edgecoder-seed` (WireGuard;
  the request arrives from the private network), then call `http://localhost:<local>`.
