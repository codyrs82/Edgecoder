<script lang="ts">
  import { logout, getMe, updateProfile } from "../lib/api";
  import type { AuthUser } from "../lib/api";

  interface Props {
    user: AuthUser;
    onLogout: () => void;
    /** The saved profile, so the sidebar shows the new name at once. */
    onUserChange?: (user: AuthUser) => void;
  }
  let { user, onLogout, onUserChange }: Props = $props();

  let profile: AuthUser | null = $state(null);
  let loading = $state(true);
  let name = $state("");
  let saving = $state(false);
  let saved = $state(false);
  let error = $state("");

  // Fetch fresh profile every time Account mounts
  $effect(() => {
    loading = true;
    getMe()
      .then((fresh) => { profile = fresh; })
      .catch(() => { profile = null; })
      .finally(() => {
        loading = false;
        name = (profile ?? user).displayName ?? "";
      });
  });

  // Use fetched profile, fall back to prop
  let display = $derived(profile ?? user);
  let dirty = $derived(name.trim() !== (display.displayName ?? ""));
  let initial = $derived((name.trim() || display.email).charAt(0).toUpperCase());

  async function save() {
    saving = true;
    error = "";
    try {
      await updateProfile(name.trim());
      const next = { ...display, displayName: name.trim() || null };
      profile = next;
      onUserChange?.(next);
      saved = true;
      setTimeout(() => (saved = false), 2000);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  let loggingOut = $state(false);

  async function handleLogout() {
    loggingOut = true;
    try {
      await logout();
      onLogout();
    } finally {
      loggingOut = false;
    }
  }
</script>

<div class="sp">
  <h1>Profile</h1>

  {#if loading}
    <p class="sp-muted" role="status">Loading profile…</p>
  {:else}
    <div class="sp-group">
      <div class="sp-card">
        <div class="sp-row">
          <span class="avatar" aria-hidden="true">{initial}</span>
          <div class="sp-text">
            <span class="sp-title">{name.trim() || display.email.split("@")[0]}</span>
            <span class="sp-desc">{display.email}</span>
          </div>
        </div>
        <div class="sp-row">
          <div class="sp-text">
            <label class="sp-title" for="display-name">Display name</label>
            <span class="sp-desc">Shown in the app and on the web portal.</span>
          </div>
          <div class="sp-controls">
            <input id="display-name" type="text" maxlength="80" placeholder="Your name" bind:value={name} onkeydown={(e) => e.key === "Enter" && dirty && save()} />
            <button class="primary" disabled={!dirty || saving} onclick={save}>{saving ? "Saving…" : saved ? "Saved" : "Save"}</button>
          </div>
        </div>
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Email</span><span class="sp-desc">{display.email}</span></div>
          {#if display.emailVerified}
            <span class="sp-pill" style="color: var(--success, #3fb950)">Verified</span>
          {:else}
            <span class="sp-pill" style="color: var(--warning, #d29922)">Not verified</span>
          {/if}
        </div>
      </div>
      {#if error}<p class="sp-err">{error}</p>{/if}
    </div>

    <div class="sp-group">
      <div class="sp-card">
        <div class="sp-row">
          <div class="sp-text"><span class="sp-title">Sign out</span><span class="sp-desc">This computer keeps running its agent; you can sign back in any time.</span></div>
          <button class="danger" onclick={handleLogout} disabled={loggingOut}>{loggingOut ? "Signing out…" : "Sign out"}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 600;
    font-size: 16px;
    background: color-mix(in srgb, var(--accent) 25%, var(--bg-surface));
    color: var(--text-primary);
  }
  #display-name {
    width: 220px;
  }
</style>
