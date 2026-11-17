# Account security: payout addresses, withdrawals and two-factor authentication

What stops a taken-over portal account (a stolen session or password) from turning into stolen sats.
Code: `src/portal/account-security.ts` (rules and storage), `src/portal/routes/account-security.ts`
(2FA, emailed links, admin unlock), `src/portal/totp.ts` (RFC 6238).

## Payout destinations

Adding or changing a payout destination (Lightning address or on-chain address, `PUT /wallet/payout-destination`):

1. With 2FA on, the request needs the second factor (see below).
2. The account's email must be verified. The portal emails a **confirmation link** (and the same
   confirmation as a 6-digit code for the desktop and iOS apps). Both work once and expire after
   `PAYOUT_DEST_CONFIRM_TTL_MINUTES` (default **30**). The response is `202 { verificationRequired, confirmation: "email_link", challengeId }`.
   Opening the link only shows a page; its button POSTs the token, so mail scanners that prefetch links confirm nothing.
3. Once confirmed, the destination **cools off** before it is saved and registered with the
   coordinator: `PAYOUT_DEST_COOLDOWN_HOURS` (default **24**) for a change, and
   `PAYOUT_DEST_FIRST_COOLDOWN_HOURS` (default **1**) for an account's first destination. A
   brand-new account has nothing to steal yet, so a short wait is enough for its owner to notice
   the notice email, while a change of an existing address gets a full day.
4. During the cooling-off:
   - the old destination (if any) keeps receiving automatic payouts;
   - manual withdrawals are refused with `423 payout_destination_cooling_off` and `unlocksAtMs`.
     A BOLT11 invoice cannot be tied to a destination, so every manual withdrawal waits;
   - the owner is emailed "A new payout address was added to your EdgeCoder account…" with a
     one-click **cancel** link. Cancelling drops the change and signs out every session.
   - the owner can also cancel from the Wallet page (`POST /wallet/payout-destination/cancel`).
5. When the cooling-off ends, a sweep (every 5 minutes) or the account's next wallet request saves
   the destination and registers it with the control plane and coordinator.

## Withdrawals

Every withdrawal the coordinator accepts (`POST /wallet/payouts/withdraw`, and the system admins'
revenue withdrawal) emails a **receipt**: amount, destination (masked), time, and "Not you? Lock your
account". The lock link works for 30 days.

**Lock** pauses payouts for the account (its payout address is cleared at the coordinator, so
automatic payouts stop; manual withdrawals and destination changes are refused with `423 account_locked`;
a cooling-off destination does not activate) and signs out every session. Only a system admin can
unlock it: Settings, Admin, Locked accounts (`POST /portal/api/admin/security/:userId/unlock`), which
registers the saved destination again and writes an audit entry.

Automatic payouts are made by the coordinator, not the portal, and are not receipted here.

## Two-factor authentication

Settings, Profile, Two-factor authentication: an authenticator app (TOTP: SHA-1, 6 digits, 30 s,
±1 step of clock skew, each step accepted once) with 10 single-use recovery codes, shown once. A
**passkey counts as a second factor**: an account with a passkey has 2FA on.

With 2FA on, these need the second factor:

| Action | Route |
| --- | --- |
| Withdrawals | `POST /wallet/payouts/withdraw` (both steps) |
| Payout destination changes | `PUT /wallet/payout-destination` |
| API key creation | `POST /portal/api/keys` |
| Adding a passkey or an authenticator | `POST /auth/passkey/register/options`, `POST /portal/api/security/2fa/totp/setup` |
| Admin actions | every POST/PUT/PATCH/DELETE under `/portal/api/admin/`, `/coordinator/ops/`, `/admin/network/registry/` |

The second factor is given either inline (`x-edgecoder-2fa-code` header or a `twoFactorCode` body
field) or as a **step-up**: `POST /portal/api/security/2fa/verify { code }` (or the passkey step-up)
covers protected actions in that session for `TWO_FACTOR_STEP_UP_MINUTES` (default 10). A protected
route without it answers `403 { error: "two_factor_required", methods }`; the web pages ask for the
code (or the passkey) and retry; the desktop app asks for the code, or opens the web page when the
account only has a passkey. After 5 wrong codes in 15 minutes, verification pauses (429).

**System admins must enable 2FA.** Until they do, the portal shows a banner. They have
`ADMIN_2FA_GRACE_DAYS` (default **7**) from the first time the portal sees them as an admin; after
that, admin actions answer `403 two_factor_enrollment_required`.

TOTP secrets are encrypted at rest (AES-256-GCM, the queue-data codec) with `PORTAL_2FA_KEY`, or a
key derived from `OAUTH_STATE_SECRET` when it is not set. Recovery codes are stored hashed.

## Storage

No migration: one JSON row per account in the existing `portal_onboarding` table, keyed
`acctsec:<userId>`, written with an optimistic version check on `updated_at_ms` (two concurrent
writers cannot both win, so a link or recovery code cannot be used twice). It holds the 2FA state,
the pending destination, the lock and the receipt lock-link hashes; it is deleted with the account.
Emailed tokens are `<base64url userId>.<random>` and only their hashes are stored.

A dedicated table would be cleaner later; a proposal is in the pull request that added this.
