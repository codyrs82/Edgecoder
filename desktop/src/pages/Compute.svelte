<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import { computeOverview, computeBuy, computeIntent, ideApiKey, IDE_API_BASE, type ComputeOverview } from "../lib/api";

  let data = $state<ComputeOverview | null>(null);
  let error = $state("");
  let loading = $state(true);
  let apiKey = $state("");
  let showKey = $state(false);
  let copied = $state<string | null>(null);

  // Buying cSats
  let buyAmount = $state(5000);
  let buying = $state(false);
  let purchase = $state<{ intentId: string; invoice: string; amountSats: number; cSats: number; feeSats: number; network: string } | null>(null);
  let purchaseStatus = $state<string>("");
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  let tool = $state<"continue" | "aider" | "zed" | "openai" | "curl">("continue");

  async function load() {
    try {
      data = await computeOverview();
      error = "";
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await load();
    apiKey = await ideApiKey();
  });
  onDestroy(() => clearInterval(pollTimer));

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => { if (copied === what) copied = null; }, 1500);
    } catch {
      error = "Couldn't copy to the clipboard.";
    }
  }

  async function buy() {
    buying = true;
    error = "";
    try {
      purchase = await computeBuy(buyAmount);
      purchaseStatus = "waiting";
      clearInterval(pollTimer);
      pollTimer = setInterval(checkPurchase, 3000);
    } catch (e) {
      error = `Couldn't create the invoice: ${(e as Error).message}`;
    } finally {
      buying = false;
    }
  }

  async function checkPurchase() {
    if (!purchase) return;
    try {
      const s = await computeIntent(purchase.intentId);
      purchaseStatus = s.status;
      if (s.status !== "created") {
        clearInterval(pollTimer);
        await load();
      }
    } catch {
      // keep polling
    }
  }

  const fmt = (n: number, digits = 3) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
  const perHour = (perSecond: number) => perSecond * 3600;

  let firstModel = $derived(data?.models?.[0]?.model ?? "qwen2.5-coder:32b");
  let modelId = $derived(`network/${firstModel}`);
  let keyShown = $derived(showKey ? apiKey : apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : "");

  let snippet = $derived(
    tool === "continue"
      ? `# ~/.continue/config.yaml\nmodels:\n  - name: EdgeCoder network\n    provider: openai\n    model: ${modelId}\n    apiBase: ${IDE_API_BASE}\n    apiKey: ${apiKey || "<key>"}`
      : tool === "aider"
        ? `export OPENAI_API_BASE=${IDE_API_BASE}\nexport OPENAI_API_KEY=${apiKey || "<key>"}\naider --model openai/${modelId}`
        : tool === "zed"
          ? `// Zed settings.json\n"language_models": {\n  "openai_compatible": {\n    "EdgeCoder": {\n      "api_url": "${IDE_API_BASE}",\n      "available_models": [{ "name": "${modelId}", "max_tokens": 32768 }]\n    }\n  }\n}\n// API key: ${apiKey || "<key>"} (Zed asks for it once)`
          : tool === "openai"
            ? `from openai import OpenAI\nclient = OpenAI(base_url="${IDE_API_BASE}", api_key="${apiKey || "<key>"}")\nstream = client.chat.completions.create(\n    model="${modelId}",\n    messages=[{"role": "user", "content": "Write a quicksort in Python"}],\n    stream=True,\n)\nfor chunk in stream:\n    print(chunk.choices[0].delta.content or "", end="")`
            : `curl ${IDE_API_BASE}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey || "<key>"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${modelId}", "stream": true, "messages": [{"role": "user", "content": "hello"}]}'`,
  );
</script>

<div class="compute">
  <h2>Compute</h2>
  <p class="lead">Buy cSats with Lightning (1 cSat = 1 sat) and use them to run models on machines across the EdgeCoder network, from this app or from your own tools. You pay per second of work, at the rate of the hardware that ran it; unused set-asides come back.</p>

  {#if error}<ErrorBanner message={error} onRetry={load} />{/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if !data?.connected}
    <div class="card">
      <h3>Not connected to the network</h3>
      <p class="muted">{data?.reason === "not_enrolled" ? "Sign in so this computer joins the network; then you can buy and use compute here." : "This computer's agent isn't reaching the network right now. It reconnects on its own; check back in a minute."}</p>
    </div>
  {:else}
    <div class="grid">
      <div class="card">
        <h3>Balance</h3>
        <div class="big">{fmt(data.account?.cSats ?? 0)} <span class="unit">cSats</span></div>
        <p class="muted">Your machines have earned {fmt(data.account?.earnedSats ?? 0, 0)} sats contributing compute.</p>
      </div>

      <div class="card">
        <h3>Buy cSats</h3>
        {#if !purchase || purchaseStatus === "settled" || purchaseStatus === "expired"}
          <div class="row">
            <input type="number" min="100" max="1000000" step="100" bind:value={buyAmount} aria-label="Amount in sats" />
            <span class="muted">sats</span>
            <button class="primary" disabled={buying || buyAmount < 100} onclick={buy}>{buying ? "Creating invoice…" : "Get invoice"}</button>
          </div>
          {#if purchaseStatus === "settled"}<p class="ok">Paid. {fmt(purchase?.cSats ?? 0)} cSats added.</p>{/if}
          {#if purchaseStatus === "expired"}<p class="muted">That invoice expired. Get a new one.</p>{/if}
        {:else}
          <p>Pay this Lightning invoice ({fmt(purchase.amountSats, 0)} sats; you get {fmt(purchase.cSats)} cSats after a {fmt(purchase.feeSats, 0)} sat fee){purchase.network !== "bitcoin" ? ` · ${purchase.network} test network` : ""}:</p>
          <code class="invoice">{purchase.invoice}</code>
          <div class="row">
            <a class="button primary" href={`lightning:${purchase.invoice}`}>Open in wallet</a>
            <button onclick={() => copy(purchase!.invoice, "invoice")}>{copied === "invoice" ? "Copied" : "Copy invoice"}</button>
            <span class="muted">Waiting for payment…</span>
          </div>
        {/if}
      </div>
    </div>

    <div class="card">
      <h3>Prices per hardware class</h3>
      <p class="muted">The rate for each class's base tier. Faster tiers cost more per second and finish sooner; a job is charged for the seconds it actually ran.</p>
      <table>
        <thead><tr><th>Class</th><th>cSats / second</th><th>cSats / hour</th><th>Network id</th></tr></thead>
        <tbody>
          {#each Object.entries(data.classes ?? {}) as [id, c] (id)}
            <tr><td>{c.label}</td><td>{fmt(c.cSatsPerSecondBaseTier)}</td><td>{fmt(perHour(c.cSatsPerSecondBaseTier), 0)}</td><td><code>@{id}</code></td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Models on the network</h3>
      {#if (data.models ?? []).length === 0}
        <p class="muted">No machines are offering models right now.</p>
      {:else}
        <table>
          <thead><tr><th>Model</th><th>Machines</th><th>Classes</th><th></th></tr></thead>
          <tbody>
            {#each data.models ?? [] as m (m.model)}
              <tr>
                <td><code>network/{m.model}</code></td>
                <td>{m.agents}</td>
                <td>{m.classes.join(", ")}</td>
                <td><button class="small" onclick={() => copy(`network/${m.model}`, m.model)}>{copied === m.model ? "Copied" : "Copy id"}</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="muted">Add <code>@gpu</code>, <code>@apple</code>, <code>@gpu.dc</code> or <code>@cpu</code> to a model id to choose the hardware class; without it, any machine with the model can run it.</p>
      {/if}
    </div>

    <div class="card">
      <h3>Use from your tools</h3>
      <p class="muted">Any tool that takes an OpenAI-compatible address can use these models while this app is running. Requests go through this computer's agent and are billed to your account.</p>
      <div class="kv">
        <span>Address</span><code>{IDE_API_BASE}</code><button class="small" onclick={() => copy(IDE_API_BASE, "base")}>{copied === "base" ? "Copied" : "Copy"}</button>
        <span>Key</span><code>{keyShown}</code>
        <span class="row-inline">
          <button class="small" onclick={() => (showKey = !showKey)}>{showKey ? "Hide" : "Show"}</button>
          <button class="small" onclick={() => copy(apiKey, "key")}>{copied === "key" ? "Copied" : "Copy"}</button>
        </span>
      </div>
      <div class="tabs" role="tablist">
        {#each [["continue", "Continue"], ["aider", "aider"], ["zed", "Zed"], ["openai", "OpenAI SDK"], ["curl", "curl"]] as [id, label] (id)}
          <button role="tab" aria-selected={tool === id} class:active={tool === id} onclick={() => (tool = id as typeof tool)}>{label}</button>
        {/each}
      </div>
      <div class="snippet">
        <pre>{snippet}</pre>
        <button class="small copy" onclick={() => copy(snippet, "snippet")}>{copied === "snippet" ? "Copied" : "Copy"}</button>
      </div>
      <p class="muted note">Cursor sends custom-model requests through its own servers, which can't reach this computer, and Claude Code speaks Anthropic's format rather than OpenAI's. Both need the hosted endpoint with API keys, which is next on the list.</p>
    </div>

    {#if (data.account?.recent ?? []).length}
      <div class="card">
        <h3>Recent activity</h3>
        <table>
          <tbody>
            {#each data.account?.recent ?? [] as r (r.atMs + r.reason)}
              <tr>
                <td class="muted">{new Date(r.atMs).toLocaleString()}</td>
                <td>{r.reason.replace(/_/g, " ").replace(/:.*/, "")}</td>
                <td class:earn={r.type === "earn"} class="amount">{r.type === "earn" ? "+" : "−"}{fmt(Math.abs(r.cSats))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .compute {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 900px;
  }
  h2 {
    margin: 0;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .lead,
  .muted {
    color: var(--text-muted);
    font-size: 13px;
    margin: 4px 0;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
  }
  .card {
    border: 0.5px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    padding: 14px 16px;
    min-width: 0;
  }
  .big {
    font-size: 28px;
    font-weight: 600;
  }
  .unit {
    font-size: 14px;
    color: var(--text-muted);
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .row-inline {
    display: flex;
    gap: 4px;
  }
  input[type="number"] {
    width: 120px;
    padding: 5px 8px;
    background: var(--bg-base);
    color: var(--text-primary);
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
  }
  button,
  .button {
    padding: 5px 12px;
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 13px;
    text-decoration: none;
  }
  button.small {
    padding: 2px 8px;
    font-size: 12px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-base);
    font-weight: 600;
  }
  .ok {
    color: var(--success, #3fb950);
    font-size: 13px;
  }
  .invoice {
    display: block;
    word-break: break-all;
    font-size: 11px;
    padding: 8px;
    background: var(--bg-base);
    border-radius: var(--radius-sm);
    max-height: 90px;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th,
  td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 0.5px solid var(--border);
  }
  th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 12px;
  }
  td.amount {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  td.earn {
    color: var(--success, #3fb950);
  }
  .kv {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 6px 10px;
    align-items: center;
    margin: 8px 0 12px;
    font-size: 13px;
  }
  .kv code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 6px;
  }
  .tabs button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .snippet {
    position: relative;
  }
  .snippet pre {
    margin: 0;
    padding: 10px 12px;
    background: var(--bg-base);
    border-radius: var(--radius-sm);
    font-size: 12px;
    overflow-x: auto;
    white-space: pre;
  }
  .snippet .copy {
    position: absolute;
    top: 6px;
    right: 6px;
  }
  .note {
    margin-top: 10px;
  }
</style>
