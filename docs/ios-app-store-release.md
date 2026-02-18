# iOS App Store Release Guide

This guide covers simulator validation, signing setup, TestFlight upload, and first App Store submission for the native iOS app at `ios/EdgeCoderIOS`.

## 1) Prerequisites

- Xcode 26.2+ on macOS
- Apple Developer account with App Store Connect access
- A unique bundle id (default scaffold: `io.edgecoder.ios`)
- App Store Connect app record created
- Production backend endpoints:
  - `https://edgecoder.io`
  - `https://control.edgecoder.io`
  - `https://coordinator.edgecoder.io`

## 2) Project setup

Project and target:

- Xcode project: `ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj`
- Scheme: `EdgeCoderIOS`
- App target: `EdgeCoderIOS`

Signing/capabilities baseline:

- Code signing style: `Automatic`
- Set `DEVELOPMENT_TEAM` in `ios/EdgeCoderIOS/project.yml` (or directly in Xcode)
- Associated domains entitlement:
  - `webcredentials:edgecoder.io`
  - `webcredentials:portal.edgecoder.io`

## 3) Local simulator validation

Build:

```bash
xcodebuild -project "ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj" \
  -scheme "EdgeCoderIOS" \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2' \
  build
```

Boot simulator + install app (optional smoke run):

```bash
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install booted ~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug-iphonesimulator/EdgeCoder.app
xcrun simctl launch booted io.edgecoder.ios
```

Core smoke checklist:

- Auth:
  - email signup/login/logout
  - passkey enroll and login
- Wallet:
  - onboarding status load
  - backup acknowledgement
- Dashboard:
  - contribution stats
  - network summary cards
- Swarm:
  - coordinator discovery fetch
  - runtime start/pause/stop controls
  - local model scaffold install + local inference test

## 4) Archive and upload to TestFlight

Archive:

```bash
xcodebuild -project "ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj" \
  -scheme "EdgeCoderIOS" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  archive \
  -archivePath build/EdgeCoderIOS.xcarchive
```

Upload (Xcode Organizer recommended):

- Open Xcode -> Window -> Organizer
- Select `EdgeCoderIOS` archive
- Distribute App -> App Store Connect -> Upload

Alternative CLI upload with API key can be added after first successful manual upload.

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
- Validate low-power/charging behavior for swarm runtime controls

## 7) Known v1 constraints

- Local inference currently includes a llama.cpp/Core ML scaffold and runtime controls.
- The actual model bridge/binary integration should be finalized and performance tested on target devices before wide rollout.
