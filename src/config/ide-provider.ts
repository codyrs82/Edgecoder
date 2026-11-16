// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envFlag, envNumber, envPort, envUrl } from "../common/config.js";
import { modelEnv, observabilityEnv, sandboxEnv, serviceUrlsEnv } from "./shared.js";

const str = () => z.string().optional();
const credits = () => envNumber(undefined, { min: 0 });

/*
 * #15: IDE provider (src/apps/ide/provider-server.ts, port 4304), the OpenAI-compatible endpoint
 * the desktop IDE and local coding agents talk to. Runs on the user's machine, so nothing is
 * required. Most of these are read where they are used (per request, so a settings change
 * applies without a restart); declaring them here validates them once at startup.
 */
export const ideProviderConfigSchema = z.object({
  ...observabilityEnv,
  ...serviceUrlsEnv,
  ...modelEnv,
  ...sandboxEnv,
  /** Loopback unless IDE_PROVIDER_TOKEN is set (src/apps/ide/ide-auth.ts). */
  IDE_PROVIDER_HOST: z.string().default("127.0.0.1"),
  IDE_PROVIDER_PORT: envPort(4304),
  IDE_PROVIDER_TOKEN: str(),
  /** Comma-separated extra web origins allowed to call the provider. */
  IDE_ALLOWED_ORIGINS: str(),
  /** Default 4306 (src/apps/ide/preview-server.ts). */
  IDE_PREVIEW_PORT: envPort(undefined),
  IDE_COMPLETION_MODEL: str(),
  IDE_EMBED_MODEL: str(),
  IDE_NATIVE_TOOLS: envFlag({ off: ["0"] }),
  /** Comma-separated command prefixes the agent may run without asking. */
  IDE_SHELL_ALLOW: str(),
  IDE_SHELL_AUTO_APPROVE: envFlag({ on: ["1"] }),
  /** Comma-separated names of environment variables passed through to shell commands. */
  IDE_SHELL_ENV_PASS: str(),
  IDE_SWARM_EXPECTED_CREDITS: credits(),
  IDE_SWARM_MAX_CREDITS: credits(),
  IDE_SWARM_SESSION_MAX_CREDITS: credits(),
  IDE_SWARM_SNAPSHOT_REF: str(),
  /** Set by the all-in-one entry once this machine is enrolled: swarm work goes through its own agent. */
  SWARM_VIA_LOCAL_AGENT_URL: envUrl(),
  AGENT_ACCOUNT_ID: str(),
  AGENT_ID: str(),
  MESH_AUTH_TOKEN: str(),
  BT_PROXY_URL: envUrl(),
  BT_STATUS_URL: envUrl(),
  EDGECODER_BOTS_FILE: str(),
  EDGECODER_CONNECTIONS_FILE: str(),
  EDGECODER_IDE_SETTINGS_FILE: str(),
  EDGECODER_PROJECTS_DIR: str(),
  EDGECODER_GH_BIN: str(),
  EDGECODER_TRUST_FILE: str(),
  /** Shared coding sessions (src/apps/ide/sessions.ts), one JSON file each. Default ~/.edgecoder/sessions. */
  EDGECODER_SESSIONS_DIR: str(),
  /** The hosted endpoint and an API key (src/apps/ide/hosted-backend.ts): network models without an enrolled agent. */
  EDGECODER_URL: str(),
  EDGECODER_API_KEY: str(),
  EDGECODER_API_KEY_FILE: str(),
  /** Frontier keys (docs/frontier-keys.md): providers, settings and caps (never the keys). Default ~/.edgecoder/frontier.json. */
  EDGECODER_FRONTIER_FILE: str(),
  /** "off": keep frontier keys in a 0600 file next to frontier.json instead of the OS keychain. */
  EDGECODER_FRONTIER_KEYCHAIN: str(),
  /** The credential-store tools (tests, unusual installs): macOS `security`, Linux `secret-tool`, Windows PowerShell. */
  EDGECODER_SECURITY_BIN: str(),
  EDGECODER_SECRET_TOOL_BIN: str(),
  EDGECODER_POWERSHELL_BIN: str(),
  /** Where `edgecoder code` looks for a running provider (default http://127.0.0.1:4304). */
  IDE_PROVIDER_URL: envUrl(),
  /** Auto's quality floor in billions of parameters (src/inference-api/auto-route.ts): chat and agent work. */
  EDGECODER_AUTO_MIN_CHAT_B: envNumber(undefined, { min: 0 }),
  EDGECODER_AUTO_MIN_CODING_B: envNumber(undefined, { min: 0 })
});

export type IdeProviderConfig = z.infer<typeof ideProviderConfigSchema>;
