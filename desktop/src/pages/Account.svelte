<script lang="ts">
  import { logout } from "../lib/api";
  import type { AuthUser } from "../lib/api";

  interface Props {
    user: AuthUser;
    onLogout: () => void;
  }
  let { user, onLogout }: Props = $props();

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

<div class="account">
  <h1>Account</h1>

  <div class="section">
    <h2>Profile</h2>
    <div class="field-grid">
      <span class="field-label">Email</span>
      <span class="field-value">{user.email}</span>

      <span class="field-label">Display Name</span>
      <span class="field-value">{user.displayName ?? "\u2014"}</span>

      <span class="field-label">Email Verified</span>
      <span class="field-value">
        {#if user.emailVerified}
          <span class="badge verified">Verified</span>
        {:else}
          <span class="badge unverified">Not verified</span>
        {/if}
      </span>
    </div>
  </div>

  <div class="section">
    <button class="btn-danger" onclick={handleLogout} disabled={loggingOut}>
      {loggingOut ? "Signing out..." : "Sign Out"}
    </button>
  </div>
</div>

<style>
  .account {
    padding: 1.5rem;
    max-width: 640px;
  }
  h1 { margin: 0 0 1.5rem; font-size: 1.4rem; }
  .section {
    background: var(--bg-surface);
    border: 0.5px solid var(--border);
    padding: 1.2rem 1.4rem;
    border-radius: var(--radius-md);
    margin-bottom: 1.2rem;
  }
  .section h2 {
    font-size: 0.92rem;
    margin: 0 0 1rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .field-grid {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.5rem 1rem;
    font-size: 0.85rem;
  }
  .field-label { color: var(--text-muted); }
  .field-value { color: var(--text-primary); }
  .badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .badge.verified {
    color: var(--green);
    background: rgba(74, 222, 128, 0.12);
  }
  .badge.unverified {
    color: var(--yellow);
    background: rgba(251, 191, 36, 0.12);
  }
  .btn-danger {
    padding: 8px 20px;
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.2);
  }
  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
