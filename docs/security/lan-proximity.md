# LAN proximity between your own machines

The desktop Network page used to estimate every machine's distance as *your round trip to its
coordinator + the coordinator's round trip to the machine*. Two Macs on the same home network
therefore looked ~70 ms apart (two trips to a Fly region and back), and "Nearest to you" listed
other people's cloud machines. LAN proximity measures your own machines on your own network
directly.

## How it works

1. **The agent reports its private addresses.** In its signed `/register`, an agent sends
   `lanAddresses`: its RFC 1918 IPv4 addresses with the subnet prefix (`192.168.1.23/24`, at most
   four, physical interfaces first). `AGENT_LAN_HINTS=off` stops this. The coordinator keeps only
   entries that parse as private CIDRs (`src/swarm/lan-proximity.ts sanitizeLanAddresses`).
2. **The coordinator compares public networks.** It already records the public address each agent
   registered from (`sourceIp`). For the world view it keeps an unexported tag of it (`netTag`:
   SHA-256 of the IPv4 address, or of the IPv6 /64). Machines behind one router share the tag.
3. **Only the owner's desktop gets them.** `GET /network/world` adds `lan: { samePublicNetwork,
   addresses }` to an agent only when (a) the agent is the caller's own (`mine`) and (b) the caller
   is a signed agent, i.e. the desktop app through its local forwarder. The portal (service token),
   other accounts and peer coordinators' public answers never get it. `netTag` and `lan` are
   internal fields of the coordinator-to-coordinator `LocalWorld` (mesh token) and are stripped in
   `toPublicWorld`, like `ownerTag`.
4. **The desktop measures.** The IDE provider (`src/apps/ide/network-world.ts`, on the user's
   computer, spawned by the app) probes an own machine only if it is not stale, is not this
   computer, `samePublicNetwork` is true, and one of its addresses lies inside one of this
   computer's own subnets. The probe is three ICMP echoes with the OS `ping` (`execFile`, no shell,
   address re-validated as private IPv4), at most 8 machines, cached 30 s. A machine that answers is
   `lan: { sameNetwork: true, rttMs }`; the addresses are removed before the answer reaches the page.
   A hosted (transport) provider never probes and drops `lan`.

The same-public-network check is what stops a false "same network": `192.168.1.x` is on half the
world's routers, so a laptop in a café must not ping the café's `192.168.1.40` because the user's
Mac Studio at home has that address.

## What it does not do

- **No new listener, no open port.** Agents still bind their mesh server to loopback
  (`AGENT_MESH_HOST`); ICMP needs nothing listening. Nothing unauthenticated is added on the LAN.
- **No probing of anyone else.** Candidates come only from the caller's own machines, as decided by
  the coordinator's verified agent-to-account mapping; a forged `lan` on someone else's agent is
  ignored by the provider (`mine` is required) and never sent by the coordinator.
- **No discovery broadcast.** No mDNS/Bonjour advertisement, so nothing about the user's machines is
  visible to other devices on the LAN.
- **Mixed IPv4/IPv6.** If one machine reaches the coordinator over IPv6 and the other over IPv4,
  their public networks do not match and they are not probed (shown with the coordinator estimate,
  as before).
- **Firewall stealth mode** (macOS) drops ICMP echo: that machine is not marked "same network".

## Routing

"My machines" calls (`target: "mine"`) from the desktop app now carry a soft preference
(`dispatch.ts preferAgent`, `BEST_FIT_PREFER_MS`) for the requester's own machine that holds the
model, has a free slot and connects from the same public address as the request. Any own machine may
still take the call when the preference lapses. The work itself still travels through the
coordinator: reaching another machine directly over the LAN would need an agent to listen on the
LAN, which this change deliberately does not add.

## Permissions

macOS (15+) asks once before an app reaches devices on the local network. The app's `Info.plist`
carries `NSLocalNetworkUsageDescription`. If the user declines, the probes fail quietly and the page
falls back to the coordinator estimate.

## Data handled

Private LAN addresses of the owner's machines are held in the coordinator's memory (agent
capability map, not persisted) and shown only to that owner's desktop app. The public address was
already recorded; only an unexported hash of it is compared between coordinators.
