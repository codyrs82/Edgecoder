// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** Whether the model a chat picked can use the web tool (it must call tools); compute-picker ids. */

import { parseNetworkModel } from "../apps/ide/network-inference.js";
import { isFrontierModelId } from "../inference-api/frontier-models.js";
import { supportsTools } from "../model/tool-support.js";

/**
 * "auto" (Auto picks a tool-capable model for a step with tools), frontier models, and any model
 * supportsTools accepts; "network/<m>@<class>", "mine/<m>" and "reserved/<id>/<m>" by their model.
 */
export function modelCallsTools(id: string): boolean {
  const m = id.trim();
  if (!m || m === "auto" || isFrontierModelId(m)) return true;
  const net = parseNetworkModel(m);
  return supportsTools(net ? net.model : m);
}
