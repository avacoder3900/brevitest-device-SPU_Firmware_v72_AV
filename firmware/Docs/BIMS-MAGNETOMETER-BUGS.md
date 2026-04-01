# BIMS Magnetometer Validation — Bug Report & Fixes

**Date:** March 31, 2026
**Source:** Firmware team audit of Bioscale_Operations_System_V2 codebase
**Status:** Needs verification by BIMS team before implementing fixes

## How Magnetometer Validation Works (End-to-End)

The SPU firmware handles the physical validation (BLE connect to magnetometer peripheral, read 5 wells, write to flash file). The BIMS pulls the results from the device via the Particle Cloud API. No firmware changes are needed — all the communication logic lives in the BIMS.

```
1. User triggers "Run Test" in BIMS UI or poll endpoint detects new data
2. BIMS calls Particle Cloud API: GET /v1/devices/{particleDeviceId}/magnet_validation
3. Particle Cloud reads the variable from the SPU device
4. BIMS receives tab-delimited string with 5 wells × 3 channels × 4 values
5. BIMS parses data, evaluates Z-axis readings against criteria (minZ/maxZ)
6. BIMS creates ValidationSession (type: 'mag') and updates SPU.validation.magnetometer
7. Results displayed in session detail page with color-coded pass/fail per well
```

### Raw Data Format from Device

```
#003	1710268200          <-- counter line (test number, timestamp)
1	T	X	Y	Z	T	X	Y	Z	T	X	Y	Z    <-- well 1: chA, chB, chC
2	...                                              <-- well 2
3	...                                              <-- well 3
4	...                                              <-- well 4
5	...                                              <-- well 5
```

Each well line has: well number, then 12 tab-separated floats (3 channels × 4 values: Temperature, X-axis, Y-axis, Z-axis).

---

## Bug #1: History Page Returns Zero Results (HIGH CONFIDENCE)

### Problem

Magnetometer validation sessions are created with `type: 'mag'` but the history page queries for `type: 'magnetometer'`. These strings don't match, so the history page always returns an empty list.

### Evidence

**Session creation** (two locations, both use `'mag'`):

`src/routes/validation/magnetometer/+page.server.ts` — readFromDevice action:
```typescript
const session = await ValidationSession.create({
    type: 'mag',        // <-- created as 'mag'
    // ...
});
```

`src/routes/api/validation/magnetometer/poll/+server.ts`:
```typescript
const session = await ValidationSession.create({
    type: 'mag',        // <-- created as 'mag'
    source: 'auto-poll',
    // ...
});
```

**History query** — `src/routes/validation/magnetometer/history/+page.server.ts` (line 12):
```typescript
const filter = { type: 'magnetometer' };  // <-- queries 'magnetometer', won't match 'mag'
```

### Fix

Change the history query to match the creation type:
```typescript
const filter = { type: 'mag' };
```

OR change all creation sites to use `'magnetometer'` and update the history query accordingly. Just needs to be consistent.

### Verification

Query MongoDB directly:
```javascript
// This will return 0:
db.validation_sessions.countDocuments({ type: 'magnetometer' })

// This will return the actual count:
db.validation_sessions.countDocuments({ type: 'mag' })
```

---

## Bug #2: Missing API Endpoint for Serial Capture (HIGH CONFIDENCE)

### Problem

The `MagnetometerCapture.svelte` component submits captured serial readings to `/api/validation/magnetometer` via POST, but no `+server.ts` file exists at that route. The request would return 404/405.

### Evidence

`src/lib/components/validation/magnetometer/MagnetometerCapture.svelte` (around line 111):
```typescript
const response = await fetch('/api/validation/magnetometer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readings, spuId, ... })
});
```

**Files that exist:**
- `src/routes/api/validation/magnetometer/poll/+server.ts` — the auto-poll endpoint
- No `src/routes/api/validation/magnetometer/+server.ts` — the POST endpoint the component expects

### Fix

Either:
1. Create `src/routes/api/validation/magnetometer/+server.ts` with a POST handler that accepts serial readings, parses them, evaluates pass/fail, and creates a ValidationSession
2. Or update `MagnetometerCapture.svelte` to use an existing endpoint

### Note

The serial capture flow uses a different data format (`MagnetometerReading` with x, y, z, magnitude) than the Particle variable flow (per-well, per-channel, tab-delimited). The API endpoint needs to handle the serial format specifically.

---

## Bug #3: Triplicated Parser with Inconsistent Behavior (MEDIUM CONFIDENCE)

### Problem

The `parseMagValidation()` function is duplicated in three files with different capabilities. The least robust version is used in the most important flow (manual readFromDevice).

### Three Versions

| File | Skips # lines | Detects errors | Fills missing wells | Sorts |
|------|--------------|----------------|--------------------|----- |
| `+page.server.ts` (readFromDevice) | NO | NO | NO | NO |
| `[sessionId]/+page.server.ts` (readResults) | YES | YES | YES | YES |
| `api/.../poll/+server.ts` (auto-poll) | YES | YES | YES | YES |

### Impact

If the magnetometer data includes a `#counter` header line (which it does — see raw data format above), the manual readFromDevice flow will try to parse it as a well reading and either produce garbage data or fail silently. The poll endpoint handles this correctly.

### Fix

Extract `parseMagValidation()` into a shared utility file (e.g., `src/lib/server/magnetometer-utils.ts`) using the most robust version (from the poll endpoint). Import it in all three locations. This ensures consistent parsing behavior across all flows.

```typescript
// src/lib/server/magnetometer-utils.ts
export function parseMagValidation(rawData: string): MagWellResult[] {
    // Use the robust version: skip # lines, detect errors, fill missing wells, sort
}

export function evaluateMagResults(results: MagWellResult[], criteria: { minZ: number, maxZ: number }) {
    // Shared pass/fail evaluation logic
}
```

---

## Additional Observations

### Two Completely Different Data Flows

The BIMS has two independent paths for magnetometer data:

1. **Particle variable flow** (working): BLE magnetometer → SPU firmware → Particle variable → BIMS reads variable → parses tab-delimited per-well data → evaluates Z-axis range

2. **Serial capture flow** (partially broken): magnetometer connected via USB serial → browser Web Serial API → captures raw X/Y/Z/magnitude readings → submits to missing endpoint

These use different data schemas, different parsers, and different evaluation criteria. They may be intentionally separate (different use cases — field validation vs bench testing), but the serial flow is non-functional due to the missing endpoint.

### Pass/Fail Criteria

Stored in `Integration` collection with `type: 'mag_criteria'`:
- `minZ`: default 3900 gauss
- `maxZ`: default 4500 gauss

All three Z-axis readings per well (channels A, B, C) must fall within this range for the well to pass. All 5 wells must pass for the session to pass.

### Files Inventory (for reference)

| File | Purpose |
|------|---------|
| `src/lib/server/particle.ts` | Particle Cloud API client |
| `src/lib/server/db/models/spu.ts` | SPU model with validation.magnetometer subdoc |
| `src/lib/server/db/models/validation-session.ts` | ValidationSession model |
| `src/lib/services/magnetometer-serial.ts` | Client-side Web Serial service |
| `src/lib/components/validation/magnetometer/MagnetometerCapture.svelte` | Serial capture UI |
| `src/lib/components/validation/magnetometer/MagnetometerResult.svelte` | Result display (serial flow) |
| `src/routes/api/validation/magnetometer/poll/+server.ts` | Auto-poll API endpoint |
| `src/routes/validation/magnetometer/+page.server.ts` | Main page (readFromDevice, updateCriteria) |
| `src/routes/validation/magnetometer/+page.svelte` | Main page UI |
| `src/routes/validation/magnetometer/[sessionId]/+page.server.ts` | Session detail (readResults) |
| `src/routes/validation/magnetometer/[sessionId]/+page.svelte` | Session detail UI |
| `src/routes/validation/magnetometer/history/+page.server.ts` | History listing (BUG: wrong type) |
| `src/routes/validation/magnetometer/history/+page.svelte` | History listing UI |
