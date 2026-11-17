// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import * as S from "../../common/served.js";

/**
 * The reply footer's formatter (src/common/served.ts, byte-identical to the desktop app's
 * desktop/src/lib/served.ts), shipped to the chat page via Function.prototype.toString.
 */
export const SERVED_BROWSER_LIB = [S.servedTok, S.servedSecs, S.servedCost, S.hardwareShort, S.servedLine, S.servedBreakdown]
  .map((f) => f.toString())
  .join("\n");
