// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { registerAccountPages } from "./account.js";
import { registerDashboardPages } from "./dashboard.js";
import { registerHomeAndChatPages } from "./home-chat.js";
import { registerLegacyPage } from "./legacy.js";
import { registerPublicPages } from "./public.js";
import { registerReviewsPage } from "./reviews.js";

/** #16: every server-rendered HTML page of the portal (API routes stay in server.ts for now). */
export function registerPortalPages(app: FastifyInstance): void {
  registerPublicPages(app);
  registerLegacyPage(app);
  registerHomeAndChatPages(app);
  registerDashboardPages(app);
  registerAccountPages(app);
  registerReviewsPage(app);
}
