# System Overview and Benefits

This page covers what EdgeCoder is, what it ships today, and why it matters.

## What EdgeCoder Is

EdgeCoder is an AI coding network built on local models. Your own machines run models locally. Work you choose to share is queued on a coordinator and runs on agents of approved hosts; coordinators gossip with each other to share tasks. On the public network the coordinators are EdgeCoder's seeds on Fly.io and the portal is EdgeCoder-hosted, so the network today is a set of operated coordinators with a mesh of agents behind them, not a serverless peer-to-peer network. Anyone can also run their own coordinator.

You sign in to the EdgeCoder portal. Running your own work on your own machines is free. Using other people's machines is paid in cSats (1 cSat = 1 sat), and hosting other people's work is by request and earns sats. Frontier models are used only with your own API key ([frontier keys](https://github.com/codyrs82/Edgecoder/blob/main/docs/frontier-keys.md)).

## Shipped Features

### Unified Agent

The `all-in-one` runtime runs coordinator, inference, control plane and an embedded worker in one process; it is what `npm run dev` and the Fly.io seeds run. Installed agents (the desktop app, `edgecoder-install`) run the agent role and connect to a coordinator.

### Chat-First Desktop App

A Tauri-based IDE ships with a Monaco code editor, streaming chat interface, conversation history, model management, and a live mesh visualization panel. This is the primary user surface for interacting with the network.

### Web Chat

Chat in the browser at `/portal/chat` on edgecoder.io, on your own machines or the network, with no install.

### `edgecoder code` Terminal

A coding agent in your terminal that works in a folder or a cloned GitHub repository, with the same tools as the desktop app's Code view ([docs/terminal.md](https://github.com/codyrs82/Edgecoder/blob/main/docs/terminal.md)).

### iOS App

EdgeCoder for iPhone and iPad, on the App Store, with Chat and Code modes; see [How EdgeCoder Works](/guide/how-edgecoder-works#ios-app).

### Code From Your Phone

With **Code from your phone** on in the desktop app, the iOS app drives coding sessions on that computer, relayed through the coordinator; `/remote` in `edgecoder code` continues a terminal session in the desktop app.

### Bits and Cloud Bits

Bits answer messages, run on a schedule and react to GitHub events: desktop bits run on your machine with its folder and tools, cloud bits run on EdgeCoder's servers with no machine needed ([docs/cloud-bots.md](https://github.com/codyrs82/Edgecoder/blob/main/docs/cloud-bots.md)).

### Web Search

Chats and bits can search the web and read pages when the model needs current information, and the answer lists its sources ([docs/web-tool.md](https://github.com/codyrs82/Edgecoder/blob/main/docs/web-tool.md)).

### Reservations

Reserve a network machine for your jobs only for a set time, paid up front in cSats, with unused time refunded on cancel (**Settings → Compute → Reserve a machine**).

### Gossip Mesh

HTTP-based peer discovery and task broadcasting. Nodes announce themselves and relay peer lists to build a full mesh view. Task distribution uses a claim-delay protocol to prevent duplicate execution across nodes.

### Local AI Inference

Agents run model inference locally via Ollama. iOS nodes use llama.cpp for on-device inference. A request you run on your own machine stays there; a request you send to the network runs on the host that claims it, after passing through a coordinator.

### BLE Local Mesh

Bluetooth Low Energy enables offline peer-to-peer task routing between nearby devices. This provides a connectivity layer that works without any network infrastructure -- useful for field deployments, air-gapped environments, and mobile-to-mobile coordination.

### cSat Economy

Compute is priced in cSats (1 cSat = 1 sat). Approved hosts earn sats for the work they run: 95 % of each compute payment goes to the host and 5 % is the network fee. Earned sats are paid out over Lightning; funding with Bitcoin on-chain is behind `ONCHAIN_ENABLED`. Every claim, result and earning is recorded in an append-only hash chain. The canonical model is [economy-math.md](https://github.com/codyrs82/Edgecoder/blob/main/docs/economy-math.md).

### External IDE Support

VS Code, Cursor, and Windsurf connect to any EdgeCoder node through an OpenAI-compatible HTTP endpoint. Developers keep their existing editor workflow and route completions through the local mesh instead of a cloud API.

### Security

Ed25519 request signing authenticates every inter-node message. Nonce-based replay prevention, per-node rate limiting, and a blacklist audit chain provide defense in depth. Envelope encryption (X25519 + AES-256-GCM) is on by default for the coordinator-to-agent hop: the coordinator encrypts each subtask to the agent that runs it and decrypts the result. It is not end to end (the coordinator sees plaintext), and iOS agents do not use it yet.

## Benefits

### Your hardware first

Inference runs on commodity hardware: your own, or an approved host's. EdgeCoder does run hosted services (the portal and the coordinators on Fly.io), and network compute is metered in cSats, but work on your own machines is free and never needs to leave them.

### Open mesh, invited hosts

Any signed-in device can run its owner's work. Hosting other people's work is by request: apply at `/host` on the portal and an admin approves you (`HOST_APPROVAL_REQUIRED`, on by default). The code is source-available, and you can run your own coordinator.

### Cryptographically auditable

Every credit transaction is recorded in an append-only, hash-chained ordering chain that `/ledger/verify` checks. Bitcoin OP_RETURN anchoring of checkpoints is implemented but not enabled yet on EdgeCoder's coordinators, which run on Bitcoin mainnet ([Bitcoin Anchoring](/economy/bitcoin-anchoring)).

### Private by choice

Work you run locally stays on your machine. Work you send to the network passes through a coordinator, which sees it in plaintext and stores the queue in Postgres, and runs on the host that claims it; the coordinator-to-agent hop is envelope-encrypted. Keep private code on your own machines, or use your own coordinator.

## When EdgeCoder Is a Strong Fit

- Teams with private code or compliance constraints that prohibit sending source to cloud APIs
- Organizations that want AI-assisted development without a recurring cloud spend line item
- Operators building internal or hybrid compute networks from existing hardware
- Mobile and field teams that need AI inference without reliable internet connectivity

## Related Pages

- [How EdgeCoder Works](/guide/how-edgecoder-works)
- [Architecture Deep Dive](/guide/architecture-deep-dive)
- [Trust and Security](/security/trust-and-security)
