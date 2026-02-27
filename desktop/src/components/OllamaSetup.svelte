<script lang="ts">
  import { open } from "@tauri-apps/plugin-shell";
  import { checkOllamaAvailable } from "../lib/api";

  interface Props { onDismiss: () => void; }
  let { onDismiss }: Props = $props();

  let checking = $state(false);

  async function handleDownload() {
    await open("https://ollama.com/download");
  }

  async function handleRetry() {
    checking = true;
    const ok = await checkOllamaAvailable();
    checking = false;
    if (ok) onDismiss();
  }
</script>

<div class="setup-overlay">
  <div class="setup-card">
    <h2>Ollama Required</h2>
    <p>EdgeCoder needs Ollama to run AI models locally. It's a free, one-time install.</p>
    <div class="setup-actions">
      <button class="btn-primary" onclick={handleDownload}>Download Ollama</button>
      <button class="btn-secondary" onclick={handleRetry} disabled={checking}>
        {checking ? "Checking..." : "I've installed it"}
      </button>
      <button class="btn-link" onclick={onDismiss}>Skip for now</button>
    </div>
  </div>
</div>

<style>
  .setup-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200; }
  .setup-card { background: var(--bg-surface, #1a1a2e); border: 1px solid var(--border-strong, #2d2d5f); border-radius: 10px; padding: 32px; max-width: 420px; text-align: center; }
  .setup-card h2 { margin: 0 0 12px; font-size: 1.2rem; color: var(--text-primary, #e2e8f0); }
  .setup-card p { color: var(--text-secondary, #94a3b8); font-size: 0.9rem; margin: 0 0 24px; line-height: 1.5; }
  .setup-actions { display: flex; flex-direction: column; gap: 10px; }
  .btn-primary { padding: 12px; background: var(--accent, #3b82f6); color: white; border: none; border-radius: 6px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: opacity 0.15s; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-secondary { padding: 10px; background: var(--bg-surface, #1a1a2e); color: var(--text-primary, #e2e8f0); border: 1px solid var(--border-strong, #2d2d5f); border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-link { background: none; border: none; color: var(--text-muted, #64748b); font-size: 0.85rem; cursor: pointer; padding: 4px; }
  .btn-link:hover { color: var(--text-secondary, #94a3b8); }
</style>
