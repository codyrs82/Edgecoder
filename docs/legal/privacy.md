# Privacy Policy

> **DRAFT — pending legal review.** This document is a working draft prepared for review by counsel. It is not final, it is not legal advice, and it has not been approved by EdgeCoder, LLC. Bracketed items such as [CONTACT EMAIL] are placeholders to be completed.

Version: 2026-11-15-draft · Effective date: [EFFECTIVE DATE]

This policy explains what personal information EdgeCoder, LLC ("EdgeCoder", "we") collects when you use the EdgeCoder website ([WEBSITE DOMAIN]), the EdgeCoder portal, the desktop and iOS apps, the EdgeCoder agent and the hosted API (the "Service"), how we use and share it, and your choices. Words defined in the [Terms of Service](/terms) have the same meaning here.

## The most important thing to know

EdgeCoder is a decentralized network. **When you send a prompt, code or data to be run on the network, it is processed on a machine operated by a Host, who is a third party and not EdgeCoder.** Task payloads are signed, and are encrypted in transit between the coordinator and the agent where the agent supports it, and code runs in a sandbox on the Host's machine. But the Host's machine has to read your prompt and data in order to run them, and we cannot fully control a machine we do not own. **Do not send passwords, API keys, private keys, personal data of other people, or other secrets** in prompts, code or files you run on the network. Work you run on your own machines ("mine/" models and your own agents) stays between you and your machines.

## What we collect

**Account information**

- Email address, display name (optional), password hash (we never store your password itself), passkey public keys, and the date you created and verified your account.
- If you sign in with Google, Microsoft or GitHub: the provider's account identifier and the email it gives us. If you connect GitHub, we store the GitHub access token you grant, your GitHub login and avatar URL, and the scopes, so the Service can act on GitHub for you.
- For AI-agent accounts: the agent's public key.
- Invite code used at sign-up (as a hash), and which version of the Terms, Privacy Policy and Acceptable Use Policy you accepted and when; for Hosts, which version of the Host Agreement you accepted and when.
- API keys you create (we store only a hash and a short prefix).

**Payment information**

- Lightning invoices and payment records for cSats you buy (amount, status, payment hash, timestamps), your cSats balance and transaction history.
- For Hosts: earnings, payouts, and the payout destination you set (a Lightning address or similar), with the verification codes used to confirm changes.
- We do not collect card numbers or bank details. We do not hold your wallet's private keys.
- If we are required to collect tax information from Hosts (see the [Host Agreement](/host-agreement)), we collect it as required. [COUNSEL: describe tax-form collection, storage and processor.]

**Machine and agent telemetry (Hosts and anyone who runs the agent or app)**

- Agent and node identifiers, operating system, app and agent version, client type, hardware profile (CPU model and cores, memory, GPU model and memory), benchmark and hardware-verification results, models installed and loaded, load and capacity, uptime and heartbeats, and the account the machine is enrolled to.
- The IP address the machine connects from, a country code derived from it, and whether it appears to use a VPN. We use these for routing, fraud and witness-independence checks, and network maps.
- Task results, timings, success and failure, and the measured work used for payment.
- If you use Bluetooth mesh on the desktop or iOS app: see "Bluetooth" below.

**Usage records**

- For each job and model call: the account, time, model, compute class, which machine ran it, which client sent it, success, duration, cost, and token counts. These records do not contain the prompt or output.

**Prompts, code, data and outputs**

- **Portal chat:** conversations you have in the portal (and the desktop app when it uses your portal account) are stored on EdgeCoder's servers, including the full text of your messages and the model's replies, so you can see them again. You can delete a conversation at any time, which deletes its messages.
- **Desktop app chats:** chats kept locally by the desktop app are stored on your computer.
- **Jobs on the network:** to run a job, its input passes through an EdgeCoder coordinator to a Host. The coordinator's job queue stores the task input and the result until [RETENTION PERIOD FOR QUEUE DATA — engineering to confirm; there is currently no automatic deletion], in encrypted form when the end-to-end task envelope is used.
- **On Hosts' machines:** the EdgeCoder agent keeps a local history of the jobs it ran, including their input and output, in a database on the Host's machine. This history is under the Host's control, not ours. [ENGINEERING: consider not storing third-party prompts in the host's local history.]
- We do not use your prompts, code, data or outputs to train AI models.

**Website and portal**

- IP address and request data (time, path, user agent) in server logs and for rate limiting and abuse prevention.
- Error reports (stack traces and request context, with personal data minimized) sent to our error-tracking provider.

**Bluetooth**

- If Bluetooth mesh is on, your device advertises a short EdgeCoder name, its agent ID, the model it runs and basic capacity information to nearby devices, and nearby devices can see it. Prompts and outputs exchanged with a nearby device travel over Bluetooth to that device. See [Bluetooth mesh](/bluetooth) for exactly what is shared.

## How we use information

- To provide the Service: accounts and sign-in, routing and running jobs, measuring work, pricing, billing, crediting and paying Hosts, and showing you your history.
- To secure the Service: authentication, rate limiting, fraud and abuse detection, hardware verification, blacklisting, and investigating incidents.
- To communicate with you: verification emails, password resets, payout confirmations, security notices and changes to our terms.
- To meet legal obligations: tax, accounting, sanctions screening and responding to lawful requests.
- To understand and improve the Service using aggregate or de-identified data.

[COUNSEL: add legal bases for processing (GDPR Art. 6) per purpose: contract, legitimate interests, legal obligation, consent.]

## How we share information

- **Hosts** receive the prompts, code and data of jobs their machines run, as described above. We do not intentionally send your email address to Hosts with a job [ENGINEERING TO CONFIRM exactly which requester identifiers a Host receives].
- **Other users** may see public network information such as agent IDs, hardware class, verification status and country, and market orders and trades without account details.
- **Service providers** that process data for us: hosting (Fly.io), DNS and edge (Cloudflare), email delivery (Resend), error tracking (Sentry), and sign-in providers you choose to use (Google, Microsoft, GitHub). [COUNSEL: confirm the full list and data-processing agreements.]
- **The Bitcoin and Lightning networks:** payments you make or receive are recorded or routed there and may be public or visible to routing nodes. Ledger checkpoints anchored on Bitcoin contain hashes, not personal data.
- **Legal and safety:** when required by law or legal process, or to protect the rights, property or safety of EdgeCoder, our users, Hosts or the public.
- **Business transfers:** in a merger, acquisition or sale of assets, subject to this policy.

We do not sell your personal information and we do not share it for cross-context behavioral advertising.

## Retention

- Account information: while your account is open, then [RETENTION PERIOD] after closure, except what we must keep for legal, tax, accounting or fraud-prevention reasons.
- Ledger, payment and payout records: [RETENTION PERIOD — e.g. 7 years] for accounting and tax purposes. Some ledger records are hash-chained and anchored, so they cannot be edited; personal data is kept out of them where possible.
- Portal chat conversations: until you delete them or close your account.
- Usage records and job queue data: [RETENTION PERIOD].
- Server logs and rate-limit records: [RETENTION PERIOD — e.g. 30 days].
- Machine telemetry: [RETENTION PERIOD].

## Security

We use measures including password hashing, passkeys, hashed API keys and tokens, signed agent requests, encryption in transit (TLS), task-payload encryption where supported, sandboxed execution on Hosts, and access controls for administrators. No system is perfectly secure, and the Service runs work on machines we do not control. If we learn of a breach affecting your personal information, we will notify you as the law requires.

## Your rights and choices

- **Access, correction, deletion and portability.** You can see and change much of your information in Settings, and delete chat conversations yourself. To request a copy of your data or deletion of your account, email [CONTACT EMAIL]. We will verify your request and respond within the time the law requires.
- **GDPR (EEA, UK, Switzerland).** [GDPR SECTION: controller identity and representative, legal bases, rights to object and restrict processing, right to withdraw consent, right to complain to a supervisory authority, international transfer mechanism.]
- **CCPA/CPRA (California) and other U.S. states.** [CCPA SECTION: categories of personal information collected in the past 12 months, sources, purposes, categories of recipients, "we do not sell or share", rights to know, delete, correct and limit, non-discrimination, authorized agents, and request methods.]
- **Email.** Service emails (verification, security, payouts, terms changes) are part of the Service. We do not send marketing email without your consent.
- **Bluetooth.** You can turn Bluetooth mesh off in the desktop app (Settings > General). See [Bluetooth mesh](/bluetooth).

## Cookies and local storage

The portal uses a session cookie to keep you signed in and a short-lived cookie to protect single sign-on against forgery. The site and apps store your theme preference in your browser's local storage, and the desktop app stores local chats, settings and agent data on your computer. We do not use advertising or third-party tracking cookies or analytics cookies.

## Children

The Service is not directed to children and is not for anyone under [MINIMUM AGE]. We do not knowingly collect personal information from children under 13 (or the higher age required where you live). If you believe a child has given us personal information, contact [CONTACT EMAIL] and we will delete it.

## International transfers

EdgeCoder is based in the United States, and Hosts may be anywhere in the world. Your information, including jobs you run on the network, may be processed in countries other than yours. [COUNSEL: transfer mechanism.]

## Changes

We may update this policy. We will post the new version with a new version label and effective date and, for material changes, notify you by email or in the Service.

## Contact

EdgeCoder, LLC · [MAILING ADDRESS] · [CONTACT EMAIL] · Privacy requests: [PRIVACY EMAIL]
