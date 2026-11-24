# Changing models from the portal

Managing a headless host's models without needing SSH access is possible through the EdgeCoder portal. This feature allows you to control models on machines that don't have direct console access.

## How to change models from the portal

To change models from the portal, follow these steps:

1. Sign in to the EdgeCoder portal
2. Navigate to **Settings > Nodes**
3. Under "Your machines' models" you'll see a list of all agents enrolled to your account
4. For each machine, you can:
   - Pull new models (with download progress shown)
   - Use an installed model as the active network model
   - Remove installed models (the active model cannot be removed)
   - Apply context window settings (2048 to 131072 tokens), parallel slots (1 to 8), and keep-alive values (-1, 0, or up to 24h)
   - Tick **Automatic** next to the context window or the parallel slots to go back to automatic sizing (from the GPU's free VRAM, or the RAM without a discrete GPU); the agent re-sizes, reloads the model if the window changed, and reports the new value
   - Reload models to unload and load them again

Each command shows who sent it, when, and the result.

## Limits and considerations

- Only the account that owns the machine can make changes
- Changes are applied through the agent's own state directory at `/var/lib/edgecoder/agent-N/.config/edgecoder/model-overrides.json`
- Remote changes are layered over the environment file but local edits take precedence
- The portal shows what the machine reports, not necessarily what's running locally
- Desktop machines (macOS, Windows) work similarly but their app stays authoritative for local chat
- Model loaded in Ollama cannot be removed remotely
- Settings applied via the portal are sent with each Ollama request and take effect immediately
- Each context window and slots field shows the value in force and whether it is automatic, pinned from the portal, or pinned by the machine's own config
- A value pinned by the machine's own config (`AGENT_CONTEXT_WINDOW` / `AGENT_PARALLEL_INFERENCE`, or the desktop app) wins over the portal, so **Automatic** is not offered for it; run `sudo edgecoder-install apply --keep-config --context-window auto` (or `--parallel auto`) on the machine, or change it in the app
- **Automatic** needs agent 1.2.8 or later. For an older agent the box is greyed out with a note to update it (it updates itself within about an hour, or now with `sudo edgecoder-install update`), since an older agent would refuse the command