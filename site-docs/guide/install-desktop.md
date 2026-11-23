---
title: Install the Desktop App
description: Install EdgeCoder on a Mac or Windows PC, sign in, link your machines, and add Linux servers with the agent installer.
---

# Install the Desktop App

The EdgeCoder desktop app is a coding assistant and the agent in one: chat, the Code view, bots and
your connections to other tools, plus the agent and Ollama that let this computer run models. There
is nothing else to install.

| Platform | Download |
| --- | --- |
| Mac (Apple silicon) | [`EdgeCoder_aarch64.dmg`](https://github.com/codyrs82/Edgecoder/releases/latest/download/EdgeCoder_aarch64.dmg) |
| Windows (x64) | [`EdgeCoder_x64-setup.exe`](https://github.com/codyrs82/Edgecoder/releases/latest/download/EdgeCoder_x64-setup.exe) |
| Linux | No desktop app yet. Use the [agent installer](#linux-and-gpu-servers). |

The links always fetch the newest release (1.4.53 at the time of writing). All versions are on the
[releases page](https://github.com/codyrs82/Edgecoder/releases). On edgecoder.io the same links are
under **Settings → Install agent**.

## Mac

1. Download `EdgeCoder_aarch64.dmg`.
2. Open it and drag **EdgeCoder** to **Applications**.
3. Open EdgeCoder from Applications. If macOS says it can't check the app, open **System Settings →
   Privacy & Security** and click **Open Anyway**.
4. When macOS asks, allow **Local Network** access. EdgeCoder uses it to find your other machines on
   the same network and reach them directly. You can change it later in System Settings → Privacy &
   Security → Local Network.

## Windows

1. Download `EdgeCoder_x64-setup.exe`.
2. Run it and allow admin access if Windows asks.
3. Open EdgeCoder from the Start menu.

## First run and signing in

1. Sign in with your EdgeCoder account (email and password, or one of the sign-in providers shown),
   or create one with **Sign up**.
2. The **Getting started** guide opens by itself the first time. It suggests a model for this
   computer's memory and GPU and walks you through the rest. Reopen it any time from Settings →
   Getting started. See [Getting Started](/guide/getting-started).
3. Signing in links this computer to your account. It appears on edgecoder.io under **Settings →
   Nodes** and in the iOS app's **Machines** tab.

The app updates itself when a new release is published.

## Linking your other machines

Every machine signed in to the same account is one of **your machines**. Work you send to your own
machines is free, and **Auto** uses them before it uses the network.

- **Another Mac or Windows PC:** install the desktop app there and sign in with the same account.
- **A Linux computer or GPU server:** use the agent installer (next section).
- **iPhone or iPad:** install the [iOS app](/guide/ios-app) and sign in.

## Linux and GPU servers

Linux machines run the EdgeCoder agent without the desktop app, installed by `edgecoder-install`.

1. On [edgecoder.io](https://edgecoder.io) create an **install key**: **Settings → Getting started →
   Add your other machines → Create install key**, or an API key (it starts with `eck_`) under
   **Settings → Connect your tools**. It is shown once.
2. On the server run:

   ```bash
   curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo EDGECODER_API_KEY=YOUR_INSTALL_KEY bash install.sh --pull-models
   ```

   The installer checks everything it downloads (the EdgeCoder release is signed), installs Node.js,
   Ollama and Docker, sets up one agent per GPU (or one for the CPU) as `systemd` services, enrols
   each with your account and downloads the models.
3. Check it: `sudo edgecoder-install status` on the server, and **Settings → Nodes** on edgecoder.io.
4. Revoke the install key once the server is online (Settings → Connect your tools → Revoke). Each
   machine keeps its own credential.

Servers installed this way update themselves. The full walkthrough, with SSH keys, GPU sizes, vLLM
and troubleshooting, is [Run EdgeCoder on a cloud GPU or Linux server](/guide/cloud-gpu-server).

## The command-line tool

To use EdgeCoder from a terminal, open the desktop app's **Settings → General → Command line →
Install command-line tool**. See [Terminal: `edgecoder code`](/guide/terminal).

## Next steps

- [Use network compute and reservations](/guide/using-compute)
- [Bots, cloud bots and web search](/guide/bots)
- [Buy cSats](/guide/buy-csats)
- [Host for the network](/guide/hosting)
