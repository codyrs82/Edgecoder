<script lang="ts">
  // Settings → Frontier models (your keys): add, test and remove your own API keys for Anthropic or
  // an OpenAI-compatible provider, pick the default lead, the worker and the spend caps
  // (docs/frontier-keys.md). Everything goes to the provider on this computer (:4304), which keeps
  // the key in the OS keychain, bound to your account; the key is never shown again after saving.
  import { addFrontierKey, getFrontierStatus, getMe, removeFrontierKey, testFrontierKey, updateFrontierSettings, type FrontierStatusView } from "../lib/api";
  import { formatUsd, frontierName } from "../lib/compute-choice";

  let status = $state<FrontierStatusView | null>(null);
  let loadError = $state("");
  let email = $state<string | null>(null);

  // Add form
  let provider = $state<"anthropic" | "openai" | "other">("anthropic");
  let otherName = $state("");
  let baseUrl = $state("");
  let key = $state("");
  let adding = $state(false);
  let addMsg = $state<{ ok: boolean; text: string } | null>(null);
  let rowMsg = $state<Record<string, { ok: boolean; text: string }>>({});

  // Settings drafts
  let lead = $state("");
  let worker = $state("auto");
  let sessionCap = $state<string | number | null>("");
  let dailyCap = $state<string | number | null>("");
  let useForAuto = $state(false);
  let settingsMsg = $state<{ ok: boolean; text: string } | null>(null);

  const providerLabel = (id: string) => (id === "anthropic" ? "Anthropic" : id === "openai" ? "OpenAI" : id);
  let providerId = $derived(provider === "other" ? otherName.trim().toLowerCase() : provider);
  let providerName = $derived(providerLabel(providerId || "your provider"));

  async function load() {
    try {
      const s = await getFrontierStatus();
      status = s;
      loadError = "";
      lead = s.settings.defaultLead;
      worker = s.settings.workerModel;
      sessionCap = s.settings.sessionCapUsd === null ? "" : String(s.settings.sessionCapUsd);
      dailyCap = s.settings.dailyCapUsd === null ? "" : String(s.settings.dailyCapUsd);
      useForAuto = s.settings.useForAuto;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't reach EdgeCoder on this computer.";
    }
  }

  $effect(() => {
    void load();
    getMe()
      .then((u) => (email = u.email))
      .catch(() => (email = null));
  });

  async function add() {
    if (!providerId || !key.trim()) return;
    adding = true;
    addMsg = null;
    try {
      const r = await addFrontierKey({ id: providerId, key: key.trim(), ...(provider === "other" ? { kind: "openai-compatible" as const, baseUrl: baseUrl.trim() } : {}) });
      addMsg = { ok: true, text: `Saved and tested.${r.models.length ? ` ${r.models.length} models available.` : ""}` };
      key = "";
      await load();
    } catch (e) {
      addMsg = { ok: false, text: e instanceof Error ? e.message : "Couldn't save the key." };
    } finally {
      adding = false;
    }
  }

  async function test(id: string) {
    rowMsg = { ...rowMsg, [id]: { ok: true, text: "Testing…" } };
    try {
      const r = await testFrontierKey(id);
      rowMsg = { ...rowMsg, [id]: { ok: true, text: `Works${r.models.length ? `: ${r.models.slice(0, 4).join(", ")}${r.models.length > 4 ? "…" : ""}` : ""}` } };
    } catch (e) {
      rowMsg = { ...rowMsg, [id]: { ok: false, text: e instanceof Error ? e.message : "The test failed." } };
    }
  }

  async function remove(id: string, owner: string, mine: boolean) {
    try {
      await removeFrontierKey(id, mine ? undefined : owner);
      await load();
    } catch (e) {
      rowMsg = { ...rowMsg, [id]: { ok: false, text: e instanceof Error ? e.message : "Couldn't remove it." } };
    }
  }

  function capValue(v: string | number | null): number | null {
    const t = String(v ?? "").trim().replace(/^\$/, "");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) throw new Error("Caps are dollar amounts (leave empty for no cap).");
    return n;
  }

  async function saveSettings() {
    settingsMsg = null;
    try {
      const r = await updateFrontierSettings({ defaultLead: lead, workerModel: worker.trim() || "auto", sessionCapUsd: capValue(sessionCap), dailyCapUsd: capValue(dailyCap), useForAuto });
      if (status) status = { ...status, settings: r.settings };
      settingsMsg = { ok: true, text: "Saved" };
    } catch (e) {
      settingsMsg = { ok: false, text: e instanceof Error ? e.message : "Not saved" };
    }
  }
</script>

<section class="sp-group" aria-labelledby="gen-frontier">
  <h2 class="sp-group-title" id="gen-frontier">Frontier models (your keys)</h2>
  <div class="sp-card">
    <div class="sp-row stack">
      <div class="sp-text">
        <span class="sp-title">Lead with a frontier model on your own API key</span>
        <span class="sp-desc">
          Add a key for Anthropic or any OpenAI-compatible provider and pick it as the lead in the model picker. The lead plans and drives the agent; helpers and delegated work stay on the worker model.
        </span>
        <span class="sp-desc" data-testid="frontier-account-rule">
          Usable only by your account{email ? ` (${email})` : ""} on this computer. Never used for other people's requests or for network work.
        </span>
      </div>
    </div>

    {#if loadError}
      <div class="sp-row"><p class="sp-err" role="alert">{loadError}</p></div>
    {:else if status}
      {#if !status.account}
        <div class="sp-row"><p class="sp-err" role="status">Sign in to EdgeCoder on this computer to add or use keys: each key is bound to your account.</p></div>
      {/if}
      {#if status.fallbackFile}
        <div class="sp-row"><p class="sp-desc" role="status">No keychain was found, so keys are kept in {status.storage}.</p></div>
      {/if}

      {#each status.providers as p (p.accountId + p.id)}
        {@const mine = p.usable}
        <div class="sp-row">
          <div class="sp-text">
            <span class="sp-title">{providerLabel(p.id)}{p.baseUrl ? ` · ${p.baseUrl}` : ""}</span>
            <span class="sp-desc">
              {#if mine}Key saved in {p.storage === "keychain" ? "your keychain" : "a private file"} · usable{:else}{p.reason ?? "Not usable here"}{/if}
            </span>
            {#if rowMsg[p.id]}<span class={rowMsg[p.id].ok ? "sp-ok" : "sp-err"}>{rowMsg[p.id].text}</span>{/if}
          </div>
          <div class="sp-controls">
            {#if mine}<button onclick={() => void test(p.id)}>Test</button>{/if}
            <button onclick={() => void remove(p.id, p.accountId, mine)} aria-label="Remove the {providerLabel(p.id)} key{mine ? '' : ' (another account)'}">Remove</button>
          </div>
        </div>
      {/each}

      <div class="sp-row stack">
        <div class="sp-text">
          <span class="sp-title">Add a key</span>
          <span class="sp-desc">Your key stays on this computer. Calls go straight to {providerName} and are billed by them.</span>
        </div>
        <div class="sp-inline">
          <select aria-label="Provider" bind:value={provider}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="other">Other (OpenAI-compatible)</option>
          </select>
          {#if provider === "other"}
            <input type="text" aria-label="Provider name" placeholder="openrouter" bind:value={otherName} />
            <input type="text" class="grow" aria-label="Base URL" placeholder="https://openrouter.ai/api/v1" bind:value={baseUrl} />
          {/if}
          <input type="password" class="grow" aria-label="API key" autocomplete="off" spellcheck="false" placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"} bind:value={key} />
          <button class="primary" onclick={() => void add()} disabled={adding || !key.trim() || !providerId || !status.account}>{adding ? "Testing…" : "Test and save"}</button>
        </div>
        {#if addMsg}<span class={addMsg.ok ? "sp-ok" : "sp-err"} role="status">{addMsg.text}</span>{/if}
      </div>

      <div class="sp-row stack">
        <div class="sp-text">
          <span class="sp-title">Default lead and worker</span>
          <span class="sp-desc">The lead runs the agent loop; the worker runs summaries, compaction and delegated work (Auto keeps those on the network or this computer).</span>
        </div>
        <div class="sp-inline">
          <select aria-label="Default lead" bind:value={lead}>
            {#each status.models.length ? status.models : [lead] as id (id)}
              <option value={id}>Lead: {frontierName(id)} · your key</option>
            {/each}
          </select>
          <input type="text" aria-label="Worker model" bind:value={worker} placeholder="auto" />
        </div>
      </div>

      <div class="sp-row stack">
        <div class="sp-text">
          <span class="sp-title">Spend caps</span>
          <span class="sp-desc">Estimated from tokens and the price table. A warning at 80%; at 100% frontier calls stop until you raise the cap. Today: {formatUsd(status.spend.today)} · last 30 days: {formatUsd(status.spend.last30Days)}.</span>
        </div>
        <div class="sp-inline">
          <label>Per session $ <input type="number" min="0" step="0.5" aria-label="Session cap (USD)" bind:value={sessionCap} /></label>
          <label>Per day $ <input type="number" min="0" step="1" aria-label="Daily cap (USD)" bind:value={dailyCap} /></label>
        </div>
      </div>

      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Use my frontier key for Auto</span>
          <span class="sp-desc">Off by default. When on, Auto may send high-complexity jobs to your default lead.</span>
        </div>
        <div class="sp-controls"><input type="checkbox" aria-label="Use my frontier key for Auto" bind:checked={useForAuto} /></div>
      </div>

      <div class="sp-row">
        <div class="sp-text"><span class="sp-desc">Pooling, sharing or reselling keys isn't supported: provider terms tie a key to its owner.</span></div>
        <div class="sp-controls">
          <button class="primary" onclick={() => void saveSettings()}>Save settings</button>
          {#if settingsMsg}<span class={settingsMsg.ok ? "sp-ok" : "sp-err"} role="status">{settingsMsg.text}</span>{/if}
        </div>
      </div>
    {:else}
      <div class="sp-row"><span class="sp-desc" role="status">Loading…</span></div>
    {/if}
  </div>
</section>
