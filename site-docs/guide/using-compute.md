---
title: Using Network Compute and Reservations
description: Run models through EdgeCoder from the desktop app and your own tools - connections, Auto routing, the hosted API, reservations, usage and pricing.
---

# Using Network Compute and Reservations

EdgeCoder runs models on this computer, on your other machines, or on the network. This page covers
using that compute from the desktop app and from your own tools.

All amounts are in cSats: **1 cSat = 1 sat** of prepaid compute. Your own machines are free; network
work is paid from your balance ([Buy cSats](/guide/buy-csats)).

## Where requests run

| Target | Where it runs | Cost |
| --- | --- | --- |
| **Auto** | The cheapest place that fits each request (below). | Free when it lands on your machines or a reservation |
| **This computer** | This computer's Ollama. | Free |
| **My machines** | Your other machines signed in to the same account. | Free |
| **Network** | Any machine on the network, optionally of one class: CPU, Apple, GPU or Datacenter GPU. You can set a maximum price. | Per token |
| **Reserved** | A machine you reserved. | Prepaid by the reservation |

### Auto routing

Auto picks a place for each request:

1. **Size the job.** A request that sends tools, or a prompt over about 6,000 tokens, is agent work;
   anything else is a quick task.
2. **Pick a model.** Nothing below 7B parameters is picked by default. Agent work prefers models near
   14B, coder models first; quick tasks take the smallest model that fits.
3. **Rank places, cheapest first:** an active reservation, this computer, your other online
   machines, then the network (faster classes first; CPU is skipped for agent work).
4. **Try in order**, up to four places.

If nothing fits, the request fails with a message asking you to install a coder model (7B or larger)
on one of your machines or to try again later.

## Connections (desktop app)

A connection is a local address on your computer that an OpenAI- or Anthropic-compatible tool can
use. Create one under **Connect your tools** in the desktop app. Each has a name, its own port
(from 4311 up), its own key (`ec-…`), a target and model, and an optional cSat budget: once spent,
requests fail with HTTP 402 until you raise it.

The model name your tool sends is ignored: the connection decides what runs.

| Route | API |
| --- | --- |
| `GET /v1/models` | OpenAI model list |
| `POST /v1/chat/completions` | OpenAI chat, streamed or not |
| `POST /v1/messages` | Anthropic Messages, streamed or not |
| `POST /v1/messages/count_tokens` | Anthropic token count |
| `GET /health` | `{"ok": true}`, no key needed |

Send the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. Connections accept only
loopback hosts and refuse requests from web pages.

```sh
curl http://127.0.0.1:4311/v1/chat/completions \
  -H "Authorization: Bearer ec-..." -H "Content-Type: application/json" \
  -d '{"model": "auto", "stream": true, "messages": [{"role": "user", "content": "hello"}]}'
```

**Connect your tools** shows the setup for each tool it supports, with the address and key filled
in. For example, Claude Code takes the base URL without `/v1`:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:4311
export ANTHROPIC_AUTH_TOKEN=ec-...
claude
```

## Hosted API

For servers, scripts and tools that call models from their own servers (so they can't reach a port
on your computer), use the hosted endpoint:

1. Create an API key on edgecoder.io under **Settings → Connect your tools → API keys**. Keys start
   with `eck_` and are shown once.
2. Point the tool at it:

```text
Base URL:  https://edgecoder.io/v1
API key:   eck_...
Model:     auto
```

It serves the same OpenAI and Anthropic routes. Requests are billed to your account in cSats. Name
the model per request:

| Model | Runs on |
| --- | --- |
| `auto` | The cheapest place that fits: a reservation, your machines, then the network |
| `network/<model>` or `network/<model>@<class>` | The network (a bare `<model>` means the same) |
| `mine/<model>` | Your own machines |
| `reserved/<reservation>/<model>` | A reservation you hold |

With the same key, `GET /v1/account` returns your balance and recent usage,
`GET /v1/account/usage?days=N` the usage records, `/v1/account/topup` buys cSats with Lightning, and
`/v1/account/reservations` lists, creates and cancels reservations. See
[API Endpoints Detailed](/reference/api-endpoints-detailed).

## Reservations

A reservation holds one machine of a class for a set time, so it works only for you. Make one on the
**Compute** page under **Reserve a machine** (desktop app or edgecoder.io), or through the API.

- Pick a class (the page shows how many machines are free), a duration (the app offers 15 minutes to
  8 hours; the network accepts 5 minutes to 24 hours) and optionally a model the machine must already
  have.
- The price is the class's per-second rate times the machine's tier weight, for every second held,
  used or not. It is paid up front from your cSats.
- While it runs, work on that machine isn't billed again.
- It ends when time is up, when you press **End**, or when the machine hasn't been seen for 2 minutes.
  **Unused time is refunded.**

To use it from a tool, create a connection with **Runs on: Reserved**, or press **Use in a tool**
next to it. Auto also uses an active reservation first.

## Usage

**Usage** in the desktop app's profile menu shows requests settled for your account over 7, 30 or
90 days, with a CSV export: cSats spent, requests, compute time, tokens, a daily chart, a breakdown by
model, class, tool and where it ran, and a request log. You can set a monthly budget there; it warns
at 80 % and when over, but doesn't stop requests. For a hard limit, set a budget on a connection.
On edgecoder.io, **Settings → Usage** shows your usage too.

Runs on this computer's Ollama aren't recorded there.

## Pricing

- **Model calls** are priced per token by model size, converted to cSats at a live BTC price, never
  below a small per-class electricity floor for the seconds they ran. The price is the same on every
  class; faster hardware finishes sooner.
- **Code jobs and reservations** are priced per second at the class's rate times the machine's tier
  weight.
- **Your own machines and this computer are free.**
- Of what you pay for work on someone else's machine, 95 % goes to that machine's owner and 5 % is
  EdgeCoder's network fee. Failed work isn't charged.

The **Compute** page lists current prices. The formulas are on [Hosting](/guide/hosting#how-jobs-are-priced).
