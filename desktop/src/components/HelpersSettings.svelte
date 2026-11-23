<script lang="ts">
  // Settings → General → Helpers: what new Code chats start with (docs/tentacles.md). Each chat
  // keeps its own; change it with the Helpers button under the message box.
  import Select from "./ui/Select.svelte";
  import { helpersDefaults, setHelpersDefaults, type HelpersDefaults } from "../lib/helpers";

  let d = $state<HelpersDefaults>(helpersDefaults());
  const WHEN: Array<{ value: HelpersDefaults["when"]; label: string }> = [
    { value: "frontier", label: "With your frontier key" },
    { value: "always", label: "Always" },
    { value: "never", label: "Off" },
  ];

  function save(patch: Partial<HelpersDefaults>) {
    d = setHelpersDefaults(patch);
  }
  const num = (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).value;
    const n = Number(v);
    return v !== "" && Number.isFinite(n) ? n : null;
  };
</script>

<section class="sp-group" aria-labelledby="gen-helpers">
  <h2 class="sp-group-title" id="gen-helpers">Helpers</h2>
  <div class="sp-card">
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Turn helpers on for new chats</span>
        <span class="sp-desc">
          In Code chats the lead hands well-specified pieces to helper agents: easy ones on this computer's model first (free), medium ones on the network.
          Helpers never use your frontier key. "With your frontier key" turns them on when the chat's model is your own Claude (or other) key.
        </span>
      </div>
      <div class="sp-controls">
        <Select ariaLabel="Turn helpers on for new chats" value={d.when} onChange={(v) => save({ when: v })} options={WHEN} />
      </div>
    </div>
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Helpers at once</span>
        <span class="sp-desc">How many run in parallel in one chat; more wait their turn.</span>
      </div>
      <div class="sp-controls">
        <input type="number" class="num" aria-label="Helpers at once" min="1" max="16" value={d.maxParallel} onchange={(e) => { const n = num(e); if (n !== null) save({ maxParallel: n }); }} />
      </div>
    </div>
    <div class="sp-row">
      <div class="sp-text">
        <span class="sp-title">Helper budget per chat</span>
        <span class="sp-desc">cSats all of a chat's helpers may spend. Helpers on this computer are free.</span>
      </div>
      <div class="sp-controls">
        <input type="number" class="num" aria-label="Helper budget per chat in cSats" min="0" step="10" value={d.budgetCSats} onchange={(e) => { const n = num(e); if (n !== null) save({ budgetCSats: n }); }} />
      </div>
    </div>
  </div>
</section>

<style>
  .num { width: 72px; }
</style>
