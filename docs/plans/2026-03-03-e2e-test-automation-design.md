# E2E Test Automation Design

## Goal

Automate end-to-end testing of the full EdgeCoder stack — portal web UI, desktop Tauri app, coordinator, agent, and Ollama inference — running locally via Docker Compose with a single command.

## Architecture

Playwright drives all testing: portal web UI in Chromium, desktop app via Tauri WebDriver, and API assertions via HTTP. Docker Compose orchestrates the full service stack (Postgres, portal, coordinator, Ollama with tinyllama, agent). Tests run sequentially through real user journeys, seeded with test data via portal API.

## Key Decisions

- **Scope:** Everything — backend flows, desktop app UI, portal web UI, agent lifecycle, model inference
- **Environment:** Local via Docker Compose, fresh state per run
- **Desktop testing:** Playwright with Tauri WebDriver
- **Inference:** Real Ollama with tinyllama model (CPU, ~637MB, cached in Docker volume)
- **Approach:** Single monolithic Playwright suite, one command

---

## 1. Docker Compose Stack

New `docker-compose.e2e.yml` extending the existing compose setup:

| Service | Image/Build | Port | Purpose |
|---------|-------------|------|---------|
| postgres | postgres:16 | 5432 | Fresh database per run |
| portal | Build from Dockerfile | 4310 | User auth, node enrollment, discovery |
| coordinator | Build from Dockerfile | 4301 | All-in-one: coordinator + inference + control-plane |
| ollama | ollama/ollama | 11434 | Real model inference with tinyllama |
| agent | Build from Dockerfile | — | Worker process registering with coordinator |

Portal seeded with test user (`test@edgecoder.io`). Coordinator connects to portal for node validation. Agent uses pre-enrolled registration token.

Health checks ensure all services ready before tests begin.

Start: `docker compose -f docker-compose.e2e.yml up -d --wait`

---

## 2. Test Framework & Structure

```
tests/e2e/
  playwright.config.ts          — Config with portal-web + desktop-app projects
  setup/
    global-setup.ts             — Start Docker Compose, wait for health, seed data
    global-teardown.ts          — Collect logs, tear down stack
    seed-data.ts                — Create user, verify email, enroll nodes
  flows/
    01-portal-auth.spec.ts              — Sign up, login, email verify
    02-node-enrollment.spec.ts          — Enroll coordinator + agent nodes
    03-desktop-launch.spec.ts           — Tauri app launches, authenticates
    04-agent-registration.spec.ts       — Agent registers with coordinator
    05-dns-auto-registration.spec.ts    — Coordinator gets DNS hostname
    06-model-inference.spec.ts          — Chat sends prompt, Ollama responds
    07-model-manager.spec.ts            — Model list loads, shows models
  helpers/
    api-client.ts               — HTTP helpers for portal/coordinator
    wait-for.ts                 — Polling utilities for health/state
```

Two Playwright projects:
1. `portal-web` — Chromium against localhost:4310
2. `desktop-app` — Tauri WebDriver against built desktop app

Sequential execution (numbered prefixes) — each flow builds on the previous.

Run: `npm run test:e2e`

---

## 3. Desktop App Testing

Tauri 2.0 WebDriver support via `tauri-driver`:

1. Global setup builds desktop app in test mode with env vars pointing at local stack
2. `desktop-app` Playwright project launches `tauri-driver` subprocess
3. Playwright connects via WebDriver protocol to Tauri WebView
4. Tests interact with Svelte UI: click, fill, assert

Build-time config:
- `VITE_PORTAL_URL=http://localhost:4310`
- `VITE_API_BASE=http://localhost:4301`

Desktop flows tested:
- App launch, loading screen, auth
- Account page displays user info
- Model Manager shows models from Ollama
- Chat sends message, receives streamed response
- Settings overlay, logout

Prerequisite: Tauri CLI + Rust toolchain. macOS runners for CI desktop tests.

---

## 4. Test Data Seeding & Cleanup

**Before tests (global-setup.ts):**
1. Create test user via `POST /auth/register`
2. Force-verify email via direct SQL on postgres container
3. Create session via `POST /auth/login`, save token
4. Enroll coordinator node via `POST /nodes/enroll`
5. Enroll agent node via `POST /nodes/enroll`
6. Write tokens/context to `test-context.json` for test specs

**After tests (global-teardown.ts):**
1. Collect container logs to `tests/e2e/logs/`
2. `docker compose -f docker-compose.e2e.yml down -v` (destroy containers + volumes)
3. Clean up `test-context.json`

Fresh database every run. No test pollution.

---

## 5. Ollama Integration

- Official `ollama/ollama` Docker image
- Model: `tinyllama` (~637MB, smallest functional model)
- Named volume `e2e-ollama-data` caches model between runs
- Setup script: `docker exec e2e-ollama ollama pull tinyllama`
- CPU-only, no GPU required (~10-30s per response)
- 60s timeouts on inference calls

Tests prove the pipeline works: coordinator detects Ollama, model list returns tinyllama, chat produces a response. Quality doesn't matter — plumbing does.

---

## 6. What This Catches

| Gap in current tests | Covered by E2E |
|---------------------|----------------|
| Real HTTP between services | Portal ↔ coordinator ↔ agent over TCP |
| Registration chain | Portal enroll → coordinator validate → agent accept |
| Desktop app rendering | Playwright asserts actual UI state from live data |
| Inference pipeline | Chat → inference service → Ollama → streamed response |
| Auth persistence | Session cached, app auto-authenticates on restart |
| DNS auto-registration | Coordinator heartbeat triggers DNS hostname |
| Model Manager loading | Real model list from real Ollama |

---

## Dependencies

- `@playwright/test` (dev dependency)
- `docker-compose.e2e.yml` (new file)
- `tauri-driver` (comes with `@tauri-apps/cli`, already installed in desktop/)
- Docker + Docker Compose on test machine
- Rust toolchain for desktop app build (desktop tests only)
