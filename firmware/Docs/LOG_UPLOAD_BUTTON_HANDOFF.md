# Handoff: Add "Dump Logs" Button to BIMS Diagnostics Page

**Date:** April 1, 2026  
**Context:** Firmware changed from automatic 60-second log uploads to on-demand only, to conserve Particle data operations. BIMS needs a button to trigger log dumps remotely.

---

## What Changed on the Firmware Side

The device no longer auto-uploads session logs every 60 seconds while idle. Instead, two new on-demand triggers were added:

| Trigger | How it works |
|---------|-------------|
| **Particle cloud function** `upload_log` | Call with `""` to trigger upload. Returns 1 (queued), 0 (no data), -1 (help). |
| **Serial command** `414` | For local debugging — flushes RAM to flash, then queues upload. |

When triggered, the device:
1. Flushes the RAM log buffer to `/log/session.txt` on flash
2. Rotates `session.txt` to `session.old.txt`
3. Publishes `session.old.txt` as a `device-log` Particle event (binary, up to 16KB)
4. Particle webhook fires to the Lambda middleware (`handle_device_log` in `logging-middleware-update-zip-ready`)
5. Middleware parses log lines, detects crashes, stores in `device_logs` and `device_crashes` collections
6. On SUCCESS response, device deletes the uploaded file from flash

---

## Middleware: Already Handled

The deployed Lambda middleware (`logging-middleware-update-zip-ready/index.mjs`) already has a full `device-log` handler:

- `handle_device_log()` — parses firmware log format (`millis|message`), extracts metadata
- `parseLogLines()` — structures raw text into `{ms, message}` array
- `parseCheckpointBlock()` — detects crashes from checkpoint trails
- Saves to `device_logs` via `db.saveDeviceLog()`
- Detects crashes and saves to `device_crashes` via `db.saveDeviceCrash()`
- Returns `SUCCESS` with `lineCount` and `crashDetected` fields

The Particle webhook (`device-log-webhook`, integration ID `69c709d6268e6e1104ac7ca8`) is already configured and active. **No middleware or webhook changes needed.**

---

## What Needs to Change in BIMS

### 1. Add a SvelteKit API Route to Call the Particle Function

**Create:** `src/routes/api/device/dump-logs/+server.ts`

```typescript
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { PARTICLE_ACCESS_TOKEN } from '$env/static/private';

export const POST: RequestHandler = async ({ request, locals }) => {
    requirePermission(locals.user, 'device:write');

    const body = await request.json();
    const { particleDeviceId } = body;

    if (!particleDeviceId) {
        throw error(400, 'particleDeviceId is required');
    }

    // Call the Particle cloud function on the device
    const response = await fetch(
        `https://api.particle.io/v1/devices/${particleDeviceId}/upload_log`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PARTICLE_ACCESS_TOKEN}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'arg='
        }
    );

    if (!response.ok) {
        const text = await response.text();
        return json(
            { success: false, error: `Particle API error: ${response.status} ${text}` },
            { status: 502 }
        );
    }

    const result = await response.json();
    // result.return_value: 1 = queued, 0 = no log data, -1 = help shown
    return json({
        success: result.return_value === 1,
        returnValue: result.return_value,
        message: result.return_value === 1
            ? 'Log upload triggered on device'
            : result.return_value === 0
                ? 'No log data on device to upload'
                : 'Unexpected response'
    });
};
```

### 2. Add the Button to the Diagnostics Page

**Edit:** `src/routes/spu/[spuId]/diagnostics/+page.svelte`

Add a "Dump Logs" button in the diagnostics page header/toolbar area, near the existing date range controls. The button should:

- Be visible only when `particleDeviceId` is available (device is linked)
- Show loading state while waiting for the Particle API call
- Display the result (success/no data/error) as a brief toast or inline status
- Be disabled while a dump is already in progress

Example implementation pattern:

```svelte
<script>
    let dumpLogsLoading = false;
    let dumpLogsMessage = '';

    async function handleDumpLogs() {
        dumpLogsLoading = true;
        dumpLogsMessage = '';
        try {
            const res = await fetch('/api/device/dump-logs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ particleDeviceId: data.particleDeviceId })
            });
            const result = await res.json();
            dumpLogsMessage = result.message;
            // After success, wait a few seconds then refresh the page
            // to pick up the new log data once it arrives via webhook
            if (result.success) {
                setTimeout(() => location.reload(), 8000);
            }
        } catch (err) {
            dumpLogsMessage = 'Failed to contact device';
        } finally {
            dumpLogsLoading = false;
        }
    }
</script>

<!-- Add near the date range / filter controls -->
{#if data.particleDeviceId}
    <button
        onclick={handleDumpLogs}
        disabled={dumpLogsLoading}
        class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
    >
        {dumpLogsLoading ? 'Requesting...' : 'Dump Logs'}
    </button>
    {#if dumpLogsMessage}
        <span class="text-sm text-gray-600 ml-2">{dumpLogsMessage}</span>
    {/if}
{/if}
```

---

## Data Flow Summary

```
[BIMS Diagnostics Page] -- user clicks "Dump Logs" -->

    POST /api/device/dump-logs { particleDeviceId }
        |
        v
    Particle REST API: POST /v1/devices/{id}/upload_log
        |
        v
    Device receives cloud function call
        -> upload_session_log() sets deferred_log_upload = true
        -> returns 1 (queued) to BIMS immediately
        |
        v
    Main loop (next IDLE cycle):
        -> flush RAM buffer to session.txt
        -> rotate session.txt to session.old.txt
        -> publish "device-log" event with binary log data
        |
        v
    Particle webhook fires to Lambda
        -> handle_device_log() in logging-middleware-update-zip-ready
        -> parseLogLines() + parseCheckpointBlock()
        -> db.saveDeviceLog() -> device_logs collection
        -> if crash detected: db.saveDeviceCrash() -> device_crashes collection
        -> returns {status: "SUCCESS", lineCount, crashDetected}
        |
        v
    Device receives hook-response/device-log
        -> response_device_log() deletes session.old.txt from flash
        |
        v
    BIMS page auto-refreshes after ~8 seconds
        -> diagnostics page queries device_logs collection
        -> new log data appears in timeline
```

---

## Timing Expectations

| Step | Typical time |
|------|-------------|
| Button click to Particle API response | ~1-2 seconds |
| Device processes function + publishes event | ~1-3 seconds |
| Webhook fires + Lambda processes + device receives response | ~2-5 seconds |
| **Total: button click to data in database** | **~5-10 seconds** |

The 8-second auto-refresh delay in the example code should catch most cases. Consider showing a "Logs requested, refreshing..." message during the wait.

---

## Cost Per Dump

- 1 data op for the `Particle.function()` call from BIMS
- 1 data op per 1,024 bytes of the log publish (a 16KB log = ~16 ops)
- **Total: ~17 data ops per dump** (vs. ~1,440/day with the old automatic system)

---

## Environment Variables

The BIMS backend needs `PARTICLE_ACCESS_TOKEN` to call the Particle API. This is already referenced in the BIMS architecture docs as a known env var — verify it's set in your `.env`.

---

## Permissions

The button requires `device:write` permission since it triggers an action on the physical device. The diagnostics page currently requires `device:read` for viewing — users with read-only access won't see the button.

---

## Edge Cases

| Scenario | What happens |
|----------|-------------|
| Device is offline | Particle API returns error (device not connected). BIMS shows error message. |
| No log data on device | Device returns 0. BIMS shows "No log data on device to upload". |
| Device is mid-test (not IDLE) | The deferred flag is set but only processed in IDLE loop. Logs will upload once test completes and device returns to IDLE. |
| Button clicked twice quickly | Second click is harmless — if first upload is still pending (`log_upload_pending = true`), `try_upload_session_log()` returns early. |
| Flash log file is empty | `try_upload_session_log()` checks file size and skips if empty. No publish, no data ops consumed. |
