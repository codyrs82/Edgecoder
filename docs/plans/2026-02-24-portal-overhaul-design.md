# Portal Overhaul Design

## Goal

Overhaul the EdgeCoder portal to: (1) remove local-only features, (2) consolidate pages into a simpler nav, (3) add a chat interface that routes through the swarm, and (4) retheme everything to match the desktop app's warm dark aesthetic.

## Navigation

**Before:** Dashboard | Nodes | Get EdgeCoder | Wallet | Coordinator Ops | Settings

**After:** Chat | Dashboard | Wallet | Get EdgeCoder | Settings

- **Chat** (NEW) — AI chat page, first in nav. SSE streaming via swarm. Deducts credits.
- **Dashboard** — Absorbs Nodes (enrollment + status) and portal-relevant Coordinator-Ops features (pending approvals, approved nodes table). Shows account overview, credit balance, node management, and task approval queue.
- **Wallet** — Unchanged.
- **Get EdgeCoder** — Unchanged (redesigned in prior work).
- **Settings** — Theme picker updated to three dark variants + passkey management.

**Removed:** Nodes page (merged into Dashboard), Coordinator-Ops page (portal features merged into Dashboard; local-only features removed entirely: device diagnostics, model orchestration, Ollama election).

## Theme — Three Dark Warm Variants

Replace all three current light themes with dark warm variants matching the desktop app (`desktop/src/App.svelte`).

### Warm (default)
- `--bg`: `#2f2f2d`
- `--bg-soft`: `#353533`
- `--card`: `rgba(58, 58, 55, 0.96)` (#3a3a37)
- `--card-border`: `rgba(214, 204, 194, 0.12)`
- `--text`: `#f7f5f0`
- `--muted`: `#8a8478`
- `--brand`: `#c17850`
- `--brand-2`: `#d4895f`
- `--ok`: `#4ade80`
- `--danger`: `#f87171`

### Midnight
- `--bg`: `#1a1a2e`
- `--bg-soft`: `#202038`
- `--card`: `rgba(37, 37, 64, 0.96)` (#252540)
- `--card-border`: `rgba(99, 102, 241, 0.18)`
- `--text`: `#e8e8f0`
- `--muted`: `#8888a0`
- `--brand`: `#6366f1`
- `--brand-2`: `#818cf8`
- `--ok`: `#4ade80`
- `--danger`: `#f87171`

### Emerald
- `--bg`: `#1a2e1a`
- `--bg-soft`: `#203520`
- `--card`: `rgba(37, 48, 37, 0.96)` (#253025)
- `--card-border`: `rgba(34, 197, 94, 0.18)`
- `--text`: `#e8f0e8`
- `--muted`: `#88a088`
- `--brand`: `#22c55e`
- `--brand-2`: `#4ade80`
- `--ok`: `#4ade80`
- `--danger`: `#f87171`

### Shared Design Tokens
- Border width: `0.5px`
- Border radius: `6-10px`
- Box shadows: minimal (`0 1px 3px rgba(0,0,0,0.3)`)
- Flat design, no gradients
- Sidebar, topbar, ticker row all use `--bg-soft` or `--card`

## Chat Page

### UI
- Server-rendered HTML + vanilla JavaScript (same pattern as rest of portal)
- Left: conversation sidebar (list, search, rename, delete)
- Right: message thread + input bar
- User messages right-aligned with subtle background
- Assistant messages left-aligned with Markdown rendering (code blocks with syntax highlight via `<pre><code>`)
- Streaming indicator: elapsed time, token count, "Swarm" route label
- Input: textarea, Enter to send, Shift+Enter for newline, disabled during streaming

### Backend
- New route: `POST /portal/api/chat` — authenticated, checks credit balance, submits to coordinator, streams SSE response
- New route: `GET /portal/chat` — renders chat page
- Conversations stored in portal PostgreSQL: `portal_conversations` table (id, account_id, title, created_at, updated_at) and `portal_messages` table (id, conversation_id, role, content, tokens_used, credits_spent, created_at)
- Credit deduction: uses existing economy pricing, deducted on completion

### Flow
```
Browser SSE → POST /portal/api/chat (auth + credit check)
  → Coordinator POST /tasks (submitterAccountId, priority)
  → Poll subtask result / stream back
  → SSE chunks to browser
  → On completion: record tokens, deduct credits, save message
```

## Dashboard Consolidation

### Current sections (kept)
- Account overview (credits, sats, enrolled nodes, email status)
- Email verification card (conditional)
- Live issuance (rolling 24h)
- Decentralized local model mesh

### Absorbed from Nodes page
- Enroll Node card (generate token)
- Node activation states table (filter, sort, delete)

### Absorbed from Coordinator-Ops (portal-only)
- Pending enrollment requests table (approve/reject)
- Approved nodes table (without model action buttons — those are local-only)
- Coordinator stats (connected agents, queue depth, results count)

### Removed (local-only features)
- Device diagnostics
- Agent model orchestration (switch ollama/edgecoder)
- Coordinator local model election (pull models)

### Quick actions updated
Remove "Coordinator operations" and "Manage nodes" links (those pages no longer exist). Replace with "Open Chat" link.
