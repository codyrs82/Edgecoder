# Security research tier

A gated tier for verified organisations doing authorized security testing. Its models must never
run on the open network or on random hosts.

This document covers the gating and routing only. **No model is listed yet**: models are chosen
after counsel agrees the policy (see "Before any model is listed").

Code:
- `src/swarm/restricted-models.ts`
- `src/swarm/coordinator/restricted.ts`
- `src/swarm/coordinator/routes/restricted.ts`
- `src/portal/security-research.ts`

Threat model: [agent threat model, section 5](security/agent-threat-model.md#5-security-research-tier-restricted-models).

## Eligibility

Access is granted to an account (the portal has no organisations; the organisation is recorded on
the entitlement) when all of these hold:

- The organisation is verified: it exists, and the person holding the account acts for it.
- It has signed an authorization agreement. The agreement says it will use the tier only to test
  systems it owns or is explicitly authorized in writing to test.
- The agreement has an end date. Access expires no later than that date, and at most two years
  after the grant.

## How access is granted

In Settings > Admin > **Security research access** (system admins only), the admin records:

- the account (email or user id);
- the kind:
  - **Call restricted models** (`security_research`): the account may list and call them;
  - **Host restricted models** (`security_research_host`): the account's machines may run them;
- the organisation name and verification notes (how the organisation and signatory were verified);
- the signed agreement reference (a document id or URL in the company's records), and the date it
  was accepted;
- the expiry date.

The admin who granted access is recorded too.

**Suspend** takes effect at once and can be undone (**Reinstate**). **Revoke** is final: to give
access again, make a new grant with its own agreement.

Every change is pushed at once to every known coordinator
(`POST /account/restricted-access/update`, portal service token). Coordinators also re-read the
whole list every `RESTRICTED_ACCESS_SYNC_MS` (`GET /internal/security-research/entitlements`).

A coordinator **fails closed**: an entitlement the portal has not confirmed for
`RESTRICTED_ACCESS_MAX_STALE_MS` (default 10 minutes) is not honoured. When access is suspended,
revoked, expires or goes stale, that account's calls in flight are cancelled.

## Making a model restricted (operator)

On every coordinator, set `RESTRICTED_MODELS_JSON` to a JSON object that maps each model tag to a
tier:

```
RESTRICTED_MODELS_JSON={"<model:tag>": "security_research"}
```

- The default is empty: no restricted models.
- A value that cannot be read stops the coordinator.
- The list must be the same on every coordinator. A coordinator without the entry would treat the
  model as open.

Hosts that will run a restricted model need both of these:

- the owner's host entitlement (above);
- `AGENT_ALLOW_RESTRICTED_MODELS=1` on the agent, which it reports with each signed pull.

## Routing guarantees

A call for a restricted model is refused with `403 restricted_model` unless the requesting account
holds a valid `security_research` entitlement. With one, it runs only:

- on the requester's own machines (`target: "mine"`), or
- on the machine held by an active lease the requester holds (`reservationId`).

It never goes to the open pool:

- A network call is refused (`403 restricted_model`, `reason: reserved_placement_required`).
- Code work naming a restricted model is always refused.

The agent that takes the call must have opted in and its owner must hold a host entitlement.
Otherwise submit answers `409 no_restricted_host`, and no such agent can claim the call.

This is enforced twice:

- **At submit**: the checks above.
- **At claim**: `claimRule` in `src/swarm/coordinator/dispatch.ts`. A claim is checked against the
  call as admitted at submit on that coordinator. A subtask that names a restricted model but was
  never admitted there can never be claimed, whatever placement fields it carries: a gossiped or
  replayed subtask, one restored after a restart, or a forged one. An agent whose active model is
  restricted takes no code work that names no model.

Listings:

- `GET /inference/models`, the portal's compute picker, `/v1/models` and the desktop picker show
  a restricted model only to entitled accounts.
- It is marked `restricted`, and offered only as "your machines" (or through a lease), never as
  network compute.
- `model: "auto"` never picks one, for anyone. This covers the portal's and the desktop's
  client-side plan, and the coordinator's best-fit routing (`withoutRestrictedModels` in
  `src/swarm/coordinator/routing.ts`). The submit gate also runs on the model that auto resolved
  to, so auto cannot route around it.

A per-account rate limit applies: `RESTRICTED_MODEL_RATE_LIMIT_PER_MIN`, default 20 per minute,
then `429`.

## Logging

Every restricted-model call is logged:

- when it is submitted, claimed and ended;
- with the account, model, tier, placement, lease, agent, host account, times, outcome and token
  counts.

Where the log goes:

- the security event log (`restricted_model_call`; refusals are `restricted_model_refused`,
  cancellations `restricted_access_suspended`);
- the coordinator database table `restricted_model_calls`;
- operators can read recent calls at `GET /admin/restricted-models` (admin token). This view never
  returns prompts or outputs.

**Prompts and outputs are not logged by default.** `RESTRICTED_MODEL_LOG_PROMPTS=true` stores
them in `restricted_model_calls`.

**For counsel: the privacy trade-off.**

- Logging prompts and outputs gives the strongest record of what the tier was used for. That
  helps in investigating misuse and in showing that use stayed within the agreement.
- But the log then holds the organisation's test targets, findings and possibly exploit details.
  That is sensitive data about third-party systems. It is a breach target, it is subject to
  retention and disclosure duties, and it may conflict with the organisation's own confidentiality
  duties to its clients.
- Metadata alone (who, when, which model, how much) supports rate and abuse review without
  holding that content.
- A decision is needed on all of these:
  - whether prompts are logged;
  - for how long;
  - who may read them;
  - whether the agreement must say so.

## Before any model is listed

Counsel must approve, in writing:

1. The eligibility criteria and verification standard for organisations and signatories.
2. The authorization agreement text, including the authorized-targets clause, the term, and the
   consequences of misuse.
3. The logging policy: whether prompts and outputs are logged
   (`RESTRICTED_MODEL_LOG_PROMPTS`), retention, access and disclosure. See the trade-off above.
4. Who may host:
   - whether only the entitled organisation's own machines are allowed;
   - or also approved third-party hosts reached through leases;
   - and what those hosts must agree to (they see prompts and hold the weights).
5. The specific models and their licences, including whether the licence permits this use and
   distribution to hosts.
6. Export-control and sanctions review for the models and the eligible organisations.
7. The suspension and incident process: who can suspend, and how quickly.

## Not done yet

- **No model is listed.** `RESTRICTED_MODELS_JSON` is empty everywhere.
- **Cancelling a call does not stop the agent.** The coordinator ends the requester's stream and
  refuses the agent's further output, but the agent's local generation runs until it times out.
- **Direct work and remote model control are not covered.** Same-account direct work between
  agents (`/agent-mesh/direct-work`) and remote model control run on the target's own models.
  They never cross accounts, but they are not gated by this tier.
- **The network world view is not filtered.** `/network/world` and peers' world views (which
  best-fit reads) still show which models machines hold; best-fit drops the restricted ones.
- **Deleting an account removes its entitlements.** The coordinators drop the entitlement at their
  next sync (`RESTRICTED_ACCESS_SYNC_MS`); the account's sessions and keys are cut at once anyway.
- **Restarts end calls.** A restricted call in flight when its coordinator restarts is not
  restored: it becomes unclaimable and times out. This is fail closed.
