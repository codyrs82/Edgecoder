// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Live preview of web projects: a loopback static server for the open project's files, framed by
 * the app. Its own origin keeps the previewed code away from the app; the path carries a random
 * per-launch key so other local web pages can't guess URLs (a <script src> could otherwise pull a
 * project file into a foreign page). GET only, no directory listings, project files only.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { ProjectFs } from "./project-fs.js";

export const PREVIEW_DEFAULT_PORT = 4306;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export interface PreviewServer {
  server: Server;
  key: string;
  /** URL of a project file (default index.html) under the current key. */
  urlFor(port: number, path?: string): string;
}

export function createPreviewServer(projectRoot: () => string | null, key = randomBytes(16).toString("hex")): PreviewServer {
  const server = createServer((req, res) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed");
    const url = new URL(req.url ?? "/", "http://preview");
    const prefix = `/p/${key}/`;
    if (!url.pathname.startsWith(prefix)) return send(404, "not found");
    const root = projectRoot();
    if (!root) return send(409, "no project open");
    let rel = decodeURIComponent(url.pathname.slice(prefix.length));
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const fs = new ProjectFs(root);
    let abs: string;
    try {
      abs = fs.resolve(rel);
      if (statSync(abs).isDirectory()) abs = fs.resolve(`${rel}/index.html`);
    } catch {
      return send(404, `not found: ${rel}`);
    }
    let body: Buffer;
    try {
      body = readFileSync(abs);
    } catch {
      return send(404, `not found: ${rel}`);
    }
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Only the desktop app may frame it.
      "content-security-policy": "frame-ancestors tauri://localhost http://tauri.localhost http://localhost:1420 http://localhost:1499",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return {
    server,
    key,
    urlFor: (port, path = "") => `http://127.0.0.1:${port}/p/${key}/${path.split("/").map(encodeURIComponent).join("/")}`,
  };
}
