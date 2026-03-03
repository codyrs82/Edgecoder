import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = resolve(__dirname, "../test-context.json");

function loadContext() {
  return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8"));
}

test.describe("Portal Authentication", () => {
  test("portal health endpoint is reachable", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBeTruthy();
  });

  test("signup rejects duplicate email", async ({ request }) => {
    // test@edgecoder.io was created in global-setup
    const res = await request.post("/auth/signup", {
      data: {
        email: "test@edgecoder.io",
        password: "AnotherPass123!",
        displayName: "Duplicate",
      },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("email_already_registered");
  });

  test("login with valid credentials returns session token", async ({ request }) => {
    const res = await request.post("/auth/login", {
      data: { email: "test@edgecoder.io", password: "TestPassword123!" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionToken).toBeTruthy();
    expect(body.user.email).toBe("test@edgecoder.io");
    expect(body.user.emailVerified).toBe(true);
  });

  test("login with wrong password returns 401", async ({ request }) => {
    const res = await request.post("/auth/login", {
      data: { email: "test@edgecoder.io", password: "WrongPassword!" },
    });
    expect(res.status()).toBe(401);
  });

  test("authenticated request to /auth/me returns user info", async ({ request }) => {
    const ctx = loadContext();
    const res = await request.get("/auth/me", {
      headers: { Authorization: `Bearer ${ctx.sessionToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.email).toBe("test@edgecoder.io");
    expect(body.user.emailVerified).toBe(true);
  });
});
