# Agent UI Redesign — Chat-First IDE

**Date:** 2026-02-24
**Status:** Approved

## Summary

Redesign the EdgeCoder desktop app from a node-operator dashboard into a chat-first IDE, styled after Claude Desktop. Two top-level tabs — **Chat** and **EdgeCoder** — replace the current 7-item sidebar. All existing dashboard/monitoring views move into a **Settings overlay** accessed via a bottom-left user avatar. Authentication and Bitcoin wallet management are integrated into the UI.

## Architecture

### App Shell

```
┌──────────────────────────────────────────────────────┐
│  ← Title Bar (draggable, Tauri) →                    │
│  [+]          [ Chat | EdgeCoder ]          [···]    │
├──────────────────────────────────────────────────────┤
│                                                      │
│              Active View Content                     │
│              (Chat or Monaco Editor)                 │
│                                                      │
├──────────────────────────────────────────────────────┤
│ [avatar]                [ Message input... ]    [↑]  │
└──────────────────────────────────────────────────────┘
```

- **Header**: `[+]` new chat button (left), pill-style tab switcher (center), `[···]` overflow menu (right). Acts as Tauri drag region.
- **Content area**: Fills remaining space. Switches between Chat and EdgeCoder views.
- **Bottom bar**: User avatar (left, opens Settings), input textarea (center, auto-grows), send button (right). Visible on both tabs.

### Color Palette (Dark Mode v1)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-base` | `#1a1a1a` | App background |
| `--bg-surface` | `#252525` | Cards, panels |
| `--bg-elevated` | `#2f2f2f` | Modals, overlays |
| `--border` | `rgba(255,255,255,0.08)` | Subtle borders |
| `--border-strong` | `rgba(255,255,255,0.15)` | Emphasized borders |
| `--accent` | `#3b82f6` | EdgeCoder blue |
| `--accent-hover` | `#2563eb` | Accent hover state |
| `--text-primary` | `#e8e6e3` | Primary text |
| `--text-secondary` | `#9a9892` | Secondary text |
| `--text-muted` | `#6b6960` | Muted/placeholder text |
| `--green` | `#4ade80` | Success/online |
| `--red` | `#f87171` | Error/offline |
| `--yellow` | `#fbbf24` | Warning/degraded |

### Typography

- Font stack: `system-ui, -apple-system, sans-serif` (v1; consider Anthropic Sans or custom font later)
- Body text: 14px / 1.5 line-height
- Input text: 16px
- Headings: 16px semi-bold (section), 14px medium (sub-section)

## Chat Tab

### Layout

- Centered conversation column, max-width 768px
- Vertically scrollable message thread
- New conversation shows centered prompt: "What would you like to build?" with quick-action chips

### Messages

- **User messages**: Right-aligned, subtle blue-tinted background (`#1e3a5f`), rounded corners
- **Agent messages**: Left-aligned, no background, full markdown rendering (code blocks, lists, bold, links, tables)
- **Streaming**: Tokens stream via NDJSON from the local agent. Typing cursor animation while streaming.
- **Network delegation**: Inline status indicators when agent delegates to the global network (e.g., "Running on 3 peers..." with spinner)

### API Integration

- Messages sent to the local EdgeCoder agent inference endpoint
- The agent transparently delegates to the global BitTorrent-style swarm network as needed
- Conversation history persisted client-side (IndexedDB for v1)

## EdgeCoder Tab (IDE)

### Layout

```
┌────────────┬─────────────────────────────────────────┐
│ File       │  tab1.py  ×  │  tab2.js  ×  │          │
│ Explorer   ├─────────────────────────────────────────┤
│            │                                         │
│ tree view  │         Monaco Editor                   │
│            │                                         │
├────────────┴─────────────────────────────────────────┤
│ [avatar]            [ Ask agent... ]            [↑]  │
└──────────────────────────────────────────────────────┘
```

- **Left panel**: Resizable, collapsible file explorer tree
- **Main area**: Monaco Editor with file tabs, syntax highlighting, multi-cursor, minimap
- **Bottom input bar**: Same input bar as Chat — prompts the agent to modify code in the editor
- **File system**: Virtual file system for v1 (files from task context). Future: mount local directories via Tauri FS API.
- **Cross-tab link**: "Open in Editor" action on code blocks in Chat jumps to EdgeCoder tab with file loaded

### Monaco Configuration

- Dark theme matching app palette
- Language support: Python, JavaScript, TypeScript, Rust, Go, and others
- Read-only mode available for agent-generated code review

## Settings Overlay

Triggered by clicking the user avatar (bottom-left). Slides up as a full-screen overlay with a left sidebar for sub-sections.

### Sub-sections

| Section | Source | Content |
|---------|--------|---------|
| Account | New | Profile, email, linked SSO providers, sign out |
| Dashboard | Dashboard.svelte | System metrics, node status, throughput chart |
| Mesh | MeshTopology.svelte | Peer topology, reputation scores |
| Models | ModelManager.svelte | Model pull, swap, delete with progress |
| Tasks | TaskQueue.svelte | Task queue monitoring and submission |
| Wallet | Credits.svelte (expanded) | Bitcoin balance, Lightning send/receive, earn/spend history |
| Logs | LogViewer.svelte | Real-time activity log with filtering |
| Preferences | Settings.svelte | Mesh config, CPU policy, BLE toggle |

## Authentication

### Login Screen

Shown when no authenticated session exists. Gates the entire app.

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│               [EdgeCoder Logo]                       │
│                                                      │
│          ┌──────────────────────────┐                │
│          │  Email                   │                │
│          ├──────────────────────────┤                │
│          │  Password                │                │
│          ├──────────────────────────┤                │
│          │      [Sign In]           │                │
│          ├──────────────────────────┤                │
│          │  ── or continue with ──  │                │
│          │  [Microsoft 365]  [SSO]  │                │
│          └──────────────────────────┘                │
│          Don't have an account? Sign up              │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Email/password auth (same flow as Portal)
- SSO: Microsoft 365 OAuth, expandable to Google, GitHub
- JWT stored in Tauri's secure credential store (not localStorage)
- Session refresh handled transparently

## Bitcoin Wallet

Full wallet management within the Settings > Wallet section:

- **Balance**: BTC balance with USD conversion
- **Lightning**: Send/receive via Lightning Network for micro-payments
- **Earn history**: Credits earned from contributing compute to the network
- **Spend history**: Credits spent on using network resources
- **Key management**: Import/export keys, backup seed phrase

## Component Inventory

### New Components

| Component | Purpose |
|-----------|---------|
| `AppShell.svelte` | Root layout with header, content area, bottom bar |
| `TabSwitcher.svelte` | Pill-style Chat/EdgeCoder toggle |
| `ChatView.svelte` | Conversation thread with message rendering |
| `ChatMessage.svelte` | Individual message bubble (user or agent) |
| `ChatInput.svelte` | Auto-growing textarea with send button |
| `EditorView.svelte` | Monaco Editor wrapper with file tabs |
| `FileExplorer.svelte` | Tree view for virtual file system |
| `SettingsOverlay.svelte` | Full-screen settings with sidebar navigation |
| `LoginScreen.svelte` | Authentication form with SSO buttons |
| `MarkdownRenderer.svelte` | Markdown-to-HTML for agent messages |
| `StreamingIndicator.svelte` | Typing/streaming animation |
| `NetworkStatus.svelte` | Inline indicator for swarm delegation |

### Reused Components

- `StatCard.svelte` — used within Settings > Dashboard
- `StatusDot.svelte` — used in connection status indicators
- `ErrorBanner.svelte` — used across all views
- `Skeleton.svelte` — loading states
- `EmptyState.svelte` — empty conversation state

### Removed from Top-Level

- `ConnectionBar.svelte` — replaced by compact status in header or Settings > Dashboard
- Sidebar navigation in `App.svelte` — replaced by tab switcher + Settings overlay

## State Management

- **Auth state**: Svelte store wrapping Tauri secure credential store
- **Chat state**: Conversation history in IndexedDB, active conversation in Svelte store
- **Editor state**: Open files and active tab in Svelte store
- **Settings state**: Existing localStorage persistence (unchanged)
- **Tab state**: Active tab (Chat/EdgeCoder) in Svelte store

## Tech Dependencies (New)

- `monaco-editor` — Code editor engine
- `marked` or `markdown-it` — Markdown parsing for chat messages
- `highlight.js` or built-in Monaco tokenizer — Syntax highlighting in chat code blocks
- `idb` (or raw IndexedDB) — Conversation persistence

## Migration Strategy

1. Replace `App.svelte` with new `AppShell` layout
2. Move existing pages into Settings overlay sub-sections (minimal code changes)
3. Build Chat tab from scratch
4. Build EdgeCoder tab with Monaco integration
5. Add login screen and auth flow
6. Expand Credits into full Wallet section
7. Update Tauri config (window title, security policies for OAuth)
