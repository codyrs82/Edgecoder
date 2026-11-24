---
title: iOS App
description: Use EdgeCoder on iPhone and iPad - chat, code sessions on your computers, bots, your machines and the network.
---

# iOS App

EdgeCoder for iPhone and iPad is a coding assistant in your pocket. You can chat with a model, drive a
coding session that runs on one of your computers, message your bots, and check your machines and the
network.

## Install and sign in

1. Install **EdgeCoder** from the [App Store](https://apps.apple.com/app/id6759273340).
2. Open it and sign in with your EdgeCoder account (the same one you use on edgecoder.io and in the
   desktop app). If you don't have one yet, create it at [edgecoder.io](https://edgecoder.io).
3. That's it. After you sign in, the app enrolls this device with your account by itself. There is no
   coordinator address or token to paste.

The app has five tabs: **Chat**, **Bots**, **Wallet**, **Machines** and **Network**.

## Chat and Code

The first tab has a **Chat | Code** switch at the top. The app remembers the last one you used.

### Chat

A conversation with a model. Tap the model name to open the model picker, which has these sections:

| Section | What it is |
| --- | --- |
| **Auto** | Your machines first, then the network. The recommended choice. |
| **On This Device** | Small models that run on the iPhone or iPad itself. Free. A model shows **Not downloaded** until you download it. |
| **Nearby Devices** | Models on devices found nearby over Bluetooth. Free. The section only appears when such a device is found. |
| **My machines** | Models on your own computers and servers signed in to your account. Free. |
| **EdgeCoder Network** | Models on other people's machines, with the size, the cost in cSats and how many machines serve each one. A model with no machines online shows **No agents**. |

Work on your own device and your own machines costs nothing. Network models are paid from your cSats
balance.

### Code

Code mode drives a coding session that runs **on one of your computers**, not on the phone. The phone
sends messages and approvals; the computer does the reading, editing and running.

1. On the computer, open the EdgeCoder desktop app, turn on **Code from your phone** in Settings, and
   open and trust the project folder you want to work in.
2. On the phone, switch to **Code**. **Your computers** lists each computer with its trusted projects
   and sessions.
3. Open a session, or tap **New session**, pick the project and the mode, and send a message.

While a session runs you can send messages (they queue while a reply is running), **Stop** the reply,
approve or deny tool calls, approve a plan, and **Undo last turn**. Sessions started on the phone
are marked **Started from your phone**.

For safety, commands that aren't read-only always ask first, paths outside the project are refused,
and approving from the phone never adds an "always allow" rule or turns on automatic edits. Very long
commands must be approved on the computer.

See [Terminal: `edgecoder code`](/guide/terminal) for how sessions work on the computer.

### Code on edgecoder.io

The same sessions are on the website. Sign in at [edgecoder.io](https://edgecoder.io/portal) with
the account that is signed in on the computer, and open **Code** in the sidebar (under **Chat**).

- **Code** lists each of your computers: online or offline, and whether **Code from your phone** is
  **On**, **View only** or **Off**. Under each one are its trusted projects and their sessions,
  newest first. **New session** starts one in a project, as on the phone.
- Open a session to read the conversation: messages, each reply's tool steps (collapsed), the files a
  turn changed (open one to see its diff), and the session's model and cSats so far. It updates by
  itself while a turn runs. A session has its own link (`/portal/code/<computer>/<session>`) you can
  bookmark.
- Send a message (it queues while a reply runs), **Allow** or **Deny** a tool call, approve a plan,
  **Stop** the reply, **Undo last turn**, remove a queued message, or switch the mode between **Ask**,
  **Accept edits** and **Plan**.

The website goes through the same relay as the phone and follows the same rules: only the account
signed in on the computer can see or drive its sessions, **Allow** covers that one call (an "always
allow" rule and **Auto** mode are set on the computer only), and very long commands must be approved
on the computer. Nothing from a session runs in the browser; code and output are shown as text.

If a computer is offline, or **Code from your phone** is **Off** or **View only**, the page says so:
open the EdgeCoder desktop app on it, go to **Settings**, and set **Code from your phone** to **On**.

## Bots

The **Bots** tab lists your bots: cloud bots, which run on EdgeCoder's servers with no machine of
yours, and desktop bots, which run on one of your machines. You can:

- read a bot's conversation and send it a message;
- pause or resume it, and answer its approvals when its machine allows control from the web;
- tap **New bot** to create one in the **Cloud** or on one of your machines, with a schedule
  (**None**, **Every few hours** or **Daily**) and an optional GitHub repository.

A GitHub token you enter for a cloud bot is sent once to create the bot and isn't saved on the
device. See [Bots, cloud bots and web search](/guide/bots).

## Machines

The **Machines** tab lists the machines signed in to your account: each one's name, whether it is
online (or when it was last seen), the model it serves and how many bots run on it. Pull down to
refresh.

No machines yet? Add one with the [desktop app](/guide/install-desktop) on a Mac or Windows PC, or
on a [Linux or GPU server](/guide/cloud-gpu-server).

## Wallet

The **Wallet** tab shows your cSats balance (1 cSat = 1 sat), what you've spent it on, and current
prices for model calls and machines. cSats pay for network models, code jobs and reserved machines;
your own device and your own machines are free.

The App Store app doesn't sell cSats. To add cSats, buy them on the website: see
[Buy cSats](/guide/buy-csats). They show up in the app as soon as the payment lands.

## Network

The **Network** tab shows the EdgeCoder network as a live map: every coordinator and the machines
connected to it. Your own machines are named and highlighted; other people's machines are unlabeled
dots. While a reply is running it shows which coordinator and machine are handling your request.

## Privacy

Chats with network models are processed on the machine that runs the model, and the coordinator that
routes them sees them too. Don't put passwords, keys or other secrets in a prompt. See
[Trust and Security](/security/trust-and-security) and the
[Privacy Policy](https://edgecoder.io/privacy).
