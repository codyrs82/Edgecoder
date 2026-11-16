# @edgecoder/tokens

The design tokens (color, spacing, type and radius) for the desktop app and the portal (#23).

- `src/tokens.json` is the source of truth. Every color has a `light` and a `dark` value. Elevation (`--shadow-sm|md|lg`, `--scrim`) is neutral black and the same in both themes. `derived` colours are mixed from two colour tokens in CSS: `--red-strong` is the red for text on a red tint (up to 15%), where plain `--red` falls below 4.5:1.
- `chart` holds the categorical chart series colours, `--chart-1..4` (light and dark). Take them in order: the order was checked as a set for colour-blind separation of neighbouring series (OKLab ΔE ≥ 8, deutan/protan/tritan) on both surfaces. A fifth series folds into "Other" (neutral ink), never a new hue.
- `node packages/tokens/build.mjs` regenerates `dist/tokens.css` (the runtime CSS variables) and `src/theme.css` (the Tailwind v4 `@theme` mapping). Both files are committed. `--check` fails if either is stale, and the unit tests check this too.
- Theme selection: light is the `:root` default. `<html data-theme="dark">` forces dark. With no `data-theme` set, `prefers-color-scheme` decides.
- The variable names match the old `App.svelte` `:root` block (`--bg-base`, `--text-primary`, ... plus the portal aliases `--bg`, `--brand`, ...), so existing component CSS keeps working.

The desktop app consumes the package as `"@edgecoder/tokens": "file:../packages/tokens"`. There are no root npm workspaces, so the root lockfile is unchanged.

The portal (#89) serves `dist/tokens.css` at `/assets/tokens.css`: `npm run build` copies it to `dist/portal/assets/` (`scripts/copy-portal-assets.mjs`), the server Dockerfiles copy it into the build stage, and when running from `src/` the server reads it from this package. After changing tokens, rebuild here and redeploy the portal; the link carries a content hash, so caches pick up the new file.
