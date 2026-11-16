<script lang="ts">
  import { login, signup, signupNeedsInvite, SignupError, getOAuthStartUrl, completeOAuthWithToken, pendingOAuthVerifier } from "../lib/api";
  import type { AuthUser } from "../lib/api";
  import { open } from "@tauri-apps/plugin-shell";
  import { portalResetPasswordUrl, portalUrl } from "../lib/endpoints";
  import { oauthOutcomeFromUrl } from "../lib/oauth-outcome";

  interface Props {
    onLogin: (user: AuthUser) => void;
  }
  let { onLogin }: Props = $props();

  let email = $state("");
  let password = $state("");
  let error = $state("");
  // "Check your email" after an SSO sign-in that needs the account's inbox to confirm the link.
  let notice = $state("");
  let submitting = $state(false);
  // Sign in, or create an account (in the app: a new account is signed in straight away).
  let mode = $state<"signin" | "signup">("signin");
  let inviteCode = $state("");
  let acceptTerms = $state(false);
  let inviteRequired = $state(false);
  // Set when sign-up says the address already has an account: offer Sign in / Forgot password.
  let accountExists = $state(false);

  function setMode(next: "signin" | "signup") {
    mode = next;
    error = "";
    notice = "";
    accountExists = false;
    if (next === "signup") signupNeedsInvite().then((v) => (inviteRequired = v));
  }

  async function handleSubmit() {
    if (submitting) return;
    if (!email.trim() || !password.trim()) return;
    if (mode === "signup") return handleCreateAccount();
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

  async function handleCreateAccount() {
    error = "";
    accountExists = false;
    if (!acceptTerms) {
      error = "To create an account, agree to the Terms, Privacy Policy and Acceptable Use Policy.";
      return;
    }
    submitting = true;
    try {
      const user = await signup({ email, password, inviteCode, acceptTerms });
      onLogin(user);
    } catch (err) {
      error = (err as Error).message;
      accountExists = err instanceof SignupError && err.code === "email_already_registered";
    } finally {
      submitting = false;
    }
  }

  function signInInstead() {
    const typed = email;
    setMode("signin");
    email = typed;
    password = "";
  }

  async function openLegal(path: string) {
    try {
      await open(`${portalUrl().replace(/\/+$/, "")}${path}`);
    } catch {
      error = "Could not open the browser";
    }
  }

  function onFormSubmit(e: SubmitEvent) {
    e.preventDefault();
    handleSubmit();
  }

  async function handleOAuth(provider: "google" | "microsoft") {
    error = "";
    try {
      const url = await getOAuthStartUrl(provider);
      await open(url);
    } catch (err) {
      error = "Could not open browser for sign-in";
    }
  }

  // Password reset also happens on the portal, in the system browser.
  async function handleForgotPassword() {
    error = "";
    try {
      await open(portalResetPasswordUrl());
    } catch {
      error = "Could not open browser for password reset";
    }
  }

  // Handle deep link callback from OAuth (edgecoder://oauth-callback?mobile_token=...)
  (window as any).__handleDeepLink = async (urlStr: string) => {
    // Only a callback for a sign-in this app started.
    if (!pendingOAuthVerifier()) return;
    try {
      const raw = typeof urlStr === "string" ? urlStr : String(urlStr);
      // Deep link payload may be JSON-encoded or a raw URL
      const cleaned = raw.startsWith('"') ? JSON.parse(raw) : raw;
      const outcome = oauthOutcomeFromUrl(new URL(cleaned));
      if (outcome.kind === "check_email") {
        error = "";
        notice = outcome.message;
        return;
      }
      if (outcome.kind === "error") {
        notice = "";
        error = outcome.message;
        return;
      }
      submitting = true;
      const user = await completeOAuthWithToken(outcome.token);
      onLogin(user);
    } catch (err) {
      error = (err as Error).message || "OAuth sign-in failed";
    } finally {
      submitting = false;
    }
  };
</script>

<main class="login-screen">
  <div class="login-card" aria-busy={submitting}>
    <div class="logo">
      <h1>EdgeCoder</h1>
    </div>

    {#if error}
      <div class="error-msg" id="login-error" role="alert">
        {error}
        {#if accountExists}
          <div class="error-actions">
            <button type="button" class="link-btn" onclick={signInInstead}>Sign in</button>
            <button type="button" class="link-btn" onclick={handleForgotPassword}>Forgot password? <span class="sr-only">(opens in your browser)</span></button>
          </div>
        {/if}
      </div>
    {/if}
    {#if notice && !error}
      <div class="notice-msg" id="login-notice" role="status">{notice}</div>
    {/if}

    <form class="form" onsubmit={onFormSubmit} aria-label={mode === "signup" ? "Create an account" : "Sign in with email"} novalidate>
      <label class="sr-only" for="login-email">Email</label>
      <input
        id="login-email"
        type="email"
        autocomplete="username"
        required
        bind:value={email}
        placeholder="Email"
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "login-error" : undefined}
        disabled={submitting}
      />
      <label class="sr-only" for="login-password">Password</label>
      <input
        id="login-password"
        type="password"
        autocomplete={mode === "signup" ? "new-password" : "current-password"}
        required
        bind:value={password}
        placeholder={mode === "signup" ? "Password (at least 8 characters)" : "Password"}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "login-error" : undefined}
        disabled={submitting}
      />
      {#if mode === "signup"}
        {#if inviteRequired}
          <label class="sr-only" for="signup-invite">Invite code</label>
          <input id="signup-invite" type="text" autocomplete="off" spellcheck="false" maxlength="64" bind:value={inviteCode} placeholder="Invite code (EC-XXXX-XXXX-XXXX-XXXX)" disabled={submitting} />
        {/if}
        <label class="agree-row" for="signup-terms">
          <input id="signup-terms" type="checkbox" bind:checked={acceptTerms} disabled={submitting} />
          <span>I agree to the
            <button type="button" class="link-btn" onclick={() => openLegal("/terms")}>Terms</button>,
            <button type="button" class="link-btn" onclick={() => openLegal("/privacy")}>Privacy Policy</button> and
            <button type="button" class="link-btn" onclick={() => openLegal("/acceptable-use")}>Acceptable Use Policy</button></span>
        </label>
        <button type="submit" class="btn-primary" disabled={submitting || !acceptTerms} aria-busy={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
      {:else}
        <button type="submit" class="btn-primary" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign In"}
        </button>
        <button type="button" class="link-btn forgot-link" onclick={handleForgotPassword}>Forgot password? <span class="sr-only">(opens in your browser)</span></button>
      {/if}
    </form>

    <div class="divider" aria-hidden="true">
      <span>or continue with</span>
    </div>

    <div class="oauth-buttons" role="group" aria-label="Continue with">
      <button class="btn-oauth" type="button" onclick={() => handleOAuth("microsoft")} disabled={submitting}>
        Microsoft 365
      </button>
      <button class="btn-oauth" type="button" onclick={() => handleOAuth("google")} disabled={submitting}>
        Google
      </button>
    </div>

    <p class="signup-link">
      {#if mode === "signup"}
        Already have an account? <button type="button" class="link-btn" onclick={() => setMode("signin")}>Sign in</button>
      {:else}
        Don't have an account? <button type="button" class="link-btn" onclick={() => setMode("signup")}>Sign up</button>
      {/if}
    </p>
  </div>
</main>

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
  .notice-msg {
    background: color-mix(in srgb, var(--accent, var(--text-primary)) 10%, transparent);
    color: var(--text-primary);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .error-msg {
    background: color-mix(in srgb, var(--red) 10%, transparent);
    color: var(--red-strong);
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
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .form input:focus {
    border-color: var(--accent);
  }
  .form input:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .form input::placeholder {
    color: var(--text-muted);
  }
  .btn-primary {
    padding: 12px;
    background: var(--accent);
    color: var(--on-accent);
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
  .error-actions {
    display: flex;
    gap: 16px;
    margin-top: 6px;
  }
  .agree-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    text-align: left;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .agree-row input {
    margin-top: 3px;
  }
  .legal-note {
    margin: 0;
    text-align: left;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .forgot-link {
    align-self: flex-end;
    font-size: 12px;
  }
  .link-btn:hover {
    text-decoration: underline;
  }
</style>
