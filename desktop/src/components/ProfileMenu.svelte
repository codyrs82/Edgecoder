<script lang="ts">
  import { Settings, User, CreditCard, Cpu, Plug, Globe, LogOut, ArrowUpCircle } from "@lucide/svelte";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { computeOverview, portalWebUrl, type AuthUser } from "../lib/api";
  import { onUpdateStatus, downloadAndInstall, type UpdateStatus } from "../lib/updater";

  interface Props {
    user: AuthUser;
    onOpenSettings: (section?: string) => void;
    onLogout: () => void;
  }
  let { user, onOpenSettings, onLogout }: Props = $props();

  let menuOpen = $state(false);
  let cSats: number | null = $state(null);
  let update: UpdateStatus = $state({ state: "idle" });
  let rowEl: HTMLDivElement | undefined = $state();
  let firstItem: HTMLButtonElement | undefined = $state();

  let name = $derived(user.displayName?.trim() || user.email.split("@")[0]);
  let initial = $derived(name.charAt(0).toUpperCase());

  async function refreshBalance() {
    try {
      const ov = await computeOverview();
      cSats = ov.account?.cSats ?? null;
    } catch {
      cSats = null;
    }
  }

  $effect(() => {
    void refreshBalance();
    const t = setInterval(refreshBalance, 60_000);
    const off = onUpdateStatus((s) => (update = s));
    return () => {
      clearInterval(t);
      off();
    };
  });

  function toggle() {
    menuOpen = !menuOpen;
    if (menuOpen) queueMicrotask(() => firstItem?.focus());
  }

  function go(section?: string) {
    menuOpen = false;
    onOpenSettings(section);
  }

  function onMenuKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      menuOpen = false;
      rowEl?.querySelector<HTMLButtonElement>(".who")?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...((e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button"))];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  }

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 0 });
</script>

<div class="profile-area" bind:this={rowEl}>
  {#if update.state === "available" || update.state === "downloading" || update.state === "installing"}
    <button class="update-row" onclick={() => update.state === "available" && downloadAndInstall()} disabled={update.state !== "available"}>
      <ArrowUpCircle size={14} />
      {#if update.state === "available"}
        <span>Update to {update.update.version}</span><span class="go">Relaunch →</span>
      {:else if update.state === "downloading"}
        <span>Downloading update… {update.progress}%</span>
      {:else}
        <span>Installing, restarting shortly…</span>
      {/if}
    </button>
  {/if}

  {#if menuOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="backdrop" onclick={() => (menuOpen = false)}></div>
    <div class="menu" role="menu" tabindex="-1" aria-label="Account" onkeydown={onMenuKeydown}>
      <div class="menu-head">
        <span class="email">{user.email}</span>
      </div>
      <button bind:this={firstItem} role="menuitem" onclick={() => go("profile")}><User size={15} /> Profile</button>
      <button role="menuitem" onclick={() => go("plan")}><CreditCard size={15} /> Plan &amp; usage {#if cSats !== null}<span class="hint">{fmt(cSats)} cSats</span>{/if}</button>
      <button role="menuitem" onclick={() => go("compute")}><Cpu size={15} /> Compute</button>
      <button role="menuitem" onclick={() => go("connect")}><Plug size={15} /> Connect your tools</button>
      <button role="menuitem" onclick={() => go()}><Settings size={15} /> Settings</button>
      <button role="menuitem" onclick={() => { menuOpen = false; void openUrl(portalWebUrl("/portal/dashboard")); }}><Globe size={15} /> Open web portal</button>
      <div class="sep"></div>
      <button role="menuitem" class="danger" onclick={() => { menuOpen = false; onLogout(); }}><LogOut size={15} /> Log out</button>
    </div>
  {/if}

  <div class="row">
    <button class="who" onclick={toggle} aria-haspopup="menu" aria-expanded={menuOpen} title="Account menu">
      <span class="avatar" aria-hidden="true">{initial}</span>
      <span class="text">
        <span class="name">{name}</span>
        <span class="sub">{cSats === null ? "EdgeCoder" : `${fmt(cSats)} cSats`}</span>
      </span>
    </button>
    {#if update.state === "available"}
      <button class="pill" onclick={() => downloadAndInstall()} title="Install {update.update.version} and relaunch">Update</button>
    {/if}
    <button class="gear" onclick={() => onOpenSettings()} title="Settings" aria-label="Settings"><Settings size={16} /></button>
  </div>
</div>

<style>
  .profile-area { position: relative; padding: 8px; border-top: 0.5px solid var(--border); }
  .update-row {
    display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 6px; padding: 8px 10px; border: none; border-radius: 8px;
    background: var(--bg-surface); color: var(--text-primary); font-size: 12.5px; cursor: pointer; text-align: left;
  }
  .update-row:disabled { cursor: default; }
  .update-row .go { margin-left: auto; color: var(--text-secondary); }
  .row { display: flex; align-items: center; gap: 4px; }
  .who {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 6px; border: none; border-radius: 8px;
    background: none; color: var(--text-primary); cursor: pointer; text-align: left;
  }
  .who:hover, .who[aria-expanded="true"] { background: var(--bg-surface); }
  .avatar {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center;
    background: color-mix(in srgb, var(--accent) 25%, var(--bg-surface)); color: var(--text-primary); font-weight: 600; font-size: 13px;
  }
  .text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
  .name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; }
  .pill {
    padding: 4px 10px; border: none; border-radius: 999px; background: var(--accent); color: var(--on-accent, #111);
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .gear {
    width: 30px; height: 30px; display: grid; place-items: center; border: none; border-radius: 8px; background: none;
    color: var(--text-secondary); cursor: pointer;
  }
  .gear:hover { background: var(--bg-surface); color: var(--text-primary); }
  .backdrop { position: fixed; inset: 0; z-index: 50; }
  .menu {
    position: absolute; left: 8px; right: 8px; bottom: calc(100% - 4px); z-index: 51; padding: 6px;
    background: var(--bg-elevated, var(--bg-surface)); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  .menu-head { padding: 6px 10px 8px; }
  .email { font-size: 12px; color: var(--text-secondary); }
  .menu button {
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: none; border-radius: 8px; background: none;
    color: var(--text-primary); font-size: 13px; cursor: pointer; text-align: left;
  }
  .menu button:hover, .menu button:focus-visible { background: var(--bg-surface); outline: none; }
  .menu .hint { margin-left: auto; color: var(--text-secondary); font-size: 12px; }
  .menu .danger { color: var(--danger, #e5484d); }
  .sep { height: 0.5px; margin: 6px 4px; background: var(--border); }
</style>
