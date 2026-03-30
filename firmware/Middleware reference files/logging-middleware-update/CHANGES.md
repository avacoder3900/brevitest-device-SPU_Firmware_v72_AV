# Logging Middleware Update

Changes to the parallel middleware (new-parallel-middleware) to complete the device logging pipeline.

**evaluate.mjs** and **utilities.mjs** are UNCHANGED — copy from new-parallel-middleware.

## Architecture Decision: BIMS API Forwarding

The middleware does NOT write directly to MongoDB logging collections. Instead, it POSTs parsed data to the BIMS API endpoints. This means:
- The BIMS owns all writes (nanoid IDs, immutable Mongoose middleware, schema validation)
- Single writer to logging collections (no Lambda + BIMS dual-write confusion)
- Lambda needs `BIMS_API_URL` and `BIMS_API_KEY` env vars
- BIMS API endpoints must be deployed BEFORE the Lambda update

## What Changed

### index.mjs

1. **New `device-log` event handler** (`handle_device_log`)
   - Receives firmware session log uploads (text or base64 binary via `loadData()`)
   - Parses `millis|message` log lines into structured `{ms, message}` arrays
   - Parses the checkpoint dump block at the top of each session log
   - Extracts session metadata (firmware version, boot count, device ID) from session headers
   - Detects crashes by looking for "INTERRUPTED at checkpoint X" in the checkpoint block
   - Forwards parsed log to BIMS via `POST /api/device/logs`
   - If crash detected, forwards crash report to BIMS via `POST /api/device/crashes`
   - Returns SUCCESS/FAILURE so firmware knows whether to delete the flash file

2. **Catch-all event archiving** (in `handler`)
   - Every incoming Particle event is forwarded to BIMS via `POST /api/device/events`
   - Best-effort / non-blocking — archive failure doesn't break the webhook response
   - Captures: deviceId, eventName, data, publishedAt, archivedAt

3. **Enhanced webhook logging** (`write_webhook_log`)
   - Every webhook round-trip is forwarded to BIMS via `POST /api/device/webhook-logs`
   - Captures: full request payload (first 500 chars), response status/data, processing time in ms
   - Separate from legacy `write_log` which still writes to CouchDB for backward compat

4. **Checkpoint code reference table** (`CHECKPOINT_NAMES`, `crashCategoryForCheckpoint`)
   - Maps firmware checkpoint codes (10-80) to human-readable names
   - Classifies crash category: CLOUD, BCODE, I2C, FILE_IO, HARDWARE, TEST_LIFECYCLE, HEATER

### db-adapter.mjs

Added BIMS API forwarding via `postToBims()` helper:

| Function | BIMS Endpoint | Purpose |
|----------|--------------|---------|
| `saveDeviceLog(doc)` | `POST /api/device/logs` | Forward parsed firmware session logs |
| `saveDeviceCrash(doc)` | `POST /api/device/crashes` | Forward crash checkpoint analysis |
| `saveWebhookLog(doc)` | `POST /api/device/webhook-logs` | Forward enhanced request/response logs |
| `saveDeviceEvent(doc)` | `POST /api/device/events` | Forward archived Particle events |

All are best-effort — failures log to console but don't break normal operation.

## Environment Variables

**New (required for logging pipeline):**
- `BIMS_API_URL` — BIMS base URL, e.g., `https://your-bims.vercel.app`
- `BIMS_API_KEY` — must match the BIMS `AGENT_API_KEY` env var

**Existing (unchanged):**
- `MONGODB_URI` — still used for cartridge/assay/legacy-log reads and writes
- `MONGODB_DB` — defaults to 'bioscale'
- `PARTICLE_ACCESS_TOKEN`, `PARTICLE_URL` — Particle Cloud API
- `COUCHDB_BASEURL`, `COUCHDB_BASE64_CREDENTIAL` — CouchDB backward compat

## Deployment Order

1. **First:** Deploy BIMS API endpoints (see BIMS-LOGGING-PRD.md)
2. **Second:** Set `BIMS_API_URL` and `BIMS_API_KEY` env vars on Lambda
3. **Third:** Copy `index.mjs` and `db-adapter.mjs` from this folder, deploy Lambda
4. **Fourth:** Create a Particle webhook for `device-log` events pointing to the Lambda URL
5. **Fifth:** Deploy firmware Build 1C (try_upload_session_log) to start the data flow
