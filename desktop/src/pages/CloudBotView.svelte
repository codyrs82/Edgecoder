<script lang="ts">
  // A cloud bot (it runs on EdgeCoder's servers, docs/cloud-bots.md): its conversation and a
  // composer. Read and message only here; its settings are on the web and in the iOS app.
  import { onDestroy } from "svelte";
  import BotAvatar from "../components/BotAvatar.svelte";
  import MarkdownRenderer from "../components/MarkdownRenderer.svelte";
  import { getCloudBot, messageCloudBot, type CloudBotSummary, type CloudBotMessage } from "../lib/api";
  import { refreshCloudBots } from "../lib/bots-store";

  interface Props {
    bot: CloudBotSummary;
  }
  let { bot }: Props = $props();

  let detail = $state<CloudBotSummary | null>(null);
  let draft = $state("");
  let sending = $state(false);
  let error = $state<string | null>(null);
  let local = $state<CloudBotMessage[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  const shown = $derived(detail ?? bot);
  const messages = $derived([...(detail?.tail ?? []), ...local.filter((m) => !(detail?.tail ?? []).some((t) => t.role === "user" && t.content === m.content))]);
  const working = $derived(shown.status === "running");

  async function load(id: string) {
    try {
      const d = await getCloudBot(id);
      if (id !== bot.id || !alive) return;
      detail = d;
      error = null;
    } catch (err) {
      error = (err as Error).message;
    }
  }
  function schedule(id: string) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await load(id);
      if (alive && id === bot.id) schedule(id);
    }, working || local.length ? 2_500 : 8_000);
  }
  $effect(() => {
    const id = bot.id;
    detail = null;
    local = [];
    void load(id).then(() => schedule(id));
  });
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    draft = "";
    local = [...local, { id: `local-${Date.now()}`, role: "user", content: text, atMs: Date.now() }];
    try {
      await messageCloudBot(bot.id, text);
      await load(bot.id);
      void refreshCloudBots();
    } catch (err) {
      error = (err as Error).message;
      draft = text;
      local = local.filter((m) => m.content !== text);
    }
    sending = false;
  }
  function when(ms: number) {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
</script>

<section class="cloud-bot" aria-label="{shown.name}, a cloud bot">
  <header class="cb-head">
    <BotAvatar name={shown.name} color={shown.color} status={working ? "running" : shown.status === "error" ? "error" : "idle"} size={32} decorative />
    <div class="cb-who">
      <h2>{shown.name}{#if shown.role}<span class="cb-role"> · {shown.role}</span>{/if}</h2>
      <p class="cb-sub"><span class="cb-chip">Cloud</span> Runs on EdgeCoder's servers{shown.repository ? ` · ${shown.repository}` : ""}{working ? ` · ${shown.activity ?? "Working…"}` : shown.enabled ? "" : " · Paused"}</p>
    </div>
  </header>
  <div class="cb-thread" aria-live="polite">
    {#if messages.length === 0}
      <p class="cb-empty">No messages yet. Message {shown.name} to get it started.</p>
    {/if}
    {#each messages as m (m.id)}
      {#if m.role === "event"}
        <p class="cb-event">{m.content} · {when(m.atMs)}</p>
      {:else}
        <article class="cb-msg" class:user={m.role === "user"}>
          <div class="cb-msg-head"><span class="cb-msg-who">{m.role === "user" ? "You" : shown.name}</span> <time>{when(m.atMs)}</time></div>
          <MarkdownRenderer source={m.content} />
        </article>
      {/if}
    {/each}
  </div>
  {#if error}<p class="cb-error" role="alert">{error}</p>{/if}
  <form class="cb-composer" onsubmit={(e) => { e.preventDefault(); void send(); }}>
    <label class="visually-hidden" for="cloud-bot-input">Message {shown.name}</label>
    <textarea id="cloud-bot-input" rows="2" bind:value={draft} placeholder="Message {shown.name}…" onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }}></textarea>
    <button class="btn" type="submit" disabled={sending || !draft.trim()}>Send</button>
  </form>
  <p class="cb-note">Change its settings on the web (Bots) or in the EdgeCoder iOS app.</p>
</section>

<style>
  .cloud-bot { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .cb-head { display: flex; gap: 10px; align-items: center; padding: 12px 18px; border-bottom: 0.5px solid var(--border); }
  .cb-who h2 { font-size: 15px; margin: 0; }
  .cb-role { color: var(--text-secondary); font-weight: 500; }
  .cb-sub { margin: 2px 0 0; font-size: 12px; color: var(--text-secondary); }
  .cb-chip { font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 999px; border: 0.5px solid var(--border-strong); }
  .cb-thread { flex: 1; overflow-y: auto; padding: 12px 18px; max-width: 820px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .cb-msg { padding: 10px 0; border-bottom: 0.5px solid var(--border); font-size: 14px; }
  .cb-msg-head { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
  .cb-msg-who { font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
  .cb-msg.user .cb-msg-who { color: var(--accent); }
  .cb-event, .cb-empty { font-size: 12px; color: var(--text-secondary); margin: 6px 0; }
  .cb-error { color: var(--danger); font-size: 12px; margin: 0 18px; }
  .cb-composer { display: flex; gap: 8px; padding: 10px 18px; align-items: flex-end; max-width: 820px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .cb-composer textarea { flex: 1; resize: vertical; min-height: 40px; font: inherit; }
  .cb-note { font-size: 11px; color: var(--text-secondary); text-align: center; margin: 0 0 10px; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
