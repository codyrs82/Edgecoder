# EdgeCoder Desktop

Tauri 2 + Svelte desktop app. See `site-docs/guide/ide-integration.md` for the full feature overview.

## Development

```bash
npm run desktop        # from the repo root
```

### IDE provider server token

The IDE provider server (`:4304`) requires a bearer token (#4). It reads the token from `~/.edgecoder/ide-token` and creates the file on first start, with mode 0600.

- The desktop app reads the same file through the Tauri command `get_ide_token`, and sends it only to the local IDE server, never to the portal.
- Start the IDE provider server once (`npm run dev:ide`) before using the IDE panel.

### Vite dev mode

In `vite dev`, the webview origin is `http://localhost:1420`. Calls to `/chat` are proxied to `:4304` with that `Origin` header, and the IDE server rejects unknown web origins with 403. Allow the dev origin when starting the IDE server:

```bash
IDE_ALLOWED_ORIGINS=http://localhost:1420 npm run dev:ide
```

Packaged builds use the Tauri origins (`tauri://localhost`, `http(s)://tauri.localhost`), which are allowed by default.

## Local auth tokens

On each launch the app generates its inference and admin tokens with the OS CSPRNG (`src-tauri/src/token.rs`, #6). The webview only receives the inference token. Admin routes are intentionally not reachable from the UI.

## Coordinator and portal URLs (#35)

The desktop app resolves its remote hosts in this order:

1. **Settings → Mesh Configuration** (Coordinator URL / Portal URL), stored in `localStorage`. Each field has **Test connection**, and **Reset to defaults** clears both. The old "Seed Node URL" setting is still read as a coordinator override.
2. **Build-time env**: `VITE_COORDINATOR_URL` and `VITE_PORTAL_URL`, for example `VITE_COORDINATOR_URL=https://seed.example npm run tauri build`.
3. **Defaults**: `https://edgecoder-seed-eu.fly.dev` and `https://edgecoder.io`.

URLs must be `https://`. `http://` is accepted only for `127.0.0.1` and `localhost`. Remote calls time out after 8 s, and the app then shows a "Coordinator/Portal unreachable at <url>" banner instead of a spinner.
