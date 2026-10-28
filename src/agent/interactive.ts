// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { AgentBase, AgentOptions } from "./base.js";
import { Language, AgentExecution } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export class InteractiveAgent extends AgentBase {
  constructor(provider: ModelProvider, options?: AgentOptions) {
    // #45: interactive/IDE runs execute the local user's own code on the host.
    super(provider, { sandbox: "host", origin: "local", ...options });
  }

  async run(task: string, language: Language): Promise<AgentExecution> {
    return this.runWithRetry(task, language);
  }
}
