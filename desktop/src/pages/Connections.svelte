<script lang="ts">
  import { onMount } from "svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { Plus, Copy, Eye, EyeOff, RefreshCw, Trash2 } from "@lucide/svelte";
  import {
    listConnections,
    createConnection,
    updateConnection,
    deleteConnection,
    listReservations,
    computeOverview,
    computeErrorText,
    portalWebUrl,
    ideApiKey,
    IDE_API_BASE,
    type Connection,
    type ConnectionTarget,
    type ComputeOverview,
    type Reservation,
  } from "../lib/api";
  import { CLASS_LABELS, shortModel } from "../lib/compute-choice";

  interface Props {
    onNavigate?: (section: string) => void;
  }
  let { onNavigate }: Props = $props();

  let conns = $state<Connection[]>([]);
  let localModels = $state<string[]>([]);
  let networkConnected = $state(false);
  let overview = $state<ComputeOverview | null>(null);
  let leases = $state<Reservation[]>([]);
  let error = $state("");
  let loading = $state(true);
  let shownKeys = $state<Record<string, boolean>>({});
  let copied = $state("");
  let selectedId = $state<string | null>(null);
  let tool = $state("claude");
  let mainKey = $state("");

  // New connection form
  let creating = $state(false);
  let form = $state({ name: "", target: "local" as ConnectionTarget, model: "", computeClass: "any", reservationId: "", maxCSatsPerSecond: "", budgetCSats: "", port: "" });

  async function load() {
    try {
      const r = await listConnections();
      conns = r.connections;
      localModels = r.localModels;
      networkConnected = r.networkConnected;
      if (!selectedId && conns[0]) selectedId = conns[0].id;
      [overview, leases] = await Promise.all([
        computeOverview().catch(() => null),
        listReservations().then((x) => x.reservations.filter((l) => l.status === "active")).catch(() => []),
      ]);
      error = "";
    } catch (e) {
      error = computeErrorText(e);
    } finally {
      loading = false;
    }
  }
  onMount(async () => {
    await load();
    mainKey = await ideApiKey().catch(() => "");
  });

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    copied = what;
    setTimeout(() => { if (copied === what) copied = ""; }, 1500);
  }

  // Models for the chosen target
  let mineModels = $derived([...new Set((overview?.account?.machines ?? []).filter((m) => m.online).flatMap((m) => m.models))]);
  let networkModels = $derived((overview?.models ?? []).filter((m) => form.computeClass === "any" || m.classes.includes(form.computeClass)).map((m) => m.model));
  let leaseModels = $derived(leases.find((l) => l.id === form.reservationId)?.models ?? []);
  let formModels = $derived(form.target === "local" ? localModels : form.target === "mine" ? mineModels : form.target === "network" ? networkModels : leaseModels);

  function startNew(target: ConnectionTarget = "local") {
    creating = true;
    const names: Record<ConnectionTarget, string> = { auto: "Auto", local: "This computer", mine: "My machines", network: "Network", reserved: "Reserved machine" };
    form = { name: names[target], target, model: target === "auto" ? "auto" : "", computeClass: target === "network" ? "gpu" : "any", reservationId: leases[0]?.id ?? "", maxCSatsPerSecond: "", budgetCSats: "", port: "" };
  }

  async function create() {
    error = "";
    try {
      const c = await createConnection({
        name: form.name.trim(),
        target: form.target,
        model: form.model,
        ...(form.target === "network" ? { computeClass: form.computeClass } : {}),
        ...(form.target === "reserved" ? { reservationId: form.reservationId } : {}),
        ...(form.target === "network" && Number(form.maxCSatsPerSecond) > 0 ? { maxCSatsPerSecond: Number(form.maxCSatsPerSecond) } : {}),
        ...(Number(form.budgetCSats) > 0 ? { budgetCSats: Number(form.budgetCSats) } : {}),
        ...(Number(form.port) > 0 ? { port: Number(form.port) } : {}),
      });
      creating = false;
      selectedId = c.id;
      await load();
    } catch (e) {
      error = computeErrorText(e);
    }
  }

  async function patch(c: Connection, p: Parameters<typeof updateConnection>[1]) {
    try {
      await updateConnection(c.id, p);
      await load();
    } catch (e) {
      error = computeErrorText(e);
    }
  }

  async function remove(c: Connection) {
    if (!confirm(`Remove "${c.name}"? Tools using port ${c.port} stop working.`)) return;
    await deleteConnection(c.id).catch((e) => (error = computeErrorText(e)));
    if (selectedId === c.id) selectedId = null;
    await load();
  }

  function whereText(c: Pick<Connection, "target" | "computeClass" | "reservationId">) {
    if (c.target === "auto") return "Auto · cheapest place per request";
    if (c.target === "local") return "This computer · free";
    if (c.target === "mine") return "My machines · free";
    if (c.target === "reserved") return "Reserved machine · prepaid";
    return `Network ${c.computeClass && c.computeClass !== "any" ? CLASS_LABELS[c.computeClass] : "(any class)"} · cSats per second`;
  }

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 });

  /** A reserved connection whose reservation is no longer active: its requests fail. */
  const leaseEnded = (c: Connection) => c.target === "reserved" && !loading && !leases.some((l) => l.id === c.reservationId && l.endMs > Date.now());
  const mask = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

  // Setup steps for the selected connection
  let sel = $derived(conns.find((c) => c.id === selectedId) ?? conns[0]);
  let base = $derived(sel ? `http://127.0.0.1:${sel.port}` : "http://127.0.0.1:4310");
  let key = $derived(sel?.key ?? "<key>");
  let modelName = $derived(sel?.model ?? "qwen3.5:9b");
  let hostedBase = $derived(portalWebUrl(""));

  const TOOLS = [
    ["claude", "Claude Code"],
    ["cursor", "Cursor"],
    ["continue", "Continue"],
    ["cline", "Cline"],
    ["aider", "aider"],
    ["codex", "Codex CLI"],
    ["zed", "Zed"],
    ["openai", "OpenAI SDK"],
    ["curl", "curl"],
  ] as const;

  let steps = $derived.by((): { text: string; code?: string } => {
    switch (tool) {
      case "claude":
        return {
          text: "In a terminal (or add these lines to your shell profile), then run claude. The connection decides the model, so the model name Claude Code sends doesn't matter.",
          code: `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=${key}\nexport ANTHROPIC_MODEL=${modelName}\nexport ANTHROPIC_SMALL_FAST_MODEL=${modelName}\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nclaude`,
        };
      case "cursor":
        return {
          text: "Cursor calls custom models from its own servers, so it can't reach a port on this computer. Use the hosted endpoint: create an API key on the web (Settings → API keys), then in Cursor: Settings → Models → turn on OpenAI API Key, paste the key, turn on Override OpenAI Base URL, and add a custom model.",
          code: `Base URL:  ${hostedBase}/v1\nAPI key:   eck_… (from the web portal)\nModel:     network/${modelName}${sel?.target === "network" && sel.computeClass && sel.computeClass !== "any" ? `@${sel.computeClass}` : ""}\n           (or mine/${modelName} for your own machines)`,
        };
      case "continue":
        return { text: "Add to ~/.continue/config.yaml:", code: `models:\n  - name: ${sel?.name ?? "EdgeCoder"}\n    provider: openai\n    model: ${modelName}\n    apiBase: ${base}/v1\n    apiKey: ${key}\n    roles: [chat, edit, apply]` };
      case "cline":
        return { text: "In Cline's settings choose API Provider: OpenAI Compatible, then:", code: `Base URL:  ${base}/v1\nAPI Key:   ${key}\nModel ID:  ${modelName}` };
      case "aider":
        return { text: "In a terminal:", code: `export OPENAI_API_BASE=${base}/v1\nexport OPENAI_API_KEY=${key}\naider --model openai/${modelName}` };
      case "codex":
        return { text: "Add a provider to ~/.codex/config.toml, then run codex --profile edgecoder:", code: `[model_providers.edgecoder]\nname = "EdgeCoder"\nbase_url = "${base}/v1"\nenv_key = "EDGECODER_KEY"\nwire_api = "chat"\n\n[profiles.edgecoder]\nmodel_provider = "edgecoder"\nmodel = "${modelName}"\n\n# then: export EDGECODER_KEY=${key}` };
      case "zed":
        return { text: "In Zed's settings.json (Zed asks for the key once):", code: `"language_models": {\n  "openai_compatible": {\n    "${sel?.name ?? "EdgeCoder"}": {\n      "api_url": "${base}/v1",\n      "available_models": [{ "name": "${modelName}", "max_tokens": 32768 }]\n    }\n  }\n}\n// API key: ${key}` };
      case "openai":
        return { text: "Python:", code: `from openai import OpenAI\nclient = OpenAI(base_url="${base}/v1", api_key="${key}")\nfor chunk in client.chat.completions.create(\n    model="${modelName}", stream=True,\n    messages=[{"role": "user", "content": "Write a quicksort in Python"}],\n):\n    print(chunk.choices[0].delta.content or "", end="")` };
      default:
        return { text: "Check it works:", code: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"model": "${modelName}", "stream": true, "messages": [{"role": "user", "content": "hello"}]}'` };
    }
  });
</script>

<div class="sp">
  <h1>Connect your tools</h1>
  <p class="sp-lead">Each connection is an address on this computer that Claude Code, Continue, Cline, aider, Zed or anything OpenAI- or Anthropic-compatible can use. Point different tools at different connections to run them on different compute at the same time.</p>

  {#if error}<p class="sp-err">{error}</p>{/if}

  <div class="sp-group">
    <div class="sp-group-title">Connections <button class="small sp-link" onclick={() => startNew()}><Plus size={13} /> New connection</button></div>
    <div class="sp-card">
      {#if loading}
        <div class="sp-row"><span class="sp-muted">Loading…</span></div>
      {:else if conns.length === 0 && !creating}
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">No connections yet</span><span class="sp-desc">Start with one of these; you can add more any time.</span></div>
          <div class="sp-controls">
            <button class="primary" onclick={() => startNew("auto")}>Auto</button>
            <button onclick={() => startNew("local")}>This computer</button>
            <button onclick={() => startNew("mine")} disabled={!networkConnected}>My machines</button>
            <button onclick={() => startNew("network")} disabled={!networkConnected}>Network GPU</button>
          </div>
        </div>
      {/if}
      {#each conns as c (c.id)}
        <div class="sp-row conn" class:selected={sel?.id === c.id}>
          <button class="sp-switch" role="switch" aria-checked={c.enabled} aria-label="{c.enabled ? 'Turn off' : 'Turn on'} {c.name}" onclick={() => patch(c, { enabled: !c.enabled })}></button>
          <button class="conn-main" onclick={() => (selectedId = c.id)} title="Show setup steps for this connection">
            <span class="sp-title">{c.name} <span class="sp-pill">{shortModel(c.model)}</span></span>
            <span class="sp-desc">
              <span class="sp-dot" class:on={c.listening} class:err={!!c.error}></span>
              {c.error ? c.error : c.enabled ? (c.listening ? c.url : "Starting…") : "Off"} · {whereText(c)}{#if c.target === "network" || c.target === "auto"} · spent {fmt(c.spentCSats)}{c.budgetCSats ? ` of ${fmt(c.budgetCSats)}` : ""} cSats{/if}
            </span>
          </button>
          <div class="sp-controls">
            <button class="small" onclick={() => copy(c.url, `url-${c.id}`)}><Copy size={12} /> {copied === `url-${c.id}` ? "Copied" : "Address"}</button>
            <button class="small" onclick={() => copy(c.key, `key-${c.id}`)}><Copy size={12} /> {copied === `key-${c.id}` ? "Copied" : "Key"}</button>
            <button class="ghost small" title={shownKeys[c.id] ? "Hide key" : "Show key"} aria-label="Show key" onclick={() => (shownKeys[c.id] = !shownKeys[c.id])}>{#if shownKeys[c.id]}<EyeOff size={13} />{:else}<Eye size={13} />{/if}</button>
            <button class="ghost small" title="New key (tools using the old one stop working)" aria-label="New key" onclick={() => confirm("Make a new key? Tools using the old key stop working.") && patch(c, { rotateKey: true })}><RefreshCw size={13} /></button>
            <button class="ghost small danger" title="Remove" aria-label="Remove {c.name}" onclick={() => remove(c)}><Trash2 size={13} /></button>
          </div>
        </div>
        {#if shownKeys[c.id]}<div class="sp-row"><code>{c.key}</code></div>{/if}
        {#if leaseEnded(c)}
          <div class="sp-row warn-row">
            <div class="sp-text">
              <span class="sp-title sp-warn">Its reservation has ended</span>
              <span class="sp-desc">Tools using "{c.name}" get an error until you point it somewhere else. Auto keeps the same address and key.</span>
            </div>
            <div class="sp-controls">
              <button class="primary small" onclick={() => patch(c, { target: "auto", model: "auto" })}>Switch to Auto</button>
              <button class="small" onclick={() => onNavigate?.("compute")}>Reserve again</button>
            </div>
          </div>
        {/if}
      {/each}

      {#if creating}
        <div class="sp-row stack new">
          <div class="form-grid">
            <label for="cn-name">Name</label>
            <input id="cn-name" type="text" bind:value={form.name} maxlength="80" />

            <span>Runs on</span>
            <div class="sp-seg">
              {#each [["auto", "Auto"], ["local", "This computer"], ["mine", "My machines"], ["network", "Network"], ["reserved", "Reserved"]] as [t, label]}
                <button class:active={form.target === t} disabled={t !== "local" && t !== "auto" && !networkConnected} onclick={() => { form.target = t as ConnectionTarget; form.model = t === "auto" ? "auto" : ""; }}>{label}</button>
              {/each}
            </div>

            {#if form.target === "network"}
              <span>Class</span>
              <div class="sp-seg">
                {#each ["any", "cpu", "apple", "gpu", "gpu.dc"] as k}
                  <button class:active={form.computeClass === k} onclick={() => { form.computeClass = k; form.model = ""; }}>{CLASS_LABELS[k]}</button>
                {/each}
              </div>
              <label for="cn-max">Max price</label>
              <span class="inline"><input id="cn-max" type="number" min="0" step="0.001" placeholder="no limit" bind:value={form.maxCSatsPerSecond} style="width:110px" /> <span class="sp-muted">cSats/s on the base tier</span></span>
            {/if}

            {#if form.target === "reserved"}
              <label for="cn-res">Reservation</label>
              {#if leases.length}
                <select id="cn-res" bind:value={form.reservationId}>
                  {#each leases as l}<option value={l.id}>{CLASS_LABELS[l.computeClass]} until {new Date(l.endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</option>{/each}
                </select>
              {:else}
                <span class="sp-muted">No active reservations. <button class="small" onclick={() => onNavigate?.("compute")}>Reserve a machine</button></span>
              {/if}
            {/if}

            {#if form.target === "auto"}
              <span>Model</span>
              <span class="sp-muted">Chosen per request: the cheapest place and smallest model that fits (your free machines first, network GPUs for heavy work).</span>
            {:else}
              <label for="cn-model">Model</label>
              <select id="cn-model" bind:value={form.model}>
                <option value="" disabled>Choose a model</option>
                {#each formModels as m}<option value={m}>{m}</option>{/each}
              </select>
            {/if}

            {#if form.target !== "local" && form.target !== "mine"}
              <label for="cn-budget">Budget</label>
              <span class="inline"><input id="cn-budget" type="number" min="0" step="1" placeholder="no limit" bind:value={form.budgetCSats} style="width:110px" /> <span class="sp-muted">cSats, then it stops</span></span>
            {/if}

            <label for="cn-port">Port</label>
            <input id="cn-port" type="number" min="1024" max="65535" placeholder="automatic" bind:value={form.port} style="width:110px" />
          </div>
          <div class="sp-controls">
            <button class="ghost" onclick={() => (creating = false)}>Cancel</button>
            <button class="primary" disabled={!form.name.trim() || !form.model} onclick={create}>Create connection</button>
          </div>
        </div>
      {/if}
    </div>
    <p class="sp-muted">Need more compute? <button class="ghost small" onclick={() => onNavigate?.("compute")}>Reserve a machine</button> or <button class="ghost small" onclick={() => onNavigate?.("plan")}>buy cSats</button>.</p>
  </div>

  <div class="sp-group">
    <div class="sp-group-title">Set up a tool{sel ? ` with "${sel.name}"` : ""}</div>
    <div class="sp-card">
      <div class="sp-row stack">
        <div class="sp-seg tools">
          {#each TOOLS as [id, label]}
            <button class:active={tool === id} onclick={() => (tool = id)}>{label}</button>
          {/each}
        </div>
        <span class="sp-desc">{steps.text}</span>
        {#if steps.code}
          <div class="code-wrap">
            <pre class="sp-code">{steps.code}</pre>
            <button class="small copy" onclick={() => copy(steps.code ?? "", "steps")}>{copied === "steps" ? "Copied" : "Copy"}</button>
          </div>
        {/if}
        {#if tool === "cursor"}
          <div class="sp-controls" style="justify-content:flex-start"><button onclick={() => openUrl(portalWebUrl("/portal/settings"))}>Create an API key on the web ↗</button></div>
        {:else if !sel}
          <span class="sp-muted">Create a connection first; the steps fill in its address and key.</span>
        {/if}
      </div>
    </div>
  </div>

  <div class="sp-group">
    <div class="sp-group-title">Other ways in</div>
    <div class="sp-card">
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">All models on one address</span>
          <span class="sp-desc">{IDE_API_BASE} with this computer's key: pick per request with the model name: a local model, <code>mine/&lt;model&gt;</code>, <code>network/&lt;model&gt;@gpu</code> or <code>reserved/&lt;id&gt;/&lt;model&gt;</code>.</span>
        </div>
        <div class="sp-controls">
          <button class="small" onclick={() => copy(IDE_API_BASE, "main-url")}>{copied === "main-url" ? "Copied" : "Address"}</button>
          <button class="small" disabled={!mainKey} onclick={() => copy(mainKey, "main-key")}>{copied === "main-key" ? "Copied" : "Key"}</button>
        </div>
      </div>
      <div class="sp-row">
        <div class="sp-text">
          <span class="sp-title">Hosted endpoint</span>
          <span class="sp-desc">{hostedBase}/v1 with an API key from the web portal: for Cursor, servers, and computers without this app. Runs on the network and your machines, paid from your cSats.</span>
        </div>
        <button onclick={() => openUrl(portalWebUrl("/portal/settings"))}>API keys ↗</button>
      </div>
    </div>
  </div>
</div>

<style>
  .conn.selected { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .warn-row { background: color-mix(in srgb, var(--warning, #d29922) 8%, transparent); }
  .conn-main {
    flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    border: none !important; background: none !important; padding: 0 !important; text-align: left; white-space: normal !important;
  }
  .conn-main .sp-desc { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .form-grid { display: grid; grid-template-columns: 110px 1fr; gap: 10px 14px; align-items: center; font-size: 13px; color: var(--text-secondary); }
  .form-grid .inline { display: flex; align-items: center; gap: 8px; }
  .new { gap: 14px; }
  .tools { align-self: flex-start; }
  .code-wrap { position: relative; }
  .code-wrap .copy { position: absolute; top: 6px; right: 6px; }
</style>
