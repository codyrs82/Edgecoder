// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { registerAccountPages } from "./account.js";
import { registerChatPage } from "./chat.js";
import { registerDashboardPages } from "./dashboard.js";
import { registerHomePage } from "./home.js";
import { registerLegacyPage } from "./legacy.js";
import { registerMarketPage } from "./market.js";
import { registerPublicPages, type PublicPagesDeps } from "./public.js";
import { registerResetPasswordPage } from "./reset-password.js";
import { registerReviewsPage } from "./reviews.js";
import { registerSettingsPages } from "./settings.js";

/** #16: every server-rendered HTML page of the portal (API routes stay in server.ts for now). */
export function registerPortalPages(app: FastifyInstance, deps: PublicPagesDeps = {}): void {
  registerPublicPages(app, deps);
  registerLegacyPage(app);
  registerHomePage(app);
  registerResetPasswordPage(app);
  registerChatPage(app);
  registerDashboardPages(app);
  registerAccountPages(app);
  registerSettingsPages(app);
  registerReviewsPage(app);
  registerMarketPage(app);
}
