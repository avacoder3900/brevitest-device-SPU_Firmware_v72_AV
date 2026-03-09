# Load Assay ~50% Failure Rate Investigation

## Background

During the firmware audit of v69 (Particle M-SoM, Device OS 6.3.x), we investigated why `load_assay` fails approximately 50% of the time. The user confirmed this failure rate through testing. The console always shows "success" (return value 0) regardless of whether the assay actually loaded.

## The Load Assay Flow (End-to-End)

1. User calls `load_assay("A74124FB")` from Particle Console
2. `load_assay()` checks assay ID length == 8, calls `publish_load_assay()`, **returns 0 immediately** (before anything actually happens)
3. `publish_load_assay()` tries to publish a "load-assay" cloud event using the **global shared `event` object**
4. Particle cloud receives event, triggers webhook to middleware (AWS Lambda)
5. Middleware fetches assay from CouchDB, compiles BCODE, computes CRC32 checksum, returns JSON response
6. Particle cloud delivers response back to device as multi-part webhook response events (chunked at 512 bytes)
7. `response_load_assay()` is called once per chunk, stores each in `payload_buffer[]`
8. `all_payloads_received()` heuristic checks if all chunks arrived (looks for first chunk < 512 bytes = last chunk)
9. Once all chunks received: parse JSON, extract BCODE, verify checksum, save to `/assay/{id}` file

## Key Files

| File | Relevant Functions/Lines |
|------|--------------------------|
| `src/brevitest-firmware.ino` | `load_assay()` (line 3765), `publish_load_assay()` (line 2289), `response_load_assay()` (line 2354), `all_payloads_received()` (line 2330), `clear_payload_buffer()` (line 2314) |
| `src/brevitest-firmware.ino` | `save_assay_to_file()` (line ~552), `load_assay_from_file()` (line ~580) |
| `src/brevitest-firmware.h` | `PARTICLE_PAYLOAD_BUFFER_SIZE = 10`, `BCODE_CAPACITY = 5000`, `ASSAY_UUID_LENGTH = 8`, `publishPeriod = 1s`, global `CloudEvent event` |
| `src/brevitest-firmware.ino` | `register_cloud_subscriptions()` (line 2004) - subscription registration |
| Middleware `index.mjs` | `load_assay()`, `send_response()`, `checksum()` (in `utilities.mjs`) |

## Problem 1: Silent Publish Drop (PRIMARY SUSPECT for 50% failure)

### What happens

`publish_load_assay()` has a guard at line 2293:

```cpp
if (!event.isSending() && ((lastPublish == 0) || (millis() - lastPublish >= publishPeriod.count())))
{
    // ... publish happens here ...
}
// If guard fails: NOTHING. No log. No error. No return value.
```

### Why it fails

- The `event` object is a **single global** shared by ALL four publish functions (validate, reset, load-assay, upload-test)
- `event.isSending()` returns true if ANY previous publish is still in flight
- `publishPeriod` is 1 second - any publish within the last second blocks all others
- If the guard fails, the function silently does nothing
- `load_assay()` already returned 0 to the console before this check

### Why ~50%

It's a timing race. Whether the phone (event object) happens to be free at the exact moment `load_assay` tries to use it depends on what the device was doing in the previous second. Sometimes it's free, sometimes it's not.

### Evidence needed

Add logging to the else branch:
```cpp
else
{
    Log.error("publish_load_assay BLOCKED: isSending=%d, timeSinceLastPublish=%lu ms",
              event.isSending(), millis() - lastPublish);
}
```

This will immediately confirm or rule out this theory.

## Problem 2: No `hook-error` Subscription

### What happens

The firmware only subscribes to success responses:
```cpp
Particle.subscribe(String(device_id + "/hook-response/load-assay/"), response_load_assay);
// NO subscription for: hook-error/load-assay/
```

If the webhook fails (middleware error, Lambda timeout, CouchDB unreachable), Particle sends a `hook-error` event. The firmware never sees it. The payload buffer waits for chunks that will never arrive. Complete silence.

### Fix

Add an error subscription and handler:
```cpp
Particle.subscribe(String(device_id + "/hook-error/load-assay/"), response_load_assay_error);
```

## Problem 3: Multi-Part Chunk Loss (Silent)

### What happens

Load-assay SUCCESS responses are typically >512 bytes (because BCODE is included), so Particle breaks them into 3-5 chunks delivered as separate events. If **any single chunk** is lost:

- `all_payloads_received()` never returns true
- The handler silently returns on each subsequent chunk
- No timeout, no cleanup, no error logging
- The payload buffer sits there with partial data until the next `load_assay` call clears it

### Fix

Add a timeout mechanism. If all chunks haven't arrived within X seconds of the first chunk, log an error and clear the buffer.

## Problem 4: Console Shows False Success

### What happens

`load_assay()` returns 0 immediately after calling `publish_load_assay()`:
```cpp
int load_assay(String assayId)
{
    if (assayId.length() == ASSAY_UUID_LENGTH)
    {
        publish_load_assay(assayId);
        return 0;  // This is what the console shows. Means NOTHING.
    }
}
```

The return value 0 only confirms the assay ID was 8 characters long. It provides zero information about whether:
- The publish fired
- The webhook responded
- The JSON parsed correctly
- The checksum matched
- The file was saved to flash

## Problem 5: `save_assay_to_file()` Ignores Write Errors

### What happens

```cpp
bool save_assay_to_file()
{
    // ...
    write(fd, assay_data.c_str(), assay_data.length()); // RETURN VALUE IGNORED
    close(fd);
    return true; // ALWAYS returns true, even if write() failed
}
```

The function always returns true regardless of whether the data was actually written to flash.

## Problem 6: No Bounds Check on BCODE Copy

### What happens

```cpp
strcpy(assay.BCODE, json.get("bcode").toString().c_str()); // NO BOUNDS CHECK
```

If the BCODE from the cloud exceeds `BCODE_CAPACITY` (5000 chars), this overflows the `assay.BCODE` buffer. Should use `strncpy` with length check.

## Checksum Comparison (NOT the cause)

Initially suspected the `abs((int)checksum(...))` cast was causing ~50% mismatches. After tracing both sides:

- **Middleware**: `Math.abs(crc ^ -1)` - applies abs to signed 32-bit CRC32
- **Firmware**: `abs((int)checksum(...))` - applies abs to signed int interpretation of uint32_t CRC32

Both sides apply the same lossy transformation, so the values **do match** for all practical CRC32 values. The only edge case is CRC32 = 0x80000000 (abs(INT_MIN) is undefined behavior), but this is a 1-in-4-billion chance, not the 50% issue.

However, the checksum code is still technically wrong and should be cleaned up to use `uint32_t` consistently on both sides.

## Proposed Solutions (Ranked by Priority)

### 1. Add logging to silent failure paths (IMMEDIATE - diagnostic)

Add `Log.error()` calls to every silent failure path in `publish_load_assay()`:
- When `event.isSending()` blocks the publish
- When rate limit blocks the publish
- When `canPublish()` returns false

This will immediately reveal whether the silent publish drop is the root cause.

### 2. Add `verify_assay` Particle.function (IMMEDIATE - workaround)

```cpp
int verify_assay(String assayId)
{
    String filename = "/assay/" + assayId;
    struct stat sb;
    if (stat(filename.c_str(), &sb) == 0)
        return sb.st_size;  // positive = exists
    return -1;  // not found
}
```

Lets the console confirm an assay is actually on the filesystem after loading.

### 3. Add `hook-error` subscription (SHORT-TERM)

Subscribe to webhook error events so middleware failures aren't invisible.

### 4. Add timeout to multi-part assembly (SHORT-TERM)

Track when the first chunk arrives. If all chunks haven't arrived within 15 seconds, log an error and clear the buffer.

### 5. Fix `save_assay_to_file()` to check write() return (SHORT-TERM)

```cpp
ssize_t written = write(fd, assay_data.c_str(), assay_data.length());
if (written != (ssize_t)assay_data.length())
{
    Log.error("save_assay_to_file: write failed, wrote %d of %d bytes", written, assay_data.length());
    close(fd);
    return false;
}
```

### 6. Fix checksum types (CLEANUP)

Use `uint32_t` consistently instead of the int/abs dance:
```cpp
uint32_t crc_loaded = json.get("checksum").toUInt();
uint32_t crc_calculated = checksum(assay.BCODE, strlen(assay.BCODE));
```

And update the middleware to not use `Math.abs()` — just return the raw CRC32 using `>>> 0` to force unsigned in JavaScript.

### 7. Add bounds check on BCODE copy (CLEANUP)

```cpp
String bcode_str = json.get("bcode").toString();
if (bcode_str.length() >= BCODE_CAPACITY) {
    Log.error("BCODE too long: %d >= %d", bcode_str.length(), BCODE_CAPACITY);
    // reject
}
strncpy(assay.BCODE, bcode_str.c_str(), BCODE_CAPACITY - 1);
assay.BCODE[BCODE_CAPACITY - 1] = '\0';
```

## Other Issues Found During Broader Audit

These were identified but not deeply investigated yet:

1. **v67 crash workaround**: Device does `System.reset()` after every test to avoid a Device OS hard fault during cloud reconnection. This is documented in `UPLOAD_CRASH_INVESTIGATION.md`. The fix is a workaround, not a root cause fix (Device OS bug in CloudEvent reconnection path).

2. **v69 validation simplification**: Removed ~800 lines of dangerous retry/backoff logic that could delete assay files on checksum mismatch. Documented in `VALIDATION_SIMPLIFICATION_SUMMARY.md`.

3. **State machine race conditions**: 12 identified race conditions between `hardware_loop()` (runs every loop iteration) and async cloud response handlers. Documented in `STATE_TRANSITION_ERRORS_ANALYSIS.md`.

4. **No watchdog timer**: The firmware has no hardware watchdog. If the main loop hangs, the device is bricked until physical reset.

5. **Thread safety**: Global variables are modified by both the main loop and cloud subscription handlers without synchronization. With `SYSTEM_THREAD(ENABLED)`, these run on different threads.
