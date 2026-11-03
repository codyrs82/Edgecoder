#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** edgecoder-mcp: the MCP server on stdio. Only MCP messages go to stdout; errors go to stderr. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./index.js";

try {
  await buildServer().connect(new StdioServerTransport());
} catch (err) {
  process.stderr.write(`edgecoder-mcp: ${(err as Error).message}\n`);
  process.exit(1);
}
