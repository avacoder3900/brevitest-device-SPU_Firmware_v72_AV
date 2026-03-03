# Upload Path Hard Fault Investigation & Controlled Reboot Fix

## Problem

After a test completes, the device crashes with a **hard fault (panic code 1, pc: 0)** during cloud reconnection, before `publish_upload_test()` ever executes. The test data is written to the cache file successfully, but the upload never happens because the device crashes during the reconnect sequence.

The crash is **100% reproducible** on every test run.

## Investigation Timeline

### 1. Initial Diagnosis

The original hypothesis was that `event.loadData()` on a ~10KB binary test record was causing a bus fault due to memory pressure. However, testing revealed:

- The crash occurs **before** `publish_upload_test()` is called — there is no "Publishing upload test" log entry before the crash
- The same 10KB upload works perfectly on a fresh boot
- The same file size has been uploading successfully for a long time

### 2. Crash Address Decoding

Using `arm-none-eabi-addr2line` on the firmware `.elf` file, the crash addresses were decoded:

**Device OS 6.3.4:**
- `pc: 0x23F4990` -> `spark::JSONValue::type()` in `spark_wiring_json.cpp:226`
- `lr: 0x23EE72F` -> `particle::EventLock::instance()` in `spark_wiring_cloud_event.cpp:72`

**Device OS 6.3.3:**
- `pc: 0` (null function pointer dereference)
- `lr: 0x23EE7AD` -> `particle::CloudEvent::saveData()` in `spark_wiring_cloud_event.cpp:477`

Both versions crash inside **Device OS internals** (CloudEvent/JSON handling), not in application code.

### 3. What We Tried (None Fixed It)

| Attempt | Rationale | Result |
|---------|-----------|--------|
| Downgrade Device OS 6.3.4 -> 6.3.3 | Rule out version-specific regression | Same crash |
| `event.clear()` before each publish call | Clear stale state between different content types | Same crash |
| `event.clear()` in `disconnect_from_cloud()` | Prevent Device OS from carrying stale event data through disconnect | Same crash |
| `event.clear()` in `connect_to_cloud()` | Ensure clean event before reconnection | Same crash |

### 4. Key Observation

The exact same upload path works perfectly on **every boot**:

```
Boot -> setup() -> test_in_cache() finds cached test -> transition to UPLOADING_RESULTS
     -> publish_upload_test() -> 9668 bytes published -> SUCCESS response -> cache cleared
```

The crash **only** occurs when reconnecting to cloud after a test (disconnect -> test -> reconnect). A fresh boot connection never crashes.

### 5. Root Cause

The crash is a **Device OS bug** in the CloudEvent/cloud reconnection pipeline. When the device:

1. Publishes a validation event (STRUCTURED/JSON content type)
2. Disconnects from cloud
3. Runs a test (uses the global `event` object for `saveData()` with BINARY content)
4. Reconnects to cloud

...the Device OS internally calls `CloudEvent::saveData()` during the reconnection handshake, hits a null function pointer (`pc: 0`), and hard faults. This is not reachable or fixable from application code — the crash occurs inside Device OS before any application publish code executes.

## Solution: Controlled Reboot After Test

Instead of reconnecting to cloud after the test (which triggers the Device OS crash), the device now performs a controlled `System.reset()`. On reboot, the auto-upload logic in `setup()` detects the cached test and uploads it via a fresh cloud connection — a path proven to work 100% of the time.

### Flow Before (Crashed):
```
Test completes -> write_test_to_file() -> connect_to_cloud() -> HARD FAULT
                                          (Device OS crash during reconnect)
```

### Flow After (Works):
```
Test completes -> write_test_to_file() -> System.reset()
Boot -> setup() -> test_in_cache() == true -> UPLOADING_RESULTS -> upload succeeds
```

### Why This Is Safe

- The test data is already written to the cache file before the reboot
- The auto-upload on boot has been tested and works on every single boot
- `System.reset()` is a clean, controlled reboot — not a crash
- The IDLE -> UPLOADING_RESULTS transition was already allowed in the state machine
- No test data is lost

### Trade-off

The device reboots after every test, adding ~7 seconds before the upload begins. This is preferable to crashing (which also reboots but uncontrolled) and has the same end result with higher reliability.

## All Changes Made

### Critical (crash fix)
1. **Controlled reboot after test** — `System.reset()` replaces `connect_to_cloud()` after test completion
2. **Auto-upload cached tests on boot** — `setup()` checks `test_in_cache()` and transitions to `UPLOADING_RESULTS` if found

### Defensive (error handling improvements)
3. **Validation after `event.loadData()`** — checks `event.data().size() == 0` to catch load failures
4. **Handle `canPublish()` failure** — added `else` branch that ends cloud operation and sets error state
5. **`event.clear()` before all publishes** — prevents stale state between different event types (validate-cartridge, reset-cartridge, load-assay, upload-test)
6. **`event.clear()` in disconnect/connect** — belt-and-suspenders cleanup

### Code quality
7. **Consolidated double JSON parse in `response_validate_cartridge()`** — single `Variant::fromJSON()` call reused for request ID verification and response processing
8. **Removed unused `particle::Variant data;`** in `publish_upload_test()` — dead code that wasted stack

### Middleware (reference only)
9. **Added `cartridgeId` to FAILURE/ERROR responses** in `brevitest-middleware-reference-3/index.mjs` — enables firmware-side error correlation

## Recommendation

This fix should be considered a **workaround** for a Device OS bug. Consider:
- Filing a bug report with Particle, including the decoded crash addresses and reproduction steps
- Testing future Device OS releases to see if the reconnection crash is fixed
- If fixed, reverting the `System.reset()` back to `connect_to_cloud()` for a faster post-test upload
