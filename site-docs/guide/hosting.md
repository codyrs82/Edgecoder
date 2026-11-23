---
title: Hosting
description: Request to host on the EdgeCoder network, how approval works, how jobs are priced, what hosts are paid, and how payouts are protected.
---

# Hosting

Hosts run other people's model calls and code jobs on their machines and are paid in sats for the
work. While the network is in early access, hosting for other people is **by invitation**: you ask,
and EdgeCoder approves hosts one at a time.

You don't need an invitation to use your own machines. Any machine signed in to your account runs
**your own** work for free. Approval is only needed to take work from other people.

## 1. Request to host

Open [edgecoder.io/host](https://edgecoder.io/host) and fill in **Request to host**:

- your name, email and (optionally) organisation;
- what you would like to run: a **compute agent** (model calls and sandboxed code jobs on CPU, NVIDIA
  or AMD GPUs, or Apple silicon), a **coordinator**, a **Bitcoin node** or a **Lightning node**;
- for a compute agent, the hardware, and optionally your region, hardware details and a message.

Use the email of the EdgeCoder account you will host with (or the one you'll sign up with). Nothing
needs installing yet. EdgeCoder reads every request and replies by email.

What hosting involves:

- a machine you control, kept online and up to date, with Docker for sandboxed code jobs;
- an EdgeCoder account in good standing; your node signs everything it does with its own key;
- accepting the [Host Agreement](https://edgecoder.io/host-agreement);
- EdgeCoder may pause or remove a host at any time while the network is in early access.

## 2. Approval

An admin reviews the request and marks it approved or declined. Approval is tied to your **email
address**: once approved, you get an email asking you to sign in (or to create an account with that
email first; it must be verified).

Coordinators check approval before they hand a machine anyone else's work. Until your account is
approved, your machines run only your own work. You can see your state with
`GET /portal/api/host/status` (`{ required, approved }`).

## 3. Set up your machine

Set up the machine on the approved account, as for any of your machines:

- **Mac or Windows:** [install the desktop app](/guide/install-desktop) and sign in.
- **Linux or a GPU server:** run the agent installer with an install key. See
  [Run EdgeCoder on a cloud GPU or Linux server](/guide/cloud-gpu-server).

Then check it under **Settings → Nodes** on edgecoder.io, and set where you want to be paid
(below).

## How jobs are priced

All amounts are in cSats, the network's unit: **1 cSat = 1 sat**. The formulas are in
`src/economy/job-pricing.ts`.

**Model calls** are priced per token by model size, with a floor for the electricity the seconds
cost:

```
token cost  = (input tokens × input price + output tokens × output price) / 1,000,000
power floor = class floor (USD/hour) × tier weight × seconds of work (excluding model load) / 3600 / parallel slots
cost        = max(token cost, power floor), converted from USD to sats at the live BTC price
```

| Model size | Input, USD per million tokens | Output, USD per million tokens |
| --- | --- | --- |
| up to 2B | 0.01 | 0.03 |
| up to 4B | 0.02 | 0.05 |
| up to 9B | 0.04 | 0.10 |
| up to 16B | 0.07 | 0.20 |
| up to 35B | 0.57 | 1.66 |
| up to 80B | 1.43 | 3.80 |
| larger | 2.85 | 7.11 |

The price per token is the same on every class of hardware; faster hardware finishes sooner.

**Code jobs and reserved machines** are priced per second: the measured seconds times the hardware
tier's rate. The rate comes from the order book, kept between 0.25× and 4× of the class reference
price, times the tier's weight.

Failed work is not charged and earns nothing.

## What hosts are paid

For every compute payment (model call, code job, reservation) **the host gets 95 %** and EdgeCoder
keeps a **5 % network fee**. What the requester pays and what the host earns are the same number,
minus that fee.

How much a machine earns depends on how much work the network sends it, which depends on demand,
the models it serves, its hardware and its uptime. There is no guaranteed amount. Running a machine
also costs electricity and, for rented servers, rent; compare those with the prices above before you
commit hardware.

Coordinator, Bitcoin node and Lightning node hosts: the code can share the network fee pool with
infrastructure hosts by uptime, but that is turned off by default. Ask about it when you apply.

## Payouts

Earned sats can leave EdgeCoder in these ways:

- **Automatic Lightning payouts:** set a **Lightning address** from your own wallet as your payout
  destination (Settings → Wallet). Once your withdrawable balance reaches the auto-payout threshold
  (10,000 sats by default) you are paid automatically.
- **Withdraw now:** paste a Lightning invoice (BOLT11) from your wallet and withdraw (1,000 sats
  minimum by default).
- **On-chain:** a Bitcoin address (`bc1…`) as your payout destination is paid in batched on-chain
  transactions, where on-chain payouts are turned on.

EdgeCoder never creates or holds your wallet's keys: you give it an address from your own wallet.

Only earnings can be withdrawn. cSats you bought can be spent on compute but not withdrawn, and
earnings you spend on compute are no longer withdrawable.

## Payout safeguards

- **Earnings hold.** On mainnet, earnings become withdrawable 24 hours after they are earned, so a bad
  result caught by spot checks can be dealt with before its sats leave.
- **Confirming a new payout address.** Adding or changing your payout destination asks for your
  second factor (when two-factor authentication is on) and a confirmation from your email. The new
  address then waits 24 hours (1 hour for your first one); meanwhile the old one keeps its automatic
  payouts, manual withdrawals are refused, and you get an email with a link to cancel.
- **Withdrawal confirmation and receipts.** A withdrawal is confirmed with an emailed code, and every
  withdrawal emails you a receipt with a "not you? lock your account" link.
- **Caps.** On mainnet, by default, one payout is at most 100,000 sats, an account at most 500,000
  sats a day, and the whole coordinator at most 2,000,000 sats a day. A payout over a cap waits; your
  balance stays.
- **Kill switch and reconciliation.** The Lightning node's balances and payments are checked against
  the ledger on a schedule. A mismatch pauses all payouts until an admin has looked. While paused,
  buying cSats still works and your earnings stay in your balance.

See [Trust and Security](/security/trust-and-security#your-account-and-your-payouts) for account
security, and [Settlement Lifecycle](/economy/settlement-lifecycle) for how payments settle.
