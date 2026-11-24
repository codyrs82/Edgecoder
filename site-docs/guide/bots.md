---
title: Bots, Cloud Bots and Web Search
description: Long-lived coding bots on your machines or on EdgeCoder's servers, their schedules, GitHub triggers and limits, and the web search tool.
---

# Bots, Cloud Bots and Web Search

A **bot** is a named, long-lived agent with a job: it answers your messages, works on a schedule, and
can react to GitHub events. There are two kinds, and both appear in one list on the web
([edgecoder.io/portal/bots](https://edgecoder.io/portal/bots)), in the desktop app and in the iOS
app's **Bots** tab.

| | Desktop bot | Cloud bot |
| --- | --- | --- |
| Runs on | One of your machines, in a project folder there | EdgeCoder's servers, no machine or folder needed |
| Tools | Read the project; optionally edit files, run commands, commit and push | Web search and page reading; GitHub through its API on one repository |
| Created from | The desktop app (or the web and iOS app, targeting a machine) | The web or the iOS app (**Runs on: Cloud**) |

## Desktop bots

A desktop bot owns a job in one project folder on one of your machines. Each run is one agent turn in
that folder on Auto compute.

| Setting | Details |
| --- | --- |
| Name, Role | The role is shown next to the name. |
| Instructions | Its job, added to the agent's instructions on every run. |
| Memory | Notes the bot saves for itself (up to 8 KB). You can edit or clear them. |
| Project folder | It reads and edits files only there. The form suggests `~/EdgeCoder/<name>`. A missing folder inside your home folder is created when you save; a folder anywhere else must already exist. |
| Schedule | `every N minutes/hours/days`, `hourly`, `daily`, `daily at HH:MM`, or a cron expression such as `0 9 * * 1-5`. At most every 5 minutes; local time. |
| Daily budget | cSats a day (default 100). Runs on this computer are free. |
| Tools | Reading is always on. Optional: Edit files, Run commands, Commit and push. |
| Lead with Claude (your key) | Off by default. Shown only when your account has a frontier key on this machine. Per-run cap (default $2) and daily cap (default $5) in USD. |

**Approvals.** Shell commands, commits and pushes always ask first: the run pauses with **Needs
approval** until you approve or reject. An unanswered approval is rejected after 24 hours. Turn off
**Apply edits without asking** to make file edits ask too.

**Running.** A bot with a job starts working when you create or resume it, then checks in on its
project every 30 minutes, waiting longer (up to 8 hours) while nothing in the project changes. It
never runs twice at once, starts at most **Runs a day** (48 by default) runs on its own, and stops
when its daily budget is spent. **Pause** stops everything it does on its own (messages still get
answers), **Stop** ends the current run, and **Check now** nudges it.

**Your frontier key.** Bots use your key only when only you can start them, and only after you
approve each use. With **Lead with Claude (your key)** on, a bot with no GitHub triggers asks in
its chat before a run uses your key: "Use Claude for this run? Up to $2.00." Choose **Approve this
run**, **Approve for today** (every run until midnight) or **Decline**. With no answer in 30
minutes, the run goes on with the bot's own compute. When a run reaches its cap, the bot asks
again. Claude leads the run, and the bot's compute does the rest. A run started by a GitHub trigger
never uses the key. Adding a GitHub trigger turns the switch off. The switch is set only in the
app; on the web you can see whether it is on and answer the bot's question. The bot's view shows
today's spend on your key next to its cSats. See [Frontier models on your own key](https://github.com/codyrs82/Edgecoder/blob/main/docs/frontier-keys.md#bots-and-your-key).

**Where each reply ran.** Under each reply, on the desktop and on the web, a line shows the model,
the kind of machine (for example a network GPU or this computer), the number of calls and the
cSats. **Runs** and **Last run** name the model and machine class that ran, instead of
`Network · best fit`, once the machine reports them. A run that fails shows `Couldn't run` with the
error's own words (up to 200 characters); hover it for the full text.

Desktop bots' settings and history stay on the machine (`~/.edgecoder/bots.json` and
`~/.edgecoder/bots/<id>/`).

## Cloud bots

A cloud bot runs on EdgeCoder's servers. Create one from the web or the iOS app with **Runs on:
Cloud**.

- **Compute:** **Auto** (default) uses your own online machines first, with a model that can call
  tools (free), and otherwise the network's best fit, billed to your account. You can also pick a
  model on your machines or on the network.
- **Web:** web search and page reading, on by default.
- **Schedule:** none, every N minutes (15 minutes to 7 days), or daily at a UTC time. It also runs
  when you message it.
- **GitHub (optional):** one repository (`owner/repo`) and a token. Triggers: a pull request opened,
  a CI run failed, or an issue labelled (`bot` by default). The repository is checked every few
  minutes.
- **Limits:** cSats per day (default 100) and per run (25), runs a day (48), and model turns per run
  (12, at most 30). A run that hits a limit stops and says why.

**What a cloud bot can do on GitHub:** read files, pull requests and issues, comment, and open a pull
request from a new `edgecoder/…` branch (at most 10 files and 200 KB). It never pushes to the default
branch, merges, deletes or force-pushes, and it refuses to touch `.github/`, `.git` and
`.gitmodules`. After it has read a web page in a run, its GitHub writes are refused for the rest of
that run. It has no shell and no file system.

**Your GitHub token** is sent when you create or update the bot and stored encrypted (AES-256-GCM).
Bot reads never return it. Give it the least scope: a fine-grained token for one repository with
contents, issues and pull requests. Text in issues and pull requests in that repository can still
steer what the bot writes, so review its pull requests before merging.

Commands from the web or the app: **message**, **pause**, **resume**, **Check now**, **stop**, edit
settings, and delete (which removes the bot, its conversation and its runs). Cloud bots never wait
for approval and don't keep notes yet.

## Web search

Chats (desktop app and web chat) and bots can search the web (`web_search`) and read a page
(`read_page`), and answers cite their sources.

- **Chats:** **Web: Auto** under the message box lets the model decide when a question needs fresh
  information. Choose **Off for this chat** to turn it off. Desktop: **Settings → General → Search the
  web automatically** sets the default.
- **Bots:** a **Search the web** permission in the bot's settings, on for new bots.
- **Models:** only models that can call tools use the web.
- **Cost:** 0.5 cSats a search and 0.2 cSats a page by default, from your balance. With no cSats the
  web tools aren't offered. Per reply, at most 3 searches and 4 page reads.
- **Free on your own machine:** a chat whose model runs on your own machine searches for free, within
  a daily allowance (100 searches and 200 page reads per account). Linux hosts set up by the
  installer can run their own search (SearXNG), which your chats on that machine use with no daily
  cap.
- **Safety:** page reads go only to public addresses on ports 80 and 443, at most 2 MB and 10
  seconds. Page content is marked as untrusted data, and after a page has been read, commands and
  other actions ask first for the rest of that reply or run, even ones the mode would run (Full
  access excepted). Edits inside the project that the mode applies anyway still apply (undoable);
  protected paths, secrets and files outside the project ask or are refused as usual. The card says
  why it asked and offers **Allow for the rest of this run**, which lets the rest of that run's
  guarded calls go ahead (never ones the mode itself asks about; nothing is kept). The phone and the
  web answer one call at a time.

In **Manual** permission mode, every web call asks first.
