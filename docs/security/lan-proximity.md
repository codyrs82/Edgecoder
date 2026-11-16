# LAN proximity: machines on the same network

Same network is about physical proximity, not accounts. Two EdgeCoder machines on one home or
office network can reach each other in a millisecond or two; through the coordinator the same work
goes out to a Fly region and back (~70 ms or more). This page covers how machines find each other
on a LAN (any account), how the coordinator uses it, the optional direct transfer between them, and
what someone else on the LAN can and cannot do.

There are two sources of "same network", merged on the desktop's Network page:

1. **Your own machines** (#342): the coordinator shares your machines' private addresses with your
   desktop app only, which pings them (ICMP). Unchanged; see "Your own machines" below.
2. **Any EdgeCoder machine on your LAN** (this page): agents announce a rotating LAN id over mDNS
   and measure each other; no private address ever goes to a coordinator.

## Discovery (Part 1, on by default)

`AGENT_LAN_DISCOVERY` (default on; the desktop's "Find EdgeCoder machines on my network").
Code: `src/swarm/lan-mdns.ts` (codec), `src/swarm/lan-discovery.ts` (agent),
`src/swarm/lan-registry.ts` and `src/swarm/coordinator/lan.ts` (coordinator).

1. **Rotating LAN id.** Each agent makes a random 16-hex LAN id and a random 32-byte LAN key, and
   replaces both every 15 minutes (the previous pair is kept for one more rotation so late reports
   resolve). The id is not the agent id, not the account, and not derived from either.
2. **Registration.** In its signed heartbeat the agent sends `lan: { ids: [{ id, key }], direct,
   neighbours }` to its coordinator (TLS, request-signed; unsigned heartbeats register nothing). The
   coordinator maps id -> agent and keeps the key in memory only. `ids: []` (discovery off) makes it
   forget the agent.
3. **Announcement.** mDNS / DNS-SD on 224.0.0.251:5353 with a multicast hop limit of 1 (link-local:
   it never leaves the LAN): a PTR `_edgecoder._tcp.local -> <id>._edgecoder._tcp.local`, an SRV
   and a TXT record with only
   - `id` the LAN id,
   - `p` the proof: HMAC-SHA256(LAN key, id + minute window), first 16 hex,
   - `w` the minute window,
   - `e` the UDP port of the echo responder,
   - `d` the TCP port of the direct listener, only when direct transfer is on.

   No host name, agent id, account, model list or address is in it. Agents re-announce every 30 s,
   answer queries for the service (at most every 200 ms) and send a goodbye (TTL 0) when they stop.
4. **Round trip.** Each agent pings the neighbours it heard with a tiny UDP echo: `ECP1 PING
   <nonce>`; the responder answers only `ECP1 PONG <its LAN id> <nonce>`, to private or link-local
   senders, at most 5 per second per sender and 50 per second in all. Three pings, the fastest
   counts; a reply from another address or id does not count. Every 60 s.
5. **Report.** In its heartbeat the agent reports up to 16 neighbours as `{ id, p, w, rttMs }`. The
   neighbour's address is kept on the agent's own computer (to ping it and, with direct transfer,
   to connect to it) and never sent anywhere.
6. **Resolution.** The coordinator accepts a report only when `p` is the valid proof of `id` under
   the key that id's agent registered, for the current window or the two before it (so a report
   shows the reporter heard the neighbour's own announcement within the last few minutes), and the
   round trip is at most 50 ms. A neighbour registered with another coordinator is resolved against
   that coordinator's current proofs, which coordinators share mesh-only (`lanProofs` in
   `/network/world/local`, never the key); reports travel the same way (`lanReports`), so proximity
   is found in both directions across coordinators.
7. **Proximity.** A pair counts as neighbours if either reported the other; the better measurement
   wins. Connected pairs form proximity groups (`LanRegistry.groups`).

### What the coordinator does with it

- **Best fit (#311)**: a host on the requester's LAN gets `BEST_FIT_LAN_BONUS` (default 0.05) added
  to its score. Between near equals the host next door wins; a far better fit elsewhere still wins.
  The routing line says "on your local network (2 ms away)" when the bonus decided it. A neighbour
  on a peer coordinator gets the bonus too, so a desktop that accepts redirects (`route_elsewhere`)
  is sent to the coordinator where its neighbour is: that is the coordinator choice for a desktop.
  The portal's coordinator choice (#346) serves browser and hosted calls, which come from no
  machine on any LAN, so it has no proximity input and is unchanged.
- **Named-model network calls**: a LAN neighbour that holds the model and has a free slot is
  preferred for `BEST_FIT_PREFER_MS` (never the requester's own machines on a billed call). Billed
  normally across accounts.
- **"My machines" calls**: a measured LAN neighbour among your own machines first, else the #342
  same-public-address rule. Free as before.
- **World view**: for a signed agent caller (the desktop app) every machine its agent measured on
  the LAN carries `near: { rttMs }`: your machines by name, other people's masked like any other
  machine (`mac-•••3f2a`). The portal never gets `near`.

### Privacy

- No private IP goes to a coordinator for discovery, and none appears in any API. (#342's
  `lanAddresses` of your own machines still go to your coordinator and back to your own desktop
  only; `AGENT_LAN_HINTS=off` stops that.)
- Other accounts stay masked: `near` adds a round trip to the masked entry, nothing else.
- The LAN id and key rotate every 15 minutes, so a LAN observer cannot follow one machine for
  longer from its announcements alone (it could still correlate by MAC address, which it sees
  anyway).
- Coordinators hold LAN ids, keys and reports in memory only (not persisted), forgotten after 5
  minutes without a heartbeat.

## Direct transfer (Part 2, opt-in per machine, off by default)

`AGENT_LAN_DIRECT=on` (the desktop's "Accept work directly from machines on my network"; needs
discovery). Both the requester's machine and the host must have it on, and the coordinator must
allow tickets (`LAN_DIRECT_TICKETS`, default on). Code: `src/swarm/lan-direct.ts`,
`src/swarm/lan-direct-requester.ts`, the host side in `src/swarm/worker-runner.ts`.

1. **Submit.** The desktop's IDE provider asks for direct transfer in `/forward/inference/submit`.
   The local agent replaces the ask with a fresh X25519 public key for this call (keeping the
   private half for 60 s), or drops it when direct is off here or no neighbour advertises it.
2. **Ticket.** If the coordinator places the call on a host that is the requester's LAN neighbour,
   is registered with it, has direct on, has an envelope key (#328) and is not barred (below), it
   answers with a ticket: `{ tid, taskId, subtaskId, hostLanId, hostAgentId, requesterAgentId,
   requesterPub, hostPub, model, maxTokens, temperature, timeoutMs, inputSha256, exp, nonce, mac }`.
   `mac` is HMAC-SHA256 under a key derived (HKDF) from the host's registered LAN key; `exp` is 15 s;
   `hostPub` is the host's envelope key; `inputSha256` digests the call as queued. The call is kept
   for the host for 2.5 s.
3. **Connect.** The requester's agent finds the host's address and port in its own mDNS table (they
   never came from the coordinator), connects, and sends `{ t: "hello", ticket }`. The host checks
   shape, MAC, that the ticket names it and one of its current LAN ids, expiry, and that the ticket
   id was never used (single use). Anything else closes the connection at once with no reply.
4. **Encryption.** Both sides derive two AES-256-GCM keys from X25519(requester key, host envelope
   key) with HKDF (salt = ticket id). Every later frame is encrypted with a direction-and-counter
   nonce and the ticket id as AAD, so frames cannot be reordered, replayed or moved to another
   session. The coordinator does not have these keys.
5. **Run.** The requester sends the messages and tools; the host refuses them unless their digest is
   the ticket's. The host starts at once and, in parallel, claims the call with a signed `/pull`
   (`lanSubtaskId`: that call only; every claim rule applies). Nothing is sent to the requester until
   the claim holds; if it fails, the host aborts and says so, and the requester reads through the
   coordinator.
6. **Settlement (unchanged).** The host streams the reply to the coordinator as well (as every call
   does), and reports its signed result and work receipt, with token counts bounded by what the
   coordinator holds. Billing, verification sampling, degenerate-reply checks and receipts are the
   coordinator path's own; a direct call is billed exactly like the same call through the
   coordinator (tested). Direct transfer is a latency path, not a privacy path: the coordinator still
   sees the request and the reply, as today.
7. **Receipt.** The requester sends `/inference/lan-receipt` (signed by its agent, the one the
   ticket names) with the SHA-256 and size of what it received. The coordinator compares it with
   the reply it holds. A mismatch is a security event (`lan_direct_reply_mismatch`); three in a day
   stop tickets for that host. Settlement follows the coordinator's copy either way.
8. **Fallback.** No ack within 500 ms (host gone, port closed, firewall, wrong network): the
   requester reads the same call through the coordinator from the start, transparently. A stream that
   breaks halfway continues from the coordinator's copy past the characters already shown. The call
   is never submitted twice.

Limits on the listener: an ephemeral port on all interfaces, announced only over mDNS; private and
link-local sources only; 8 connections at once, 2 per source, 30 hellos per source per minute; a
2 s deadline for the hello; frames at most 16 KiB before the hello and 4 MiB after; one call per
connection and no other endpoint.

## What an attacker on the LAN can and cannot do

Someone on your Wi-Fi (or a malicious device there) **can**:

- See that EdgeCoder machines are present, their current LAN ids (rotating every 15 minutes) and
  ports, and measure their round trips with the echo (rate limited).
- Send forged mDNS records. They can make your agent list a fake neighbour and ping it; a report of
  it carries no valid proof, so the coordinator ignores it. They cannot claim another agent's id
  (the coordinator resolves ids by key, and an agent ignores records with its own id).
- Replay a neighbour's fresh proof to their own coordinator in real time, to look "near" a machine
  they can hear. This only affects their own routing preference and world view; it gives no access.
- Connect to the direct port. Without a valid ticket for that host the connection is closed at once.
- Observe direct traffic: it is encrypted; they see sizes and timing.
- Drop or delay packets: the call falls back to the coordinator path.

They **cannot**:

- Learn anyone's agent id, account, host name or models from the announcements.
- Get a private address into a coordinator or any API, or read another account's addresses.
- Use a ticket meant for someone else: tickets are MACed with the host's LAN key, name the host's
  agent and LAN id, expire in 15 s and are single use; a captured ticket is useless without the
  requester's X25519 private key (the session keys come from it).
- Run work on a host without paying, or be paid without working: the call is submitted, claimed,
  settled and verified by the coordinator exactly as before.
- Make a host run a different request than the one the coordinator queued (digest check), or make
  the requester accept a reply the host did not send (AEAD).
- Inflate a bill: token counts are bounded by the coordinator's own copy of the request and reply.

A malicious **host** could send the requester a different reply directly than the one it reports.
The requester's receipt detects it; the host is logged and loses tickets after three. A malicious
**requester** cannot lower what it pays by lying in its receipt: the bill follows the coordinator's
copy.

## Permissions (macOS)

macOS 15+ asks once before an app reaches devices on the local network ("“EdgeCoder” would like
to find and connect to devices on your local network"). The agent and the IDE provider are child
processes the app spawns directly (`std::process::Command`, not launchd), so macOS attributes them
to the app as their responsible process and the one prompt covers them. `Info.plist` carries
`NSLocalNetworkUsageDescription` (the text in that prompt) and `NSBonjourServices`
(`_edgecoder._tcp`). If the user declines, discovery, the echo, direct transfer and the #342 pings
fail quietly: everything takes the coordinator path and the Network page shows estimates. The
choice can be changed in System Settings > Privacy & Security > Local Network. Turning discovery
off in Settings > General stops announcing and listening (no prompt then).

Linux agents need nothing: UDP 5353 is shared (SO_REUSEADDR) with avahi if it runs; a host
firewall that drops multicast or the ephemeral ports just turns the feature off for that machine.

## Your own machines (#342)

The agent reports its RFC 1918 addresses with prefix in its signed `/register` (`lanAddresses`,
`AGENT_LAN_HINTS`, at most four). `GET /network/world` adds `lan: { samePublicNetwork, addresses }`
to an agent only when it is the caller's own and the caller is a signed agent (the desktop app).
The desktop's IDE provider pings (ICMP, the OS `ping`, no shell) own machines that share its public
network and one of its subnets, and merges that with `near`, keeping the better measurement; the
addresses never reach the page. The same-public-network check stops a false "same network" in a
café whose `192.168.1.x` matches home.

## Limits

- IPv4 only (mDNS over 224.0.0.251); one interface (the default route's) joins the group.
- Networks that block multicast (some guest Wi-Fi, client isolation) show no neighbours.
- A round trip above 50 ms is not counted as the same network (VPNs, bridged sites).
- Direct transfer needs host and requester on the same coordinator (the claim happens there);
  otherwise the call takes the coordinator path.

## Data handled

In coordinator memory only: LAN ids and keys (5 minutes), neighbour reports (ids, proofs, round
trips), issued tickets (30 minutes), receipt results and mismatch counts (a day). Nothing is
persisted. Private addresses of your own machines (#342) as before.
