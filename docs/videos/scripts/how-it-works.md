---
step: how
name: how-it-works
title: How EdgeCoder works
voice: en_GB-cori-high
---

# How EdgeCoder works (narration script)

The explainer for the Getting started guide's **How EdgeCoder works** step
(`/portal/welcome/how`, `data-video-anchor="welcome-how"`). Built by
`node scripts/videos/build.mjs how` (see [../README.md](../README.md)).

Format: each `### <segment>` is one stretch of narration. `focus:` names what the recording
highlights while it plays: `title`, `card:<n>` (the five numbered cards), `more` (the "Also in
EdgeCoder" cards), `more:<n>` (one of those) or `next` (the Next button). The text under it is both
what the voice says and the captions. Pronunciations (cSats, `/remote`) are in
`scripts/videos/lib.mjs`.

Facts checked against `src/common/onboarding.ts` (HOW_CARDS, HOW_MORE), `docs/economy-math.md`
(1 cSat = 1 sat; hosts 95 %, network 5 %) and the README (envelope encryption between the
coordinator and the agent, not end to end).

### intro
focus: title

Here's how EdgeCoder works. Five things to know.

### ask
focus: card:1

First, you ask. In a chat, a Code task, a bot, or through the API.

### pick
focus: card:2

Next, the coordinator picks the best fit. It matches your job to a model and a machine.

### run
focus: card:3

Then a machine runs it. Your own machines are free. A host's machine is paid per token.

### encrypt
focus: card:4

Jobs travel encrypted between the coordinator and the machine. It's not end to end: the coordinator can read a job, so it can route it. Work on this computer stays here.

### pay
focus: card:5

Network calls cost cSats per token. One cSat is one sat. Hosts keep 95 percent.

### bots
focus: more:1

Also in EdgeCoder: bots run on a schedule, with a daily budget.

### code
focus: more:2

Code is an agent. It edits your project, runs tests, and opens pull requests when you allow it.

### tentacles
focus: more:3

Tentacles are helpers on cheap models. They take parts of a big task at once.

### remote
focus: more:4

And type /remote in edgecoder code to carry on in the app.

### outro
focus: next

That's it. Press Next to set up this computer.
