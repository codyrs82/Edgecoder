---
step: fund
name: fund
title: Fund your account
tts: kokoro
voice: af_heart
---

# Fund your account (narration script)

The explainer for the Getting started guide's **Fund your account** step (`/portal/welcome/fund`,
`data-video-anchor="welcome-fund"`). Built by `node scripts/videos/build.mjs fund`; format in
[how-it-works.md](how-it-works.md) and [../README.md](../README.md).

**Kept generic on purpose:** how payments work may change (a "pay from your own wallet" design is
under consideration). This script says only "fund with Lightning from the wallet page": no invoices,
amounts, limits or who holds the funds, so it stays true either way. Revisit it if the wallet page
changes its main button.

Facts checked against `src/common/onboarding.ts` (the step body, cSatsPerCall), `docs/economy-math.md`
(1 cSat = 1 sat) and `src/portal/pages/welcome.ts` (the estimator, bots' daily budget).

### intro
focus: title

Your own machines are free. You only need cSats for the network.

### estimate
focus: sel:.wz-est-controls, .wz-est-result

This estimate uses live prices. Choose how many calls a day, and a model size. It shows roughly what you'd spend.

### table
focus: sel:.wz-table

Bigger models cost more per call. One cSat is one sat.

### lightning
focus: sel:.wz-estimator + .wz-actions .wz-btn.primary

When you're ready, fund your account with Lightning, from the wallet page.

### bots
focus: sel:.wz-actions ~ p.wz-muted:last-of-type

Bots have a daily budget. So a bot never spends more than you allow.

### skip
focus: sel:#wzSkip

Only using your own machines? Skip this step.
