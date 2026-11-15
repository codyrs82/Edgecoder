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

## Content Security Policy (#11)

`src-tauri/tauri.conf.json` has two policies:
- **`csp`** for release builds: `script-src 'self'` (no `unsafe-eval`, no `unsafe-inline`, no dev origins). `connect-src` covers only the local services (`4301`, `4302`, `4304`, `11434` on `127.0.0.1` and `localhost`), `https://edgecoder.io`, `https://*.edgecoder.io` and the default coordinator.
- `dangerousDisableAssetCspModification: ["style-src"]`: Tauri still adds nonces to `script-src` but leaves `style-src` alone. A nonce in `style-src` would make browsers ignore `'unsafe-inline'` and break Monaco's and Svelte's inline styles. `connect-src` also allows `ws://` on `127.0.0.1` and `localhost` for `4301`, `4302` and `4304`.
- **`devCsp`** for `tauri dev`: allows the Vite dev server and HMR.

Monaco's workers are bundled with Vite (`src/lib/monaco-setup.ts`), so the editor doesn't need `eval`. CI (`desktop-web-build`) fails if a main-thread chunk contains `eval(` or `new Function(`.

**Custom hosts:** a coordinator or portal URL set in Settings that isn't in `connect-src` gets blocked by the release CSP. For self-hosted builds, add the host to `connect-src`.

**CI debug artifacts (#85).** Each PR run of the `desktop-debug-build` workflow uploads unsigned debug builds:
- **macOS:** `edgecoder-desktop-debug-macos-latest` contains `edgecoder-desktop-debug-macos.tar.gz`. Extract it with `tar -xzf` rather than Finder's zip handling, so the executable bit survives. The build is unsigned, so Gatekeeper quarantines it. Clear that with `xattr -dr com.apple.quarantine EdgeCoder.app` (or right-click → Open) before launching.
- **Windows:** `edgecoder-desktop-debug-windows-latest` contains the NSIS `*-setup.exe`. It's unsigned, so SmartScreen will warn: choose "More info → Run anyway".

**Manual QA before release** (`npm run tauri build -- --debug` is enough):
- open the editor;
- check syntax highlighting;
- check the diff view;
- send a chat;
- log in through the deep link;
- connect the local agent;
- use the IDE panel.

## color-mix() and WebKitGTK (#161)

On Linux the app renders in the system WebKitGTK. CSS `color-mix()` needs **WebKitGTK 2.40 or newer**; macOS WebKit and Windows WebView2 already support it. Check a Linux machine with `pkg-config --modversion webkit2gtk-4.1` (Tauri 2 links webkit2gtk-4.1).

Most `color-mix()` uses in `src/` tint a token for a hover or status background, for example `color-mix(in srgb, var(--red) 10%, transparent)`. A plain declaration written above it does **not** act as a fallback. The value contains `var()`, so an engine without `color-mix()` still accepts the declaration when parsing, then drops it at computed-value time. The property becomes `unset` (a transparent background, a `currentColor` border), and the earlier declaration is lost.

What that means in practice:
- **Decorative tints** (hover washes, diff and status row backgrounds, soft borders): older WebKitGTK shows no tint. That's acceptable, because text and icons keep their token colors and nothing becomes unreadable.
- **A tint that carries meaning, or is the only hover or focus cue**, gets an explicit `@supports` fallback with a solid token:

  ```css
  .context-menu-item.delete:hover {
    background: color-mix(in srgb, var(--red) 10%, transparent);
  }
  @supports not (background: color-mix(in srgb, red 10%, transparent)) {
    .context-menu-item.delete:hover { background: var(--bg-surface); }
  }
  ```

- Don't use `color-mix()` for text color or for a focus ring.
- A tint behind colored text also lowers its contrast. The sidebar's red "Delete" menu item used a 10% red wash on hover, which put the red text under 4.5:1 in both themes (caught by the `conversation menu` axe test), so it now uses the neutral hover background instead.
