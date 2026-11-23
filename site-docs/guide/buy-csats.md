# Buy cSats (pay for network compute)

This guide shows you how to put cSats on your EdgeCoder account so you can use other people's
machines (the network) for calls, code jobs and reservations. You don't need to know anything
about bitcoin. It takes about five minutes, most of it in your wallet app.

**You don't need cSats to use your own machines.** Models on this computer and on machines you
added to your account are free. If that's all you want, skip this guide.

**What you'll do:**

1. [Choose an amount](#1-choose-an-amount)
2. [Pay with Lightning](#2-pay-with-lightning)
3. [Wait a few seconds](#3-wait-a-few-seconds)

Then: [paying from common wallets](#paying-from-common-wallets),
[how much to buy](#how-much-to-buy), [balances and refunds](#balances-and-refunds),
[reservations](#reservations-are-paid-from-csats-too) and the
[troubleshooting FAQ](#troubleshooting-faq).

## What cSats are

- **cSats are prepaid credit for EdgeCoder compute.** 1 cSat is 1 sat (one hundred-millionth of a
  bitcoin). You buy them once, then they're spent as you use the network.
- **Network calls are paid per token**, by model size: a bigger model costs more per call. Code
  jobs are paid per second. Each reply says where it ran and what it cost.
- **Reserving a machine is paid from the same balance** (see
  [reservations](#reservations-are-paid-from-csats-too)).
- **Where your cSats go:** when you use someone else's machine, 95 % goes to that machine's owner
  (the host) and EdgeCoder keeps 5 %. Buying cSats has no purchase fee unless the Wallet page
  shows one.
- **Bots have a daily budget**, so a bot never spends more than you allow.

## Before you start

You need:

- **An EdgeCoder account.** Sign up at [edgecoder.io](https://edgecoder.io).
- **A Lightning wallet with a little bitcoin in it.** Any Lightning wallet works. If you don't
  have one, see [paying from common wallets](#paying-from-common-wallets).

## 1. Choose an amount {#1-choose-an-amount}

Open the Wallet page:

- **On the web:** sign in at [edgecoder.io](https://edgecoder.io) and go to
  **Settings → Wallet** (`/portal/settings/plan`), then press **Buy cSats**.
- **In the desktop app:** open **Settings → Wallet**.
- **From Getting started:** the **Fund your account** step has a **Fund with Lightning** button
  that opens the same page.

In the **Buy cSats** box you see four buttons: **5,000**, **20,000** (picked for you) and
**100,000** sats, and **Custom** (any whole number from 100 to 1,000,000). Under them:

- **You pay:** the amount in sats, with roughly what it is in US dollars;
- **You get:** the cSats added to your balance (the same number when there's no purchase fee);
- **About N calls on a 30B coder model:** what that amount buys at today's network prices.

Press **Buy N cSats with Lightning**.

## 2. Pay with Lightning {#2-pay-with-lightning}

The box changes to **Scan to pay**. You see:

- a **QR code** (a square black-and-white pattern);
- the **payment code** (a long line of letters starting with `lnbc`);
- **Copy payment code** and **Open in wallet** buttons;
- **Waiting for payment…** with a countdown: **Expires in 14:59**.

Pay it the way that suits you:

- **Wallet on your phone:** open the wallet, choose **Scan** or **Send**, and point the camera at
  the QR code.
- **Wallet on the same computer:** press **Open in wallet**, or press **Copy payment code** and
  paste it into the wallet's **Send** screen.

Your wallet shows the amount. Check it, then confirm the payment.

**A payment code works for 15 minutes.** If it runs out, nothing is charged: just make a new one
(see [the FAQ](#the-payment-code-expired)).

## 3. Wait a few seconds {#3-wait-a-few-seconds}

You don't need to do anything. The page checks every few seconds; once the payment lands it shows
a green tick, **Payment received** and **+N cSats**, with what you paid, what was added and your new
balance. Press **Done**.

The **Getting started** guide updates by itself too: the checklist item **Your balance is above
zero** ticks within a few seconds.

Every purchase is listed under **Activity → Top-ups** on the Wallet page, and every change to
your balance under **Activity → Balance changes**.

## Paying from common wallets

**Any Lightning wallet works.** The names below are examples, not recommendations: EdgeCoder
isn't connected to any of them and gets nothing from them. Check that the app is available where
you live.

- **Apps that let you buy bitcoin and send it over Lightning**, for example Cash App or Strike:
  buy a small amount of bitcoin in the app, then use its **Send** or **Scan** option with the QR
  code or payment code.
- **Lightning wallets**, for example Wallet of Satoshi or Phoenix: add bitcoin to the wallet
  (each app explains how), then scan or paste the payment code.
- **An exchange that supports Lightning withdrawals or payments:** look for "Lightning" in its
  send or withdraw screen and paste the payment code there.

Things to know:

- **Pay the exact code you were given.** Lightning payments can't be reversed. EdgeCoder can't
  recall a payment you sent ([Terms, section 5](https://edgecoder.io/terms)).
- **A small routing fee** may be added by your wallet. That goes to the Lightning network, not to
  EdgeCoder, and your cSats are the amount on the code.
- **A wallet that only does on-chain bitcoin** (a `bc1…` address, no Lightning) can't pay a
  Lightning code. Paying with on-chain bitcoin shows as **Fund with Bitcoin: Coming soon** until
  it's turned on.

### Real sats on Bitcoin mainnet {#on-the-test-network}

EdgeCoder's coordinators run on **Bitcoin mainnet** (since 17 November 2026). The Wallet page
shows the badge **Bitcoin mainnet · real sats**: you pay with real bitcoin from a normal Lightning
wallet, as above.

**Running your own coordinator on a test network?** A coordinator set to `BITCOIN_NETWORK=signet`,
`testnet` or `regtest` (see [self-hosting](/operations/self-hosting)) shows a yellow badge instead,
such as **Signet · test sats, no value**, and a note under the payment code. Real-money wallets
can't pay a test-network code. On signet, pay it with free test sats from
[faucet.mutinynet.com](https://faucet.mutinynet.com) (paste the payment code into its Lightning
payment form). Test sats have no value, and balances on a test coordinator may be reset.

## How much to buy

Start small. You can always buy more, and you can't cash cSats out (see
[balances and refunds](#balances-and-refunds)).

- The Getting started step **Fund your account** shows what **1,000 cSats** buys on a 30B coder
  model, and has an **Estimate your cost** box: pick calls per day and a model size, and it shows
  about how many cSats a day and a month. It uses live prices from the network.
- **How a network model call is priced.** Each call costs its tokens at a reference price in US
  dollars per million tokens, set by model size, converted to cSats at the coordinator's BTC/USD
  rate. It is never less than the electricity floor for the seconds the host's machine spent on it.

  `cost (USD) = tokens in × input price ÷ 1,000,000 + tokens out × output price ÷ 1,000,000`

  For models from 17B up to 35B (a 30B coder model, for example) the reference price is
  **0.57 USD per million tokens in** and **1.66 USD per million tokens out** (prices set
  16 November 2026, `src/economy/job-pricing.ts`).
- **Worked example.** A typical agent call is about 8,300 tokens in and 130 out. On a 30B model
  that's 8,300 × 0.57 ÷ 1,000,000 + 130 × 1.66 ÷ 1,000,000 ≈ **0.0049 USD** a call. In sats it
  depends on the bitcoin price: *assuming* 1 BTC = 100,000 USD (1 sat = 0.001 USD), that's about
  **5 cSats a call**, or about 200 calls per 1,000 cSats. If bitcoin is worth less, a call costs
  more cSats; if it's worth more, fewer. Smaller models cost much less per call; bigger ones cost
  more.
- The **Fund your account** estimate uses live prices and the current rate, so trust it over the
  example above. Prices can change for future calls; each reply shows what it actually cost.

If you try EdgeCoder for a few days, 5,000 or 20,000 sats is plenty for most people.

## Balances and refunds

The rules are in the [Terms of Service](https://edgecoder.io/terms), section 4. In short:

- **cSats are spent only on EdgeCoder compute.** They can't be redeemed for cash or bitcoin, and
  can't be sold or transferred outside EdgeCoder.
- **Purchases are final and non-refundable**, except where the law requires a refund.
- **Failed work isn't charged.** If a service failure means compute you paid for isn't delivered,
  the amount is credited back to your balance as cSats.
- **Unused cSats may expire** 12 months after your last account activity, with notice where the
  law requires it.
- **On a self-hosted test-network coordinator** (not EdgeCoder's), balances have no real value
  and may be reset.

Earnings are different: if you host, what your machines **earn** can be withdrawn to your own
Lightning wallet from the Wallet page. Purchased cSats can't.

## Reservations are paid from cSats too

To hold a machine for your jobs only, open **Settings → Compute → Reserve a machine**
(`/portal/settings/compute` on the web). Pick a machine class, how many minutes, and optionally a
model. The cost is shown before you press **Reserve**, and it's **charged now from your cSats
balance**. If you cancel early, the unused time comes back to your balance.

There's no separate wallet to connect: one cSats balance pays for calls, jobs and reservations.

## Troubleshooting FAQ

### The payment code expired {#the-payment-code-expired}

The page says **This payment code expired** and **Nothing was charged**. Press **New payment
code** to get a fresh one for the same amount, or **Change amount**. Don't pay an old code after
it has expired: most wallets refuse it, and a payment to an expired code may not be credited.

### My wallet says "route not found" or the payment failed

Nothing was taken. Try again in a minute, or try a smaller amount. Some wallets need a little
extra balance for the routing fee.

### I paid but no cSats arrived

Wait a few minutes and reload the Wallet page: the payment can take a moment to settle, and the
**Top-ups** list shows its status. If your wallet says the payment **completed** and you still
have no credit after a few minutes, email **support@edgecoder.io** with:

- the email address of your EdgeCoder account;
- the amount and the time you paid;
- the payment code, or the payment ID or preimage your wallet shows for the payment.

Don't send your wallet's seed words or passwords. EdgeCoder never asks for them.

### The Buy button is greyed out

- **"Enter 100 to 1,000,000 sats":** the custom amount is outside that range or not a whole
  number.
- **In the desktop app:** this computer's agent must be connected to the network. It connects on
  its own while you're signed in; give it a minute after the app starts.

### My wallet says the code is for the wrong network

EdgeCoder's coordinators are on Bitcoin mainnet, so their codes start with `lnbc` and any normal
Lightning wallet can pay them. If the Wallet page shows a yellow **test sats, no value** badge, you
are on a self-hosted coordinator running a test network: real-money wallets can't pay its codes
(see [above](#on-the-test-network)).
