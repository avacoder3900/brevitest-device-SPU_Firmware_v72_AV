# Bug Report: `System.deviceID()` Returns Empty on Some OTA Reboots

## Summary

On some devices, after an OTA firmware update, `System.deviceID()` returns an empty string. This causes the webhook subscription topic to be registered as `/hook-response/` instead of `DEVICE_ID/hook-response/`, which means no webhook responses are ever delivered to the device. Load-assay, validate-cartridge, upload-test — all webhook-dependent operations fail silently.

## Observed Behavior

Across 6 devices tested on 2026-03-30, 2 devices had empty `device_id` after OTA to v76:

| Device | FW | device_id | Subscription Topic | Webhooks Work? |
|--------|-----|-----------|-------------------|----------------|
| BT-M01-0000-0215 | v76 | **empty** | `/hook-response/` | **No** |
| BT-M01-0000-0219 | v76 | **empty** | `/hook-response/` | **No** |
| BT-M01-0000-0235 | v76 | `0a10aced...71ea4` | `71ea4/hook-response/` | Yes |
| BT-M01-0000-0209 | v76 | `0a10aced...719f8` | `719f8/hook-response/` | Yes |
| BT-M01-0000-0202 | v76 | `0a10aced...7194c` | `7194c/hook-response/` | Yes |
| BT-M01-0000-0209 | v74 | `0a10aced...713b4` | `713b4/hook-response/` | Yes |

100% correlation: empty device_id = no webhook responses.

## Evidence from Logs

**Failing device (BT-M01-0000-0215, v76 boot):**
```
Webhook subscription: OK (topic: /hook-response/)
...
device id:
Firmware version: 76 (code: 76)
Interrupted test ? Y
Test interrupted: [garbage characters] - saving cancelled test to file
boot #0
```

**Same device, previous boot (v75, working):**
```
Webhook subscription: OK (topic: 0a10aced202194944a07138c/hook-response/)
...
device id: 0a10aced202194944a07138c
Firmware version: 75 (code: 75)
Interrupted test ? N
boot #3
```

**Note:** The same device BT-M01-0000-0235 also had an empty device_id on its v75 OTA boot, but recovered on the next reboot. So this is not device-specific — it's boot-condition-specific.

## Common Conditions on Failing Boots

Every boot where `device_id` was empty shared these characteristics:
1. **OTA firmware update** triggered the reboot (not a power cycle or manual reset)
2. **`boot #0`** — EEPROM was reset (DATA_FORMAT_VERSION changed, triggering `reset_eeprom()`)
3. **`Interrupted test ? Y`** — the EEPROM `running_test_uuid` field contained garbage data (not a real test, but uninitialized memory after EEPROM reset)
4. **Garbage characters** in the interrupted test log: `Test interrupted: [garbage] (Assay [garbage])`

## Why It Happens (Theory)

`System.deviceID()` reads the device's unique 24-character hex ID from hardware. According to Particle documentation, this should always return a valid value regardless of cloud connection state.

However, on certain OTA reboot paths — specifically when the firmware version change triggers an EEPROM reset — `System.deviceID()` returns an empty string when called early in `setup()`. The exact mechanism is unclear. Possibilities:

1. **Timing:** On OTA reboots with EEPROM migration, the system hasn't fully initialized when `setup()` runs and `System.deviceID()` is called
2. **Memory corruption:** The garbage EEPROM data during interrupted test cleanup could be corrupting the `device_id` String object (though `device_id` is set before the EEPROM handling runs, the String is heap-allocated and could be stomped)
3. **Particle Device OS bug:** An edge case in the OTA reboot path where the device identity isn't available yet

## Impact

When `device_id` is empty:
- Subscription topic becomes `/hook-response/` which never matches incoming responses (they start with the device ID)
- **All webhook responses are silently dropped** — load-assay, validate-cartridge, upload-test, reset-cartridge
- Device appears to publish events successfully but never receives responses
- Device-log uploads still appear to work (Lambda returns SUCCESS) but that's because the firmware checks the response via `response_device_log`, and the subscription `/hook-response/` doesn't match `DEVICE_ID/hook-response/device-log/0`
- Wait — actually device-log responses also wouldn't be received, but the firmware has a timeout that just retries next cycle, so it's not as visible
- **The device is effectively broken until rebooted** — subsequent reboots may or may not recover depending on whether `System.deviceID()` returns correctly

## Fix Applied (Firmware v77)

Moved `System.deviceID()` call to after `waitFor(Particle.connected, 20000)`, with a retry:

```cpp
// Before (v76 and earlier):
device_id = System.deviceID();          // Called before cloud connects
waitFor(Particle.connected, 20000);     // Then wait for cloud

// After (v77):
waitFor(Particle.connected, 20000);     // Wait for cloud first
device_id = System.deviceID();          // Then get device ID
if (device_id.length() == 0) {          // If still empty...
    delay(1000);                        // Wait a bit more
    device_id = System.deviceID();      // Try again
}
if (device_id.length() == 0) {
    Log.error("CRITICAL: device_id is empty after retries");
}
```

This gives the system maximum time to initialize before we read the device ID. The 20-second cloud connection wait provides ample time for any system initialization that `System.deviceID()` might depend on.

## Monitoring

The firmware now logs `Device ID: %s (length: %d)` on every boot. If the length is 0, it logs a CRITICAL error. This will be visible in:
- Serial output
- Device session logs uploaded to BIMS
- The BIMS diagnostics timeline

## Questions for Senior Engineer

1. Have you seen `System.deviceID()` return empty on M-SoM before? Is this a known Device OS issue?
2. Should we file a bug with Particle? The device ID is hardware-burned and should never be empty.
3. Is there a more reliable way to get the device ID that doesn't depend on timing? (e.g., reading it directly from the hardware registers)
4. Should we add a watchdog that checks `device_id` periodically in the main loop and attempts recovery if it's empty? (Re-read + re-subscribe)
5. The EEPROM garbage data (`running_test_uuid` containing random bytes after reset) — could this be causing a heap corruption that affects `device_id`? Should we zero out the EEPROM struct fields before the interrupted test check?
