# Dependency audit (#13)

Generated from `npm audit --json` on each lockfile, before (base `ci/31-scale-nonroot`) and after this change. Every version change below is either a direct `npm audit fix` result or one of the explicit bumps listed here. After the change, no lockfile has a high or critical advisory. CI enforces this with `npm ci --ignore-scripts` and `npm audit --audit-level=high` per lockfile (the `dependency-audit` job).

## Explicit bumps and overrides

| Where | Change | Why (npm audit) |
|---|---|---|
| root `overrides` | `tar` → ^7.5.22 | critical: node-tar path traversal / symlink poisoning. Only reached through the optional BLE native build chain (`@abandonware/*` → `node-gyp`, `@mapbox/node-pre-gyp`). |
| root `overrides` | `@mapbox/node-pre-gyp` → ^2.0.3, `node-gyp` → ^11.5.0 | high, via `tar`. These are the first majors on tar 7. They're used only to compile the optional BLE modules at install. |
| root `overrides` | `vitepress` → `vite` ^6.4.1 | high: vite path traversal in optimized deps `.map` handling, and launch-editor UNC hash disclosure. vitepress 1.6.4 (latest stable) pins vite 5, which has no patched 5.x. This is docs build only; the docs CI job checks that it still builds. |
| root lockfile | `npm audit fix` | fastify, find-my-way, undici, ws, zod, vitest, vue, dompurify, mermaid parser, and others (see the table). These stay within their existing semver ranges. |
| desktop | `vite` ^5 → ^7.3.7, `@sveltejs/vite-plugin-svelte` ^4 → ^6.2.4 | high: vite advisories (no patched 5.x). Plugin v6 is the release line for vite 7. |
| desktop | `monaco-editor` ^0.55.1 → ^0.57.0, `overrides.dompurify` ^3.4.17 | high/critical: DOMPurify XSS bundled by Monaco. 0.57 pulls 3.4.15, which still has an advisory, so the override pins the patched 3.4.17 (same major). |
| desktop | removed `@types/marked` | `marked` ships its own types (#13). |
| extensions/vscode | `@vscode/vsce` ^2.22.0 → ^3.9.2 | high: markdown-it / linkify-it ReDoS, which only vsce 3 fixes. vsce is a dev-only packaging tool. |

BLE is **best-effort until it's replaced.** The node-gyp 11 / node-pre-gyp 2 overrides are not verified against a native build of the `@abandonware/*` modules, and because they are optional, `npm ci` silently skips them if they fail to compile, so BLE can disappear on Linux or macOS without an error. If BLE is needed, check with `node -e "import('@abandonware/noble')"` after install.

vitepress 1.6.4 is built for vite 5, so running it on vite 6 (the override) is an unsupported pairing. Nothing verifies the docs build until #34 / #120 land. Revisit this override then: drop it if vitepress ships a vite-6 release, or accept the dev-only vite 5 advisory.

`@abandonware/noble` and `bleno` stay `optionalDependencies` (they are unmaintained, with no fixed release). Their vulnerable build chain is patched through the overrides above. If they fail to compile, `npm ci` skips them, and `src/mesh/ble/noble-ble-transport.ts` loads them dynamically.

Remaining (low only): root: katex/mermaid (fix would need mermaid 10, a downgrade). desktop: deepmerge via vite-plugin-svelte-inspector. vscode: 3 moderate (`@azure/identity`, `@azure/msal-node`, `uuid` through vsce).

The `dependency-audit` job is deliberately strict: an advisory published after merge turns unrelated PRs red until it is fixed, and Dependabot security PRs usually fix it. If that becomes noisy, make the audit step `continue-on-error` and rely on Dependabot.

Dependabot (`.github/dependabot.yml`) now opens weekly grouped updates for the three npm lockfiles, Cargo and GitHub Actions.

## Before → after, per lockfile (moderate and above, before)

## `package-lock.json`

Before: 2 critical, 27 high, 11 moderate.

| Package | Before | After | Severity | Advisories (direct) |
|---|---|---|---|---|
| `@abandonware/bleno` | 0.6.2 | 0.6.2 | high | via xpc-connect |
| `@abandonware/bluetooth-hci-socket` | 0.5.3-12 | 0.5.3-12 | high | via node-gyp |
| `@abandonware/noble` | 1.9.2-26 | 1.9.2-26 | high | via @abandonware/bluetooth-hci-socket |
| `@chevrotain/cst-dts-gen` | 11.0.3 | removed | moderate | via @chevrotain/gast, lodash-es |
| `@chevrotain/gast` | 11.0.3 | removed | moderate | via lodash-es |
| `@mapbox/node-pre-gyp` | 1.0.11 | 2.0.3 | high | via tar |
| `@mermaid-js/parser` | 0.6.3 | 1.2.1 | moderate | via langium |
| `@vitest/mocker` | 4.0.18 | 4.1.12 | moderate | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock; [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) Vitest: Code injection via unauthenticated manual mock registration |
| `@vue/server-renderer` | 3.5.28 | 3.5.44 | high | [GHSA-g2v6-rqmx-r4w6](https://github.com/advisories/GHSA-g2v6-rqmx-r4w6) @vue/server-renderer: XSS via missing CR in attribute-name blacklist |
| `brace-expansion` | 1.1.12, 2.0.2, 5.0.3 | 2.1.7 | high | [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v) brace-expansion: Zero-step sequence causes process hang and memory exhaustion |
| `cacache` | 16.1.3, 18.0.4 | 19.0.1 | high | via tar |
| `chevrotain` | 11.0.3 | removed | moderate | via @chevrotain/cst-dts-gen, @chevrotain/gast, lodash-es |
| `dompurify` | 3.3.1 | 3.4.17 | high | [GHSA-v2wj-7wpq-c8vv](https://github.com/advisories/GHSA-v2wj-7wpq-c8vv) DOMPurify contains a Cross-site Scripting vulnerability; [GHSA-h7mw-gpvr-xq4m](https://github.com/advisories/GHSA-h7mw-gpvr-xq4m) DOMPurify: FORBID_TAGS bypassed by function-based ADD_TAGS predicate (asymmetry with FORBID_ATTR fix); [GHSA-crv5-9vww-q3g8](https://github.com/advisories/GHSA-crv5-9vww-q3g8) DOMPurify has a SAFE_FOR_TEMPLATES bypass in RETURN_DOM mode |
| `esbuild` | 0.21.5, 0.27.3 | 0.25.12, 0.27.2 | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) esbuild enables any website to send any requests to the development server and read the response; [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) esbuild allows arbitrary file read when running the development server on Windows |
| `fast-uri` | 3.1.0 | 3.1.9, 4.2.3 | high | [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) fast-uri vulnerable to host confusion via literal backslash authority delimiter; [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) fast-uri vulnerable to host confusion via backslash authority introducer; [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) fast-uri vulnerable to path traversal via percent-encoded dot segments |
| `fastify` | 5.7.4 | 5.12.7 | high | [GHSA-573f-x89g-hqp9](https://github.com/advisories/GHSA-573f-x89g-hqp9) Fastify's Missing End Anchor in "subtypeNameReg" Allows Malformed Content-Types to Pass Validation; [GHSA-444r-cwp2-x5xf](https://github.com/advisories/GHSA-444r-cwp2-x5xf) fastify: request.protocol and request.host Spoofable via X-Forwarded-Proto/Host from Untrusted Connections; [GHSA-247c-9743-5963](https://github.com/advisories/GHSA-247c-9743-5963) Fastify has a Body Schema Validation Bypass via Leading Space in Content-Type Header |
| `find-my-way` | 9.4.0 | 9.10.0 | high | [GHSA-c96f-x56v-gq3h](https://github.com/advisories/GHSA-c96f-x56v-gq3h) find-my-way: DDoS with HTTP2 |
| `http-cache-semantics` | 4.2.0 | 4.3.0 | high | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) http-cache-semantics max-stale handling can disclose cross-user cached responses |
| `langium` | 3.3.1 | removed | moderate | via chevrotain |
| `lodash-es` | 4.17.21, 4.17.23 | 4.18.1 | high | [GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) lodash vulnerable to Code Injection via `_.template` imports key names; [GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh) lodash vulnerable to Prototype Pollution via array path bypass in `_.unset` and `_.omit`; [GHSA-xxjr-mmjv-4gpg](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg) Lodash has Prototype Pollution Vulnerability in `_.unset` and `_.omit` functions |
| `make-fetch-happen` | 10.2.1, 13.0.1 | 14.0.3 | high | via cacache |
| `mermaid` | 11.12.2 | 11.17.2 | moderate | [GHSA-ghcm-xqfw-q4vr](https://github.com/advisories/GHSA-ghcm-xqfw-q4vr) Mermaid: Improper sanitization of `classDef` in state diagrams leads to HTML injection; [GHSA-xcj9-5m2h-648r](https://github.com/advisories/GHSA-xcj9-5m2h-648r) Mermaid: Improper sanitization of `classDefs` in diagrams leads to CSS injection; [GHSA-6m6c-36f7-fhxh](https://github.com/advisories/GHSA-6m6c-36f7-fhxh) Mermaid Gantt Charts are vulnerable to an Infinite Loop DoS |
| `minimatch` | 3.1.3, 5.1.7, 9.0.6 | 9.0.9 | high | [GHSA-7r86-cg39-jmmj](https://github.com/advisories/GHSA-7r86-cg39-jmmj) minimatch has ReDoS: matchOne() combinatorial backtracking via multiple non-adjacent GLOBSTAR segments; [GHSA-23c5-xmqv-rm74](https://github.com/advisories/GHSA-23c5-xmqv-rm74) minimatch ReDoS: nested *() extglobs generate catastrophically backtracking regular expressions |
| `nanoid` | 3.3.11 | 3.3.20 | high | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) nanoid: non-secure generators can loop indefinitely with negative size; [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) nanoid: custom generators can loop indefinitely when size is zero; [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) nanoid: Integer Overflow or Wraparound |
| `node-gyp` | 10.3.1, 9.4.1 | 11.5.0 | high | via make-fetch-happen, tar |
| `picomatch` | 4.0.3 | 4.0.7 | high | [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) Picomatch: Method Injection in POSIX Character Classes causes incorrect Glob Matching; [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) Picomatch has a ReDoS vulnerability via extglob quantifiers |
| `postcss` | 8.5.6 | 8.5.32 | high | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) PostCSS has XSS via Unescaped </style> in its CSS Stringify Output; [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments; [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset |
| `rollup` | 4.57.1 | 4.65.1 | high | [GHSA-mw96-cpmx-2vgc](https://github.com/advisories/GHSA-mw96-cpmx-2vgc) Rollup 4 has Arbitrary File Write via Path Traversal |
| `source-map-js` | 1.2.1 | 1.2.2 | high | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) source-map-js allows event-loop denial of service through indexed source-map section offsets |
| `tar` | 6.2.1 | 7.5.22 | critical | [GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v) node-tar Vulnerable to Arbitrary File Creation/Overwrite via Hardlink Path Traversal; [GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97) node-tar is Vulnerable to Arbitrary File Overwrite and Symlink Poisoning via Insufficient Path Sanitization; [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx) Arbitrary File Read/Write via Hardlink Target Escape Through Symlink Chain in node-tar Extraction |
| `undici` | 7.22.0 | 7.30.1 | high | [GHSA-f269-vfmq-vjvj](https://github.com/advisories/GHSA-f269-vfmq-vjvj) Undici: Malicious WebSocket 64-bit length overflows parser and crashes the client; [GHSA-2mjp-6q6p-2qxm](https://github.com/advisories/GHSA-2mjp-6q6p-2qxm) Undici has an HTTP Request/Response Smuggling issue; [GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q) Undici has Unbounded Memory Consumption in WebSocket permessage-deflate Decompression |
| `uuid` | 11.1.0 | 14.0.3 | moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided |
| `vite` | 5.4.21, 7.3.1 | 6.4.5, 8.3.5 | high | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling; [GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r) Vite: `server.fs.deny` bypassed with queries |
| `vitepress` | 1.6.4 | 1.6.4 | moderate | via vite |
| `vitepress-plugin-mermaid` | 2.0.17 | 2.0.17 | moderate | via vitepress |
| `vitest` | 4.0.18 | 4.1.12 | critical | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) When Vitest UI server is listening, arbitrary file can be read and executed; [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock |
| `vue` | 3.5.28 | 3.5.44 | high | via @vue/server-renderer |
| `ws` | 8.19.0 | 8.22.0 | high | [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) ws: Uninitialized memory disclosure; [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) ws: Memory exhaustion DoS from tiny fragments and data chunks |
| `xpc-connect` | 3.0.0 | 3.0.0 | high | via node-gyp |
| `zod` | 4.3.6 | 4.6.7 | high | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) Zod can exhaust memory while validating oversized constrained collections |

## `desktop/package-lock.json`

Before: 0 critical, 6 high, 5 moderate.

| Package | Before | After | Severity | Advisories (direct) |
|---|---|---|---|---|
| `@sveltejs/vite-plugin-svelte` | 4.0.4 | 6.2.4 | moderate | via @sveltejs/vite-plugin-svelte-inspector, deepmerge, vite |
| `@sveltejs/vite-plugin-svelte-inspector` | 3.0.1 | 5.0.2 | moderate | via @sveltejs/vite-plugin-svelte, vite |
| `devalue` | 5.6.3 | 5.9.4 | high | [GHSA-cfw5-2vxh-hr84](https://github.com/advisories/GHSA-cfw5-2vxh-hr84) devalue has prototype pollution in devalue.parse and devalue.unflatten; [GHSA-77vg-94rm-hx3p](https://github.com/advisories/GHSA-77vg-94rm-hx3p) Svelte devalue: DoS via sparse array deserialization; [GHSA-mwv9-gp5h-frr4](https://github.com/advisories/GHSA-mwv9-gp5h-frr4) Sveltejs devalue's `devalue.parse` and `devalue.unflatten` emit objects with `__proto__` own properties |
| `dompurify` | 3.2.7 | 3.4.17 | high | [GHSA-v2wj-7wpq-c8vv](https://github.com/advisories/GHSA-v2wj-7wpq-c8vv) DOMPurify contains a Cross-site Scripting vulnerability; [GHSA-h7mw-gpvr-xq4m](https://github.com/advisories/GHSA-h7mw-gpvr-xq4m) DOMPurify: FORBID_TAGS bypassed by function-based ADD_TAGS predicate (asymmetry with FORBID_ATTR fix); [GHSA-crv5-9vww-q3g8](https://github.com/advisories/GHSA-crv5-9vww-q3g8) DOMPurify has a SAFE_FOR_TEMPLATES bypass in RETURN_DOM mode |
| `esbuild` | 0.21.5 | 0.28.2 | moderate | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) esbuild enables any website to send any requests to the development server and read the response |
| `monaco-editor` | 0.55.1 | 0.57.0 | moderate | via dompurify |
| `nanoid` | 3.3.11 | 3.3.20 | high | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) nanoid: non-secure generators can loop indefinitely with negative size; [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) nanoid: custom generators can loop indefinitely when size is zero; [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) nanoid: Integer Overflow or Wraparound |
| `postcss` | 8.5.6 | 8.5.32 | high | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) PostCSS has XSS via Unescaped </style> in its CSS Stringify Output; [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments; [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset |
| `source-map-js` | 1.2.1 | 1.2.2 | high | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) source-map-js allows event-loop denial of service through indexed source-map section offsets |
| `svelte` | 5.53.3 | 5.57.3 | moderate | [GHSA-qgvg-pr8v-6rr3](https://github.com/advisories/GHSA-qgvg-pr8v-6rr3) Svelte: XSS via HTML Comment Injection in SSR Error Boundary Hydration Markers; [GHSA-phwv-c562-gvmh](https://github.com/advisories/GHSA-phwv-c562-gvmh) Svelte vulnerable to XSS during SSR with contenteditable `bind:innerText` and `bind:textContent`; [GHSA-f3cj-j4f6-wq85](https://github.com/advisories/GHSA-f3cj-j4f6-wq85) Svelte: SSR XSS via Insecure Promise Serialization in hydratable |
| `vite` | 5.4.21 | 7.3.7 | high | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling; [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) launch-editor: NTLMv2 hash disclosure via UNC path handling on Windows; [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) launch-editor: escapeCmdArgs() omits % escaping on Windows |

## `extensions/vscode/package-lock.json`

Before: 0 critical, 8 high, 5 moderate.

| Package | Before | After | Severity | Advisories (direct) |
|---|---|---|---|---|
| `@azure/identity` | 4.13.0 | 4.13.0 | moderate | via @azure/msal-node |
| `@azure/msal-node` | 3.8.7 | 3.8.10 | moderate | via uuid |
| `@vscode/vsce` | 2.32.0 | 3.9.2 | moderate | via markdown-it |
| `brace-expansion` | 1.1.12 | 5.0.12 | high | [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v) brace-expansion: Zero-step sequence causes process hang and memory exhaustion; [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups; [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash |
| `form-data` | 4.0.5 | 4.0.6 | high | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) form-data: CRLF injection in form-data via unescaped multipart field names and filenames |
| `linkify-it` | 3.0.3 | 5.0.2 | high | [GHSA-22p9-wv53-3rq4](https://github.com/advisories/GHSA-22p9-wv53-3rq4) LinkifyIt#match scan loop has quadratic algorithmic complexity; [GHSA-v245-v573-v5vm](https://github.com/advisories/GHSA-v245-v573-v5vm) linkify-it: Quadratic-complexity DoS via the `mailto:` validator scan-loop on attacker text |
| `markdown-it` | 12.3.2 | 14.3.3 | high | [GHSA-6v5v-wf23-fmfq](https://github.com/advisories/GHSA-6v5v-wf23-fmfq) markdown-it: Quadratic complexity DoS in smartquotes rule via replaceAt string operations; [GHSA-r7fv-28h4-cvq7](https://github.com/advisories/GHSA-r7fv-28h4-cvq7) markdown-it: Quadratic complexity in smartquotes with unmatched closing quotes; [GHSA-vfgh-jcmw-g37q](https://github.com/advisories/GHSA-vfgh-jcmw-g37q) markdown-it: Quadratic-time denial of service in inline HTML parsing with html enabled |
| `minimatch` | 3.1.2 | 10.2.6 | high | [GHSA-3ppc-4f35-3m26](https://github.com/advisories/GHSA-3ppc-4f35-3m26) minimatch has a ReDoS via repeated wildcards with non-matching literal in pattern; [GHSA-7r86-cg39-jmmj](https://github.com/advisories/GHSA-7r86-cg39-jmmj) minimatch has ReDoS: matchOne() combinatorial backtracking via multiple non-adjacent GLOBSTAR segments; [GHSA-23c5-xmqv-rm74](https://github.com/advisories/GHSA-23c5-xmqv-rm74) minimatch ReDoS: nested *() extglobs generate catastrophically backtracking regular expressions |
| `qs` | 6.15.0 | 6.17.0 | moderate | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) qs has a remotely triggerable DoS: qs.stringify crashes with TypeError on null/undefined entries in comma-format arrays when encodeValuesOnly is set; [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) qs array-limit bypass via bracket-key comma parsing; [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) qs: Denial of Service via Attacker Controlled isBuffer |
| `tmp` | 0.2.5 | 0.2.7 | high | [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape |
| `underscore` | 1.13.7 | 1.13.8 | high | [GHSA-qpx9-hpmf-5gmw](https://github.com/advisories/GHSA-qpx9-hpmf-5gmw) Underscore has unlimited recursion in _.flatten and _.isEqual, potential for DoS attack |
| `undici` | 7.22.0 | 7.30.1 | high | [GHSA-f269-vfmq-vjvj](https://github.com/advisories/GHSA-f269-vfmq-vjvj) Undici: Malicious WebSocket 64-bit length overflows parser and crashes the client; [GHSA-2mjp-6q6p-2qxm](https://github.com/advisories/GHSA-2mjp-6q6p-2qxm) Undici has an HTTP Request/Response Smuggling issue; [GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q) Undici has Unbounded Memory Consumption in WebSocket permessage-deflate Decompression |
| `uuid` | 8.3.2 | 8.3.2 | moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided |
