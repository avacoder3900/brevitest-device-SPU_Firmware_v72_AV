# BIMS UI: Device Logging Dashboard Requirements

The device logging pipeline is live. Firmware uploads session logs to the BIMS via the Lambda middleware. Data is landing in MongoDB in three collections. The UI needs to display this data.

## Collections and What's In Them

### `device_logs` — Firmware session logs
Each document is one upload from a device. Contains parsed log lines from the firmware's flash log.

Sample document:
```json
{
  "_id": "YkXk_AsTPljuWn3IwMlDv",
  "deviceId": "0a10aced202194944a0713b4",
  "deviceName": "BT-M01-0000-0219",
  "sessionId": "0a10aced202194944a0713b4_bootunknown_2026-03-30T16:22:49.769Z",
  "firmwareVersion": 74,
  "bootCount": 47,
  "bootTime": "2026-03-30T16:22:49.769Z",
  "uploadedAt": "2026-03-30T16:22:49.912Z",
  "logLines": [
    { "ms": 142000, "message": "HEAT: T=45.0 target=45.0 pwr=12 err=0 int=200" },
    { "ms": 148000, "message": "HEAT: T=45.5 target=45.0 pwr=0 err=-5 int=195" },
    { "ms": 1109025, "message": "Uploading session log (93 bytes)" }
  ],
  "lineCount": 3,
  "errorCount": 0,
  "hasCrash": false,
  "firstLine": "HEAT: T=45.0 target=45.0 pwr=12 err=0 int=200",
  "lastLine": "Uploading session log (93 bytes)"
}
```

### `device_crashes` — Crash reports (only created when a crash is detected)
Each document represents one crash, extracted from the checkpoint block at the top of a session log. These are rare — only appear when the device was interrupted mid-operation.

Sample document:
```json
{
  "_id": "abc123def456ghi78",
  "deviceId": "0a10aced202194944a0713b4",
  "deviceName": "BT-M01-0000-0219",
  "firmwareVersion": 73,
  "bootCount": 46,
  "detectedAt": "2026-03-30T10:00:00.000Z",
  "lastCheckpoint": 12,
  "lastCheckpointName": "CP_CLOUD_CONNECT",
  "checkpointSequence": [70, 10, 11, 71, 60, 61, 30, 40, 41, 31, 50, 51, 12],
  "crashCategory": "CLOUD",
  "sessionLogId": "YkXk_AsTPljuWn3IwMlDv"
}
```

### `webhook_logs` — Lambda request/response for every webhook call
Each document is one webhook round-trip (device published an event, Lambda processed it, sent response back).

Sample document:
```json
{
  "_id": "xyz789",
  "deviceId": "0a10aced202194944a0713b4",
  "eventName": "validate-cartridge",
  "timestamp": "2026-03-30T16:41:57.000Z",
  "processingTimeMs": 230,
  "request": {
    "raw": "{\"uuid\":\"CART-2026-001\"}",
    "parsed": { "uuid": "CART-2026-001" }
  },
  "response": {
    "status": "SUCCESS",
    "data": { "cartridgeId": "CART-2026-001", "assayId": "ASSAY-001" },
    "errorMessage": null
  },
  "cartridgeId": "CART-2026-001",
  "firmwareVersion": 74
}
```

### `device_events` — Raw Particle event archive (every event the device publishes)
These are lightweight — just the event name, payload, and timestamp.

```json
{
  "_id": "evt123",
  "deviceId": "0a10aced202194944a0713b4",
  "eventType": "device-log",
  "eventData": { "raw": "data:application/octet-stream;base64,..." },
  "createdAt": "2026-03-30T16:41:56.000Z"
}
```

## What the UI Should Show

### 1. Device Diagnostics Page (`/spu/devices/[deviceId]/diagnostics`)

This is the main view for debugging a single device. It should show:

**Stats cards at top:**
- Total session logs uploaded (count of `device_logs` for this deviceId)
- Total crashes detected (count of `device_crashes` for this deviceId, red if > 0)
- Last upload date (most recent `uploadedAt` from `device_logs`)
- Average webhook processing time (avg `processingTimeMs` from `webhook_logs`)

**Tabs:**

**Session Logs tab** — Table of `device_logs` sorted by `uploadedAt` desc:
- Columns: Upload Date, Firmware Version, Boot Count, Line Count, Error Count, Crash (boolean badge)
- Click a row to expand and show the full `logLines` array as a scrollable log viewer
- Each log line shows the `ms` timestamp and `message`
- Lines containing ERROR, WARN, OVERHEAT, or INTERRUPTED should be highlighted red/orange

**Crashes tab** — Table of `device_crashes` sorted by `detectedAt` desc:
- Columns: Detected Date, Firmware Version, Checkpoint (code + name), Category, Sequence Length
- Click a row to expand and show the full `checkpointSequence` array
- Each checkpoint in the sequence should show the code number and human-readable name
- The last checkpoint (the one that was interrupted) should be highlighted red
- Link to the associated session log via `sessionLogId`

**Webhook Logs tab** — Table of `webhook_logs` sorted by `timestamp` desc:
- Columns: Timestamp, Event Name, Status, Processing Time (ms)
- Click to expand and show full request/response JSON
- Color-code status: SUCCESS=green, FAILURE=red, ERROR=red, INVALID=orange

**Events tab** — Table of `device_events` sorted by `createdAt` desc:
- Columns: Timestamp, Event Type, Data preview (first 100 chars)
- Simple list, just for reference

### 2. Cross-Device Crash Dashboard (`/admin/device-crashes`)

Fleet-wide crash overview for all devices.

**Stats cards:**
- Total crashes (all time)
- Crashes last 7 days
- Most common crash category (e.g., "CLOUD — 12 crashes")
- Most crash-prone device (e.g., "BT-M01-0000-0219 — 5 crashes")

**Filters:** Device dropdown, crash category dropdown, date range picker

**Table:** Same as the Crashes tab above but across all devices, with an additional Device column.

### 3. Existing Device Detail Page (`/spu/devices/[deviceId]`)

Add a "Diagnostics" button/link that navigates to the diagnostics page. If the device has any crashes, show a red badge with the count.

## Checkpoint Code Reference

For displaying human-readable checkpoint names. The checkpoint codes and their meanings:

```
10: Cloud Disconnect          11: Cloud Disconnect OK
12: Cloud Connect             13: Cloud Connect OK
14: Publish Validate          15: Publish Validate OK
16: Publish Load Assay        17: Publish Load Assay OK
18: Publish Upload            19: Publish Upload OK
20: Publish Reset             21: Publish Reset OK
22: Webhook Response Received 23: Webhook Timeout
30: BCODE Start               31: BCODE Complete
40: Spectro Reading Start     41: Spectro Reading Complete
50: File Write Test           51: File Write Test OK
52: File Read Assay           53: File Read Assay OK
54: File Write Assay          55: File Write Assay OK
60: Stage Reset               61: Stage Reset OK
62: Barcode Scan              63: Barcode Scan OK
64: I2C Bus Init              65: I2C Bus Init OK
70: Test Start                71: Test Hardware Setup
80: Heater Overheat
```

Even codes = "about to do X", odd codes = "X completed OK". If the last checkpoint in a crash sequence is even, that operation was interrupted.

Crash categories: CLOUD, BCODE, I2C, FILE_IO, HARDWARE, TEST_LIFECYCLE, HEATER, UNKNOWN.

## Mongoose Models

The models should already exist in `src/lib/server/db/models/`:
- `device-log.ts` → `DeviceLog` → collection `device_logs`
- `device-crash.ts` → `DeviceCrash` → collection `device_crashes`
- `webhook-log.ts` → `WebhookLog` → collection `webhook_logs`

The existing `device-event.ts` → `DeviceEvent` → collection `device_events` should already be handling the events.

## Data Access Pattern

All queries should use `.lean()` then `JSON.parse(JSON.stringify(data))` per BIMS conventions. Filter by `deviceId` for device-specific pages. Sort by date descending. Paginate with reasonable limits (50-100 per page).
