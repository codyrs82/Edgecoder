# Reservation backfill

A reserved machine whose holder isn't using it may take **small, preemptible network model calls**.
The lease is unchanged. Each call is billed to whoever submitted it. Its host-side earnings are
split between the lease holder and the host. The holder's own jobs always go first.

Code: `src/economy/reservation-backfill.ts` (pure rules), `src/swarm/coordinator/backfill.ts`
(wiring), `dispatch.ts` `claimRule`, `results.ts` `accrueResultCredits`, `credits/store.ts`
`accruePricedJob`, `ledger/reconcile.ts`.

## Opt-in

- Each lease has a flag, `Reservation.backfill` ("Let the network use my idle time"). It is stored
  in `compute_reservations.record_json`, so no migration is needed.
- `POST /account/reservations` takes `backfill: boolean`. When the field is left out, the lease
  uses `RESERVATION_BACKFILL_DEFAULT` (default **on**).
- `POST /account/reservations/backfill {reservationId, enabled}` turns the flag on or off on an
  active lease. The stored row is updated only while it is still active (`jsonb_set ... WHERE
  status = 'active'`), so a lease that another coordinator has ended is never rewritten.
- Leases created before this feature have no flag, so backfill is off for them.
- `RESERVATION_BACKFILL=off` turns backfill off everywhere.

**Why the default is on:** the holder pays for every held second either way. Backfill only adds
credits to the holder: half of the host-side pay for work done while their machine was idle. The
cost to the holder is bounded:

- Their jobs pre-empt the queue.
- A free slot is kept for them on multi-slot agents.
- On a single-slot agent, the worst case is the remainder of one call that was expected to take
  ≤ 15 s. Past that, the backfill call is handed to another agent if its requester hasn't seen any
  output yet.

## Eligibility (`backfillGate` + `backfillCallEligible`)

The gate is checked once per pull, against the agent and the lease:

- the lease has opted in;
- the agent is live, not blacklisted, its circuit is closed and its memory is not under pressure;
- **no lease job is queued** (claimable or not) and **none is running** on the agent;
- the backfill calls the agent is running are below the slot cap. The cap is
  `max(1, floor(slots × RESERVATION_BACKFILL_SLOT_FRACTION))`; on agents with 2 or more slots it is
  at most `slots − 1`.

The call itself must meet all of these:

- It is a model call (`kind: "inference"`). Code jobs are never backfill: they need a sandbox,
  they're billed per second, and their size isn't known in advance.
- It is not a lease job and not an own-machines job (`reservationId` / `onlyAccountId`).
- Its model is not restricted (the security research tier).
- It is not paid from the buyer's own wallet (NWC). That tally has no holder share.
- Its model is **already loaded** on the agent, or, without memory telemetry, it is the agent's
  active model or the lease's model. Loading another model would evict the holder's model.
- `contextNeeded` (the prompt plus reply room) is ≤ `RESERVATION_BACKFILL_MAX_TOKENS` (8192).
- The expected run on *this* agent is ≤ `RESERVATION_BACKFILL_MAX_SECONDS` (15 s). This estimate
  is `promptTokens / prefillTps + expectedOutputTokens / decodeTps`. It comes from `describeJob`
  (job-descriptor / job-complexity) and the agent's measured tokens per second (best-fit `decodeTps`).
- The normal network rules also apply: the sandbox, the model check, the context window, peer
  grants, the restricted-model rule, the order book's market match and capability constraints,
  and the envelope policy.

Admission is not changed. Routing and `/inference/submit` still treat reserved agents as
unavailable. Backfill only absorbs network calls that are already queued. A call that only a
reserved machine could serve is still refused as before.

## Priority and slots

- While a lease job is queued, the gate is closed. So a reserved agent's pull can only return the
  lease's own jobs (`claimRule`), and no new backfill starts.
- A lease job takes a free slot at once (`mayTakeNow`). The slot cap keeps headroom on multi-slot
  (vLLM) agents.
- Fast dispatch's deferral also applies: a reserved agent that already holds work leaves a fresh
  network call to an idle network agent for `DEFER_MS`. In practice, backfill is spillover.

## Preemption (`preemptOverrunBackfill`, every 2 s)

The rule applies when a lease job is waiting and a backfill call on the agent has run longer than
`RESERVATION_BACKFILL_MAX_SECONDS`:

- **The requester has seen nothing yet:** the call is handed to another agent by
  `retryInferenceElsewhere`. The reserved agent is excluded, its late pieces and result are
  refused, and nothing is charged for the cut run (only successes are paid). The agent stops at its
  next piece: the coordinator answers `403 not_claimant`, and the runner aborts the call
  (`CLAIM_REVOKED_ERROR`), which frees the slot.
- **Part of the reply has already streamed:** the call finishes. The billing code can't charge for
  partial output (a cut stream is refunded in full and the requester gets an error), so finishing
  is the cheaper outcome for everyone. The size caps bound how long this takes.

**Measured holder wait:** each lease job that became claimable while backfill ran on the agent
has its pickup wait recorded. This is an upper bound on the added wait. The lease API reports it
as `backfillStats.holderWait {samples, p50Ms, maxMs}`. Target: ≤ a few seconds on multi-slot
agents. On single-slot agents, the bound is the remainder of one call of ≤ 15 s.

## Billing

- The submitter is charged exactly as for any network call (reserve, then settle).
- `accrueResultCredits` computes `agentMsat` and `feeMsat` with `splitJobCost` as usual. For a
  backfill call (recorded at claim; after a restart, any non-lease call that an agent with an
  opted-in active lease ran wholly inside that lease), it then splits the earnings:
  - `holderMsat = floor(agentMsat × holderShareBps / 10000)`;
  - `hostMsat = agentMsat − holderMsat`.
- `accruePricedJob` writes the following in **one transaction** with the contribution report:
  - the host's earn row, `reservation_backfill_host:<lease>`;
  - the holder's earn row, `reservation_backfill_holder:<lease>`;
  - the normal `network_fee:<task>` row.

  Both earn rows have `related_task_id` = the backfill task. Conservation is exact to the msat:
  host + holder + fee = cost.
- **Cap at the lease price.** The holder's total backfill credit on one lease never exceeds what
  they paid for it (`prepaidMsat`). At best, the reservation becomes free. Past the cap, the
  holder's share goes to the host, so host + holder + fee is still the cost
  (`capBackfillSplit`).
  - On Postgres, the holder's running total for the lease is read under a per-lease advisory lock
    (`BACKFILL_CAP_LOCK_NAMESPACE`, keyed by the holder reason). The read happens in the accrual's
    own transaction, so concurrent accruals can't over-credit.
  - In memory, the read and the write happen with no await in between.
  - A lease that is no longer in the book caps at 0.
- The `earnings_accrual` record carries the host's `credits` and `msat`, plus
  `backfill {reservationId, holderAccountId, holderMsat, hostMsat, holderShareBps, holderCapMsat,
  cappedMsat}`. These are the amounts after the cap; `cappedMsat` is what the cap moved from the
  holder to the host.
- The lease's own accounting (prepaid, used, refund, settlement at end) is unchanged. The lease
  fields are never touched.
- Ledger checks (`/ledger/verify`, `reconcile.ts`):
  - host + holder must equal the recomputed `agentMsat`;
  - the holder's part plus `cappedMsat` must equal the recorded share;
  - per (holder, task), the holder rows must match the accruals (`backfill_split_mismatch`);
  - host rows count with `compute_contribution` rows;
  - task-reserve "paid" (and `taskLedgerTotals` in billing restore) includes both backfill reasons,
    so a reserve is never refunded twice.

  There are no spends, so no balance can go negative.

## Visibility

- `/account/reservations/list` and `POST /account/reservations` return `backfill` and
  `backfillStats {jobs, earnedCSats, capCSats, remainingCSats, holderShare, preempted, holderWait,
  active}` for each lease. `capCSats` is the lease price and `remainingCSats` is the room left
  under it.
  Jobs and earnings come from the ledger (`earnIncome`, by reason).
- The holder's credit history (`/account/summary` recent, wallet) shows
  `reservation_backfill_holder:*` rows labeled "Your reserved machine's idle time (network jobs)".
- The portal (Settings › Compute) and the desktop (Compute market) show one line on the lease:
  "Idle time shared with the network · N jobs · X cSats to you".

## Safety

- Backfill calls are ordinary network subtasks. A lease job (`reservationId`) still matches only
  its own lease's agent. A backfill call never carries, and is never given, lease data. Lease jobs
  are never billed as network work (`accrueResultCredits` still returns early for `reservationId`).
- The sandbox, restricted-model, host-approval, envelope and market rules are unchanged. A lease
  holder's own-machines placement (`onlyAccountId`) is never backfill.
- The holder can't profit from backfill beyond getting the lease free (the cap).
- Self-dealing gains nothing. A holder or host who submits work to the leased machine pays the full
  price and gets back at most the host-side share less the fee.

## Ending a lease whose machine went offline

This is not backfill-specific, but it is part of the same change.

- A lease ends as `agent_offline` once its agent has been unseen for 2 minutes. It is billed up to
  the agent's **last-seen time**, clamped to `[startMs, endMs]`, not up to the moment the
  coordinator noticed. The host's pay and the holder's refund follow from that time
  (`offlineEndMs`, `ReservationBook.due`).
- The last-seen time is the newer of two values:
  - this coordinator's `agentCapabilities[agent].lastSeenMs`, updated on registration, heartbeat
    and mesh activity;
  - the newest `agent_registry.last_seen_ms` any coordinator recorded. This one is persisted in
    Postgres, so it survives a coordinator restart.
- **Fallback:** with no shared store and no local record (a restart without Postgres), or when the
  last-seen time is 0 (a clean goodbye zeroes the local value), the lease is billed to the time it
  was noticed, as before.

## Defaults

| Variable | Default | Why |
|---|---|---|
| `RESERVATION_BACKFILL` | on | Kill switch. |
| `RESERVATION_BACKFILL_DEFAULT` | on | Pure upside for the holder, with bounded latency cost (see above). |
| `RESERVATION_BACKFILL_HOLDER_SHARE` | 0.5 | The owner's decision. |
| `RESERVATION_BACKFILL_MAX_TOKENS` | 8192 | A typical chat turn with the default reply room. |
| `RESERVATION_BACKFILL_MAX_SECONDS` | 15 | Keeps the single-slot worst case near "a few seconds" on average. |
| `RESERVATION_BACKFILL_SLOT_FRACTION` | 0.5 | Half the slots, and always ≥ 1 slot free on multi-slot agents. |
