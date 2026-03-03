# Firmware Code Changes Summary (v67)

## The Problem

After every test, the device crashed with a hard fault (`panic code 1, pc: 0`) during cloud reconnection. The crash occurred inside Device OS in `CloudEvent::receiveRequestApp()` — the internal function that dispatches incoming cloud messages to subscription handlers. The test data was saved to cache before the crash, but the upload never happened until the device rebooted and the auto-upload recovery kicked in.

## Root Cause

The subscribe handlers used the new `CloudEvent` callback signature (introduced in Device OS 6.3.0). After a disconnect/reconnect cycle, the `receiveRequestApp()` dispatch path hit a null function pointer when trying to deliver an incoming cloud message. This is a Device OS bug — the old-style string-based dispatch path does not have this issue.

## Changes

### 1. Subscribe handlers: CloudEvent → old-style signatures

**The fix.** Bypasses `receiveRequestApp()` entirely.

```cpp
// Before
void response_validate_cartridge(CloudEvent cancel_event)
{
    String event_data = cancel_event.dataString();
    String event_name = cancel_event.name();
    ...
}

// After
void response_validate_cartridge(const char *event_name, const char *data)
{
    String event_data = String(data);
    ...
}
```

Changed all four handlers: `response_validate_cartridge`, `response_reset_cartridge`, `response_load_assay`, `response_upload_test`.

**Why:** The crash was in `CloudEvent::receiveRequestApp()` at line 875 of Device OS's `spark_wiring_cloud_event.cpp`. The old-style `(const char*, const char*)` handlers use a different, stable dispatch path that has worked since the earliest Particle devices. Outgoing publishes still use `CloudEvent` — only the incoming subscription callbacks changed.

**Trade-off:** Old-style handlers have a 1024-byte incoming payload limit vs 16KB for CloudEvent. Our incoming responses are ~100-200 bytes of JSON, so this doesn't matter.

### 2. File I/O: CloudEvent → direct POSIX

```cpp
// Before (write_test_to_file)
event.data((char *)&test, sizeof(test), ContentType::BINARY);
event.saveData(filename);

// After
int fd = open(filename, O_WRONLY | O_CREAT | O_TRUNC);
write(fd, (char *)&test, sizeof(test));
close(fd);
```

Changed `write_test_to_file()`, `load_cached_test()`, and `output_cache()`.

**Why:** The old code loaded 9,668 bytes of binary test data into the global `event` object for file I/O while the cloud was disconnected. This was unnecessary — `event.saveData()`/`event.loadData()` are just wrappers around POSIX `open()`/`read()`/`write()`/`close()` with no special format. The global event object should only be used for actual cloud publishes. The codebase already uses direct POSIX for assay files (`save_assay_to_file`), so this is consistent.

### 3. Removed subscription re-registration after reconnect

```cpp
// Before (connect_to_cloud)
if (Particle.connected())
{
    Log.info("Connected to cloud");
    register_cloud_subscriptions();  // removed
}

// Before (main loop)
if (current_cloud_connected && !last_cloud_connected)
{
    Log.info("Cloud connection restored - re-registering subscriptions");
    register_cloud_subscriptions();  // removed
}
```

**Why:** Subscriptions persist in RAM across disconnect/reconnect. Device OS automatically re-establishes them with the cloud during the handshake (confirmed by logs: `"Checksum has not changed; not sending subscriptions"`). Re-registration was unnecessary — the Device OS source code shows `add_event_handler()` checks for duplicates and silently ignores them, so these calls were harmless but misleading.

### 4. Removed `event.clear()` from disconnect/connect

**Why:** Was added as a defensive measure while debugging. No longer needed since the event object is no longer used for file I/O.

### 5. Error handling in `publish_upload_test()`

- Check `event.data().size() == 0` after `event.loadData()` — catches file load failures
- Added `else` branch for `canPublish()` failure — prevents state machine from getting stuck

**Why:** Previously, a failed `loadData()` or `canPublish()` would silently fail without ending the cloud operation, leaving the state machine stuck in `UPLOADING_RESULTS`.

### 6. Auto-upload cached tests on boot

```cpp
// In setup(), after transitioning to IDLE:
if (test_in_cache())
{
    device_state.test_state = TestState::UPLOAD_PENDING;
    device_state.transition_to(DeviceMode::UPLOADING_RESULTS);
}
```

**Why:** Safety net. If the device ever crashes or loses power after saving test data but before uploading, the cached test is automatically uploaded on the next boot. This path was already proven to work reliably.

### 7. Consolidated double JSON parse in `response_validate_cartridge()`

Single `Variant::fromJSON()` call reused for request ID verification and response processing, replacing two separate parse calls.

**Why:** Less memory usage, cleaner code.

## Verification

- Ran a full test cycle (cartridge insert → barcode scan → validation → test → upload)
- Device reconnected to cloud after test without crashing
- Upload completed successfully without reboot
- No `panic` or `hard_fault` in diagnostics
