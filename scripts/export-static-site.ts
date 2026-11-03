// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
// Usage: PORTAL_PUBLIC_URL=https://edgecoder.io npx tsx scripts/export-static-site.ts [outDir]
import { exportStaticSite } from "../src/portal/static-site.js";

const outDir = process.argv[2] ?? "dist-static";
const portalUrl = process.env.PORTAL_PUBLIC_URL ?? "https://edgecoder.io";
const files = await exportStaticSite(outDir, { portalUrl });
for (const f of files) console.log(f);
console.log(`\nStatic mirror written to ${outDir} (dynamic paths redirect to ${portalUrl}).`);
