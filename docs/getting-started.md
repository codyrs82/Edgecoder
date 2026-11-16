# Getting started

From zero to taking part: your machines, models, funds and tools. This page follows the
**Getting started** guide in the app and on the web, step by step.

- **Desktop app:** the guide opens by itself the first time you sign in. Reopen it from
  Settings → Getting started or the profile menu.
- **Web:** [`/portal/welcome`](https://edgecoder.io/portal/welcome), also under Settings →
  Getting started and the account menu.

Your progress is saved to your account, so you can stop and carry on later, on any computer or
on the web. Close the guide whenever you like.

Accounts are invite-only for now (`LAUNCH_MODE=invite`): you need an invite code to sign up.

| Step | Web URL | App route | Done when |
| --- | --- | --- | --- |
| 1. Welcome | `/portal/welcome/welcome` | `#/welcome/welcome` | you chose what you want to do |
| 2. How EdgeCoder works | `/portal/welcome/how` | `#/welcome/how` | you moved past it |
| 3. Set up this computer | `/portal/welcome/this-machine` | `#/welcome/this-machine` | a model is installed here (app), a machine is on your account |
| 4. Add your other machines | `/portal/welcome/machines` | `#/welcome/machines` | a second machine is on your account |
| 5. Choose models and where they run | `/portal/welcome/models` | `#/welcome/models` | you chose where things run |
| 6. Fund your account | `/portal/welcome/fund` | `#/welcome/fund` | your balance is above zero |
| 7. Connect your tools | `/portal/welcome/tools` | `#/welcome/tools` | you moved past it (GitHub, an API key and the CLI are optional) |
| 8. Try it | `/portal/welcome/try` | `#/welcome/try` | your first task finished |
| 9. Host for the network | `/portal/welcome/host` | `#/welcome/host` | you're approved to host |
| 10. Done | `/portal/welcome/done` | `#/welcome/done` | |

## 1. What do you want to do?

- **Use my own machines.** Run models on computers you own. Free, and open to everyone.
- **Buy network compute.** Run bigger models on other people's machines and pay per token.
- **Both.** Your machines first, the network when you need more.
- **Host for others.** Earn sats running other people's work. Hosting is by request.

Your answer changes the next steps: buying compute skips adding machines, and using only your own
machines makes funding optional.

## 2. How EdgeCoder works

1. **You ask.** A chat, a Code task, a bot, or a call to the API.
2. **The coordinator picks the best fit.** It matches the job to a model and a machine by
   capability, speed and price.
3. **A machine runs it.** One of yours (free), a machine you leased (already paid), or a host's
   machine (paid per token).
4. **Encrypted on the way.** Jobs travel encrypted between the coordinator and the machine. Work on
   this computer never leaves it. The coordinator can read network work; see
   [Security](../README.md#security).
5. **You pay per token.** Network calls cost cSats by model size; 1 cSat = 1 sat. Hosts get 95 %,
   the network 5 %.

Also: **bots** run on a schedule with a daily budget; **Code** is an agent that reads and edits a
project; **tentacles** are helpers on cheap models that take parts of a big task at once
([tentacles.md](tentacles.md)); **remote co-editing** (`/remote` in `edgecoder code`) continues a
terminal session in the app ([terminal.md](terminal.md)).

## 3. Set up this computer

The desktop app (Mac and Windows) bundles the agent and Ollama, and updates and restarts itself.
Download it from the [latest release](https://github.com/codyrs82/Edgecoder/releases/latest).

The app suggests a model for this computer's memory and GPU (all can use tools, so agents can run
on them) and downloads it with progress:

| This computer | Suggested |
| --- | --- |
| A GPU, or a Mac with 32 GB or more | `qwen3-coder:30b` (a 30B coder) |
| 16 GB or more | `qwen3.5:9b` (7–9B) |
| 8 GB | `qwen3.5:4b` |
| Less | `qwen3.5:2b` |

More models: Settings → Models.

## 4. Add your other machines

Every machine you own adds free compute for you.

- **Mac and Windows:** install the desktop app and sign in with the same account.
- **Linux and GPU servers:** get a token from Settings → Nodes on the web, then run the installer
  ([install.md](install.md); vLLM for big GPUs: [inference-engines.md](inference-engines.md)):

  ```sh
  curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --token <token>
  ```

On a Mac, allow **Local Network** access when macOS asks. EdgeCoder uses it to find your other
machines on the same network and reach them directly. You can change it in System Settings →
Privacy & Security → Local Network.

The guide shows your machines as they connect. Each machine's models are under Settings → Nodes
on the web, where you can change them remotely.

## 5. Choose models and where they run

| Choice | What it does |
| --- | --- |
| **Auto** (recommended) | Best fit for each request: your machines when one has a capable model (free), else the network. |
| Local first | This computer first, then your machines, then the network. |
| This computer only | Never leaves this computer. Free. |
| My machines only | This computer and your other machines. Free, never the network. |
| Specific model | Always the model you pick in the chat's compute menu. |

In the app, Auto and This computer only set the chat's compute menu. Bots have their own setting
in the bot form. Agents (Code, bots) run only on tool-capable models.

Optional: bring your own frontier key (Settings → General in the app) to lead with a frontier
model. Only your account uses it and the provider bills you ([frontier-keys.md](frontier-keys.md)).

## 6. Fund your account

Your own machines (and a machine you leased) are free. Network calls cost cSats per token, by
model size. The guide estimates your cost from the live prices: pick calls per day and a model
size, and it shows about how many calls 1,000 cSats buys. A typical agent call (about 8,300 tokens
in, 130 out) on a 30B model is about 2.8 cSats.

- **Buy cSats → Fund with Lightning:** live.
- **Fund with Bitcoin** (on-chain): shown as "Coming soon" until it is turned on
  (`ONCHAIN_ENABLED`).
- During the invite launch, purchases have a daily cap, shown in the Wallet.
- Bots have a daily budget, so a bot never spends more than you allow.

The step offers three choices, by what you want to do:

- **Buy cSats for on-demand compute** (the default): prepaid credit for EdgeCoder compute only,
  drawn down per call. It can't be cashed out; failed work is credited back.
- **Connect a wallet to pay hosts directly for reservations**: reservations, blocks of time and
  whole-server commitments are paid from your own wallet straight to the host (Lightning, Bitcoin
  on-chain or Zcash), plus EdgeCoder's 5 % to EdgeCoder's own address. Shown when the coordinator
  turns direct payments on ([design](../design/noncustodial-payments.md)).
- **Hosting? Set your payout addresses**: a Lightning address, a Bitcoin address or xpub, and a
  Zcash address with its incoming viewing key, so buyers can pay you directly.

Skip this step if you only use your own machines.

## 7. Connect your tools

- **GitHub:** clone repositories and open pull requests (Code → New project → Clone from GitHub).
- **Hosted API:** OpenAI-compatible `/v1/chat/completions` and Anthropic-style `/v1/messages` at
  `https://edgecoder.io/v1`, with an API key from Settings → Connect your tools on the web
  ([API.md](API.md)). Use it from Cursor, servers and scripts.
- **Editors on this computer:** Continue, Zed, Cline, Claude Code and other tools can use the app's
  local provider at `http://localhost:4304/v1`. Settings → Connect your tools in the app gives each
  tool its own key and setup ([using-compute.md](using-compute.md)). Cursor calls models from its
  own servers, so it uses the hosted API instead.
- **Terminal:** Settings → General → Command line → **Install command-line tool**, then
  `edgecoder code` in a project. Type `/remote` to keep working on the session in the app's Code
  view ([terminal.md](terminal.md)).

## 8. Try it

Ask for something small: a question in Chat, "explain this file" in Code, or a bot with a small
daily budget. Each reply ends with where it ran (your machine or the network) and what it cost.

## 9. Host for the network (optional)

Hosts earn 95 % of what their machines' calls cost. Hosting is by request: send the form at
[`/host`](https://edgecoder.io/host) and an admin reviews it (`HOST_APPROVAL_REQUIRED`). Until then
your machines run only your own work. What helps: a machine that stays on with a good connection,
and a model people use (a 30B coder on a GPU or a 32 GB+ Mac earns most).

## 10. Done

The guide lists what's set up and what you skipped; reopen any step from there.

## For builders

The steps are data in `src/common/onboarding.ts` (byte-identical copy in
`desktop/src/lib/onboarding.ts`, checked by `tests/common/onboarding.test.ts`). Progress is kept per
account in `portal_onboarding` and served by `GET`/`POST /portal/api/onboarding`
(`src/portal/routes/onboarding.ts`), which also reads the real state the checklists show. Each
step's panel carries `data-video-anchor="welcome-<step>"` and a video slot (`video.src`, `poster`,
`captions`) that stays hidden until set.
