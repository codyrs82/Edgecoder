# Terms of Service

> **DRAFT — pending legal review.** This document is a working draft prepared for review by counsel. It is not final, it is not legal advice, and it has not been approved by EdgeCoder. Bracketed items such as [GOVERNING LAW] are placeholders to be completed.

Version: 2026-11-15-draft · Effective date: [EFFECTIVE DATE]

These Terms of Service (the "Terms") are an agreement between you and EdgeCoder ("we", "us"). They govern your use of the EdgeCoder website ([WEBSITE DOMAIN]), the EdgeCoder portal, the desktop and iOS apps, the EdgeCoder agent, the hosted API and any related services (together, the "Service").

By creating an account, checking the box at sign-up, or using the Service, you agree to these Terms, the [Privacy Policy](/privacy) and the [Acceptable Use Policy](/acceptable-use), which is part of these Terms. If you install the EdgeCoder agent to run work for others, the [Host Agreement](/host-agreement) also applies. If you do not agree, do not use the Service.

## 1. What EdgeCoder is

EdgeCoder is a decentralized compute network. People who want work done ("Buyers") buy prepaid service credits called cSats with Bitcoin over the Lightning Network, and spend them to run AI models and code jobs. People who install the EdgeCoder agent ("Hosts") let their machines run those jobs and are paid for the work. EdgeCoder operates the coordinators that match jobs to machines, measure the work, keep the ledger, and settle payments.

Jobs you send may run on machines owned and operated by other people, not by EdgeCoder. See section 9 and the [Privacy Policy](/privacy).

## 2. Eligibility

You may use the Service only if:

- you are at least [MINIMUM AGE — e.g. 18] years old and able to form a binding contract;
- you are not barred from using the Service under the laws of the United States or the country where you live, and you are not on, owned by or acting for anyone on a U.S. or other applicable sanctions or restricted-party list;
- you are not located in a country or region subject to comprehensive sanctions [SANCTIONED JURISDICTIONS LIST — counsel to confirm];
- we have not previously suspended or terminated your account.

If you use the Service for an organization, you confirm that you are authorized to bind it, and "you" includes that organization.

During early access, creating an account may require an invite code.

## 3. Accounts

- You must give accurate information, including a working email address, and keep it current.
- You are responsible for everything done through your account, your sessions, API keys, enrolment tokens and agents. Keep your password, passkeys, API keys and tokens secret.
- Tell us promptly at [CONTACT EMAIL] if you believe your account or keys are compromised.
- One person may not create multiple accounts to get around limits, invite caps or suspensions.
- AI agents may create accounts with a public key instead of an email address where the Service allows it. The person or organization operating that agent is responsible for it under these Terms.

## 4. cSats: prepaid service credits

- **What they are.** cSats are prepaid credits for using the Service. 1 cSat is priced at 1 satoshi (one hundred-millionth of a bitcoin) at the time of purchase. cSats are a record in EdgeCoder's ledger of service you have prepaid for.
- **What they are not.** cSats are not currency, legal tender, e-money, a deposit, a bank account, a security, a commodity or an investment. They do not earn interest. They have no value outside the Service, and you have no ownership interest in EdgeCoder or the network by holding them.
- **No transfer.** You may not sell, transfer or trade cSats outside the Service, except through features the Service provides.
- **Non-refundable.** Purchases of cSats are final and non-refundable, except: (a) where the law requires a refund; (b) where we cancel the Service or close your account without cause, in which case we will refund unused purchased cSats [REFUND METHOD AND TIMING]; or (c) as we otherwise decide in writing. [COUNSEL: confirm refund policy and any state-law requirements for prepaid credits.]
- **Expiry.** Unused cSats may expire [EXPIRY PERIOD — e.g. 12 months after last account activity], with notice where required by law. [COUNSEL: confirm whether expiry is permitted and on what terms.]
- **Pricing.** Prices for compute are set in cSats per unit of measured work, by hardware class, and move with the market and the daily BTC/USD rate. The price that applies to a job is the price shown or agreed when it is placed. We may change prices for future jobs at any time.
- **Errors.** We may correct ledger errors, including credits applied by mistake, and reverse credits obtained through fraud, abuse or a defect in the Service.

## 5. Bitcoin and Lightning payments

You pay for cSats, and Hosts are paid, in bitcoin, usually over the Lightning Network. You accept the following risks, which are allocated to you except where the law says otherwise or the error is ours:

- **Irreversible.** Bitcoin and Lightning payments cannot be reversed once sent. We cannot recall a payment you sent or that we sent on your instruction.
- **Wrong details.** You are responsible for the invoice, Lightning address or bitcoin address you pay or give us. If you pay the wrong invoice, pay an expired invoice, overpay, or give us a wrong or unreachable payout destination, the funds may be lost, and we are not responsible for recovering them. If we receive a payment we can match to your account, we will try to credit it, but we do not have to.
- **Fees.** Network fees (Lightning routing fees and on-chain fees) are set by the networks, not by us, and may be deducted from what is sent or received. Minimum payout amounts and fee floors apply and are shown in the Service.
- **Price volatility.** The value of bitcoin changes. cSats are priced in sats; we do not guarantee their value in any other currency.
- **Network risk.** Lightning payments can fail, route slowly or be held in flight. Bitcoin and Lightning software, nodes, channels and third-party wallets may have bugs, outages or attacks. We are not responsible for losses caused by the Bitcoin or Lightning networks or by wallets and services we do not control.
- **Your wallet.** You are responsible for the security of your own wallet, keys and devices. EdgeCoder does not hold your private keys.
- **Holds and checks.** We may delay, hold or refuse a payout to check for fraud, abuse, errors, sanctions or legal requirements (see section 7 and the [Host Agreement](/host-agreement)).

[COUNSEL: confirm money-transmission, custody and consumer-protection analysis for prepaid credits purchased with bitcoin and for host payouts.]

## 6. Test mode

Parts of the Service, including the network's settlement, currently run on Bitcoin test networks (such as regtest) or with test funds. While a part of the Service is in test mode:

- balances, cSats, earnings and payouts in it may have no real value, may be reset, and may not be redeemable;
- features may change or be removed without notice;
- the Service is provided for testing and evaluation only.

We will tell you in the Service when a feature moves from test mode to real funds.

## 7. Buyers

If you buy compute:

- You are responsible for the prompts, code, files, data and instructions you submit ("Your Content"), for having the rights to submit them, and for the legality of your use of the Service and of any output.
- Do not submit secrets, credentials, personal data of others, or regulated or confidential data unless you have decided it is acceptable for that data to be processed on machines operated by third parties (see section 9).
- You must follow the [Acceptable Use Policy](/acceptable-use).
- Jobs may fail, time out, be retried on another machine or return wrong results. Charges are based on the work measured by the coordinator under the pricing in effect; failed jobs are charged or refunded as the Service describes for that job type.

## 8. Hosts

If you install the EdgeCoder agent and run work for others, the [Host Agreement](/host-agreement) applies in addition to these Terms. In summary:

- **Payment for services.** What you earn is payment for the computing services your machine performs. Hosts receive 95% of the compute payment for work their machines perform and verify; EdgeCoder keeps 5% as a network fee. [COUNSEL: confirm the fee description and whether infrastructure-host fee-pool distributions need separate terms.] The rates in effect are shown in the Service and may change for future work.
- **Not an employee.** You are an independent provider. Nothing in these Terms makes you an employee, partner, agent or joint venturer of EdgeCoder.
- **Taxes.** You are responsible for all taxes on what you earn. We may be required to collect tax information from you (for example a Form W-9 or W-8, or equivalent), to report payments to tax authorities, or to withhold tax, and we may hold payouts until you provide what is required.
- **Verification and holds.** We may verify your hardware and the work your machine returns, pay at a lower tier until verified, hold or withhold payment for work that is invalid, fraudulent or in breach of these Terms, and suspend or blacklist machines.

## 9. Your Content and how jobs are processed

- You keep all rights you have in Your Content. You give EdgeCoder, and the Hosts whose machines run your jobs, a limited license to store, copy, transmit and process Your Content only to provide the Service to you, to secure the network, and as described in the [Privacy Policy](/privacy).
- **Third-party machines.** Your jobs may run on machines owned and operated by Hosts who are not EdgeCoder. We use measures such as signed requests, encryption of task payloads in transit where supported, and sandboxing on the host, but a Host's machine necessarily processes your prompts, code and data in order to run them, and we cannot fully control what happens on a machine we do not own. Do not send secrets.
- You are responsible for backing up Your Content. We may delete content as described in the Privacy Policy.

## 10. AI output

- AI models can be wrong, incomplete, outdated, biased, insecure or offensive, and can produce code that does not work or has security flaws. Output can resemble other people's content.
- Output is provided for you to review. You are responsible for checking it, including testing and reviewing any code, before relying on it or running it, and for how you use it.
- Output is not professional advice (legal, medical, financial, security or otherwise).
- Models run on the network are open models made by third parties and run by Hosts. Their licenses may restrict some uses; you are responsible for following them. [COUNSEL: review model license pass-through.]
- As between you and EdgeCoder, and to the extent we have any rights in it, you may use output you receive, subject to these Terms and the model licenses.

## 11. Acceptable use

You must follow the [Acceptable Use Policy](/acceptable-use), which is part of these Terms.

## 12. EdgeCoder's rights

The Service, including the software, the protocol, the EdgeCoder name and logos, is owned by EdgeCoder and its licensors. Source code published by EdgeCoder is licensed under the license in its repository (currently the Business Source License 1.1); that license governs the code, and these Terms govern the Service. Feedback you give us may be used without obligation to you.

## 13. Suspension and termination

- You may stop using the Service and ask us to close your account at any time.
- We may suspend or limit your account, agents, API keys or payouts, or terminate your account, at any time if we reasonably believe you breached these Terms, created risk or possible legal exposure for us, Hosts or other users, or if required by law. Where reasonable we will tell you why, unless that would compromise security or an investigation or is prohibited by law.
- We may discontinue the Service or any part of it. If we discontinue the Service as a whole, we will give [NOTICE PERIOD] notice where practicable and handle unused purchased cSats as described in section 4.
- On termination, your right to use the Service ends. Sections that by their nature should survive (including 4, 5, 9 to 10, 12 and 14 to 19) survive. Earned and unpaid Host amounts are handled under the [Host Agreement](/host-agreement).

## 14. No warranty

THE SERVICE, ALL OUTPUT AND ALL WORK PERFORMED BY HOSTS ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY AND QUIET ENJOYMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE OR ERROR-FREE, THAT JOBS WILL COMPLETE, THAT OUTPUT WILL BE CORRECT, OR THAT HOSTS WILL BEHAVE AS EXPECTED. Some jurisdictions do not allow some of these exclusions, so some may not apply to you.

## 15. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW:

- EDGECODER WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, DATA, GOODWILL OR BITCOIN, ARISING OUT OF OR RELATED TO THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY;
- EDGECODER'S TOTAL LIABILITY FOR ALL CLAIMS RELATED TO THE SERVICE IS LIMITED TO THE GREATER OF (A) THE AMOUNT YOU PAID EDGECODER FOR THE SERVICE IN THE [12] MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM AND (B) [LIABILITY CAP AMOUNT — e.g. US$100];
- EDGECODER IS NOT LIABLE FOR THE ACTS OR OMISSIONS OF HOSTS, BUYERS OR OTHER USERS, OR FOR THE BITCOIN AND LIGHTNING NETWORKS.

These limits apply to every theory of liability and even if a remedy fails of its essential purpose, except where the law does not allow them.

## 16. Indemnification

You will defend, indemnify and hold harmless EdgeCoder, its members, officers, employees and agents from claims, losses, liabilities, damages, costs and expenses (including reasonable attorneys' fees) arising from: (a) Your Content; (b) your use of the Service or of output; (c) your breach of these Terms or the Acceptable Use Policy; (d) your violation of law or of anyone's rights; and (e) if you are a Host, the operation of your machine and network. We may take control of the defense of a claim at our cost, and you will cooperate.

## 17. Changes to these Terms

We may change these Terms. We will post the new version with a new version label and effective date, and, for material changes, tell you by email or in the Service at least [NOTICE PERIOD — e.g. 14 days] before they take effect, unless a change is required sooner by law or for security. If you keep using the Service after a change takes effect, you accept it. We record which version of the Terms each account accepted, and we may ask you to accept a new version before you continue.

## 18. Disputes

- **Governing law.** These Terms are governed by the laws of [GOVERNING LAW — e.g. the State of ___], without regard to conflict-of-laws rules.
- **Informal resolution first.** Before filing a claim, you and we each agree to try to resolve the dispute informally for at least [30] days after written notice to [CONTACT EMAIL] or to the email on your account.
- **Forum.** [DISPUTE RESOLUTION MECHANISM — counsel to choose: binding individual arbitration administered by [ARBITRATION PROVIDER] under its rules, seated in [ARBITRATION SEAT], with a small-claims carve-out, a class-action waiver and an opt-out window; OR exclusive jurisdiction of the state and federal courts located in [VENUE].]
- Nothing here stops either party from seeking injunctive relief for misuse of intellectual property or for security incidents.

## 19. General

These Terms, with the policies they incorporate, are the entire agreement between you and EdgeCoder about the Service. If a provision is unenforceable, the rest remains in effect. Our failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a merger, acquisition or sale of assets. We are not liable for delays caused by events beyond our reasonable control. Notices to us go to [CONTACT EMAIL] and [MAILING ADDRESS].

## 20. Contact

EdgeCoder · [MAILING ADDRESS] · [CONTACT EMAIL]
