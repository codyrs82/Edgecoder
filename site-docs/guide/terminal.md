---
title: "Terminal: edgecoder code"
description: Run EdgeCoder's coding agent in a terminal, choose where models run, approve its edits and commands, and continue the session in the desktop app with /remote.
---

# Terminal: `edgecoder code`

`edgecoder code` is EdgeCoder's coding agent in your terminal. It works in a folder, or in a GitHub
repository it clones first, with the same agent loop and tools as the desktop app's Code view:
reading and searching files, editing them, running commands, git and pull requests. With `/remote`,
the same session continues in the desktop app.

## Install

**With the desktop app:** open **Settings → General → Command line → Install command-line tool**. It
writes a small launcher that runs the agent bundled in the app:

- macOS: `~/.local/bin/edgecoder`
- Windows: `%LOCALAPPDATA%\EdgeCoder\bin\edgecoder.cmd`

The app tells you whether that folder is on your `PATH`. If not, add it (macOS:
`export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`) and open a new terminal.

**Linux hosts** installed with the [agent installer](/guide/install-desktop#linux-and-gpu-servers)
have the agent but no desktop app; see [Without the app](#without-the-app).

## Usage

```sh
cd ~/EdgeCoder/my-app && edgecoder code                       # work in this folder
edgecoder code --repo https://github.com/OWNER/REPO           # clone (or update) into ~/EdgeCoder, then work there
edgecoder code --model network/qwen3-coder:30b --remote       # a network model, shown in the app from the start
edgecoder code --resume <session-id>                          # continue a saved session (--list shows them)
```

The first time in a folder it asks once whether to trust it. A trusted folder may run its own
tooling (type checkers, linters) by itself. The agent's own commands still ask first.

| Option | Meaning |
| --- | --- |
| `--repo <url\|owner/repo>` | Clone into `~/EdgeCoder` (or update the copy already there). |
| `--model <id>` | A local Ollama model, `network/<model>[@cpu\|apple\|gpu\|gpu.dc]`, `mine/<model>`, or `auto` (the default). |
| `--compute local\|network\|mine\|auto` | Where the model runs. |
| `--mode ask\|auto-edits\|auto\|plan\|full` | How much it asks first (below). |
| `--remote` | Show the session in the desktop app from the start. |
| `--resume <id>`, `--list` | Continue a saved session, or list them. |
| `--api-key-file <path>` | An `eck_` API key for network models without the app. |

While it runs, replies stream as the model writes them and each tool call prints on one line. You can
type at any time: during a reply, Enter queues your message. **Esc** (or `/stop`) stops the reply.
`/undo` reverts the files the last reply changed. Each turn ends with a line saying which model ran
it, where, how long it took and what it cost.

## Approvals and modes

Before an edit the diff prints; before a command the command prints. Then it asks
`Allow …? [Y/n/a]` (Enter means yes; **a** means always for this project).

| Mode | Edits | Commands |
| --- | --- | --- |
| `ask` (Manual) | ask | ask |
| `auto-edits` (Accept edits) | apply, each turn undoable | ask |
| `auto` | apply | safe ones run (tests, lint, build, git add/commit on a work branch); risky ones ask; dangerous ones are refused |
| `plan` | refused | read-only only, until you approve the plan with `/approve` |
| `full` (Full access) | apply | run without asking (pushes and PRs too); only sudo, wiping a disk or the project, download-and-run and secrets are refused. Set with `--mode full` or `/mode full`; Shift+Tab never cycles into it |

The default is `auto-edits` in a git repository with a clean working tree, otherwise `ask`.
**Shift+Tab** cycles the mode. Pushes and pull requests always ask, except in Full access.

## Commands

| Command | Does |
| --- | --- |
| `/model [name]`, `/compute [place]` | Show or set the model and where it runs. |
| `/mode [mode]`, `/approve [mode]` | Set the mode; approve a plan. |
| `/stop`, `/queue`, `/unqueue [n]` | Stop the reply; list or remove queued messages. |
| `/undo`, `/clear` | Revert the last reply's file changes; start the conversation over. |
| `/status`, `/cost` | Session, model, where the last call ran; cSats spent this session. |
| `/remote [off]` | Continue this session in the desktop app, or stop showing it there. |
| `/github` | Sign in to GitHub with a one-time code (uses the GitHub CLI, `gh`). |
| `/help`, `/exit` | Help, and leave. The session is kept. |

## `/remote`: continue in the desktop app

`/remote` (or `--remote`) publishes the session to the desktop app on **the same computer**. In the
app's **Code** view it appears under its project, marked **Live** while the terminal is attached.

Both sides work on it at once: either can send a message (queued during a reply), stop the reply,
approve or reject a tool call (the first answer wins and the other side's prompt closes), and change
the model or mode. `/remote off` stops showing it in the app.

The session server listens on `127.0.0.1` only and every request needs a local token, so web pages
and other machines can't reach it. Controlling a terminal session from another computer isn't
available. To work from your phone, use **Code** in the [iOS app](/guide/ios-app#code), which drives
sessions on a computer whose desktop app has **Code from your phone** turned on. The same sessions
are on the web too: see [Code on edgecoder.io](/guide/ios-app#code-on-edgecoder-io).

## Without the app

If the desktop app isn't running (for example on a server over SSH), `edgecoder code` starts its own
session server inside the process. Network models then go through this machine's agent if it is
enrolled, or else through the hosted API (`https://edgecoder.io/v1`) with your API key, set in
`EDGECODER_API_KEY` or passed with `--api-key-file`. Usage is billed to the key's account in cSats.

Sessions are saved in `~/.edgecoder/sessions` (one file each, readable only by you).

## Your own frontier model key

You can let a frontier model lead on your own provider API key, with network models as helpers:

```sh
edgecoder keys add anthropic           # once; asks for the key (hidden)
edgecoder code --lead frontier/anthropic/<model> --worker auto
```

The key stays in your keychain and is used only for your account on this computer, never for other
people's work. Calls go straight to the provider, which bills you; EdgeCoder charges no cSats for
them. A per-session and a daily spending cap (defaults $5 and $25) warn at 80 % and stop at 100 %.
