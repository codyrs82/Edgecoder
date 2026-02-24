<script lang="ts">
  import { login, getOAuthStartUrl } from "../lib/api";
  import type { AuthUser } from "../lib/api";

  interface Props {
    onLogin: (user: AuthUser) => void;
  }
  let { onLogin }: Props = $props();

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let submitting = $state(false);

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) return;
    submitting = true;
    error = "";

    try {
      const user = await login(email, password);
      onLogin(user);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") handleSubmit();
  }

  function handleOAuth(provider: "google" | "microsoft") {
    const url = getOAuthStartUrl(provider);
    window.open(url, "_blank");
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <div class="logo">
      <h1>EdgeCoder</h1>
    </div>

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    <div class="form">
      <input
        type="email"
        bind:value={email}
        placeholder="Email"
        onkeydown={handleKeydown}
        disabled={submitting}
      />
      <input
        type="password"
        bind:value={password}
        placeholder="Password"
        onkeydown={handleKeydown}
        disabled={submitting}
      />
      <button class="btn-primary" onclick={handleSubmit} disabled={submitting}>
        {submitting ? "Signing in..." : "Sign In"}
      </button>
    </div>

    <div class="divider">
      <span>or continue with</span>
    </div>

    <div class="oauth-buttons">
      <button class="btn-oauth" onclick={() => handleOAuth("microsoft")}>
        Microsoft 365
      </button>
      <button class="btn-oauth" onclick={() => handleOAuth("google")}>
        Google
      </button>
    </div>

    <p class="signup-link">
      Don't have an account? <button class="link-btn">Sign up</button>
    </p>
  </div>
</div>

<style>
  .login-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
  }
  .login-card {
    width: 380px;
    padding: 40px 32px;
    text-align: center;
  }
  .logo h1 {
    font-size: 1.6rem;
    margin: 0 0 32px;
    color: var(--text-primary);
  }
  .error-msg {
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .form input {
    padding: 12px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .form input:focus {
    border-color: var(--accent);
  }
  .form input::placeholder {
    color: var(--text-muted);
  }
  .btn-primary {
    padding: 12px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .divider {
    margin: 24px 0;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .divider::before, .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-strong);
  }
  .oauth-buttons {
    display: flex;
    gap: 8px;
  }
  .btn-oauth {
    flex: 1;
    padding: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-oauth:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .signup-link {
    margin-top: 24px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    padding: 0;
  }
  .link-btn:hover {
    text-decoration: underline;
  }
</style>
