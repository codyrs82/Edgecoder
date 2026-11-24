# iOS App Store Release Guide

This guide covers simulator validation, signing setup, TestFlight upload, and first App Store submission for the native iOS app at `ios/EdgeCoderIOS`.

## 0) Owner steps to the first TestFlight build (checklist)

Everything below needs the owner's Apple account; nothing in the repo signs or uploads.

1. **Finish the Xcode install on the build Mac (admin password).** `xcodebuild` currently fails with
   "failed to load a required plug-in ... CoreSimulator" because Xcode's first-launch packages were never
   installed. Run once: `sudo xcodebuild -runFirstLaunch` (or open Xcode.app and accept the component install).
   Then install an iOS simulator runtime if you want simulator runs: Xcode > Settings > Components (several GB).
2. **Team.** Confirm the team ID in `ios/EdgeCoderIOS/project.yml` (`DEVELOPMENT_TEAM: 63CL88WY7G`, the
   value the checked-in project and the portal's passkey file use; an older `project.yml` said `R68RHRM2H4`).
   If the team changes, update `project.yml`, run `cd ios/EdgeCoderIOS && xcodegen generate`, and set the
   portal's `IOS_APP_TEAM_ID` secret so `/.well-known/apple-app-site-association` names the new team.
3. **Bundle id.** `io.edgecoder.ios` (tests: `io.edgecoder.ios.tests`). In developer.apple.com > Identifiers,
   register it with the **Associated Domains** capability (passkeys: `webcredentials:edgecoder.io`,
   `webcredentials:portal.edgecoder.io`). The portal serves `/.well-known/apple-app-site-association` with
   `<IOS_APP_TEAM_ID>.io.edgecoder.ios` (src/portal/routes/well-known.ts); check it on both hosts.
4. **App Store Connect record.** My Apps > + > New App: platform iOS, name "EdgeCoder", bundle id
   `io.edgecoder.ios`, SKU e.g. `edgecoder-ios`. Fill the privacy questionnaire to match
   `EdgeCoderIOS/PrivacyInfo.xcprivacy` (email, user ID, device ID, other user content, purchase history;
   all linked to the user, app functionality only, no tracking). Privacy policy URL `https://edgecoder.io/privacy`,
   support URL `https://edgecoder.io` (support@edgecoder.io).
5. **Archive, export and upload** (bump `CURRENT_PROJECT_VERSION` in `project.yml` and regenerate for every upload):

   ```bash
   cd ios/EdgeCoderIOS
   xcodegen generate
   xcodebuild -project EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS -configuration Release \
     -destination 'generic/platform=iOS' -archivePath build/EdgeCoder.xcarchive \
     -allowProvisioningUpdates archive
   cat > build/ExportOptions.plist <<'PLIST'
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>method</key><string>app-store-connect</string>
     <key>destination</key><string>upload</string>
     <key>signingStyle</key><string>automatic</string>
     <key>teamID</key><string>YOUR_TEAM_ID</string>
   </dict></plist>
   PLIST
   # Upload straight to App Store Connect (signed in to Xcode with the team account, or pass
   # -authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID for an API key):
   xcodebuild -exportArchive -archivePath build/EdgeCoder.xcarchive \
     -exportOptionsPlist build/ExportOptions.plist -exportPath build/export -allowProvisioningUpdates
   ```

   Or Xcode > Window > Organizer > the archive > Distribute App > App Store Connect > Upload.
6. **TestFlight.** In App Store Connect > TestFlight, answer the export-compliance question (the app sets
   `ITSAppUsesNonExemptEncryption = false`: HTTPS and system crypto only), add internal testers (no review),
   then an external group (Beta App Review applies the guidelines below).
7. **Decide the payments question** (section 8) before the first external TestFlight / App Store submission.
8. **Before re-enabling sign-up in the app**, ship a portal account-deletion API (section 9).

## 1) Prerequisites

- Xcode 27.2 on macOS (first-launch components installed, see step 0.1)
- XcodeGen (`brew install xcodegen`): `project.yml` is the source of truth for the Xcode project and Info.plist
- Apple Developer account with App Store Connect access
- Production backend endpoints:
  - `https://edgecoder.io` (portal: sign-in, web chat API, bots, wallet)
  - `https://coordinator.edgecoder.io` (coordinator; the control plane runs in the same all-in-one process)

## 2) Project setup

Project and target:

- Xcode project: `ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj` (generated: `cd ios/EdgeCoderIOS && xcodegen generate`)
- Schemes: `EdgeCoderIOS` (app), `EdgeCoderIOSTests` (unit tests, no host app)
- App target: `EdgeCoderIOS`; the only package is SwiftLlama (`swift-llama-cpp` 1.2.0, pinned)

Signing/capabilities baseline:

- Code signing style: `Automatic`
- `DEVELOPMENT_TEAM` in `ios/EdgeCoderIOS/project.yml`
- Associated domains entitlement:
  - `webcredentials:edgecoder.io`
  - `webcredentials:portal.edgecoder.io`
- Background modes: `fetch`, `processing`, `bluetooth-central`, `bluetooth-peripheral` (BLE mesh and the
  on-device runtime; see site-docs/operations/ios-power-scheduling.md). Expect App Review to ask why; the
  review notes should explain the nearby-Mac BLE mesh and that background work runs only on external power.
- Usage strings: Bluetooth (always + peripheral), local network. No camera (the app shows QR codes, it does not scan them).
- Privacy manifest: `EdgeCoderIOS/PrivacyInfo.xcprivacy` (UserDefaults reason CA92.1; no tracking).

## 3) Local simulator validation

Build (on a shared Mac, one xcodebuild at a time, niced):

```bash
nice -n 10 xcodebuild -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS \
  -destination 'generic/platform=iOS Simulator' -configuration Debug -jobs 2 build CODE_SIGNING_ALLOWED=NO
```

Unit tests (chat-failure wording, the served/footer line, buy limits, chat stream / wallet / bots parsing,
the purchase policy, plus the request-signing and BLE vectors):

```bash
xcrun simctl list devices available   # pick an installed iPhone
nice -n 10 xcodebuild test -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOSTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -jobs 2
```

Release compile check without signing:

```bash
nice -n 10 xcodebuild archive -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS \
  -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/EdgeCoder.xcarchive -jobs 2 \
  CODE_SIGNING_ALLOWED=NO
```

Boot simulator + install app (optional smoke run):

```bash
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install booted ~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug-iphonesimulator/EdgeCoder.app
xcrun simctl launch booted io.edgecoder.ios
```

Request-signing unit check (#64; the Swift signer must match the TypeScript
vectors in `tests/security/fixtures/request-signing-vectors.json`). CI runs it
with plain `swiftc`; locally, either:

```bash
cd ios/EdgeCoderIOS
swiftc -o /tmp/request-signing-vectors \
  EdgeCoderIOS/Security/RequestSigner.swift \
  EdgeCoderIOSTests/RequestSigningVectorCheck.swift \
  Scripts/request-signing-vectors/main.swift
/tmp/request-signing-vectors ../../tests/security/fixtures/request-signing-vectors.json
```

or run the `EdgeCoderIOSTests` scheme as above (the generated project contains the test target).

Core smoke checklist (signed in to a mainnet account with a desktop machine online):

- Sign in: email + password, passkey (physical device), sign out. No "Create Account" in the app (section 9).
- Chat (web chat API): Auto answers on your own machine first (footer "My machines · <model>", free), then the
  network (footer "N cSats · Network · best fit"); an account with 0 cSats shows "Couldn't run: out of cSats",
  the set-aside detail and "Signed in as ...", with Retry; no Buy button in a Release build.
- Network badge: "mainnet" in the chat header and "Bitcoin mainnet · real sats" in the wallet.
- Bots: list by machine, New bot (+) waits for a Mac (#414), open a bot, message it, Pause / Resume, approve or deny
  a pending call; a view-only or offline machine is read-only.
- Wallet: balance, activity, prices, earnings; withdraw asks for the emailed code, and with 2FA on (#420) for the
  authenticator code (passkey-only 2FA points to the web); a locked account or a cooling-off payout address shows
  the portal's reason; the coordinator's limits are shown. Debug builds also show Buy cSats with
  its limits and the Lightning invoice (QR, copy, "Open in wallet" `lightning:` link).
- Settings: Delete account... opens a prefilled deletion request to support@edgecoder.io.
- On-device runtime / BLE mesh: start, pause, stop; nearby Mac discovery (physical devices only).

## 4) Archive and upload to TestFlight

See step 0.5 (archive, export with `ExportOptions.plist`, upload) and 0.6 (TestFlight groups).

## 5) App Store Connect metadata checklist

- App name, subtitle, description
- Keywords
- Support URL and privacy policy URL
- Screenshots (6.9", 6.7", 6.5", iPad sizes as needed)
- App privacy nutrition labels
- Encryption compliance (`ITSAppUsesNonExemptEncryption` currently set to false)

## 6) Release hardening before submission

- Replace placeholder bundle id if needed
- Confirm production passkey origin and RP settings match app domain
- Validate seed phrase handling policy and no sensitive local persistence beyond Keychain flags
- Run on at least one physical iPhone with Face ID / Touch ID passkey flows
- Validate charging behavior for hosting: network jobs and Bluetooth serving only while plugged in, both stop on unplug and resume on plug-in

## 7) Known v1 constraints (deferred from the first TestFlight)

- Bot settings edits; bot history and memory views (create, message, pause/resume and approvals are in).
- Passkey-only two-factor step-up and payout-address changes: the app sends those to edgecoder.io (TOTP step-up works in the app).
- Picking a specific network compute class or a reserved machine in chat (Auto and a named network model only).
- Syncing the portal's conversation list into the app (the app keeps its own history; replies still use the
  portal conversation for context).
- Fund with Bitcoin (on-chain) and buying cSats in Release builds (section 8).
- Local inference: llama.cpp via SwiftLlama works on device but is not performance-tested across devices.
- The BLE mesh and power scheduling (site-docs/guide/ble-local-mesh.md, site-docs/operations/ios-power-scheduling.md)
  are unchanged and need a physical-device pass.

## 8) Payments and the App Store (decide before external TestFlight)

cSats are spent inside the app (chat, bots), so App Review treats them as digital goods (Guideline 3.1.1).
Selling them inside the app with Lightning instead of In-App Purchase would be rejected; 3.1.5 (cryptocurrencies)
permits wallets for orgs but does not exempt in-app sales of credits.

- **United States storefront:** since the April 30, 2025 injunction in Epic v. Apple, Apple's guidelines
  (3.1.1(a), 3.1.3) allow buttons and links to an external purchase page with no entitlement and no commission.
  Apple revised 3.1.1(a) again on October 16, 2026: read the current text before relying on this.
- **Every other storefront:** no buttons, links or calls to action to buy elsewhere (EU / some regions: only with a
  StoreKit External Purchase entitlement and Apple's commission).

What the app does (`Core/PurchasePolicy.swift`, Info.plist `EdgeCoderPurchaseMode` from the build setting
`EDGECODER_PURCHASE_MODE` in `project.yml`):

| Mode | Release default | Behaviour |
|---|---|---|
| `none` | **yes** | No buying and no call to action. Wallet shows balance, activity, earnings and withdrawals; out-of-cSats replies say so, without a Buy button. |
| `link-out-us` | opt-in | US storefront only (StoreKit `Storefront.current`): "Buy cSats on edgecoder.io" opens the web wallet in the browser. Elsewhere behaves as `none`. |
| `in-app-lightning` | Debug only | The in-app Lightning invoice flow. Not for App Store builds. |

Recommendation: ship `none` for the first TestFlight; move to `link-out-us` once the owner has confirmed the
current 3.1.1(a) text. Offering cSats through In-App Purchase is the only way to sell inside the app everywhere,
at Apple's commission.

Two further review risks to address in the review notes:

- **Earning on the phone.** The on-device runtime runs other people's jobs for sats. Guideline 2.4.2 forbids
  unrelated background processing such as crypto mining and 3.1.5(ii) forbids on-device mining; position it as
  opt-in, user-started, foreground or on-power compute sharing, and consider leaving it off by default for review.
- **Withdrawals** (sending earned sats to a Lightning wallet) are wallet functionality: 3.1.5(i) requires the
  developer account to be an organization.

## 9) Account deletion (Guideline 5.1.1(v))

Apps that let people create an account must let them delete it in the app. The portal has no account-deletion API
yet, so this build removes "Create Account" from the app (sign in only; accounts are created on edgecoder.io) and
offers Settings > Delete account..., which opens a prefilled deletion request to support@edgecoder.io. Before
adding sign-up back, ship a portal `DELETE /me` (or similar) that deletes the account and its data, and call it
from that Settings row.
