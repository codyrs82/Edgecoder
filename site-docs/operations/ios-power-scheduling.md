# iOS App — Power & Background Behavior

This page covers what the current iOS app does about battery, power and background work, and how the coordinator treats a phone's power readings. For using the app (the **Chat**, **Bots**, **Wallet**, **Machines** and **Network** tabs), see the [iOS app guide](/guide/ios-app).

::: warning Removed from the app
Older builds had a three-way compute mode picker (**Off / On / Bluetooth Local**) in a **Swarm** tab, an automatic switch to Bluetooth Local when the internet dropped, and an **IDE** tab that listed tasks a Mac sent to the phone over Bluetooth. None of these exist in the current app. The IDE tab was replaced by **Machines** in build 34 (#429).
:::

## Bluetooth hosting

The iPhone hosts only over Bluetooth: nearby machines can send it prompts and it answers with the on-device model. It does not take jobs from the network (no coordinator `/pull`). The controls are in **Settings** (bottom of the Chat drawer):

| Card | What it shows or controls |
|---|---|
| **Bluetooth hosting** | On or off, start and stop buttons, how many Bluetooth requests it served or failed since the app opened, and two toggles: **Auto-start on launch** (on by default) and **Run only when charging** (off by default). |
| **Local Model** | Pick, download and load the on-device model that answers Bluetooth requests. |
| **Network** | Nearby peers, battery percent, and power source (`AC` or `Bat`). |

After you sign in, the app enrolls the phone (`POST /nodes/enroll`) and, if **Auto-start on launch** is on, starts Bluetooth hosting: it advertises and scans over Bluetooth and answers requests from nearby machines. It also registers with the coordinator as an agent (`os: "ios"`, `clientType: "edgecoder-ios"`) and sends a heartbeat about every 15 seconds. Registration gives the phone the account its Bluetooth credit transactions are signed for; the heartbeat tells it when it is offline (start Bluetooth scanning) and back online (sync the offline ledger).

**Run only when charging** is checked when hosting starts: if the phone is not charging or full, it does not start and shows "Bluetooth hosting blocked: connect power to start." It does not stop hosting that is already running when you unplug.

## Power telemetry

Every `/register` and `/heartbeat` from the phone carries a `powerTelemetry` object:

| Field | Meaning |
|---|---|
| `onExternalPower` | Battery state is charging or full |
| `batteryLevelPct` | Battery percentage (0–100) |
| `lowPowerMode` | iOS Low Power Mode is on |
| `updatedAtMs` | When the reading was taken |

The app does not report thermal state. Thermal throttling in the coordinator applies only to desktop agents that send `thermalState`.

## Coordinator jobs

Coordinators give iOS agents no jobs. `/pull` from an agent registered with `os: "ios"` (or `clientType: "edgecoder-ios"`) answers `{ "subtask": null, "reason": "ios_bluetooth_only" }`, the same shape as an idle pull, so older app builds that still poll simply wait for their next poll (`refusesCoordinatorJobs` in `src/swarm/power-policy.ts`). `/register`, `/heartbeat` and `/credits/ble-sync` work as before.

### Power policy (reporting only)

The coordinator still evaluates `evaluateIosPowerPolicy` (`src/swarm/power-policy.ts`) for iOS agents and shows the result in `/capacity`; it no longer decides whether a phone gets work, since a phone never does. The first matching rule wins:

| Order | Condition | Result | `reason` |
|---|---|---|---|
| 1 | Low Power Mode on | No work | `ios_low_power_mode` |
| 2 | On external power | Work allowed | `ios_external_power` |
| 3 | Battery ≤ `IOS_BATTERY_TASK_STOP_LEVEL_PCT` (default `20`) | No work | `ios_battery_critical` |
| 4 | Last assignment less than `IOS_BATTERY_PULL_MIN_INTERVAL_MS` ago (default `45000`) | No work yet | `ios_on_battery_throttled` |
| 5 | Otherwise | Work allowed | `ios_on_battery_lite_mode` |

Both thresholds are coordinator settings; see [Environment Variables](/reference/environment-variables).

## Background execution

The app declares these background modes in `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>fetch</string>
  <string>processing</string>
  <string>bluetooth-central</string>
  <string>bluetooth-peripheral</string>
</array>
```

Each time the app goes to the background it submits these `BGTaskScheduler` requests:

| Task ID | Type | Request |
|---|---|---|
| `io.edgecoder.ios.runtime` | `BGProcessingTask` | Needs external power |
| `io.edgecoder.ios.heartbeat` | `BGAppRefreshTask` | Earliest 15 minutes later |
| `io.edgecoder.ble-mesh` | `BGProcessingTask` | Needs external power; earliest 1 minute later |

iOS decides whether and when these run. The handlers only keep the process alive for a while and schedule the next request; heartbeats happen in the hosting loop. Do not expect a backgrounded phone to keep answering Bluetooth requests, especially on battery.

## Nearby devices (Bluetooth)

The chat model picker shows a **Nearby Devices** section only when Bluetooth hosting has discovered a peer. This path is not tested end to end, so don't rely on it. The older transport that made the phone a Bluetooth peripheral for a Mac (`BluetoothTransport`, used with `edgecoder-ble-proxy`) is still compiled into the app, but nothing in the current app starts it (#429).

## Cross-links

- [iOS app guide](/guide/ios-app)
- [Public Mesh Operations](/operations/public-mesh-operations)
- [Environment Variables](/reference/environment-variables)
