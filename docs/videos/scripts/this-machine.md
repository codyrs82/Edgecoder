---
step: this-machine
name: this-machine
title: Set up this computer
tts: kokoro
voice: af_heart
---

# Set up this computer (narration script)

The explainer for the Getting started guide's **Set up this computer** step (`/portal/welcome/this-machine`,
`data-video-anchor="welcome-this-machine"`). Built by `node scripts/videos/build.mjs this-machine`; format in
[how-it-works.md](how-it-works.md) and [../README.md](../README.md).

Facts checked against `src/common/onboarding.ts` (the step, MODEL_SUGGESTIONS, INSTALL_LINKS) and
`src/portal/pages/welcome.ts` (the web step's text).

### intro
focus: title

Step three: set up this computer.

### app
focus: sel:.wz-video + p

Install the EdgeCoder desktop app on your Mac or Windows PC. It runs the agent and Ollama for you. And it keeps itself up to date.

### model
focus: sel:.wz-list

The app suggests a model sized for this computer. A good GPU, or a Mac with 32 GB or more, gets a 30B coder. With 16 GB, a 9B model. Smaller machines get a smaller model, and send bigger jobs to the network.

### download
focus: sel:[data-action=mac], [data-action=windows]

Download it for Mac or Windows here. Then sign in with this account.

### check
focus: sel:[data-item=machine-linked]

Once the app is signed in, this computer joins your account. This item checks off by itself.

### outro
focus: next

Then press Next.
