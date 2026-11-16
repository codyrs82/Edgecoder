---
step: models
name: models
title: Choose models and where they run
tts: kokoro
voice: af_heart
---

# Choose models and where they run (narration script)

The explainer for the Getting started guide's **Choose models and where they run** step (`/portal/welcome/models`,
`data-video-anchor="welcome-models"`). Built by `node scripts/videos/build.mjs models`; format in
[how-it-works.md](how-it-works.md) and [../README.md](../README.md).

Facts checked against `src/common/onboarding.ts` (ROUTING_OPTIONS, the step body) and
`src/portal/pages/welcome.ts` (bots' own setting, the frontier key in the desktop app).

### intro
focus: title

Now choose where your requests run.

### auto
focus: sel:.wz-choice:nth-of-type(1)

Auto is recommended. Each request goes to the best fit. That's one of your machines when it has a capable model, which is free. Otherwise, the network.

### local
focus: sel:.wz-choice:nth-of-type(2)

Local first tries this computer. Then your other machines. Then the network.

### only
focus: sel:.wz-choice:nth-of-type(3), .wz-choice:nth-of-type(4)

This computer only, and My machines only, never use the network. They're free.

### pick
focus: sel:.wz-choice:nth-of-type(5)

Or always use one model that you pick.

### agents
focus: sel:.wz-body

Code and bots need models that can use tools. The app only offers them those.

### frontier
focus: sel:.wz-choices ~ h3, .wz-choices ~ h3 + p

You can also add your own frontier key in the desktop app. Only your account uses it, and the provider bills you.

### outro
focus: next

Pick one, then press Next.
