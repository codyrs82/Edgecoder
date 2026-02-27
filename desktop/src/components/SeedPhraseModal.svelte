<script lang="ts">
  import { acknowledgeWalletSeed } from "../lib/api";

  interface Props {
    seedPhrase: string;
    derivedAddress: string | null;
    guidance: { title: string; steps: string[] };
    onDone: () => void;
  }
  let { seedPhrase, derivedAddress, guidance, onDone }: Props = $props();

  let secondsLeft = $state(120);
  let expired = $state(false);
  let confirming = $state(false);
  let displayPhrase = $state(seedPhrase);

  // Countdown timer — auto-clear seed from DOM
  $effect(() => {
    const timer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(timer);
        displayPhrase = "";
        expired = true;
      }
    }, 1000);
    return () => clearInterval(timer);
  });

  async function handleConfirm() {
    confirming = true;
    try {
      await acknowledgeWalletSeed();
      displayPhrase = "";
      onDone();
    } catch {
      confirming = false;
    }
  }

  function handleClose() {
    displayPhrase = "";
    onDone();
  }
</script>

<div class="modal-backdrop">
  <div class="modal">
    <h2>Your Recovery Seed Phrase</h2>

    {#if expired}
      <p class="warning">Seed phrase cleared for security. Generate a new one if you didn't write it down.</p>
    {:else}
      <p class="timer">Auto-clears in {secondsLeft}s</p>
      <div class="seed-grid">
        {#each displayPhrase.split(" ") as word, i}
          <div class="seed-word"><span class="word-num">{i + 1}</span>{word}</div>
        {/each}
      </div>

      {#if derivedAddress}
        <div class="address">
          <span class="address-label">Bitcoin Address</span>
          <code>{derivedAddress}</code>
        </div>
      {/if}

      <div class="guidance">
        <strong>{guidance.title}</strong>
        <ol>
          {#each guidance.steps as step}
            <li>{step}</li>
          {/each}
        </ol>
      </div>
    {/if}

    <div class="modal-actions">
      {#if !expired}
        <button class="btn-confirm" onclick={handleConfirm} disabled={confirming}>
          {confirming ? "Confirming..." : "I wrote this down"}
        </button>
      {/if}
      <button class="btn-close" onclick={handleClose}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 300; }
  .modal { background: var(--bg-surface, #1a1a2e); border: 1px solid var(--border-strong, #2d2d5f); border-radius: 10px; padding: 32px; max-width: 520px; width: 90%; max-height: 85vh; overflow-y: auto; color: var(--text-primary, #e2e8f0); }
  .modal h2 { margin: 0 0 8px; font-size: 1.1rem; }
  .timer { color: var(--red, #f87171); font-size: 0.85rem; margin: 0 0 16px; }
  .warning { color: #facc15; font-size: 0.9rem; }
  .seed-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
  .seed-word { background: var(--bg-deep, #0d0d1a); padding: 8px 10px; border-radius: 6px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.85rem; }
  .word-num { color: var(--text-muted, #64748b); font-size: 0.7rem; margin-right: 6px; }
  .address { margin-bottom: 16px; }
  .address-label { display: block; font-size: 0.8rem; color: var(--text-muted, #64748b); margin-bottom: 4px; }
  .address code { font-size: 0.82rem; color: var(--accent, #3b82f6); word-break: break-all; }
  .guidance { font-size: 0.85rem; color: var(--text-secondary, #94a3b8); margin-bottom: 20px; }
  .guidance ol { padding-left: 18px; margin: 8px 0 0; }
  .guidance li { margin-bottom: 4px; }
  .modal-actions { display: flex; gap: 10px; }
  .btn-confirm { flex: 1; padding: 12px; background: var(--accent, #3b82f6); color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
  .btn-confirm:hover { opacity: 0.9; }
  .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-close { padding: 12px 20px; background: var(--bg-surface, #1a1a2e); color: var(--text-secondary, #94a3b8); border: 1px solid var(--border-strong, #2d2d5f); border-radius: 6px; cursor: pointer; }
  .btn-close:hover { color: var(--text-primary, #e2e8f0); }
</style>
