# Docs Site Deployment

This repository includes a VitePress docs site under `site-docs/`.

## Local usage

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

## How it is hosted

The site is deployed to **GitHub Pages** by `.github/workflows/deploy-docs.yml`:

- On a push to `main` that touches `site-docs/**`, `package.json`, `package-lock.json` or the
  workflow, it runs `npm run docs:build` and deploys `site-docs/.vitepress/dist` with
  `actions/deploy-pages`. Pull requests that touch those paths build the site without deploying it,
  so a broken docs build shows up before `main`. It can also be run by hand (`workflow_dispatch`).
- The custom domain is `docs.edgecoder.io` (`site-docs/public/CNAME`).

### Known issue: base path

The workflow builds with `DOCS_BASE: /Edgecoder/`, the base path of the project Pages URL
(`https://codyrs82.github.io/Edgecoder/`). The custom domain serves the site from the root
(`https://docs.edgecoder.io/`), where the base should be `/` (`site-docs/.vitepress/config.ts`
falls back to `/` when `DOCS_BASE` is unset). With the custom domain active, asset and link URLs
built under `/Edgecoder/` can 404. The fix is a workflow change (set `DOCS_BASE` to `/`, or drop
it) and is not made here.

The output is a static site, so any static host (Cloudflare Pages, Netlify, Vercel) would also
work.

## Wire docs link into the portal website

The portal website reads these environment variables:

- `DOCS_SITE_URL`: external docs URL shown in home and portal navigation.
- `GITHUB_REPO_URL`: repository URL shown in home and portal navigation.

Defaults:

- `DOCS_SITE_URL=http://127.0.0.1:5173`
- `GITHUB_REPO_URL=https://github.com/codyrs82/Edgecoder`

Example:

```bash
DOCS_SITE_URL=https://docs.edgecoder.io
GITHUB_REPO_URL=https://github.com/codyrs82/Edgecoder
```
