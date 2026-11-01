#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
// npm bin: the "install" role of the single edgecoder dispatcher (docs/packages.md).
process.argv.splice(2, 0, "install");
await import("./edgecoder.js");
