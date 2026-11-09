// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { AgentBase, AgentOptions } from "./base.js";
import { Language, AgentExecution } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export class InteractiveAgent extends AgentBase {
  constructor(provider: ModelProvider, options?: AgentOptions) {
    // #45: interactive/IDE runs are the local user's own tasks, but the code is model output, so it
    // runs in the Docker sandbox. Without Docker, runCode uses the host only when
    // EDGECODER_UNSAFE_HOST_EXECUTION=1 is set (see unsafeHostExecutionAllowed).
    super(provider, { sandbox: "docker", origin: "local", ...options });
  }

  async run(task: string, language: Language): Promise<AgentExecution> {
    return this.runWithRetry(task, language);
  }
}
