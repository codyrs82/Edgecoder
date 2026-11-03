# EdgeCoder roadmap

What is shipped, what is next, and the design direction behind the larger items. Dates are when an
item was added or finished.

## Shipped (2026-11-02)

- **Compute you can buy and point tools at.**
  - cSats are priced per second by compute class (cpu, apple, gpu, gpu.dc).
  - Network models are streamed to your own tools.
  - Connections give each tool its own local port, key and budget, fixed to one place to run: this
    computer, your machines, any network machine (with a class and price ceiling), or a reserved
    machine.
  - The endpoints speak both OpenAI and Anthropic APIs. Claude Code runs end to end with tool calls,
    verified through a reserved network machine.
  - A hosted `/v1` endpoint with API keys covers Cursor and computers without the app.
- **Reserved capacity.** Hold one machine of a class for a set time, paid up front. Unused time is
  refunded, and the owner is paid for the time held, minus the network fee.
- **Claude/Cursor-style app shell and web portal.**
  - A profile menu at the bottom left.
  - A compute picker in the chat box.
  - Cursor-style settings with search.
  - Pages: Plan & usage, Compute, Connect your tools.
  - Editable display name.
- **Local compute set up by the app.** Ollama and the Colima sandbox are downloaded (pinned and
  checksummed), started and kept running, with no terminal step.

## Next

1. **Usage tracking page** (desktop and web, like Cursor's Plan & Usage).
   - Spend over time (day, week, month), split by model, compute class, connection or tool, and
     machine.
   - A per-request log: time, model, where it ran, seconds, cSats, and tokens when known.
   - Budget alerts, and CSV export.
   - Needs a usage ledger written at settlement: today the credit ledger records the reason and task
     only, not the model, class or connection.
2. **BLE mesh, fully tested.**
   - Two machines discover each other over Bluetooth with no network.
   - A task runs over BLE and is paid when back online.
   - Covered by an automated two-process test where the hardware allows, plus a scripted test on
     two Macs.
3. **Release and verify live:** deploy the seeds and portal, then on the user's two Macs check
   reservations, connections and the hosted endpoint.
4. Carried over:
   - model fallback;
   - LSP in the editor;
   - remote branch agents;
   - GPU box install (8x RTX 6000 Ada);
   - Dependabot alerts;
   - CRS-NODE-001 cleanup;
   - wipe the regtest balances before mainnet.

## Direction

### Credits are a unit of measure; value moves in bitcoin

cSats measure work: 1 cSat is 1 sat of compute. They should never change hands as a currency.
Every payment and every exchange of value settles in bitcoin, over Lightning.

- **Today (custodial):**
  - A purchase is a Lightning payment to the coordinator, which credits a balance.
  - Agents accrue earnings in the ledger and withdraw them over Lightning.
  - Value sits with the coordinator in between.
- **Target:**
  - **Pay per job or lease, in sats, at the time of use.**
    - A reservation is a Lightning hold invoice: settled for the time used, the rest cancelled
      rather than refunded as credit.
    - Per-second jobs are paid in short batches (keysend, or BOLT12 offers) from the requester's
      wallet. A prepaid balance becomes an optional convenience, not the model.
  - **Providers are paid in sats on a short settlement window**, to their own Lightning address or
    node. There are no cSat balances to move between accounts.
  - **The network fee is taken in sats** at settlement.
  - **cSats remain only in the display and the accounting.** Every row reconciles to a sat amount
    and a payment hash.
- Ecash (Cashu or Fedimint) is an option for small, frequent, private payments. It is still
  bitcoin-backed, but it trusts a mint, so it would be opt-in.

### AI agents as first-class users (MCP)

**Status:** key-based signup, `/v1/account` (balance, usage, Lightning top-up, reservations) and the
MCP server (`packages/mcp-server`) are built (docs/mcp.md). L402 and Nostr Wallet Connect are
designed there but not built.

Agents should be able to sign up, pay with their own bitcoin, and use compute without a person or
the desktop app.

- **An EdgeCoder MCP server** with these tools: `list_models`, `quote`, `reserve`, `run` (chat or
  inference), `usage`, `top_up`.
- **Identity is a key, not an email:** a Nostr key or a Lightning node key. Nothing else is needed
  to start.
- **Payment from the agent's own wallet:**
  - L402 (HTTP 402 plus a Lightning invoice per request or per block of time), or
  - Nostr Wallet Connect for budgeted spending.
- **Agents reach compute through the coordinators' hosted endpoints,** not `localhost`. People using
  the app keep the local ports. Both meet on the same network, so the network serves a mix of
  people, people's own agents, and independent agents.

### Persistent bots for jobs (Phase 2)

Named, long-lived bots that own a job, like the bots list in the Claude app: "Harry the Engineer", a
billing bot, a security reviewer.

- **What a bot keeps:** its own instructions, memory, tools and project or repo, with a history of
  its work.
- **How it starts work:**
  - on a schedule;
  - on an event (a PR, a failed CI run, an email or webhook, a file change);
  - or when you message it.
- **Where it lives:** in the app's sidebar, with its latest status. You create one from the
  header's **+ → New bot**, which is there today, disabled, and marked Phase 2.
- **Runs on Auto compute.** Each step goes to the cheapest place that fits it: small local models
  for quick steps, your own machines next, network GPUs for heavy steps. The decision is the same
  one Auto uses today (`src/inference-api/auto-route.ts`). It is made fresh for every request from
  a cached view of what's available, so it adds no noticeable time.
- **Spending limits:**
  - a cSat budget per bot, and per day;
  - an approval step for anything that changes things outside its project;
  - every action is recorded on the usage page.
- **The same bots can be reached through MCP and the hosted endpoint,** so agents and people work
  with them in the same way.

### Cloud sessions on your own Fly.io or Azure account (Phase 3)

Choose a cloud session instead of a local one, and EdgeCoder provisions it on your own cloud
account.

- **Setup:**
  - Connect Fly.io or Azure (token or OAuth) and pick the hardware (CPU, GPU type) and region.
  - EdgeCoder creates the machine from its agent image and sets up the OS, Ollama, models, sandbox
    and limits for your needs.
- **Use:** the machine joins as one of your machines, so your own use is free on the network; you
  pay your cloud provider directly. You can choose to sell its idle time on the market.
- **Lifecycle:** it stops when idle and starts again when you pick it in the chat box. Settings are
  kept, and nothing runs without your say-so.

### Global coordinator entry points

Question: should `coordinator.edgecoder.io` (or `mesh.edgecoder.io`) be load balancers that send
users to verified coordinators run by others around the world, chosen by latency?

**Decided (2026-11-02):** one URL for the whole platform. Agents, the apps, tools, MCP and the hosted
API all use `coordinator.edgecoder.io` and never need to know which coordinator answered.

Behind that name, requests are routed by latency and health across a pool that includes community
coordinators. The routing is by steering, not by proxying.

- **Use geo or latency DNS plus a signed registry.**
  - `coordinator.edgecoder.io` resolves to the nearest healthy coordinator from a registry that
    EdgeCoder signs (the discovery feed already exists).
  - Clients verify each coordinator's identity key against that registry, as the desktop app
    already pins keys.
  - A proxying load balancer that terminates TLS would sit in the middle of every request,
    centralize the network, and see traffic meant for community operators.
- **Admission for community coordinators:** they need a verified operator, a stake or bond in
  sats, uptime and correctness history (the reliability score), and a published key. They are
  dropped automatically on failed health checks or bad receipts.
- **EdgeCoder's own seeds stay in the pool as the fallback,** so the network still works if the
  community pool is empty.
- **Routing cost:** latency first, then the coordinator's load and the market's depth for the
  class you asked for.
