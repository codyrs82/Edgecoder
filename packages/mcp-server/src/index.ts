// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * EdgeCoder compute for AI agents over MCP; cli.ts runs it on stdio (the edgecoder-mcp bin).
 *
 *   EDGECODER_URL               portal / hosted API (default: the EdgeCoder portal)
 *   EDGECODER_API_KEY           an eck_ key; without it the server signs up with its own key
 *   EDGECODER_AGENT_KEY_FILE    where that key lives (default ~/.edgecoder/agent-key)
 *   EDGECODER_AGENT_NAME        name for a new agent account
 *
 * Nothing is written to stdout except MCP messages; logs go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { baseUrlFrom, fetchHttp } from "./http.js";
import { apiKeySource, defaultKeyPath } from "./identity.js";
import { authedHttp, makeHandlers, toolDescriptions, toolShapes, type ToolName } from "./tools.js";

export const VERSION = "0.1.0";

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const url = baseUrlFrom(env);
  const http = fetchHttp(url);
  const key = apiKeySource({ http, url, envKey: env.EDGECODER_API_KEY?.trim() || undefined, keyPath: defaultKeyPath(env), name: env.EDGECODER_AGENT_NAME?.trim() || undefined });
  const handlers = makeHandlers(authedHttp(http, key));
  const server = new McpServer({ name: "edgecoder", version: VERSION });
  for (const name of Object.keys(toolShapes) as ToolName[]) {
    const handler = handlers[name] as (args: unknown) => ReturnType<(typeof handlers)[ToolName]>;
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolShapes[name] }, async (args: unknown) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        return { content: [{ type: "text" as const, text: `EdgeCoder: ${(err as Error).message}` }], isError: true };
      }
    });
  }
  return server;
}
