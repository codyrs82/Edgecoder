const DEFAULT_IOS_MODEL = process.env.IOS_OLLAMA_MODEL ?? "qwen2.5:0.5b";

// iOS agents are intentionally headless contributors in this build.
process.env.AGENT_OS = "ios";
process.env.AGENT_MODE = "swarm-only";
process.env.LOCAL_MODEL_PROVIDER = process.env.LOCAL_MODEL_PROVIDER ?? "ollama-local";
process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? DEFAULT_IOS_MODEL;
process.env.AGENT_CLIENT_TYPE = process.env.AGENT_CLIENT_TYPE ?? "edgecoder-ios";

await import("./worker-runner.js");
