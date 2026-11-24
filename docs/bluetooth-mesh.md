# Bluetooth mesh

EdgeCoder devices can find each other over Bluetooth Low Energy (BLE) and pass AI work to a nearby device when the internet, or the EdgeCoder coordinator, can't be reached. This page explains what the feature is for, how it works, what it shares, what it costs your battery, how the work is paid for, and what is built today and what isn't.

## Why it exists

Normally every job goes through an EdgeCoder coordinator over the internet. That fails when a device is offline: on a plane, in a basement, at a site with no signal, or when the coordinator is down. Bluetooth mesh is the **last-resort path** for that case: a device that can't reach the coordinator can ask a nearby EdgeCoder device to run a model prompt, get the answer back over Bluetooth, and settle the payment later, when one of them is back online.

The internet path is always preferred. Bluetooth is used only when the coordinator can't be reached.

## How it works, step by step

1. **Advertising.** While Bluetooth mesh is on, the device advertises an EdgeCoder Bluetooth service with a short name (`EC-` plus the first 8 characters of its agent ID). Nearby EdgeCoder devices can read its agent ID, the model it runs and basic capacity: memory, current load, battery level and device type.
2. **Scanning.** A device that has lost the coordinator scans for that service. Devices not seen for 60 seconds are dropped from its list.
3. **Choosing a peer.** It ranks nearby devices by model size, load, battery (phones on low battery are avoided), signal strength and past failures, and tries up to three.
4. **Sending the request.** It connects and writes the request: a request ID, its own agent ID, the prompt text and a signature. Requests between Macs also carry a proof made with a shared mesh token (see Security).
5. **Admission.** The receiving device checks the request before running anything (see Security) and refuses it if a check fails.
6. **Running it.** The receiving device runs the prompt on **its local model only**. No code is executed for a Bluetooth request: Bluetooth carries model prompts, not code jobs.
7. **Returning the answer.** The output comes back over Bluetooth, split into chunks, with the CPU time the work took. Requests time out after 90 seconds.
8. **Signing the payment.** Both devices sign a small credit record for the work (see "How it's paid"). Each device keeps the signed record in a local offline ledger.
9. **Settling later.** When either device is back online, it sends its signed records to the coordinator, which checks them and moves the credits between the two accounts.

## What goes over Bluetooth, and what doesn't

**Shared with nearby devices**

- Your device's agent ID and EdgeCoder Bluetooth name, the model it runs and its size, memory, load, battery level and device type.
- On a Mac with a mesh token configured: a one-way hash of the token (never the token itself).
- When you send work: **the full prompt text**. When you run work: **the full output**.
- For payment: both agent IDs, the payee's account ID, a SHA-256 hash of the prompt (not the prompt), the CPU time, the credits and both signatures.

**Not shared**

- The mesh token itself, your private keys or passwords.
- Your balance, wallet, payout destination or payment details.
- Files, repositories or code to run. Only the prompt text is sent, though a prompt can contain code you pasted into it.

## Security and privacy

- **Bluetooth traffic is not encrypted by EdgeCoder.** Devices don't pair, and prompts and outputs travel as plain text. Anyone nearby with Bluetooth tools could capture them, and the device that runs your prompt can read it. **Don't send secrets over Bluetooth mesh.**
- **Macs refuse incoming Bluetooth work unless an operator sets a mesh token.** Without a token (the default), a Mac still advertises and can be discovered, but it turns down every request. With a token (the `MESH_AUTH_TOKEN` setting), a request must carry a proof made with the same token, issued within the last 2 minutes and never seen before, so it can't be replayed. Prompts are limited to 64 KiB, and each sender to 6 requests a minute (30 a minute in total).
- **iPhones and iPads** serve nearby devices only while they are charging (or full on the charger). They accept prompts from any nearby EdgeCoder device; requester authentication is not built there yet. They limit prompts to 16 KiB, run one Bluetooth request at a time, and require at least 5 seconds between requests from the same device. The iOS app doesn't log Bluetooth prompts.
- **Local history.** A Mac keeps Bluetooth prompts and outputs it ran in its local job history, like other jobs.
- **Payment records are signed by both sides.** A device signs only a record that matches the work it actually did, and only once per job. The coordinator verifies both signatures against the devices' registered keys and the accounts they belong to. A payer can't claim more CPU time than the request actually took (on Macs). Each record is capped at 100 credits.

## Battery and performance

- While Bluetooth mesh is on, the device advertises continuously. Advertising uses little power.
- Scanning uses more. A Mac scans only while it can't reach the coordinator and stops when it reconnects. The iOS app scans from start-up, stops once it is back online, and starts again after three failed heartbeats.
- Scanning is continuous while active; there is no duty cycling yet.
- An iPhone serves nearby devices (advertises and runs their prompts) only while it is charging or full. When you unplug it, it stops advertising and refuses new requests at once, with a reply saying so (a prompt already running finishes); when you plug it back in, it resumes. On battery it still scans for nearby devices to send its own requests.
- Running a prompt for someone else uses your CPU or GPU, memory and battery as any job does. Phones on low battery are avoided when choosing a peer.

## How it's paid and settled

- Work over Bluetooth earns **credits for CPU time**: one credit per CPU second, multiplied by the size of the model that ran it (1.0 for 7B parameters or more, 0.7 for 3B or more, 0.5 for 1.5B or more, 0.3 below that).
- The device that asked pays; the device that ran it earns. Both sign the record, so neither can change it alone.
- Records wait in each device's offline ledger until it is back online, then go to the coordinator in signed batches. The coordinator checks them, skips duplicates, and moves the credits from the requester's account to the provider's. A record that can't settle yet (for example, the requester's balance is too low) stays pending and is retried.
- Bluetooth work settles through the same ledger as other EdgeCoder work, with the same Bitcoin settlement and the same test-mode status. See the [Terms of Service](/terms).

## Current status and limits

Bluetooth mesh is an **early feature**. Built today:

- discovery and advertising on macOS (desktop app and agent) and iOS;
- the Mac admission checks (mesh token, replay protection, size and rate limits) and the iOS limits;
- running a prompt for a nearby device and returning the answer in chunks;
- payment records signed by both devices, the offline ledger, and settlement with the coordinator.

Not built yet, or limited:

- **A Mac does not yet send its own work over Bluetooth** in normal use. It discovers peers and can run work for them, but nothing in the app queues outgoing Bluetooth work yet.
- **iPhones can't yet send work to Macs.** iOS requests don't carry the mesh-token proof, so Macs refuse them. iPhone-to-iPhone works.
- iOS devices don't yet check who is sending a request, and the iOS requester doesn't yet cap the CPU time it signs for.
- No Bluetooth encryption or pairing.
- macOS and iOS only: no Linux or Windows support.
- A Mac currently advertises its model size as unknown, so it earns at the lowest model-size multiplier (0.3) for Bluetooth work.
- No scan duty cycling, and no separate Bluetooth switch in the iOS app.

## Turning it on or off

- **Desktop app (macOS):** Settings > General > Bluetooth mesh. It is on by default; switching it restarts the agent.
- **Agent without the app:** set `EDGECODER_BLE=0` to turn it off.
- **Accepting work on a Mac:** in addition, an operator must set `MESH_AUTH_TOKEN` on the agent, with the same value on every Mac allowed to send it work. Without it the Mac never runs Bluetooth requests.
- **iOS:** the phone serves nearby devices over Bluetooth while hosting runs (Settings > Hosting) and the phone is charging, the same rule as network jobs from the coordinator. On battery it neither advertises nor runs Bluetooth requests. To stop Bluetooth altogether, stop hosting in the app, or turn off Bluetooth access for EdgeCoder in iOS Settings > Privacy & Security > Bluetooth.
