// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { registerPortalAssets } from "../assets.js";
import { registerAccountPages } from "./account.js";
import { registerChatPage } from "./chat.js";
import { registerDashboardPages } from "./dashboard.js";
import { registerHomePage } from "./home.js";
import { registerHostPage } from "./host.js";
import { registerPublicPages, type PublicPagesDeps } from "./public.js";
import { registerSeoRoutes } from "./seo.js";
import { registerResetPasswordPage } from "./reset-password.js";
import { registerReviewsPage } from "./reviews.js";
import { registerBotsPage } from "./bots.js";
import { registerCodePage } from "./code.js";
import { registerSettingsPages } from "./settings.js";
import { registerWelcomePages } from "./welcome.js";

/** #16: every server-rendered HTML page of the portal (API routes stay in server.ts for now). */
export function registerPortalPages(app: FastifyInstance, deps: PublicPagesDeps = {}): void {
  // #89: /assets/tokens.css and /assets/theme.js, linked from every page.
  registerPortalAssets(app);
  registerPublicPages(app, deps);
  // robots.txt, sitemap.xml, llms.txt, favicon.ico (src/portal/pages/seo.ts).
  registerSeoRoutes(app);
  // Hosting by request (src/portal/host-requests.ts): the "Host with us" page and its form.
  registerHostPage(app);
  // #27: /portal-legacy was the first single-page portal. Nothing linked to it and every function
  // it had lives on /portal and in Settings, so the page is gone; old bookmarks land on sign-in.
  app.get("/portal-legacy", async (_req, reply) => reply.redirect("/portal", 302));
  registerHomePage(app);
  registerResetPasswordPage(app);
  registerChatPage(app);
  registerDashboardPages(app);
  registerAccountPages(app);
  registerSettingsPages(app);
  // Getting started (/portal/welcome): the same steps as the desktop app's wizard.
  registerWelcomePages(app);
  registerReviewsPage(app);
  registerBotsPage(app);
  // Code (/portal/code): the coding sessions on your Macs, through the Code from your phone relay.
  registerCodePage(app);
}
