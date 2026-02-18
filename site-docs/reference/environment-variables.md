# Environment Variables

This page consolidates key environment controls documented across `README.dev.md`,
installer docs, and operations runbooks.

## Core Runtime and Network

- `NETWORK_MODE` (`public_mesh` or `enterprise_overlay`)
- `CONTROL_PLANE_URL`
- `COORDINATOR_URL` / `COORDINATOR_PUBLIC_URL`
- `COORDINATOR_DISCOVERY_URL`
- `COORDINATOR_BOOTSTRAP_URLS`

## Worker Identity and Enrollment

- `AGENT_ID`
- `AGENT_OS`
- `AGENT_MODE` (`swarm-only`, `ide-enabled`)
- `AGENT_REGISTRATION_TOKEN`
- `AGENT_CLIENT_TYPE`

## Model Provider Controls

- `LOCAL_MODEL_PROVIDER` (`edgecoder-local`, `ollama-local`)
- `OLLAMA_AUTO_INSTALL`
- `OLLAMA_MODEL`
- `OLLAMA_HOST`

## Security and Auth

- `MESH_AUTH_TOKEN`
- `INFERENCE_AUTH_TOKEN`
- `ADMIN_API_TOKEN`
- `PORTAL_SERVICE_TOKEN`
- `PORTAL_DATABASE_URL`

## Portal and Passkeys

- `PORTAL_PUBLIC_URL`
- `PASSKEY_RP_ID`
- `PASSKEY_RP_NAME`
- `PASSKEY_ORIGIN`
- `PASSKEY_CHALLENGE_TTL_MS`

## Wallet and Economy

- `WALLET_DEFAULT_NETWORK`
- `WALLET_SECRET_PEPPER`
- `COORDINATOR_FEE_BPS`
- `COORDINATOR_FEE_ACCOUNT`
- `PAYMENT_INTENT_TTL_MS`

## Website and Docs links

- `DOCS_SITE_URL`
- `GITHUB_REPO_URL`

## Operational guidance

- Keep secrets in production secret stores rather than static env files.
- Keep public origin values on HTTPS in production.
- Review source docs before introducing new deployment profiles.

## Canonical references

- [Developer Guide configuration notes](https://github.com/your-org/Edgecoder/blob/main/README.dev.md)
- [macOS env example](https://github.com/your-org/Edgecoder/blob/main/scripts/macos/payload/etc/edgecoder/edgecoder.env.example)
- [Public mesh operations env references](https://github.com/your-org/Edgecoder/blob/main/docs/public-mesh-operations.md)
