// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The one Ollama release EdgeCoder installs: the official GitHub release archive of OLLAMA_VERSION,
 * accepted only when its SHA-256 matches the pin below. Never a script piped into a shell.
 *
 * The same values are written into scripts/{linux,macos}/payload/bin/edgecoder-install-ollama.sh
 * and deploy/install.{sh,ps1}; tests/install/ollama-pins.test.ts fails if any of them drift.
 */
export const OLLAMA_VERSION = "0.40.7";
export const OLLAMA_RELEASE_BASE_URL = "https://github.com/ollama/ollama/releases/download";

export type OllamaTarget = "linux-x64" | "linux-arm64" | "darwin" | "win-x64";

export interface OllamaAsset {
  name: string;
  sha256: string;
}

export const OLLAMA_ASSETS: Readonly<Record<OllamaTarget, OllamaAsset>> = {
  "linux-x64": { name: "ollama-linux-amd64.tar.zst", sha256: "7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41" },
  "linux-arm64": { name: "ollama-linux-arm64.tar.zst", sha256: "c74249e87795b1437ce0f484adfd05b4628d7497472c475b13ec6db69ecc69cf" },
  darwin: { name: "ollama-darwin.tgz", sha256: "6c8b378e423a4c959b586c0bb62865d20ae057e817f1a8ee10abcc44bde6abab" },
  "win-x64": { name: "ollama-windows-amd64.zip", sha256: "e6527768c53e85ec4596495fb0f035ef07f437b4b591ebc3581684699a4668f4" }
};

export function ollamaAssetUrl(asset: OllamaAsset, version = OLLAMA_VERSION): string {
  return `${OLLAMA_RELEASE_BASE_URL}/v${version}/${asset.name}`;
}

export function ollamaTargetFor(platform: NodeJS.Platform, arch: string): OllamaTarget | undefined {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return arch === "x64" ? "win-x64" : undefined;
  if (platform === "linux") {
    if (arch === "x64") return "linux-x64";
    if (arch === "arm64") return "linux-arm64";
  }
  return undefined;
}
