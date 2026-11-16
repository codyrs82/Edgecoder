---
step: try
name: try
title: Try it
tts: kokoro
voice: af_heart
---

# Try it (narration script)

The explainer for the Getting started guide's **Try it** step (`/portal/welcome/try`,
`data-video-anchor="welcome-try"`). Built by `node scripts/videos/build.mjs try`; format in
[how-it-works.md](how-it-works.md) and [../README.md](../README.md).

Facts checked against `src/portal/pages/welcome.ts` (the ideas, the reply footer) and the desktop
chat (`ChatMessage.svelte`: each reply shows where it ran and what it cost).

### intro
focus: title

Now try it. Ask for something small.

### chat
focus: sel:.wz-list li:nth-child(1)

In Chat, ask a short question. For example: explain what a Lightning invoice is, in two sentences.

### code
focus: sel:.wz-list li:nth-child(2)

In the app's Code view, open a project, and ask it to explain a file.

### bot
focus: sel:.wz-list li:nth-child(3)

Or create a bot, with a small daily budget.

### footer
focus: sel:.wz-list + p

Every reply ends with where it ran, on your machine or the network. And what it cost.

### ask
focus: sel:[data-action=chat]

Ask in Chat opens a new chat.

### check
focus: sel:[data-item=first-task]

When your first task finishes, this checks off.

### outro
focus: next

Then press Next.
