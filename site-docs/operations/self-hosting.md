# Self-hosting: hostnames and endpoints

Every EdgeCoder-run hostname in the code is a default, and each one can be overridden by an environment variable (#22). `tests/repo/hostnames.test.ts` fails if a new hard-coded `edgecoder.io` or `fly.dev` host appears in `src/` that can't be overridden.

## Portal

| Variable | Set it to |
|---|---|
| `PORTAL_PUBLIC_URL` | Your portal's public https URL. It's used in email links and OAuth redirects, and its host appears in the "Back to …" link. |
| `PASSKEY_RP_ID` / `PASSKEY_ORIGIN` / `PASSKEY_ALLOWED_ORIGINS` | Your portal's domain and origin (WebAuthn). |
| `DOCS_SITE_URL` | Your docs site URL (https in production). |
| `GITHUB_REPO_URL` | Your fork's URL, for changelog and release links. |
| `SUPPORT_EMAIL` | The contact address shown in the privacy policy and terms. It must be a plain address; anything else falls back to the default. |
| `COORDINATOR_DISCOVERY_URLS` | A comma-separated list of your coordinator URLs. Without it, the portal uses the EdgeCoder EU seed. In production, it (or `CONTROL_PLANE_URL`) is required. |
| `DNS_BASE_DOMAIN` | The base domain for node DNS records, if you use the DNS manager. |
| `IOS_APP_BUNDLE_ID` | Your iOS bundle id, for apple-app-site-association. |

## Coordinator and agents

| Variable | Set it to |
|---|---|
| `COORDINATOR_PUBLIC_URL` | Your coordinator's public URL. |
| `COORDINATOR_URL` | The coordinator an agent connects to. |
| `COORDINATOR_BOOTSTRAP_URLS` | Your coordinator peers. |
| `MODEL_DOWNLOAD_DOMAINS` | A comma-separated list of exact hostnames that signed model manifests may download from. It replaces the defaults (`models.edgecoder.io`, `huggingface.co`). |

## Desktop app

- At build time, set `VITE_COORDINATOR_URL` and `VITE_PORTAL_URL`. Their origins are added to the release CSP `connect-src` (#83). Users can also change the hosts in Settings (#35). A host changed after the build is still blocked by the CSP (#138).

## Deploy configs

`deploy/fly/*.toml` describe the EdgeCoder-run Fly apps. For your own deployment, copy them, change `app`, `PORTAL_PUBLIC_URL`, `PASSKEY_*`, `DOCS_SITE_URL` and `COORDINATOR_DISCOVERY_URLS`, and set the required secrets (see [Environment variables](../reference/environment-variables.md)).
