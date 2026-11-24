---
title: Web Chat and Privacy
description: Chat with models on edgecoder.io, choose where each chat runs, search the web, and control how your chats are stored and used.
---

# Web Chat and Privacy

The web chat at [edgecoder.io/portal/chat](https://edgecoder.io/portal/chat) is a coding assistant in
your browser. Sign in, start a chat, and pick where it runs.

## Where a chat runs

The compute picker above the message box lists:

| Group | What it is | Cost |
| --- | --- | --- |
| **Default → Auto** | The network's best fit: the coordinator picks the model and the machine. When it can't, EdgeCoder's default chat model answers. | Network work is billed in cSats |
| **Default → EdgeCoder · *model*** | EdgeCoder's own default chat models. | Free |
| **My machines · free** | Models on machines signed in to your account. | Free |
| **Network · billed in cSats** | A specific model on the network, optionally on one class of hardware. Cloud models are listed here too, marked **Cloud · recommended** (DeepSeek V4.1 Flash) or **Cloud · premium** (GLM-5.3) and **hosted model API**: a host forwards them to a hosted model provider. | Per token, in cSats |
| **Reserved** | A machine you reserved (see [Using network compute](/guide/using-compute#reservations)). | Prepaid by the reservation |

Each reply says where it ran and, for network work, what it cost. If you run out of cSats, the chat
says so; see [Buy cSats](/guide/buy-csats).

You can paste, drop or attach images in the message box, but no chat model on the network reads
images yet. The chat says **This model can't read images** and keeps them in the box without
sending them. To show images to a coding agent, use **Code** (below).

## Searching the web

Under the message box, **Web: Auto** means the model may search the web and read pages when a
question needs fresh information: news, prices, release versions, a specific page. Coding questions
are answered without searching. Answers list their sources with links, and a footer such as
`2 searches · 1 page · 1.2 cSats`.

- The menu has **Auto** and **Off for this chat**.
- It needs a model that can call tools; otherwise it shows **Web: unavailable with this model**.
- Each search (0.5 cSats by default) and page read (0.2 cSats) costs a little. With no cSats the chat
  answers without the web and the indicator says **needs cSats**.
- A chat that runs on your own machine searches for free, within a daily allowance.

More in [Bots, cloud bots and web search](/guide/bots#web-search).

## Your conversations

The sidebar has a **Chat / Code** switch at the top. **Chat** lists your web chats. **Code** lists
the coding sessions on computers running the EdgeCoder desktop app, grouped by project, newest
first, each with the computer's name. A session runs on that computer, not in your browser. See
[Code on edgecoder.io](/guide/ios-app#code-on-edgecoder-io).

Conversations are titled from your first message. You can delete one
at any time; deleting a conversation deletes its messages. Messages can be up to 32,000 characters; the most recent part of
a long conversation is sent to the model as context.

## Privacy

- **Stored encrypted at rest.** Web chat messages and conversation titles are stored on EdgeCoder's
  servers encrypted with AES-256-GCM, under a key kept outside the database.
- **Not end-to-end encrypted.** EdgeCoder's servers decrypt your chats to show them to you and to send
  them to a model. The coordinator that routes a reply and the machine that runs the model see your
  messages in plaintext while they process them. On the network, that machine belongs to a host, a
  third party. Don't paste passwords, API keys, private keys or other secrets into a chat.
- **Your own machines.** A chat on **My machines** runs on a machine you control, but it still passes
  through EdgeCoder's portal and a coordinator.

### Share my chats (off by default)

**Settings → Profile → Privacy → Share my chats to help improve EdgeCoder** is **off** unless you turn
it on.

- While it's off, your chat content isn't used to improve EdgeCoder or to train models.
- While it's on, chats you share may be used to improve EdgeCoder, including to train AI models.
- Turning it off withdraws the chats you shared from future use. Models already trained on them are
  not retrained.
- Your chats stay encrypted at rest either way.

Developers: the setting is `GET /me/chat-sharing` and
`PUT /me/chat-sharing { "shareChatForImprovement": true | false }`.

See [Trust and Security](/security/trust-and-security#web-chat-privacy) for the details and the
[Privacy Policy](https://edgecoder.io/privacy) for retention and your rights.
