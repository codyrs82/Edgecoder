---
step: tools
name: tools
title: Connect your tools
tts: kokoro
voice: af_heart
---

# Connect your tools (narration script)

The explainer for the Getting started guide's **Connect your tools** step (`/portal/welcome/tools`,
`data-video-anchor="welcome-tools"`). Built by `node scripts/videos/build.mjs tools`; format in
[how-it-works.md](how-it-works.md) and [../README.md](../README.md).

Facts checked against `src/portal/pages/welcome.ts` (the web step), `docs/terminal.md` (installing
the command-line tool, `/remote`) and `docs/API.md` (OpenAI- and Anthropic-style endpoints).

### intro
focus: title

Connect the tools you already use. Each one is optional.

### github
focus: sel:.wz-video + h3, .wz-video + h3 + p

Connect GitHub to clone your repositories, and open pull requests.

### api
focus: sel:.wz-code:has(#wzHostedApi)

The hosted API speaks the OpenAI and Anthropic formats. Create an API key in Settings. Then call it from Cursor, servers or scripts.

### editors
focus: sel:.wz-code:has(#wzLocalProvider)

With the desktop app running, editors like Continue, Zed and Claude Code can use its local provider, right on this computer.

### cli
focus: sel:.wz-code:has(#wzCli)

For the terminal, install the command-line tool from the app's Settings. Then run edgecoder code.

### remote
focus: sel:.wz-code:has(#wzCli) + p

Type /remote in a session to keep working on it in the app.

### outro
focus: next

Press Next when you're done.
