# Host Agreement

> **DRAFT — pending legal review.** This document is a working draft prepared for review by counsel. It is not final, it is not legal advice, and it has not been approved by EdgeCoder. Bracketed items such as [CONTACT EMAIL] are placeholders to be completed.

Version: 2026-11-15-draft · Effective date: [EFFECTIVE DATE]

This Host Agreement is between you and EdgeCoder. It applies when you install the EdgeCoder agent, the desktop app with the agent enabled, the iOS app with its swarm runtime, or any other EdgeCoder software that lets your machine run work for others (a "Host"). It adds to the [Terms of Service](/terms), the [Acceptable Use Policy](/acceptable-use) and the [Privacy Policy](/privacy). If this agreement conflicts with the Terms on hosting, this agreement controls.

By installing or running the agent, enrolling a machine, or checking the box to accept this agreement, you agree to it.

## 1. What installing the agent means

- The agent connects your machine to EdgeCoder coordinators, reports its hardware and status, and accepts jobs from other users of the network: AI model calls (prompts sent to a model on your machine) and code jobs (code run in a sandbox).
- The installer may install and configure other software: for example Node.js, Ollama (to run models), Docker (for the sandbox), background services that start with your machine, and models downloaded from public sources. You are responsible for following those programs' and models' licenses.
- The agent updates itself or is updated by the app. Updates can change what it does, within this agreement.
- On macOS and iOS, the app may use Bluetooth to find nearby EdgeCoder devices and exchange work with them when the internet is unavailable. See [Bluetooth mesh](/bluetooth). You can turn it off on the desktop app.
- You can stop hosting at any time by stopping or uninstalling the agent (for example `edgecoder-install uninstall` or quitting the app and turning off the agent).

## 2. Resources your machine uses

While hosting, your machine will use:

- **CPU, GPU and memory**, sometimes at or near full load for long periods;
- **disk space** for models (often several to tens of gigabytes each), sandbox images, logs and a local job history;
- **network bandwidth** to download models and software and to send and receive jobs and results;
- **electricity**, and it will produce heat and fan noise. Sustained load may increase wear on hardware and reduce battery life on laptops and phones.

You control which machines you enrol and can set limits where the app offers them. EdgeCoder does not pay for your power, bandwidth, hardware or wear.

## 3. The sandbox does not guarantee isolation

Code jobs run inside a sandbox (currently a Docker container with no network access, a read-only filesystem and resource limits), and the agent refuses code jobs if the sandbox is not available. AI model calls run in the model runtime on your machine. These measures reduce risk but **do not guarantee isolation**. Sandboxes and model runtimes can have vulnerabilities, and a malicious job could try to exploit them. You accept that risk. We recommend you:

- host on a machine or virtual machine that holds no sensitive data, credentials or access to sensitive networks;
- keep your operating system, Docker and Ollama up to date;
- not host on a machine you do not own or are not allowed to use for this purpose.

## 4. Your responsibilities

- **Permission.** Make sure you are allowed to host. Your internet service provider's terms, your employer's or school's policies, your landlord, data-center or cloud provider's terms, and local laws may restrict running servers, sustained heavy use, or running third-party workloads. Do not host on employer or client equipment or networks without written permission.
- **Power and bandwidth.** You pay for your electricity and internet, including any data caps or overage charges.
- **Security.** Keep your machine, accounts and enrolment tokens secure. Do not share tokens.
- **Honest operation.** Run the unmodified agent, or a modification EdgeCoder has approved; report your hardware truthfully; return the actual results your machine computed; and do not read, keep, copy or disclose other users' jobs, prompts, data or outputs except as needed to run them. The agent keeps a local job history on your machine; treat it as confidential and do not use it for any other purpose.
- **Compliance.** Follow the [Acceptable Use Policy](/acceptable-use), including the sanctions section. Do not host from a sanctioned jurisdiction.
- **Taxes.** See section 6.

## 5. Payment

- **What you are paid for.** You are paid for computing services your machine performs and that the coordinator measures and accepts. You receive 95% of the compute payment for that work; EdgeCoder keeps 5% as a network fee. [COUNSEL: confirm fee description; infrastructure-host fee-pool distributions may need their own section.]
- **How work is measured.** The coordinator measures the time your machine spends on accepted work and converts it to credits by hardware class and tier at the price in effect. Your hardware tier is verified by speed checks and cross-checks against other machines; until it is verified you are paid at your class's standard tier. Results may be sampled and checked against other machines.
- **Payouts.** Earnings are paid in bitcoin, usually over Lightning, to the payout destination you set, on request or automatically, subject to a minimum payout amount and network fees shown in the Service. You are responsible for giving a correct destination; payments sent to the destination you gave are final (see section 5 of the [Terms](/terms)).
- **Holds.** We may delay or hold payouts: (a) while work is being verified; (b) when we suspect fraud, invalid results, misreported hardware, or a breach of this agreement; (c) for sanctions, tax or legal reasons, including until you give required tax information; (d) for security incidents; and (e) when a payout destination was recently changed. [HOLD PERIODS AND RELEASE PROCESS — counsel and operations to define.]
- **Forfeiture and clawback.** We may withhold, reverse or offset earnings for work that was invalid, fabricated, obtained through a breach of this agreement or the AUP, or credited by error.
- **Test mode.** While network settlement runs on a Bitcoin test network or with test funds, earnings shown may have no real value and may be reset. See section 6 of the [Terms](/terms).
- **No guarantee.** We do not guarantee any amount of work, earnings or uptime rewards. Demand and prices change.

## 6. Taxes and tax information

You are an independent provider, not an employee, and you are responsible for all taxes on your earnings, including income and self-employment taxes and any sales, VAT or similar taxes. We may be required to ask you for tax information (for example IRS Form W-9 or W-8BEN, or an equivalent in your country), to issue tax forms such as Form 1099, to report your earnings to tax authorities, or to withhold tax. We may hold payouts until you provide what is required. [COUNSEL: confirm thresholds, the treatment of payments in bitcoin, and the forms needed.]

## 7. Suspension, blacklisting and removal

We may, at any time and without prior notice where reasonable:

- pay your machine at a lower tier, stop sending it work, or remove it from the network;
- blacklist a machine, account, network or hardware fingerprint, for example for invalid results, failed or faked verification, misreported hardware, security risk, poor reliability, abuse, or a breach of this agreement, the Terms or the AUP;
- revoke enrolment tokens and suspend your account.

Where reasonable we will tell you why, unless that would compromise security or an investigation. Earned amounts for valid work done before suspension will be paid, subject to section 5 holds and offsets.

## 8. Disclaimers and liability

EDGECODER DOES NOT WARRANT THAT THE AGENT, THE SANDBOX OR JOBS FROM OTHER USERS ARE SAFE, SECURE OR FREE OF HARMFUL CODE, OR THAT HOSTING WILL NOT AFFECT YOUR MACHINE, DATA, NETWORK OR ACCOUNTS WITH THIRD PARTIES. TO THE MAXIMUM EXTENT PERMITTED BY LAW, EDGECODER IS NOT LIABLE FOR DAMAGE TO YOUR HARDWARE OR DATA, FOR YOUR POWER, BANDWIDTH OR OTHER COSTS, OR FOR CONSEQUENCES WITH YOUR ISP, EMPLOYER OR OTHERS, AND THE LIMITATIONS IN SECTIONS 14 AND 15 OF THE [TERMS](/terms) APPLY. You will indemnify EdgeCoder as described in section 16 of the Terms, including for claims arising from the operation of your machine and network.

## 9. Changes and termination

We may change this agreement as described in section 17 of the [Terms](/terms); we record which version each Host accepted and may ask you to accept a new version before your machine receives more work. You may stop hosting at any time. We may end this agreement by removing your machines from the network.

## 10. Contact

EdgeCoder · [MAILING ADDRESS] · [CONTACT EMAIL]
