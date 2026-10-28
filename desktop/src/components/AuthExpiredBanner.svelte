<script lang="ts">
  // #24: persistent state -> banner (not a toast). Stays until the user signs in again.
  import { onSessionExpired } from "../lib/session-state";

  interface Props {
    onSignIn: () => void;
  }
  let { onSignIn }: Props = $props();
  let visible = $state(false);

  $effect(() => onSessionExpired(() => { visible = true; }));
</script>

{#if visible}
  <div class="auth-banner" role="alert">
    <span>Your session has expired. Sign in again to keep syncing.</span>
    <button type="button" onclick={onSignIn}>Sign in</button>
  </div>
{/if}

<style>
  .auth-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: var(--amber, #b54708);
    color: #fff;
    font-size: 13px;
  }
  .auth-banner button {
    background: rgba(255, 255, 255, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.4);
    color: inherit;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .auth-banner button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
</style>
