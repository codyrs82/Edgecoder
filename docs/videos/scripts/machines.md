---
step: machines
name: machines
title: Add your other machines
tts: kokoro
voice: af_heart
---

# Add your other machines (narration script)

The explainer for the Getting started guide's **Add your other machines** step (`/portal/welcome/machines`,
`data-video-anchor="welcome-machines"`). Built by `node scripts/videos/build.mjs machines`; format in
[how-it-works.md](how-it-works.md) and [../README.md](../README.md).

Facts checked against `src/common/onboarding.ts` (the step, LOCAL_NETWORK_NOTE, installCommand) and
`src/portal/pages/welcome.ts`.

### intro
focus: title

Next, add your other machines. Every machine you own is more free compute for you.

### count
focus: sel:.wz-live

This line shows how many machines are on your account, and how many are online.

### desktop
focus: sel:.wz-live + h3, .wz-live + h3 + p

On a Mac or a Windows PC, install the desktop app. Sign in with the same account.

### linux
focus: sel:.wz-code

For Linux and GPU servers, get an install token from Settings, Nodes. Then run this installer command on the server.

### gpu
focus: sel:.wz-code + p

Each GPU gets its own agent, with a model sized to its memory.

### lan
focus: sel:.wz-note

On a Mac, allow Local Network access when macOS asks. EdgeCoder uses it to find your other machines, and reach them directly.

### check
focus: sel:[data-item=second-machine]

When a second machine connects, this checks off.

### skip
focus: sel:#wzSkip

Only have this one computer? You can skip this step.
