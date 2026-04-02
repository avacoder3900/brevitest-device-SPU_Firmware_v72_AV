# BIMS UI: Unified Device Timeline View

## Concept

A single chronological view that stitches together ALL data sources for a device into one continuous log. Instead of separate tabs for device logs, webhook logs, crashes, and events, this view merges them all into one timeline — like reading the complete story of what a device did.

## Data Sources and How to Merge Them

There are 4 collections to pull from for a given `deviceId`:

### 1. `device_logs` — Firmware log lines
- Query: `DeviceLog.find({ deviceId }).sort({ uploadedAt: 1 }).lean()`
- Each document has a `logLines` array of `{ ms, message }` objects
- Multiple documents should be concatenated in `uploadedAt` order to reconstruct the full session
- **Timestamp conversion:** Each line has `ms` (milliseconds since device boot). Convert to wall-clock time using: `wallClock = new Date(bootTime.getTime() + ms)` where `bootTime` comes from the document's `bootTime` field
- If `bootTime` is null, fall back to: `wallClock = new Date(uploadedAt.getTime() - lastLine.ms + line.ms)` (approximate using the upload time as anchor)

### 2. `webhook_logs` — Lambda request/response round-trips
- Query: `WebhookLog.find({ deviceId }).sort({ timestamp: 1 }).lean()`
- Each document is one event with `timestamp` (wall-clock, already correct)
- Display as a single entry in the timeline at its `timestamp`

### 3. `device_crashes` — Crash reports
- Query: `DeviceCrash.find({ deviceId }).sort({ detectedAt: 1 }).lean()`
- Each document has `detectedAt` (wall-clock)
- Display as a single entry in the timeline at `detectedAt`

### 4. `device_events` — Raw Particle events
- Query: `DeviceEvent.find({ deviceId }).sort({ createdAt: 1 }).lean()`
- Each document has `createdAt` (wall-clock)
- Display as a single entry in the timeline at `createdAt`

## How to Build the Merged Timeline

```typescript
type TimelineEntry = {
    timestamp: Date;           // wall-clock time for sorting
    source: 'firmware' | 'webhook' | 'crash' | 'event';
    data: any;                 // the source-specific data
};

// 1. Flatten device_logs into individual line entries
const firmwareEntries: TimelineEntry[] = [];
for (const log of deviceLogs) {
    const bootTime = log.bootTime ? new Date(log.bootTime).getTime() : null;
    const uploadTime = new Date(log.uploadedAt).getTime();
    const lastMs = log.logLines.length > 0 ? log.logLines[log.logLines.length - 1].ms : 0;

    for (const line of log.logLines) {
        const timestamp = bootTime
            ? new Date(bootTime + line.ms)
            : new Date(uploadTime - lastMs + line.ms);  // approximate fallback

        firmwareEntries.push({
            timestamp,
            source: 'firmware',
            data: { ms: line.ms, message: line.message, sessionId: log.sessionId }
        });
    }
}

// 2. Map webhook logs
const webhookEntries: TimelineEntry[] = webhookLogs.map(wh => ({
    timestamp: new Date(wh.timestamp),
    source: 'webhook',
    data: wh
}));

// 3. Map crashes
const crashEntries: TimelineEntry[] = crashes.map(cr => ({
    timestamp: new Date(cr.detectedAt),
    source: 'crash',
    data: cr
}));

// 4. Map events
const eventEntries: TimelineEntry[] = events.map(ev => ({
    timestamp: new Date(ev.createdAt),
    source: 'event',
    data: ev
}));

// 5. Merge and sort
const timeline = [
    ...firmwareEntries,
    ...webhookEntries,
    ...crashEntries,
    ...eventEntries
].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
```

## UI Layout

### Timeline View (unified)

A single scrollable list, newest at top (or bottom — pick one, be consistent). Each entry is a row with:

```
[timestamp] [source badge] [content]
```

**Source badges** (color-coded):
- `FIRMWARE` — blue/gray — for device log lines
- `WEBHOOK` — green — for webhook round-trips
- `CRASH` — red — for crash reports
- `EVENT` — purple/light — for raw Particle events

### How Each Source Type Renders

**Firmware log lines:**
```
16:41:56  FIRMWARE  HEAT: T=45.0 target=45.0 pwr=12 err=0 int=200
16:42:02  FIRMWARE  HEAT: T=45.5 target=45.0 pwr=0 err=-5 int=195
16:42:10  FIRMWARE  Cloud connected
```
- Just the message text, monospace font
- Lines containing ERROR, WARN, OVERHEAT, INTERRUPTED, THERMISTOR DISCONNECT → red/orange text or background highlight
- Lines starting with `=== PREV SESSION CHECKPOINTS` → distinct styling (section header)

**Webhook round-trips:**
```
16:42:15  WEBHOOK  validate-cartridge → SUCCESS (230ms)
```
- Single line summary: event name → status (processing time)
- Click to expand and show full request/response JSON
- Color status: SUCCESS=green text, FAILURE/ERROR=red text

**Crash reports:**
```
16:43:00  CRASH  ⚠ INTERRUPTED at CP_CLOUD_CONNECT (code 12) — Category: CLOUD
```
- Always visually prominent — red background or border
- Click to expand and show full checkpoint sequence with human-readable names
- Show the trail like: `Test Start → Cloud Disconnect → Cloud Disconnect OK → ... → Cloud Connect ⚠`
- The interrupted checkpoint (last even code) gets a warning indicator

**Raw events:**
```
16:42:14  EVENT  validate-cartridge published
```
- Light/muted styling — these are supplementary context
- Click to expand and show event data payload
- Can be hidden/shown via a toggle since they're the least useful in the timeline

### Filters and Controls

- **Date range picker** — filter the timeline to a specific window
- **Source toggles** — checkboxes to show/hide each source type (firmware, webhook, crash, event)
- **Search** — text search across all firmware log messages
- **Session boundaries** — visual separator line between device boot sessions (detect by `=== SESSION START ===` lines or by different `sessionId` values in firmware entries)

### Pagination / Virtualization

The timeline could have thousands of entries for an active device. Use either:
- Pagination (load 200 entries at a time, "Load more" button)
- Virtual scrolling (render only visible rows)
- Date-range windowing (default to last 24 hours, user expands)

## Example: What the Timeline Looks Like for a Full Test Cycle

```
10:30:00  FIRMWARE  ======== SESSION START ========
10:30:00  FIRMWARE  Boot #47 | Device: e00fce68... | Firmware: v74 | Format: v40
10:30:00  FIRMWARE  === PREV SESSION CHECKPOINTS (boot #46) ===
10:30:00  FIRMWARE    CP[0] = 70    (Test Start)
10:30:00  FIRMWARE    CP[1] = 10    (Cloud Disconnect)
10:30:00  FIRMWARE    ...
10:30:00  FIRMWARE  === END CHECKPOINTS ===
10:30:01  FIRMWARE  EEPROM loaded, format v40
10:30:05  FIRMWARE  Cloud connected
10:31:00  FIRMWARE  HEAT: T=25.0 target=45.0 pwr=255 err=200 int=10
10:32:00  FIRMWARE  HEAT: T=35.0 target=45.0 pwr=200 err=100 int=50
10:33:00  FIRMWARE  HEAT: T=44.5 target=45.0 pwr=20 err=5 int=180
10:33:05  FIRMWARE  HEAT: ready=YES T=45.0
10:35:00  FIRMWARE  Insertion detected
10:35:02  FIRMWARE  Barcode scanned: CART-2026-001
10:35:03  EVENT     validate-cartridge published
10:35:03  FIRMWARE  Publishing validate-cartridge
10:35:04  WEBHOOK   validate-cartridge → SUCCESS (230ms)
10:35:04  FIRMWARE  Validation response: SUCCESS, assayId=ASSAY-001
10:35:05  EVENT     load-assay published
10:35:05  FIRMWARE  Publishing load-assay
10:35:06  WEBHOOK   load-assay → SUCCESS (180ms)
10:35:06  FIRMWARE  Assay loaded, BCODE compiled, duration=120s
10:35:10  FIRMWARE  Cloud disconnected for test
10:35:11  FIRMWARE  Starting test...
          ... (test execution — no uploads during test, these lines come in the post-test upload) ...
10:37:15  FIRMWARE  Test complete, writing results to file
10:37:16  FIRMWARE  Cloud reconnected
10:37:17  EVENT     upload-test published
10:37:18  WEBHOOK   upload-test → SUCCESS (340ms)
10:37:18  FIRMWARE  Upload response: SUCCESS
10:37:20  FIRMWARE  Removal detected
```

This gives a complete narrative of what happened — you can follow the device's behavior from boot through heating, cartridge insertion, validation, test execution, upload, all in one scrollable view.

## Relationship to Other Views

The unified timeline is the PRIMARY diagnostics view. The separate tabs (Session Logs, Crashes, Webhook Logs, Events) from the original spec still exist as focused views for when you want to dig into one data type. The timeline is the overview; the tabs are the detail drilldowns.

### Page Structure

```
/spu/devices/[deviceId]/diagnostics

├── Tab: Timeline (unified view — this doc)
├── Tab: Session Logs (table of device_log documents, expandable)
├── Tab: Crashes (table of device_crash documents, expandable)
├── Tab: Webhook Logs (table of webhook_log documents, expandable)
└── Tab: Events (table of device_event documents, expandable)
```

Timeline tab is the default.
