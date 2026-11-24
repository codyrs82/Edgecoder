<script lang="ts">
  // Settings → General → Sandbox (src/apps/ide/sandbox.ts): in Auto mode, commands Auto can't check
  // (inline scripts, project scripts) run without asking inside an OS sandbox that writes only in the
  // project and has no network. Kept by this computer's IDE server (~/.edgecoder/sandbox.json), so
  // chats, sessions and bots follow it. Off, or with no sandbox on this computer, they ask.
  import { onMount } from "svelte";
  import { getSandboxSetting, setSandboxSetting, type SandboxSettingView } from "../lib/api";

  let view = $state<SandboxSettingView | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      view = await getSandboxSetting();
    } catch (err) {
      error = (err as Error).message || "Couldn't read it from the IDE server.";
    }
  });

  async function toggle() {
    if (!view) return;
    try {
      view = await setSandboxSetting(!view.enabled);
      error = null;
    } catch (err) {
      error = (err as Error).message || "Not saved";
    }
  }
</script>

<section class="sp-group" aria-labelledby="gen-sandbox">
  <h2 class="sp-group-title" id="gen-sandbox">Sandbox</h2>
  <div class="sp-card">
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Run unchecked commands in a sandbox</span>
        <span class="sp-desc">
          In Auto mode, scripts Auto can't check (<code>python3 - &lt;&lt;'EOF'</code>, <code>node -e</code>, <code>python3 tools/x.py</code>) run without asking, inside a sandbox that can write only in the project and has no network. If the sandbox blocks one, it asks to run it outside. Off: they ask.
          {#if view && !view.available}<br />Not available here: {view.why}, so they ask.{/if}
          {#if error}<br /><span class="sp-err">{error}</span>{/if}
        </span>
      </div>
      <div class="sp-controls">
        <button class="sp-switch" role="switch" aria-checked={view?.enabled ?? true} aria-label="Run unchecked commands in a sandbox" disabled={!view} onclick={() => void toggle()}></button>
      </div>
    </div>
  </div>
</section>
