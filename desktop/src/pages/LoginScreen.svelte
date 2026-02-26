<script lang="ts">
  import { login, getOAuthStartUrl, completeOAuthWithToken } from "../lib/api";
  import type { AuthUser } from "../lib/api";
  import { open } from "@tauri-apps/plugin-shell";

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

  async function handleOAuth(provider: "google" | "microsoft") {
    error = "";
    const url = getOAuthStartUrl(provider);
    try {
      await open(url);
    } catch (err) {
      error = "Could not open browser for sign-in";
    }
  }

  // Handle deep link callback from OAuth (edgecoder://oauth-callback?mobile_token=...)
  (window as any).__handleDeepLink = async (urlStr: string) => {
    try {
      const raw = typeof urlStr === "string" ? urlStr : String(urlStr);
      // Deep link payload may be JSON-encoded or a raw URL
      const cleaned = raw.startsWith('"') ? JSON.parse(raw) : raw;
      const url = new URL(cleaned);
      const token = url.searchParams.get("mobile_token");
      const status = url.searchParams.get("status");
      if (status !== "ok" || !token) {
        error = "OAuth sign-in was not completed";
        return;
      }
      submitting = true;
      const user = await completeOAuthWithToken(token);
      onLogin(user);
    } catch (err) {
      error = (err as Error).message || "OAuth sign-in failed";
    } finally {
      submitting = false;
    }
  };
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
      <button class="btn-oauth" onclick={() => handleOAuth("microsoft")} disabled={submitting}>
        Microsoft 365
      </button>
      <button class="btn-oauth" onclick={() => handleOAuth("google")} disabled={submitting}>
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
    border: 0.5px solid var(--border-strong);
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
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-oauth:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .btn-oauth:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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
