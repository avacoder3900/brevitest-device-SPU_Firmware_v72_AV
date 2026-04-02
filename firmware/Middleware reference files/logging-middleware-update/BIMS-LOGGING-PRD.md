# PRD: Device Logging Pipeline — BIMS Integration

## Overview

The Brevitest firmware has a comprehensive 3-layer logging system (EEPROM checkpoints, RAM log buffer with flash flush, heater monitoring) that has been shipping since firmware v71. The AWS Lambda middleware has been updated to parse these logs and forward them to the BIMS API. This PRD covers the BIMS (Bioscale Operations System V2) changes needed to receive, store, and display this data.

## Architecture

The Lambda middleware POSTs parsed data to BIMS API endpoints. The BIMS owns all writes.

```
Device (idle) → Particle.publish("device-log") → Particle Cloud webhook
    → AWS Lambda middleware
        - parses session log text into structured lines
        - parses checkpoint block, detects crashes
        - classifies crash category from checkpoint codes
    → POST to BIMS API endpoints (this PRD)
        - /api/device/logs        — session logs
        - /api/device/crashes     — crash reports
        - /api/device/webhook-logs — webhook round-trips
        - /api/device/events      — all Particle events (catch-all)
    → MongoDB collections via Mongoose
    → BIMS dashboard pages (this PRD)
```

The Lambda authenticates to the BIMS using `x-api-key` header with a shared `BIMS_API_KEY` / `AGENT_API_KEY` value. This is the same auth pattern used by the existing Particle webhook endpoint at `src/routes/api/particle/webhook/+server.ts`.

## Decisions (Finalized)

1. **BIMS API approach** — Lambda POSTs to BIMS endpoints, not direct MongoDB writes. BIMS owns all logging data (nanoid IDs, immutable middleware, Mongoose validation).
2. **30-day TTL** on device_logs, webhook_logs, and device_events. Crashes kept forever.
3. **Remove DeviceEvent enum** — change `eventType` from restricted enum to open `String` so any Particle event name is accepted.
4. **Lambda → BIMS via API** — same as decision 1. Lambda needs `BIMS_API_URL` and `BIMS_API_KEY` env vars.

---

## 1. New Mongoose Models

All three new models are **Tier 3 — Immutable** (insert-only, no updates or deletes). Apply `applyImmutableMiddleware` from `$lib/server/db/middleware/immutable.ts`.

All `_id` fields use `nanoid(21)` via `generateId()` from `$lib/server/db/utils.ts`.

### 1A. DeviceLog

**File:** `src/lib/server/db/models/device-log.ts`
**Collection:** `device_logs`

Stores complete firmware session logs uploaded from devices. Each document is one boot session's worth of log data.

```typescript
import { Schema, model } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const DeviceLogSchema = new Schema({
    _id: { type: String, default: generateId },

    // Device identification
    deviceId: { type: String, required: true },       // Particle device ID (coreid)
    deviceName: { type: String },                      // Human-readable device name

    // Session identification
    sessionId: { type: String, required: true },       // Unique per session: "deviceId_bootN_timestamp"
    firmwareVersion: { type: Number },                 // e.g., 73
    dataFormatVersion: { type: Number },               // e.g., 40
    bootCount: { type: Number },                       // Boot counter from EEPROM (wraps at 255)
    bootTime: { type: Date },                          // When the device booted this session

    // Upload metadata
    uploadedAt: { type: Date, default: Date.now, required: true },

    // The actual log content — array of {ms, message} objects
    // ms = millis() timestamp from firmware clock, message = log line text
    // Example: { ms: 142000, message: "HEAT: T=45.0 target=45.0 pwr=12 err=0 int=200" }
    logLines: [{
        _id: false,
        ms: { type: Number },
        message: { type: String }
    }],

    // Summary fields (computed by middleware on insert, for fast dashboard display)
    lineCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },          // Lines containing ERROR/WARN/OVERHEAT/etc.
    hasCrash: { type: Boolean, default: false },        // Was the previous session interrupted?
    firstLine: { type: String },
    lastLine: { type: String }
}, {
    timestamps: false,
    collection: 'device_logs'
});

DeviceLogSchema.index({ deviceId: 1, uploadedAt: -1 });
DeviceLogSchema.index({ hasCrash: 1, uploadedAt: -1 });
DeviceLogSchema.index({ sessionId: 1 }, { unique: true });
// TTL: auto-delete after 30 days
DeviceLogSchema.index({ uploadedAt: 1 }, { expireAfterSeconds: 2592000 });

applyImmutableMiddleware(DeviceLogSchema);

export default model('DeviceLog', DeviceLogSchema);
```

### 1B. DeviceCrash

**File:** `src/lib/server/db/models/device-crash.ts`
**Collection:** `device_crashes`

Stores crash reports extracted from session log checkpoint blocks. Only created when the middleware detects "INTERRUPTED at checkpoint X". Links to the full session log via `sessionLogId`.

**No TTL — crash reports are kept forever.** These are rare (only on actual crashes) and are the most valuable diagnostic data.

```typescript
import { Schema, model } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const DeviceCrashSchema = new Schema({
    _id: { type: String, default: generateId },

    // Device identification
    deviceId: { type: String, required: true },
    deviceName: { type: String },
    firmwareVersion: { type: Number },
    bootCount: { type: Number },

    // When the crash was detected (= when the NEXT boot happened and uploaded logs)
    detectedAt: { type: Date, default: Date.now, required: true },

    // Checkpoint forensics — the core diagnostic data
    // The firmware writes even checkpoint codes BEFORE risky operations and odd codes AFTER.
    // If the last checkpoint is even, that operation was interrupted (crash/hang/power-loss).
    lastCheckpoint: { type: Number, required: true },       // e.g., 12
    lastCheckpointName: { type: String, required: true },   // e.g., "CP_CLOUD_CONNECT"
    checkpointSequence: [{ type: Number }],                 // Full trail: [70, 10, 11, 71, 60, 61, 30, 40, 41, 31, 50, 51, 12]

    // Classification (derived from checkpoint code range in firmware header)
    // 10-23 = CLOUD, 30-31 = BCODE, 40-41 = I2C, 50-57 = FILE_IO,
    // 60-67 = HARDWARE, 70-73 = TEST_LIFECYCLE, 80+ = HEATER
    crashCategory: {
        type: String,
        enum: ['CLOUD', 'BCODE', 'I2C', 'FILE_IO', 'HARDWARE', 'TEST_LIFECYCLE', 'HEATER', 'UNKNOWN'],
        required: true
    },

    // Link to full session log (may be null if log upload failed but crash was detected)
    sessionLogId: { type: String }
}, {
    timestamps: false,
    collection: 'device_crashes'
});

DeviceCrashSchema.index({ deviceId: 1, detectedAt: -1 });
DeviceCrashSchema.index({ lastCheckpoint: 1 });
DeviceCrashSchema.index({ crashCategory: 1, detectedAt: -1 });
// No TTL — crashes kept forever

applyImmutableMiddleware(DeviceCrashSchema);

export default model('DeviceCrash', DeviceCrashSchema);
```

### 1C. WebhookLog

**File:** `src/lib/server/db/models/webhook-log.ts`
**Collection:** `webhook_logs`

Stores enhanced request/response logs for every webhook round-trip through the Lambda middleware. This is what lets you see "the Lambda got the request and sent back X" — the piece that's invisible to the device.

```typescript
import { Schema, model } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const WebhookLogSchema = new Schema({
    _id: { type: String, default: generateId },

    deviceId: { type: String, required: true },
    eventName: { type: String, required: true },            // "validate-cartridge", "upload-test", "device-log", etc.
    timestamp: { type: Date, default: Date.now, required: true },
    processingTimeMs: { type: Number },                     // How long the Lambda took

    // What the device sent (via Particle Cloud webhook)
    request: {
        _id: false,
        raw: { type: String },                              // Raw payload (first 500 chars)
        parsed: { type: Schema.Types.Mixed },               // What the Lambda extracted
        particlePublishedAt: { type: Date }                 // When the device published the event
    },

    // What the Lambda sent back (via Particle Cloud webhook response)
    response: {
        _id: false,
        status: { type: String },                           // "SUCCESS", "FAILURE", "ERROR", "INVALID"
        data: { type: Schema.Types.Mixed },
        errorMessage: { type: String }
    },

    // Correlation fields
    cartridgeId: { type: String },
    assayId: { type: String },
    firmwareVersion: { type: Number }
}, {
    timestamps: false,
    collection: 'webhook_logs'
});

WebhookLogSchema.index({ deviceId: 1, timestamp: -1 });
WebhookLogSchema.index({ eventName: 1, timestamp: -1 });
WebhookLogSchema.index({ 'response.status': 1, timestamp: -1 });
// TTL: auto-delete after 30 days
WebhookLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

applyImmutableMiddleware(WebhookLogSchema);

export default model('WebhookLog', WebhookLogSchema);
```

### 1D. Modify Existing DeviceEvent Model

**File:** `src/lib/server/db/models/device-event.ts`

Change the `eventType` field from a restricted enum to an open string:

```typescript
// BEFORE:
eventType: { type: String, enum: ['validate', 'load_assay', 'upload', 'reset', 'error'] },

// AFTER:
eventType: { type: String, required: true },
```

Also add a TTL index:
```typescript
// TTL: auto-delete after 30 days
DeviceEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });
```

### Model Registration

Add new models to `src/lib/server/db/models/index.ts` under the **Tier 3 — Immutable Logs** section:

```typescript
// --- Tier 3: Immutable Logs ---
export { default as AuditLog } from './audit-log.js';
export { default as ElectronicSignature } from './electronic-signature.js';
export { default as InventoryTransaction } from './inventory-transaction.js';
export { default as DeviceEvent } from './device-event.js';
export { default as ManufacturingMaterialTransaction } from './manufacturing-material-transaction.js';
// NEW:
export { default as DeviceLog } from './device-log.js';
export { default as DeviceCrash } from './device-crash.js';
export { default as WebhookLog } from './webhook-log.js';
```

Also re-export from `src/lib/server/db/index.ts` if that file re-exports models.

---

## 2. API Endpoints

All ingestion endpoints use `requireAgentApiKey(request)` for auth — same as `src/routes/api/particle/webhook/+server.ts`. The Lambda authenticates with the `x-api-key` header.

### 2A. Device Log Ingestion

**File:** `src/routes/api/device/logs/+server.ts`
**Method:** POST
**Auth:** `requireAgentApiKey(request)`

Receives parsed session logs from the Lambda middleware.

```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, DeviceLog } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
    requireAgentApiKey(request);
    await connectDB();

    const body = await request.json();

    const deviceLog = await DeviceLog.create({
        deviceId: body.deviceId,
        deviceName: body.deviceName || null,
        sessionId: body.sessionId,
        firmwareVersion: body.firmwareVersion || null,
        dataFormatVersion: body.dataFormatVersion || null,
        bootCount: body.bootCount || null,
        bootTime: body.bootTime ? new Date(body.bootTime) : new Date(),
        uploadedAt: new Date(),
        logLines: body.logLines || [],
        lineCount: body.lineCount || 0,
        errorCount: body.errorCount || 0,
        hasCrash: body.hasCrash || false,
        firstLine: body.firstLine || '',
        lastLine: body.lastLine || ''
    });

    return json({ success: true, logId: deviceLog._id });
};
```

### 2B. Device Crash Ingestion

**File:** `src/routes/api/device/crashes/+server.ts`
**Method:** POST (ingestion), GET (dashboard queries)
**Auth:** POST = `requireAgentApiKey(request)`, GET = `requirePermission('device:read')`

```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, DeviceCrash } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
    requireAgentApiKey(request);
    await connectDB();

    const body = await request.json();

    const crash = await DeviceCrash.create({
        deviceId: body.deviceId,
        deviceName: body.deviceName || null,
        firmwareVersion: body.firmwareVersion || null,
        bootCount: body.bootCount || null,
        detectedAt: new Date(),
        lastCheckpoint: body.lastCheckpoint,
        lastCheckpointName: body.lastCheckpointName,
        checkpointSequence: body.checkpointSequence || [],
        crashCategory: body.crashCategory,
        sessionLogId: body.sessionLogId || null
    });

    return json({ success: true, crashId: crash._id });
};

export const GET: RequestHandler = async ({ url, locals }) => {
    // requirePermission(locals.user, 'device:read');  // uncomment when wiring up dashboard
    await connectDB();

    const deviceId = url.searchParams.get('deviceId');
    const category = url.searchParams.get('category');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const filter = {};
    if (deviceId) filter.deviceId = deviceId;
    if (category) filter.crashCategory = category;
    if (from || to) {
        filter.detectedAt = {};
        if (from) filter.detectedAt.$gte = new Date(from);
        if (to) filter.detectedAt.$lte = new Date(to);
    }

    const [crashes, total] = await Promise.all([
        DeviceCrash.find(filter)
            .sort({ detectedAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        DeviceCrash.countDocuments(filter)
    ]);

    return json({
        crashes: JSON.parse(JSON.stringify(crashes)),
        total,
        page
    });
};
```

### 2C. Webhook Log Ingestion

**File:** `src/routes/api/device/webhook-logs/+server.ts`
**Method:** POST
**Auth:** `requireAgentApiKey(request)`

```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, WebhookLog } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
    requireAgentApiKey(request);
    await connectDB();

    const body = await request.json();

    await WebhookLog.create({
        deviceId: body.deviceId,
        eventName: body.eventName,
        timestamp: new Date(),
        processingTimeMs: body.processingTimeMs || null,
        request: body.request || {},
        response: body.response || {},
        cartridgeId: body.cartridgeId || null,
        assayId: body.assayId || null,
        firmwareVersion: body.firmwareVersion || null
    });

    return json({ success: true });
};
```

### 2D. Device Event Archiving

**File:** `src/routes/api/device/events/+server.ts`
**Method:** POST
**Auth:** `requireAgentApiKey(request)`

This receives the catch-all Particle event archive from the middleware.

```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, DeviceEvent } from '$lib/server/db';

export const POST: RequestHandler = async ({ request }) => {
    requireAgentApiKey(request);
    await connectDB();

    const body = await request.json();

    await DeviceEvent.create({
        deviceId: body.deviceId,
        eventType: body.eventName,
        eventData: body.data || null,
        createdAt: body.publishedAt ? new Date(body.publishedAt) : new Date()
    });

    return json({ success: true });
};
```

---

## 3. Shared Utility: Checkpoint Code Reference

**File:** `src/lib/checkpoint-codes.ts`

Used by dashboard components to display human-readable checkpoint names alongside numeric codes.

```typescript
export const CHECKPOINT_NAMES: Record<number, string> = {
    10: 'Cloud Disconnect',
    11: 'Cloud Disconnect OK',
    12: 'Cloud Connect',
    13: 'Cloud Connect OK',
    14: 'Publish Validate',
    15: 'Publish Validate OK',
    16: 'Publish Load Assay',
    17: 'Publish Load Assay OK',
    18: 'Publish Upload',
    19: 'Publish Upload OK',
    20: 'Publish Reset',
    21: 'Publish Reset OK',
    22: 'Webhook Response Received',
    23: 'Webhook Timeout',
    30: 'BCODE Start',
    31: 'BCODE Complete',
    40: 'Spectro Reading Start',
    41: 'Spectro Reading Complete',
    50: 'File Write Test',
    51: 'File Write Test OK',
    52: 'File Read Assay',
    53: 'File Read Assay OK',
    54: 'File Write Assay',
    55: 'File Write Assay OK',
    60: 'Stage Reset',
    61: 'Stage Reset OK',
    62: 'Barcode Scan',
    63: 'Barcode Scan OK',
    64: 'I2C Bus Init',
    65: 'I2C Bus Init OK',
    70: 'Test Start',
    71: 'Test Hardware Setup',
    80: 'Heater Overheat'
};

export const CRASH_CATEGORIES: Record<string, string> = {
    CLOUD: 'Cloud Operations (connect/disconnect/publish)',
    BCODE: 'Test Protocol Execution',
    I2C: 'Spectrophotometer / I2C Bus',
    FILE_IO: 'Flash File System',
    HARDWARE: 'Hardware (stage/barcode/I2C init)',
    TEST_LIFECYCLE: 'Test Lifecycle',
    HEATER: 'Heater / Temperature Control',
    UNKNOWN: 'Unknown'
};

// Even checkpoint codes = "about to do X", Odd = "X completed OK"
// If the last checkpoint is even, that operation was interrupted (crash/hang/power-loss)
export const isInterruptedCheckpoint = (code: number): boolean => {
    return code % 2 === 0 && code !== 0;
};

export const getCheckpointName = (code: number): string => {
    return CHECKPOINT_NAMES[code] ?? `Unknown (${code})`;
};
```

---

## 4. Dashboard Pages

### 4A. Device Diagnostics Detail Page

**Route:** `src/routes/spu/devices/[deviceId]/diagnostics/+page.server.ts` + `+page.svelte`
**Permission:** `device:read`

Follow the `admin/agent-activity` page pattern (stats cards, filters, paginated table).

**Data loading (`+page.server.ts`):**
- Load device from `ParticleDevice` or `FirmwareDevice` by `deviceId`
- Query `DeviceLog` — most recent 50 sessions, sorted by `uploadedAt` desc
- Query `DeviceCrash` — all crashes for this device, sorted by `detectedAt` desc
- Query `WebhookLog` — most recent 100 webhook logs
- Query `DeviceEvent` — most recent 100 events
- Compute stats: total logs, total crashes, most common crash category, avg webhook processing time
- Apply URL param filters: date range (`from`, `to`), event type

**Page layout (`+page.svelte`):**

1. **Header** — Device name, ID, firmware version, online status, last heard
2. **Stats cards:**
   - Total session logs uploaded
   - Total crashes (red highlight if > 0)
   - Most common crash category
   - Average webhook processing time (ms)
   - Last crash date (or "No crashes")
3. **Tabs:**
   - **Timeline** — Unified chronological view, all event types interleaved. Color-coded by source. Expandable entries.
   - **Session Logs** — Table: upload date, firmware version, boot count, line count, error count, crash flag. Click to expand full log lines.
   - **Crashes** — Table: date, firmware version, last checkpoint (code + name), category, sequence length. Expandable to show full checkpoint trail with names.
   - **Webhook Logs** — Table: timestamp, event name, status, processing time. Expandable for full request/response.
4. **Date range filter** across all tabs

### 4B. Cross-Device Crash Dashboard

**Route:** `src/routes/admin/device-crashes/+page.server.ts` + `+page.svelte`
**Permission:** `admin:full` or `device:read`

Fleet-wide crash overview.

**Data loading:**
- Query `DeviceCrash` with pagination
- Aggregate: count by `crashCategory`, count by `lastCheckpoint`, count by `deviceId`
- Apply filters: deviceId, crashCategory, firmware version, date range

**Page layout:**

1. **Stats cards:**
   - Total crashes (all time / last 7 days / last 24 hours)
   - Most common crash category (with count)
   - Most crash-prone device (with count)
   - Most common checkpoint failure (code + name + count)
2. **Filters:** Device dropdown, crash category dropdown, firmware version, date range
3. **Paginated table:** Date, Device, Firmware, Checkpoint (code + name), Category. Click to expand: full checkpoint sequence, link to session log.

### 4C. Extend Existing Device Detail Page

**File:** `src/routes/spu/devices/[deviceId]/+page.svelte`

Add:
- "Diagnostics" button linking to the new diagnostics page
- Crash count badge if crashes exist for this device
- Last session log upload date in the device info section

---

## 5. Coding Standards (from existing CLAUDE.md)

- **IDs:** All `_id` fields are `nanoid(21)` strings, never ObjectId. Use `generateId()` from `$lib/server/db/utils.ts`
- **Serialization:** Mongoose results must use `.lean()` then `JSON.parse(JSON.stringify(data))` before returning from load functions
- **Tier 3 models:** Apply `applyImmutableMiddleware` — blocks all updates and deletes at Mongoose layer
- **API auth:** External endpoints use `requireAgentApiKey(request)` from `$lib/server/api-auth`
- **Page auth:** Dashboard pages use `requirePermission(locals.user, 'device:read')`
- **DB connection:** Every handler must call `await connectDB()` before queries
- **Exports:** New models exported from `src/lib/server/db/models/index.ts` and `src/lib/server/db/index.ts`
- **Subdoc IDs:** Use `_id: false` on subdocument schemas (like `logLines`, `request`, `response`) to prevent Mongoose from auto-generating ObjectId subdoc IDs
- **Style:** Tailwind CSS, no custom CSS. Follow existing component patterns.

---

## 6. Implementation Order

1. Create the 3 new model files (device-log.ts, device-crash.ts, webhook-log.ts)
2. Modify existing DeviceEvent model (remove enum restriction, add TTL index)
3. Register all models in index.ts exports
4. Create the 4 API endpoint files (logs, crashes, webhook-logs, events)
5. Create checkpoint-codes.ts shared utility
6. Create device diagnostics page (spu/devices/[deviceId]/diagnostics)
7. Create cross-device crash dashboard (admin/device-crashes)
8. Add diagnostics link to existing device detail page

---

## 7. Testing

- **Model creation:** Create DeviceLog, DeviceCrash, WebhookLog with sample data. Verify documents are created with nanoid `_id` fields.
- **Immutability:** Attempt to update or delete a DeviceLog. Verify Mongoose throws an error.
- **API ingestion:** POST sample session log JSON to `/api/device/logs`. Verify 200 response with `logId`. Verify document exists in MongoDB.
- **Crash detection:** POST a log where `hasCrash: true`, then POST a crash to `/api/device/crashes`. Verify crash document links to log via `sessionLogId`.
- **TTL:** Verify TTL indexes exist on device_logs (uploadedAt), webhook_logs (timestamp), device_events (createdAt). All set to 2592000 seconds (30 days). Verify device_crashes has NO TTL index.
- **DeviceEvent enum:** POST an event with `eventType: 'device-log'` to `/api/device/events`. Verify it succeeds (would have failed with old enum).
- **Dashboard:** Load diagnostics page for a device with sample data. Verify all tabs render.

---

## Appendix: Sample Data for Testing

### Sample DeviceLog POST body

```json
{
    "deviceId": "e00fce68abcd1234",
    "deviceName": "BT-M01-0000-0209",
    "sessionId": "e00fce68abcd1234_boot47_2026-03-27T10:30:00Z",
    "firmwareVersion": 73,
    "dataFormatVersion": 40,
    "bootCount": 47,
    "bootTime": "2026-03-27T10:30:00Z",
    "logLines": [
        { "ms": 0, "message": "=== PREV SESSION CHECKPOINTS (boot #46) ===" },
        { "ms": 0, "message": "  CP[0] = 70" },
        { "ms": 0, "message": "  CP[1] = 10" },
        { "ms": 0, "message": "  CP[2] = 11" },
        { "ms": 0, "message": "  CP[3] = 30" },
        { "ms": 0, "message": "  CP[4] = 31" },
        { "ms": 0, "message": "  CP[5] = 13" },
        { "ms": 0, "message": "=== END CHECKPOINTS ===" },
        { "ms": 1200, "message": "Firmware v73 booting..." },
        { "ms": 1500, "message": "EEPROM loaded, format v40" },
        { "ms": 5000, "message": "Cloud connected" },
        { "ms": 30000, "message": "HEAT: T=25.0 target=45.0 pwr=255 err=200 int=10" },
        { "ms": 60000, "message": "HEAT: T=35.0 target=45.0 pwr=200 err=100 int=50" },
        { "ms": 90000, "message": "HEAT: T=44.5 target=45.0 pwr=20 err=5 int=180" },
        { "ms": 95000, "message": "HEAT: ready=YES T=45.0" }
    ],
    "lineCount": 15,
    "errorCount": 0,
    "hasCrash": false,
    "firstLine": "=== PREV SESSION CHECKPOINTS (boot #46) ===",
    "lastLine": "HEAT: ready=YES T=45.0"
}
```

### Sample DeviceCrash POST body

```json
{
    "deviceId": "e00fce68abcd1234",
    "deviceName": "BT-M01-0000-0209",
    "firmwareVersion": 73,
    "bootCount": 46,
    "lastCheckpoint": 12,
    "lastCheckpointName": "CP_CLOUD_CONNECT",
    "checkpointSequence": [70, 10, 11, 71, 60, 61, 30, 40, 41, 40, 41, 31, 50, 51, 12],
    "crashCategory": "CLOUD",
    "sessionLogId": "abc123def456ghi78"
}
```

### Sample WebhookLog POST body

```json
{
    "deviceId": "e00fce68abcd1234",
    "eventName": "validate-cartridge",
    "processingTimeMs": 230,
    "request": {
        "raw": "{\"uuid\":\"CART-2026-001\"}",
        "parsed": { "uuid": "CART-2026-001" },
        "particlePublishedAt": "2026-03-27T10:35:00Z"
    },
    "response": {
        "status": "SUCCESS",
        "data": { "cartridgeId": "CART-2026-001", "assayId": "ASSAY-001", "checksum": 12345 },
        "errorMessage": null
    },
    "cartridgeId": "CART-2026-001",
    "assayId": "ASSAY-001",
    "firmwareVersion": 73
}
```
