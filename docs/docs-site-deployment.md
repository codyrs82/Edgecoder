# Docs Site Deployment

This repository includes a VitePress docs site under `site-docs/`.

## Local usage

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

## Recommended hosting

Deploy `site-docs/.vitepress/dist` to any static host, for example:

- GitHub Pages
- Cloudflare Pages
- Netlify
- Vercel static hosting

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
