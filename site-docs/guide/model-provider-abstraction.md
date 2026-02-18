# Model Provider Abstraction

EdgeCoder separates orchestration from model implementation through a provider abstraction.
This allows switching providers while preserving the same higher-level task workflow.

## Provider options

- `edgecoder-local`
  - default local provider path
  - optimized for local-first behavior and predictable startup
- `ollama-local`
  - integrates local or remote Ollama endpoint
  - useful for model experimentation and self-hosted variants

## Why the abstraction exists

- Keep agent loop stable across provider changes.
- Avoid coupling coordinator logic to a single model backend.
- Support environment-specific rollout (developer laptop vs production node).

## Selection flow

```mermaid
flowchart LR
  config[RuntimeConfig]
  registry[ProviderRegistry]
  chosen[ChosenProvider]
  health[HealthCheck]
  ready[ProviderReady]
  fallback[FallbackOrError]

  config --> registry
  registry --> chosen
  chosen --> health
  health -->|ok| ready
  health -->|fail| fallback
```

## Runtime considerations

- Keep provider startup behavior explicit in deployment scripts.
- Use health checks before accepting work.
- Document default model tags per runtime profile.
- For Ollama, ensure `OLLAMA_HOST` and model availability are validated early.

## Configuration keys

| Variable | Purpose |
|---|---|
| `LOCAL_MODEL_PROVIDER` | Select provider implementation |
| `OLLAMA_AUTO_INSTALL` | Control automatic model pull behavior |
| `OLLAMA_MODEL` | Default model tag for Ollama runtime |
| `OLLAMA_HOST` | Local/remote Ollama endpoint |
| `IOS_OLLAMA_MODEL` | Optional iOS worker default model |

## Related pages

- [Executor Sandbox and Isolation](/guide/executor-sandbox-isolation)
- [Runtime Modes](/reference/runtime-modes)
- [Environment Variables](/reference/environment-variables)
