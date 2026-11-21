import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const api = vi.hoisted(() => {
  class SignupError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    SignupError,
    login: vi.fn(),
    signup: vi.fn(),
    getOAuthStartUrl: vi.fn(),
    completeOAuthWithToken: vi.fn(),
    pendingOAuthVerifier: vi.fn(() => null),
  };
});
const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/lib/api", () => api);
vi.mock("@tauri-apps/plugin-shell", () => shell);

import LoginScreen from "../src/pages/LoginScreen.svelte";

const user = { userId: "u1", email: "cody@proton.me", displayName: null, emailVerified: false };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openSignup() {
  const onLogin = vi.fn();
  render(LoginScreen, { onLogin });
  await fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
  await fireEvent.input(screen.getByPlaceholderText("Email"), { target: { value: "cody@proton.me" } });
  await fireEvent.input(screen.getByPlaceholderText(/Password/), { target: { value: "correct-horse-1" } });
  return onLogin;
}

describe("LoginScreen sign-up", () => {
  it("creates the account in the app and signs in", async () => {
    api.signup.mockResolvedValue(user);
    const onLogin = await openSignup();
    const create = screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // until the terms are accepted
    await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(create);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith(user));
    expect(api.signup).toHaveBeenCalledWith({ email: "cody@proton.me", password: "correct-horse-1", acceptTerms: true });
    expect(shell.open).not.toHaveBeenCalled();
  });

  it("shows Creating account… and sends one request while in flight", async () => {
    let release!: (u: typeof user) => void;
    api.signup.mockReturnValue(new Promise((r) => (release = r)));
    const onLogin = await openSignup();
    await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const busy = (await screen.findByRole("button", { name: "Creating account…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await fireEvent.submit(busy.closest("form")!);
    expect(api.signup).toHaveBeenCalledTimes(1);
    release(user);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
  });

  it("an existing account offers Sign in (email kept) and Forgot password", async () => {
    api.signup.mockRejectedValue(new api.SignupError("email_already_registered", "An account with this email already exists."));
    await openSignup();
    await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("An account with this email already exists.");
    expect(screen.getAllByRole("button", { name: /Forgot password/ }).length).toBeGreaterThan(0);
    const signIn = [...alert.querySelectorAll("button")].find((b) => b.textContent === "Sign in")!;
    await fireEvent.click(signIn);
    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe("cody@proton.me");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never asks for an invite code (sign-up is open)", async () => {
    await openSignup();
    expect(screen.queryByPlaceholderText(/Invite code/)).toBeNull();
  });
});
