# Run EdgeCoder on a cloud GPU or Linux server

This guide takes you from nothing to a rented GPU (or any Linux server) running EdgeCoder for your
account. You don't need to know Linux: copy each command, paste it, press Enter. It takes about
30 to 60 minutes, most of it waiting for downloads.

In the commands, replace anything in `CAPITALS` or between `<` and `>` with your own value, and
leave everything else exactly as it is. Lines that start with `#` are comments: you don't have to
type them.

**What you'll do:**

1. [Check what you need](#before-you-start)
2. [Make an SSH key](#1-make-an-ssh-key) (once per computer)
3. [Rent or prepare the server](#2-rent-or-prepare-the-server)
4. [Create an install key](#3-create-an-install-key) on edgecoder.io
5. [Connect to the server](#4-connect-to-the-server)
6. [Install EdgeCoder](#5-install-edgecoder)
7. [GPU servers: switch to vLLM](#6-gpu-servers-switch-to-vllm)
8. [Check it's online](#7-check-it-s-online)

Then: [keep it running](#keep-it-running), [stop and remove it](#stop-and-remove-it), and the
[troubleshooting FAQ](#troubleshooting-faq).

## Before you start

You need:

- **An EdgeCoder account with a verified email address.** Sign up at
  [edgecoder.io](https://edgecoder.io). Verify your email (the dashboard shows a reminder if you
  haven't): without it you can't create an install key and your machines can't sign in.
- **A Linux server running Ubuntu 22.04 or 24.04** that you can log in to. Either rent one (next
  sections) or use one you already have. It must be a full virtual machine or a real computer
  with `systemd`, not a container.
- **An NVIDIA GPU is optional.** Without one, EdgeCoder runs a small model on the CPU, which is
  slow. For a GPU, see [which GPU to rent](#which-gpu-to-rent).
- **At least 100 GB of free disk** for a GPU server (the model, vLLM and its CUDA libraries).
- **A computer to connect from:** a Mac, Windows 10/11 or Linux computer. They all have SSH built
  in.

The server needs no open ports except SSH (port 22): EdgeCoder only makes outgoing connections.

## 1. Make an SSH key {#1-make-an-ssh-key}

SSH is how you log in to a server from your own computer. An **SSH key** is a pair of files:

- the **private key** (`id_ed25519`) stays on your computer. Never share it, upload it or paste it
  anywhere. Anyone who has it can log in to your servers;
- the **public key** (`id_ed25519.pub`, ending in `.pub`) is the one you give to server providers.
  It's safe to share.

If you've made one before, skip to [step 2](#2-rent-or-prepare-the-server) and just copy your
public key from step 1c.

### 1a. Mac or Linux

Open **Terminal** (on a Mac: press `Cmd`+`Space`, type `Terminal`, press Enter) and run:

```bash
ssh-keygen -t ed25519
```

Press **Enter** to accept the file location. It asks for a passphrase: type one to protect the key
(recommended), or press Enter twice for none. Nothing shows while you type; that's normal.

### 1b. Windows

Open **PowerShell** (press the Windows key, type `PowerShell`, press Enter) and run:

```powershell
ssh-keygen -t ed25519
```

Press **Enter** to accept the location, then type a passphrase (or press Enter twice for none).

### 1c. Copy your public key

Mac:

```bash
pbcopy < ~/.ssh/id_ed25519.pub
```

Linux (then select the line it prints and copy it):

```bash
cat ~/.ssh/id_ed25519.pub
```

Windows PowerShell:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```

The public key is one line that starts with `ssh-ed25519`. It's now on your clipboard, ready to
paste into your provider's **SSH keys** page.

## 2. Rent or prepare the server {#2-rent-or-prepare-the-server}

::: danger Billing runs until you terminate the server
Cloud GPUs are billed by the minute or hour from launch until you **terminate** (delete) the
server, whether or not EdgeCoder is running, and closing SSH or your laptop doesn't stop it. On
most providers a stopped or powered-off server is still billed. When you're done, follow
[Stop and remove it](#stop-and-remove-it).
:::

### Which GPU to rent

EdgeCoder serves **Qwen3-Coder 30B**, a coding model built for agents, on every GPU from 24 GB
up. With vLLM (step 6), the GPU's memory decides how long a conversation can be (context) and how
many calls it serves at once:

| GPU memory | Examples | vLLM profile (`auto` picks it) | Model build | Context | Calls at once | Our advice |
| --- | --- | --- | --- | --- | --- | --- |
| 80 GB or more | H100, A100 80 GB, H200 | `a100-80` | FP8 (8-bit) | 64K | 12 | Best |
| 44 to 48 GB | L40S, RTX A6000, A40, RTX 6000 Ada | `gpu-48gb` | AWQ (4-bit) | 64K | 6 | Very good |
| 40 GB | A100 40 GB | `a100-40` | AWQ (4-bit) | 64K | 4 | Good |
| 22 to 37 GB | A10, L4, RTX 3090, RTX 4090 | `gpu-24gb` | AWQ (4-bit) | 16K | 1 | Works, but tight: Ollama does about as well here |
| 2 × 16 GB | 2× A16 | `a16x2` (install with `--single`) | AWQ over both cards | 64K | 2 | OK |
| Under 22 GB | T4, one A16, smaller cards | none | Ollama picks a smaller model | | | Stay on Ollama; skip step 6 |

vLLM needs an NVIDIA GPU from 2020 or later (Ampere, Ada or Hopper: A10, A100, L4, L40S, H100,
RTX 30xx/40xx/50xx). Older cards such as the V100 or T4 stay on Ollama.

A server with several GPUs runs one agent per GPU. If it has **4 or more GPUs of 40 GB or more**,
add `--per-gpu` to the install command in step 5, so each card gets its own agent and its own vLLM.

### Lambda

1. Sign in to Lambda's cloud dashboard and open **SSH keys**. Add a key and paste your public key
   from step 1c. (If you let Lambda generate a key instead, it downloads a `.pem` file: that's your
   private key. See [Connect with a downloaded key](#connect-with-a-downloaded-pem-key).)
2. Launch an instance: pick the GPU (for example **1× A100 (40 GB)**), a region, the
   **GPU Base 22.04** image (Ubuntu 22.04 with the NVIDIA driver and CUDA), and the SSH key from
   step 1. You don't need to attach a filesystem.
3. Wait until the instance is running and copy its **IP address**. The login user is `ubuntu`.

Lambda instances can't be paused: you're billed until you terminate them.

### Vultr

1. In the Vultr dashboard open **Account → SSH Keys**, add a key and paste your public key.
2. Deploy a **Cloud GPU** server: pick the GPU, **Ubuntu 22.04** or **24.04**, and tick your SSH
   key. Vultr's GPU images come with the NVIDIA driver.
3. Copy the server's IP address. The login user is `root`.

A stopped Vultr server is still billed: destroy it when you're done.

### RunPod, Vast.ai and other "GPU pods"

Their usual GPU **pods** are containers, not full servers: they have no `systemd`, so the
EdgeCoder installer can't set up its services there. Choose a provider's full virtual machine or
bare-metal offering instead, or use Lambda, Vultr or another provider from this page.

### Any other provider or your own server

Any Ubuntu 22.04 or 24.04 machine works: a VPS, a dedicated server or a PC at home. You need to
log in as `root` or as a user who can use `sudo`. Your provider's dashboard tells you the IP
address and the login user (often `ubuntu` or `root`). For a GPU, the NVIDIA driver must be
installed (version 550 or newer for vLLM); check after you connect with `nvidia-smi` and see
[the FAQ](#nvidia-smi-command-not-found) if it's missing.

## 3. Create an install key {#3-create-an-install-key}

The installer signs your server in to your account with an **install key** (an EdgeCoder API key).
It's the easiest way: one key enrols every GPU on the server, and it works on any number of
servers.

**From the Getting started guide (easiest):** on [edgecoder.io](https://edgecoder.io) open
**Settings → Getting started → Add your other machines** and click **Create install key**. The
install command in step 3 of that page then has your key filled in: copy it from there in step 5.

**Or from Settings:** open **Settings → Connect your tools**. Under **API keys**, type a name such as
`GPU server` and click **Create key**. Copy the key that starts with `eck_`.

Keep the key private:

- it's shown **only once**: if you lose it, create another;
- it doesn't expire, and anyone who has it can act as your account (including spending your
  cSats). Once your server is online, **revoke it** (the **Revoke** button next to it under
  Settings → Connect your tools). Your server keeps working: each machine gets its own
  credential when it enrols.

::: details Advanced: a node token instead of an install key
**Settings → Nodes → Enroll a node** makes a registration token for one node id (the
**Generate node token** button; the token is shown once and doesn't expire). A token belongs to
exactly one node id, and the agent must use **exactly that name**
([why](#node-names)). The page shows the install command with both filled in:

```bash
curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --token <node-id>=<token>
```

On a one-GPU (or CPU-only) machine the installer names the agent after the token's node id. A
server with several GPUs runs one agent per GPU, so it needs one enrolled node id and one
`--token <node-id>=<token>` per GPU, with the ids the installer gives them (`sudo edgecoder-install
plan` lists them). The install key avoids all of that.
:::

## 4. Connect to the server {#4-connect-to-the-server}

On a **Mac or Linux** open Terminal; on **Windows** open PowerShell. Then run, with your server's IP
address (and `root` instead of `ubuntu` if your provider uses root):

```bash
ssh ubuntu@SERVER_IP
```

For example `ssh ubuntu@192.0.2.10`.

The first time, SSH asks:

```text
The authenticity of host '192.0.2.10' can't be established.
ED25519 key fingerprint is SHA256:....
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

That's normal for a new server: type `yes` and press Enter. If you set a passphrase in step 1, type
it. You're in when the prompt changes to something like `ubuntu@192-0-2-10:~$`. Every command from
now on runs **on the server**, in this window.

### If SSH doesn't connect

| You see | What to do |
| --- | --- |
| `Permission denied (publickey)` | Check the user: Lambda and most GPU clouds use `ubuntu`, Vultr and many VPS providers `root`. Check the server was launched **with your SSH key** (adding a key to your account later doesn't change a running server). If your key isn't the default file, name it: `ssh -i ~/.ssh/MY_KEY ubuntu@SERVER_IP`. |
| `Connection timed out` | The server may still be starting: wait a minute. Check the IP address. Check the provider's firewall allows **TCP port 22** from anywhere (or from your IP). Some office and public Wi-Fi networks block port 22: try another network or a phone hotspot. |
| `Connection refused` | The server is still booting. Wait a minute and try again. |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` | You've used this IP for a different server before. If this is a new server, remove the old entry with `ssh-keygen -R SERVER_IP` and connect again. |
| `bad permissions` or `UNPROTECTED PRIVATE KEY FILE` | Run `chmod 600 ~/.ssh/MY_KEY` (Mac, Linux). |

#### Connect with a downloaded `.pem` key {#connect-with-a-downloaded-pem-key}

If your provider generated the key and you downloaded a `.pem` file, point SSH at it. Mac or Linux:

```bash
chmod 600 ~/Downloads/MY_KEY.pem
ssh -i ~/Downloads/MY_KEY.pem ubuntu@SERVER_IP
```

Windows PowerShell:

```powershell
ssh -i $env:USERPROFILE\Downloads\MY_KEY.pem ubuntu@SERVER_IP
```

## 5. Install EdgeCoder {#5-install-edgecoder}

On the server, paste this one line, with your install key from step 3 in place of
`YOUR_INSTALL_KEY` (the Getting started page shows it with the key already in):

```bash
curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo EDGECODER_API_KEY=YOUR_INSTALL_KEY bash install.sh --pull-models
```

It takes 5 to 15 minutes. What it does:

- downloads the installer, which checks everything it downloads before running it (Node.js,
  Ollama and the EdgeCoder release, which is signed);
- installs Node.js, Ollama, Docker (the sandbox for code jobs) and, on NVIDIA servers, NVIDIA's
  container toolkit. It never installs or changes your GPU driver;
- detects the GPUs and sets up **one agent per GPU** (or one for the CPU), each as a `systemd`
  service, with the best model for that GPU's memory;
- enrols each agent with your account using the install key (the key itself isn't stored on the
  server), and starts them;
- downloads each agent's model (`--pull-models`).

It ends with a summary of the agents, `Wrote ... files; services: ...` and a line about the Host
Agreement. Each agent is named after the server: `<server-name>-gpu` on a one-GPU server,
`<server-name>-gpu0`, `<server-name>-gpu1`, … with several GPUs, or `<server-name>-cpu` without
one. With the install key you don't need to know: it enrols each agent under the name it uses.

::: tip If other people can log in to this server
A key on the command line ends up in your shell history. To keep it out, type the key at a hidden
prompt instead:

```bash
read -rs EDGECODER_API_KEY     # paste the key, press Enter; nothing shows
curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo EDGECODER_API_KEY="$EDGECODER_API_KEY" bash install.sh --pull-models
```

To read the installer before it runs, download it first (`curl -fsSLo install.sh https://edgecoder.io/install.sh`),
look at it with `less install.sh`, then run the `sudo ... bash install.sh` part. The
[installer reference](https://github.com/codyrs82/Edgecoder/blob/main/docs/install.md) explains every check and option.
:::

## 6. GPU servers: switch to vLLM {#6-gpu-servers-switch-to-vllm}

Skip this on a server without an NVIDIA GPU of 22 GB or more.

The install runs each model on Ollama. **vLLM** serves the same model to several calls at once,
which is what a datacenter GPU is for. One command picks the settings for your GPU and switches:

```bash
sudo edgecoder-install apply --vllm-profile auto
```

`--vllm-profile` needs EdgeCoder agent 1.2.0 or later (`edgecoder-install help` lists it). On an
older install, update first; the agents keep their enrolment, so no install key is needed:

```bash
curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh
```

`auto` reads the GPUs with `nvidia-smi` and picks the profile from the
[table above](#which-gpu-to-rent) (a 1× A100 40 GB gets `a100-40`). It then installs vLLM, downloads
the model (17 GB, or 31 GB on 80 GB cards), turns that GPU's Ollama off and starts vLLM. Allow 10
to 30 minutes; the first start also compiles GPU kernels.

To see what it will do first, without changing anything:

```bash
sudo edgecoder-install plan --vllm-profile auto
```

Each GPU's line ends with `[installs vLLM, profile a100-40]` (or the profile for your GPU). If it says
no profile fits, your GPU is too small for vLLM: stay on Ollama.

To choose a profile yourself, name it instead of `auto`, for example
`sudo edgecoder-install apply --vllm-profile gpu-48gb`.

### Check vLLM is running

```bash
sudo edgecoder-install status
```

Every service should say `active`: `edgecoder-vllm@0.service` (vLLM for GPU 0) and
`edgecoder-agent-0.service` (the agent). Then:

```bash
journalctl -u edgecoder-vllm@0 -f
```

shows vLLM starting. Wait for `Application startup complete`, then press `Ctrl`+`C` to stop
watching (vLLM keeps running). Check it answers:

```bash
curl -s http://127.0.0.1:8000/v1/models
```

It prints the model's name and its `max_model_len`. And:

```bash
nvidia-smi
```

shows a process using most of the GPU's memory (vLLM reserves 92 to 95% of it for the model and
its cache; that's expected).

The agent's log says it found vLLM, with a line like
`vLLM at http://127.0.0.1:8000 serves ... as qwen3-coder:30b`:

```bash
journalctl -u edgecoder-agent-0 -n 100 --no-pager | grep -i vllm
```

With several GPUs, GPU 1 is `edgecoder-vllm@1` on port 8001, and so on. To go back to Ollama:
`sudo edgecoder-install apply --engine ollama`.

## 7. Check it's online {#7-check-it-s-online}

On the server:

```bash
journalctl -u edgecoder-agent-0 -n 200 --no-pager | grep registered
```

prints `registered with https://coordinator.edgecoder.io` once the agent has signed in.

On [edgecoder.io](https://edgecoder.io):

- **Settings → Nodes**, under **Your nodes**: each agent (`<server-name>-gpu`, …) is listed with
  **VERIFIED**, **APPROVED** and **ACTIVE**, and a recent **Last seen**. Under **Your machines'
  models** you can see and change each machine's model.
- **Settings → Getting started → Add your other machines**: **Machines on your account** counts it
  (it refreshes by itself every few seconds).

Your machines run your own work for free. To have them earn by running other people's work, request
to host in **Settings → Getting started → Host for the network**.

Now revoke the install key if you haven't (Settings → Connect your tools → Revoke).

## Keep it running

- **Closing SSH is fine.** The agents are `systemd` services: they keep running after you log out
  or close your laptop. You don't need `tmux`, `screen` or `nohup`.
- **Reboots are fine.** The services start by themselves when the server boots. To check:
  `sudo reboot`, wait a minute, connect again and run `sudo edgecoder-install status`.
- **Updates are automatic:** see [Updates](#updates) below.
- **Logs** live in the system journal: `journalctl -u edgecoder-agent-0 -f` (the agent),
  `journalctl -u edgecoder-vllm@0 -f` (vLLM), `journalctl -u edgecoder-ollama-0 -f` (Ollama).

## Updates {#updates}

The server updates EdgeCoder by itself. Every 6 hours it checks for a new signed release. When
there is one, it:

1. downloads it and checks its signature against EdgeCoder's release key (the same check the install
   command does), installing nothing that fails it;
2. waits until the agents have finished the work they are running (up to 10 minutes; if they are
   still busy it tries again at the next check);
3. installs it, keeping every setting: enrolment, node names, engine (vLLM stays vLLM), models and
   tuning;
4. checks the agents come back online. If they don't, it puts the previous version back by itself.

- **Update now:** `sudo edgecoder-install update` (add `--check` to only see whether one is out).
- **See what happened:** `sudo edgecoder-install status` shows the version, whether automatic
  updates are on, and the last check with its result; `journalctl -u edgecoder-update` has the
  details. The portal's machine list shows each machine's version and **UPDATE AVAILABLE** when it
  is behind.
- **Turn automatic updates off:** `sudo edgecoder-install apply --auto-update off`. Turn them back on
  with `--auto-update on`.
- **Installed before automatic updates existed?** Run the install command one more time, with the
  options you installed with; from then on the server updates itself:

  ```bash
  curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh
  ```

The reference: [Updates in the installer docs](https://github.com/codyrs82/Edgecoder/blob/main/docs/install.md#updates).

## Stop and remove it

1. **Remove EdgeCoder** from the server (stops and deletes its services and settings; downloaded
   models stay until the server is deleted):

   ```bash
   sudo edgecoder-install remove
   ```

2. **Remove the machines from your account:** Settings → Nodes → **Delete** next to each of them.
3. **Revoke the install key** if you still have it: Settings → Connect your tools → **Revoke**.
4. **Terminate the server** in your provider's dashboard (Lambda: **Terminate**; Vultr:
   **Destroy**). This is the step that stops the billing. Stopping or powering off usually isn't
   enough.

On a server you own and keep, also delete the files the installer left:
`sudo rm -rf /opt/edgecoder /var/lib/edgecoder /etc/edgecoder /var/log/edgecoder`.

## Troubleshooting FAQ

### The install says `run as root (sudo)`

Run the command exactly as shown, with `sudo`. If you log in as `root`, it works as is.

### The install stops with `enrolment failed for all ... node(s)`

The install key was wrong, revoked, or your email isn't verified. Create a new key (step 3) and run
the install command again. Running it again is always safe.

### `Machines on your account` stays at 0, or the node shows DORMANT

Run `sudo edgecoder-install status`: every service should be `active`. If one isn't, look at its
log, for example `journalctl -u edgecoder-agent-0 -n 100 --no-pager`. Check your email is verified
(Settings → Nodes shows **UNVERIFIED** otherwise). A new agent can take a minute or two to show up.

### The node shows offline or `n/a` last seen, and the agent log says `isn't enrolled` {#node-names}

Every agent signs in under its **node id**, and the network accepts it only if that exact name is
enrolled on your account (Settings → Nodes) and its registration token is that name's token.
Names are case-sensitive, and `lambda-a100-gpu0` is not `lambda-a100-gpu`. When they don't match,
the agent's service runs (`active`) but every sign-in is refused, so the node you enrolled never
comes online. The agent's log says so:

```text
[agent:nvidia-1-gpu] This machine's id "nvidia-1-gpu" isn't enrolled. Enroll it on edgecoder.io → Settings → Nodes with exactly this name, ...
```

and Settings → Nodes shows **A machine named `nvidia-1-gpu` tried to connect but isn't enrolled
under that name**. To fix it, pick one:

- **Use an install key** (step 3) and run the install command again: it enrols every agent under
  the name it uses.
- **Re-run the installer with your token:**
  `curl -fsSLo install.sh https://edgecoder.io/install.sh && sudo bash install.sh --token <node-id>=<token>`.
  On a one-GPU machine the installer names the agent after the token's node id.
- **Enroll the name the agent uses**: click **Enroll it** next to the message (or type the name
  from the log), **Generate node token**, and run the install command the page shows.

### `nvidia-smi: command not found` {#nvidia-smi-command-not-found}

The NVIDIA driver isn't installed. On Ubuntu:

```bash
sudo apt-get update && sudo ubuntu-drivers install
sudo reboot
```

Connect again after a minute and check `nvidia-smi` lists your GPU, then run the install command
again. On a cloud GPU it's usually quicker to relaunch with the provider's GPU image (Lambda's
**GPU Base**, Vultr's GPU images).

### `--vllm-profile auto found no vLLM profile`

Your GPU has less than 22 GB of memory, or isn't NVIDIA. Stay on Ollama: the install already set
up a model sized for it. With two 16 GB cards (2× A16), pool them: run `sudo edgecoder-install remove`,
then the install command again (with an install key) with `--single` added at the end, then the
vLLM command.

### vLLM keeps restarting, or its log says `CUDA out of memory`

Something else is using the GPU: `nvidia-smi` lists the processes. Otherwise switch to a smaller
profile. A profile is set when vLLM is first installed, so change it in three steps (here to
`gpu-24gb`; use `vllm-1.env` for GPU 1):

```bash
sudo edgecoder-install apply --engine ollama
sudo rm /etc/edgecoder/vllm-0.env
sudo edgecoder-install apply --vllm-profile gpu-24gb
```

### The disk is full

`df -h /` shows the free space. A GPU server needs about 100 GB: vLLM and its CUDA libraries (about
10 GB), the model (17 to 31 GB), Ollama's model (19 GB) and Docker. Resize the disk with your
provider, or launch a server with a bigger one.

### Do I need to open any ports?

No. EdgeCoder only connects out. Ollama and vLLM listen on `127.0.0.1` only, so they aren't
reachable from the internet. Keep just SSH (port 22) open.

### Is it safe to run the commands again?

Yes. The install command and `edgecoder-install apply` can be run as often as you like; they keep
each agent's enrolment, engine and settings.

### I think my install key leaked

Revoke it at once in Settings → Connect your tools. Your servers keep working: they use their own
credentials, not the key.

### Where can I read more?

- [Installer reference](https://github.com/codyrs82/Edgecoder/blob/main/docs/install.md): every
  option, what gets created, the service accounts and the release checks.
- [Inference engines](https://github.com/codyrs82/Edgecoder/blob/main/docs/inference-engines.md):
  vLLM and its profiles in detail.
- [Changing models from the portal](/guide/remote-model-control).
