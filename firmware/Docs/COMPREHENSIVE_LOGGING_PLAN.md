# Comprehensive Logging & Diagnostics Plan

## Brevitest Platform — Firmware + Cloud + Dashboard

**Date:** March 11, 2026 (updated)
**Status:** Draft v3 — Builds 1A, 1B, 1D implemented and tested on hardware
**Scope:** End-to-end diagnostic logging across firmware, Particle cloud, AWS Lambda middleware, and admin dashboard

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current State](#current-state)
3. [Proposed Architecture](#proposed-architecture)
4. [Build 1: Firmware Checkpoint + Log System](#build-1-firmware-checkpoint--log-system)
5. [Build 2: Lambda Logging Migration](#build-2-lambda-logging-migration)
6. [Build 3: Particle Event Catch-All](#build-3-particle-event-catch-all)
7. [Build 4: Admin Dashboard Diagnostics View](#build-4-admin-dashboard-diagnostics-view)
8. [MongoDB Schema Design](#mongodb-schema-design)
9. [Open Questions for Senior Engineer](#open-questions-for-senior-engineer)
10. [Risk Assessment](#risk-assessment)
11. [Implementation Priority](#implementation-priority)

---

## Problem Statement

When bugs occur in the field, we currently have no reliable way to reconstruct what happened. Diagnostic information is scattered across multiple disconnected systems, most of which are ephemeral:

- **Serial port output** — The richest source of device diagnostics. Contains temperature readings, BCODE steps, state transitions, cloud communication status. **Gone forever** unless someone is actively watching a terminal.
- **Particle Console event stream** — Shows cloud publishes and webhook responses in real-time. **Scrolls away** and is not archived. Limited retention. We've needed this data to debug recent issues and had to rely on catching it live.
- **Lambda/server logs** — Partially captured in CouchDB `log` database, but only records responses, not full request context. Not visible in the admin dashboard.
- **Firmware crash data** — If the device hangs or hard-resets mid-operation, there is **zero record** of what it was doing when it died. The only indicator is the `running_test_uuid` in EEPROM, which tells us a test was interrupted but not where or why.
- **Heater/temperature data** — No historical record of temperature behavior. We've observed devices getting stuck at elevated temperatures (e.g., 49C with a 45C target) and unable to come back down. Without logs, we can't diagnose whether this is a PID tuning issue, environmental, or hardware.

### The Core Insight: "Dead Man's Log" Problem

The current firmware logging pattern logs results AFTER operations complete:

```cpp
// Current pattern — result logging
disconnect_from_cloud();
Log.info("Disconnected from the cloud");  // never reached if disconnect hangs
```

If an operation hangs, the log statement after it is never executed. The device produces **no evidence** of the failure.

### What Has Actually Caused Problems

Based on observed issues in the field, here are the real problem areas ranked by how often they've caused trouble:

| Problem Area | Frequency | What Happens |
|---|---|---|
| **Cloud disconnect/reconnect hanging** | Most common | `connect_to_cloud()` / `disconnect_from_cloud()` block for up to 25s or hang indefinitely. Happens after every test during reconnection. |
| **Webhook round-trip failures** | Common | Device publishes validate-cartridge or load-assay, but the webhook response never arrives or arrives malformed. Device waits with no visibility into what went wrong. |
| **Heater temperature issues** | Occasional | Device overshoots target temperature and gets stuck above 45C. PID correctly turns heater off but passive cooling is slow. Device sits in HEATING mode looking "stuck." |
| **Particle.publish() blocking** | Occasional | Can block if cloud connection is degraded, especially upload-test which sends the largest payloads. |
| **Stage reset (limit switch)** | Rare | `move_stage_until_proximal_limit()` depends on hardware limit switch. If switch fails, infinite loop. |
| **Barcode scanning** | Rare | Blocking while loop with timeout, but has been reliable. |
| **I2C / spectrophotometer** | Rare | I2C bus lockup is theoretically the most dangerous hang (no timeout), but hasn't been a significant source of field issues. Covered by bookend checkpoints as a safety net. |
| **BCODE execution** | Not observed | BCODE commands themselves haven't caused crashes. The test protocol loop has been reliable. Covered by bookend checkpoints as a safety net. |

The checkpoint system is designed around this priority list — cloud operations and webhook round-trips get the most granular coverage because that's where the problems are. I2C and BCODE get simple bookend checkpoints as safety nets in case they become issues later.

---

## Current State

### What Exists Today

| Data Source | Captured? | Stored Where? | Accessible in Dashboard? |
|---|---|---|---|
| Firmware serial output (`Log.info()`) | Only if someone is watching | Nowhere — ephemeral | No |
| Firmware crash/hang data | No | Nowhere | No |
| Device state transitions | RAM only | Lost on reboot | No |
| Heater temperature history | Only via serial command 10 (live) | Nowhere — ephemeral | No |
| Particle cloud events | Temporarily in Particle Console | Not archived | No |
| Lambda webhook responses | Partially | CouchDB `log` database | No |
| Lambda webhook requests (what device sent) | No | Not captured | No |
| Webhook round-trip timing | No | Nowhere | No |
| Test results (spectrophotometer data) | Yes | CouchDB (migrating to MongoDB) | Yes |

### Current Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────┐     ┌───────────────┐
│   Device     │────▶│  Particle Cloud  │────▶│ AWS Lambda │────▶│ CouchDB/Mongo │
│  (M-SoM)    │     │                  │     │            │     │               │
│             │     │  Event Stream    │     │  index.mjs │     │ Cartridge docs│
│ Serial out ─┼──▶ (nowhere)          │     │            │     │ Log entries   │
│ EEPROM     │     │                  │     │            │     │               │
│ Flash FS   │     └──────────────────┘     └────────────┘     └───────┬───────┘
└─────────────┘                                                         │
                                                                        ▼
                                                              ┌─────────────────┐
                                                              │ Admin Dashboard  │
                                                              │ (Svelte/Vercel) │
                                                              │                 │
                                                              │ Test results: Y │
                                                              │ Device logs: N  │
                                                              │ Cloud events: N │
                                                              │ Crash data: N   │
                                                              └─────────────────┘
```

---

## Proposed Architecture

### Three-Layer Firmware Logging

The firmware implements three complementary logging layers, each covering different failure scenarios:

| Layer | What | When Written | Survives Crash? | Detail Level | Purpose |
|---|---|---|---|---|---|
| **EEPROM Checkpoints** | Numeric checkpoint codes in 40-entry ring buffer | Before/after every risky operation | Yes (flash-backed) | Low — just a code number | Crash forensics: "WHERE did it die?" |
| **RAM Log Buffer** | Timestamped text log lines (100 lines x 120 chars) | On every `device_log()` call | No — lost on crash | High — full context | Real-time diagnostics + source for file flush |
| **File System Log** | RAM buffer flushed to `/log/session.txt` + `/log/session.old.txt` (two-file rotation at 16KB) | At safe moments (after cloud ops, when idle — never during tests) | Yes — persists on flash | High — full context | Post-mortem: "WHAT was happening leading up to the crash?" |

How the layers cover each other's blind spots:

```
Timeline:  ──────[safe moment]──────────[risky operation]──────[crash]

File log:  ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
           (flushed up to last safe     (gap — never flushed)
            moment)

EEPROM:    ░░░░░░░░░░░░░░░░░░░░░░░░░░░█████████████████████████████████
           (not useful for normal       (shows exactly where crash happened)
            operation)

Combined:  ████████████████████████████████████████████████████████████████
           (complete picture)
```

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         DEVICE (M-SoM)                          │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │   EEPROM    │  │  RAM Buffer  │  │    Flash File System   │ │
│  │ Checkpoint  │  │ (100 lines)  │  │                        │ │
│  │ Ring Buffer │  │              │  │  /log/session.txt      │ │
│  │ (40 entries)│  │  ─flush──▶   │  │  /log/session.old.txt  │ │
│  │             │  │              │  │  /cache/ (test data)   │ │
│  └──────┬──────┘  └──────────────┘  └───────────┬────────────┘ │
│         │                                        │              │
│         │  On boot: dump checkpoint trail to log  │              │
│         └─────────────────────────────────────────┤              │
│                   When idle + cloud connected:     │              │
│                   upload log file ─────────────────┤              │
│                   delete after confirmed ──────────┘              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PARTICLE CLOUD                             │
│                                                                 │
│  Existing webhooks:              New catch-all integration:     │
│  * validate-cartridge    ──▶     * ALL events archived    ──▶  │
│  * load-assay            ──▶     * device-log (new)       ──▶  │
│  * upload-test           ──▶                                    │
│  * reset-cartridge       ──▶                                    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AWS LAMBDA                                │
│                                                                 │
│  Existing handler (index.mjs):     New handler/routes:          │
│  * validate-cartridge              * catch-all event archiver   │
│  * load-assay                      * device-log receiver        │
│  * upload-test                     (parses crash data from log) │
│  * reset-cartridge                                              │
│                                                                 │
│  Enhanced: Log FULL request + response for every webhook call   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        MONGODB                                  │
│                                                                 │
│  Existing collections:           New collections:               │
│  * cartridges                    * device_events                │
│  * assays                        * device_logs                  │
│  * (others from migration)       * device_crashes               │
│                                                                 │
│  All indexed by deviceId + timestamp + cartridgeId              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ADMIN DASHBOARD                               │
│                    (Svelte / Vercel)                             │
│                                                                 │
│  Existing views:                 New "Device Diagnostics" view: │
│  * Test results                  * Unified event timeline       │
│  * Cartridge management          * Crash reports with           │
│  * (other existing views)        | checkpoint sequences         │
│                                  * Device session logs          │
│                                  * Filter by device / cartridge │
│                                  | / time range / event type    │
│                                  * Cross-reference firmware log │
│                                  | + cloud events + Lambda logs │
└─────────────────────────────────────────────────────────────────┘
```

---

## Build 1: Firmware Checkpoint + Log System

### 1A. EEPROM Checkpoint Ring Buffer

**What:** A 40-entry ring buffer in EEPROM that records checkpoint codes before/after risky operations. On every boot, the checkpoint trail from the previous session is dumped to the session log as the first lines — this captures crash evidence AND normal operation context. 40 entries provides enough history to capture the full lifecycle of a test.

**EEPROM struct changes (`brevitest-firmware.h`):**

```cpp
#define CP_BUFFER_SIZE 40

struct Particle_EEPROM {
    // === Existing fields — offsets unchanged for safe migration ===
    uint8_t firmware_version = FIRMWARE_VERSION;
    uint8_t data_format_version = DATA_FORMAT_VERSION;
    int lifetime_stress_test_cycles = 0;
    int stress_test_cycles_since_reset = 0;
    int stress_test_cycles = 0;
    int stress_test_reading_count = 0;
    char running_test_uuid[BARCODE_UUID_LENGTH + 1];
    char running_assay_id[ASSAY_UUID_LENGTH + 1];

    // === NEW: Crash checkpoint system (appended at end) ===
    uint8_t cp_boot_count;              // Increments each boot (wraps at 255)
    uint8_t cp_index;                   // Current position in ring buffer (0-39)
    uint8_t cp_buffer[CP_BUFFER_SIZE];  // Last 40 checkpoint codes
};
```

**CRITICAL: New fields MUST be appended at the end of the struct, never inserted in the middle.** Inserting fields between existing ones shifts all subsequent field offsets. On migration boot, `setup_eeprom()` reads raw EEPROM bytes into the new struct layout — if offsets have shifted, `reset_eeprom()` reads `lifetime_stress_test_cycles` from the wrong offset and loses the value. Appending at the end keeps all existing field offsets identical, so `reset_eeprom()` correctly preserves `lifetime_stress_test_cycles` during the version-bump migration.

**Migration safety:** Firmware updates always trigger a device reboot. During a test, the device is disconnected from cloud and cannot receive OTA updates, so interrupted-test data loss during migration is not a practical concern. The existing `setup_eeprom()` version check + `reset_eeprom()` migration path handles the transition cleanly: existing fields read correctly from their original offsets, the new checkpoint fields at the end read uninitialized EEPROM bytes (irrelevant — they get zeroed during reset), and `DATA_FORMAT_VERSION` is bumped to trigger the reset.

Additional EEPROM usage: **42 bytes** (out of 4,096 available; currently using ~64 bytes).

EEPROM wear concern: **None.** M-SoM EEPROM is emulated on wear-leveled flash. A typical test writes ~20-25 checkpoints. At a few tests per day, this is negligible.

#### Checkpoint Code Definitions

Checkpoints use a before/after pair pattern: even numbers = "about to do X", odd numbers = "X succeeded." If the last checkpoint in the buffer is even, that operation was interrupted (crash, power loss, reset). If odd, the last operation completed normally.

```cpp
// ============================================================
//  EEPROM CHECKPOINT CODES
//  Pattern: even = BEFORE operation, odd = AFTER (success)
//  If last checkpoint is even, the operation it marks is
//  where the crash/hang/power-loss occurred.
// ============================================================

// ─── CLOUD OPERATIONS (10-29) ───────────────────────────────
// Cloud connect/disconnect and Particle.publish() calls.
// These are the highest-risk operations — cloud calls can
// block for up to 25 seconds or hang indefinitely.

#define CP_CLOUD_DISCONNECT              10  // About to call disconnect_from_cloud()
#define CP_CLOUD_DISCONNECT_OK           11  // Disconnect completed successfully
#define CP_CLOUD_CONNECT                 12  // About to call connect_to_cloud()
#define CP_CLOUD_CONNECT_OK              13  // Cloud connection re-established
#define CP_CLOUD_PUBLISH_VALIDATE        14  // About to publish validate-cartridge event
#define CP_CLOUD_PUBLISH_VALIDATE_OK     15  // Publish succeeded
#define CP_CLOUD_PUBLISH_LOAD_ASSAY      16  // About to publish load-assay event
#define CP_CLOUD_PUBLISH_LOAD_ASSAY_OK   17  // Publish succeeded
#define CP_CLOUD_PUBLISH_UPLOAD          18  // About to publish upload-test event
#define CP_CLOUD_PUBLISH_UPLOAD_OK       19  // Publish succeeded
#define CP_CLOUD_PUBLISH_RESET           20  // About to publish reset-cartridge event
#define CP_CLOUD_PUBLISH_RESET_OK        21  // Publish succeeded
#define CP_WEBHOOK_RESPONSE_RECEIVED     22  // A webhook response callback fired on device
#define CP_WEBHOOK_TIMEOUT               23  // Cloud operation timed out waiting for response

// ─── BCODE EXECUTION (30-31) ────────────────────────────────
// Bookends around the entire BCODE test protocol execution.
// BCODE commands themselves have not been a crash source.
// No file flushes happen during test execution, so if a crash
// occurs between START and COMPLETE, the EEPROM trail is the
// primary evidence.

#define CP_BCODE_START                   30  // About to enter process_BCODE()
#define CP_BCODE_COMPLETE                31  // BCODE execution finished successfully

// ─── SPECTROPHOTOMETER (40-41) ──────────────────────────────
// Bookends around each BCODE spectro command (baseline or test
// scan). Wraps the entire reading sequence, NOT individual
// channels or scan positions. A typical test has 2 spectro
// BCODE commands (baseline + test), so this produces 4
// checkpoint writes per test.
//
// Each spectro command does ~10 positions x 3 channels = ~30
// individual I2C reading cycles internally. If a crash occurs
// between START and COMPLETE, it was an I2C hang during
// spectrophotometer operations. The file flush log will show
// which BCODE command was running.

#define CP_SPECTRO_READING_START         40  // About to execute spectro BCODE command
#define CP_SPECTRO_READING_COMPLETE      41  // Spectro BCODE command finished

// ─── FILE I/O (50-57) ──────────────────────────────────────
// Flash filesystem reads and writes. These can fail if the
// filesystem is corrupted, full, or if a previous write was
// interrupted mid-operation.

#define CP_FILE_WRITE_TEST               50  // About to write test results to flash
#define CP_FILE_WRITE_TEST_OK            51  // Test results written successfully
#define CP_FILE_READ_ASSAY               52  // About to read assay/BCODE file from flash
#define CP_FILE_READ_ASSAY_OK            53  // Assay file read successfully
#define CP_FILE_WRITE_ASSAY              54  // About to write received assay to flash
#define CP_FILE_WRITE_ASSAY_OK           55  // Assay written successfully
#define CP_FILE_FLUSH_LOG                56  // Reserved — not used (removed to prevent EEPROM flooding)
#define CP_FILE_FLUSH_LOG_OK             57  // Reserved — not used

// ─── HARDWARE (60-67) ──────────────────────────────────────
// Physical hardware operations that involve blocking loops
// or I2C communication.

#define CP_STAGE_RESET                   60  // About to reset stage (move until limit switch)
#define CP_STAGE_RESET_OK                61  // Stage reset completed — limit switch reached
#define CP_BARCODE_SCAN                  62  // About to scan barcode (blocking while loop)
#define CP_BARCODE_SCAN_OK               63  // Barcode scanned successfully
#define CP_I2C_BUS_INIT                  64  // About to initialize I2C bus (Wire.begin)
#define CP_I2C_BUS_INIT_OK               65  // I2C bus initialized

// ─── TEST LIFECYCLE (70-73) ────────────────────────────────
// High-level markers for the test flow. Other subsystem
// checkpoints (cloud, BCODE, spectro, file) provide detail
// within the test. These mark the entry point and the
// hardware setup phase that precedes BCODE execution.

#define CP_TEST_START                    70  // run_test() called — test lifecycle begins
#define CP_TEST_HARDWARE_SETUP           71  // Hardware setup: stage reset, LEDs, buzzer, temp off
    // After 71: expect CP_STAGE_RESET (60/61), then CP_BCODE_START (30)

// ─── SPECIAL CONDITIONS (80+) ──────────────────────────────
#define CP_HEATER_OVERHEAT               80  // Temperature exceeded HEATER_MAX_TEMPERATURE (60C)
                                             // Logged when get_heater_temperature() triggers
                                             // stop_temperature_control() due to overheat
```

#### What Was Intentionally Left Out (and Why)

| Omitted checkpoint | Rationale |
|---|---|
| Individual BCODE commands (delay, move, oscillate) | ~50-120 BCODE steps per test would flood the ring buffer. BCODE commands haven't been a crash source. File flush log captures BCODE step detail. |
| Per-channel spectro I2C (A, B, C separately) | ~30 reading cycles per spectro command would produce 60+ checkpoint writes. If we later find repeated spectro crashes, we can add channel-level granularity. |
| Stage move (fixed distance) | Fixed-distance moves send N pulses — they can't hang. Only `reset_stage()` (move-until-limit-switch) has hang risk. |
| Heater PID control | Runs every second in the main loop — would overwhelm the buffer. Heater monitoring is handled by the RAM log system instead (see Section 1D). |
| LED / buzzer / GPIO operations | Simple `digitalWrite()` calls with essentially zero hang risk. |
| BLE magnetometer operations | Less frequent, BLE has its own timeouts. Can add in a future pass if needed. |
| Temperature readings (analogRead) | Simple ADC read, not I2C. No hang risk. |
| State machine transitions | Already tracked in DeviceStateMachine history (RAM). Will be logged to file via device_log() system. |

#### Checkpoint Counts Per Operation

| Operation | Checkpoints written | What they are |
|---|---|---|
| Full test lifecycle | ~20-25 | test start, cloud disconnect/ok, hardware setup, stage reset/ok, bcode start, spectro start/complete (x2), bcode complete, file write/ok, cloud connect/ok, cloud publish upload/ok |
| Cartridge validation (no test) | ~4-6 | cloud publish validate/ok, webhook response, cloud publish load-assay/ok |
| Boot | 2 | i2c init/ok |
| Idle operation | 0 | No checkpoints during idle — only the RAM log system runs (flush checkpoints 56/57 were removed after hardware testing showed they flooded the buffer) |

With a 40-entry buffer, a full test lifecycle fits with room to see pre-test context (cartridge validation, assay loading).

#### Checkpoint Function

```cpp
void checkpoint(uint8_t code) {
    eeprom.cp_buffer[eeprom.cp_index] = code;
    eeprom.cp_index = (eeprom.cp_index + 1) % CP_BUFFER_SIZE;
    EEPROM.put(0, eeprom);
    Log.info(">>> CP %d", code);  // serial breadcrumb comes free
}
```

**Performance:** `EEPROM.put()` takes ~1-5ms on Particle. With ~20-25 checkpoints per test spread across minutes of execution, total overhead is 20-125ms — unnoticeable.

**Important timing note:** Do NOT place checkpoints inside tight timing loops. The spectrophotometer measurement sequence (laser on → sensor integration → ADC read) is timing-sensitive. Checkpoint BEFORE `CP_SPECTRO_READING_START`, not between laser-on and sensor-read.

#### Checkpoint Dump on Boot

On every boot, the checkpoint trail from the previous session is dumped into the session log via `device_log()`. No conditional logic — always dump. Whether the previous session ended cleanly or crashed, the checkpoint trail is useful context. If the last checkpoint is even (before an operation), something interrupted it. If odd (after), the last operation completed normally.

```cpp
void dump_checkpoint_trail() {
    uint8_t last_index = (eeprom.cp_index - 1 + CP_BUFFER_SIZE) % CP_BUFFER_SIZE;
    uint8_t last_checkpoint = eeprom.cp_buffer[last_index];
    bool was_interrupted = (last_checkpoint % 2 == 0) && (last_checkpoint != 0);

    device_log("=== PREV SESSION CHECKPOINTS (boot #%d) ===", eeprom.cp_boot_count);
    if (was_interrupted) {
        device_log("!!! INTERRUPTED at checkpoint %d", last_checkpoint);
    }

    // Dump trail oldest to newest
    for (int i = 0; i < CP_BUFFER_SIZE; i++) {
        int idx = (eeprom.cp_index + i) % CP_BUFFER_SIZE;
        if (eeprom.cp_buffer[idx] != 0) {
            device_log("  CP[%d] = %d", i, eeprom.cp_buffer[idx]);
        }
    }
    device_log("=== END CHECKPOINTS ===");

    // Clear buffer for new session
    eeprom.cp_boot_count++;
    memset(eeprom.cp_buffer, 0, CP_BUFFER_SIZE);
    eeprom.cp_index = 0;
    EEPROM.put(0, eeprom);
}
```

This is called early in `setup()`. The checkpoint data becomes part of the session log, rides the same upload pipeline as everything else, and shows up in the dashboard. No separate crash report mechanism needed.

#### Example: Checkpointed `run_test()` Function

```cpp
void run_test() {
    checkpoint(CP_TEST_START);
    device_state.test_state = TestState::RUNNING;

    checkpoint(CP_CLOUD_DISCONNECT);
    disconnect_from_cloud();
    checkpoint(CP_CLOUD_DISCONNECT_OK);

    checkpoint(CP_TEST_HARDWARE_SETUP);
    turn_on_dont_touch_LED();
    checkpoint(CP_STAGE_RESET);
    reset_stage(false);
    checkpoint(CP_STAGE_RESET_OK);
    move_stage_to_test_start_position();
    turn_on_buzzer_for_duration(1000, 600);
    turn_off_buzzer_timer();
    stop_temperature_control();

    // Save to EEPROM (existing behavior)
    memcpy(eeprom.running_test_uuid, test.cartridge_id, BARCODE_UUID_LENGTH + 1);
    memcpy(eeprom.running_assay_id, test.assay_id, ASSAY_UUID_LENGTH + 1);
    EEPROM.put(0, eeprom);

    // Execute test
    checkpoint(CP_BCODE_START);
    test.start_time = millis();
    process_BCODE(0);
    test.duration = (millis() - test.start_time) / 1000;
    checkpoint(CP_BCODE_COMPLETE);

    start_temperature_control();

    // Save results
    checkpoint(CP_FILE_WRITE_TEST);
    write_test_to_file();
    checkpoint(CP_FILE_WRITE_TEST_OK);
    output_test_readings(&test);

    // Reconnect and upload
    checkpoint(CP_CLOUD_CONNECT);
    connect_to_cloud();
    checkpoint(CP_CLOUD_CONNECT_OK);
}
```

#### Example: Checkpointed BCODE Spectro Commands

```cpp
// Inside process_one_BCODE_command():

case 11:  // Baseline scans
    index = get_BCODE_token(index, &param1);
    Log.info("Baseline scans: %d", param1);
    position = stage_position;
    checkpoint(CP_SPECTRO_READING_START);
    noInterrupts();
    spectrophotometer_reading(true, param1, false);
    interrupts();
    checkpoint(CP_SPECTRO_READING_COMPLETE);
    move_stage_to_position(position, MOTOR_SLOW_STEP_DELAY);
    break;

case 14:  // Test scans
    index = get_BCODE_token(index, &param1);
    Log.info("Test scans: %d", param1);
    position = stage_position;
    checkpoint(CP_SPECTRO_READING_START);
    noInterrupts();
    spectrophotometer_reading(false, param1, false);
    interrupts();
    checkpoint(CP_SPECTRO_READING_COMPLETE);
    move_stage_to_position(position, MOTOR_SLOW_STEP_DELAY);
    break;

case 16:  // Continuous sensor readings
    // ... param parsing ...
    checkpoint(CP_SPECTRO_READING_START);
    noInterrupts();
    spectrophotometer_reading_continuous(param1 == 1, param2, param3, param4, false);
    interrupts();
    checkpoint(CP_SPECTRO_READING_COMPLETE);
    break;
```

#### Example: Checkpoint Trail in Session Log

After a crash, the next boot's session log would start with:

```
0|=== PREV SESSION CHECKPOINTS (boot #47) ===
0|!!! INTERRUPTED at checkpoint 12
0|  CP[0]  = 70    (CP_TEST_START)
0|  CP[1]  = 10    (CP_CLOUD_DISCONNECT)
0|  CP[2]  = 11    (CP_CLOUD_DISCONNECT_OK)
0|  CP[3]  = 71    (CP_TEST_HARDWARE_SETUP)
0|  CP[4]  = 60    (CP_STAGE_RESET)
0|  CP[5]  = 61    (CP_STAGE_RESET_OK)
0|  CP[6]  = 30    (CP_BCODE_START)
0|  CP[7]  = 40    (CP_SPECTRO_READING_START)
0|  CP[8]  = 41    (CP_SPECTRO_READING_COMPLETE)
0|  CP[9]  = 40    (CP_SPECTRO_READING_START)
0|  CP[10] = 41    (CP_SPECTRO_READING_COMPLETE)
0|  CP[11] = 31    (CP_BCODE_COMPLETE)
0|  CP[12] = 50    (CP_FILE_WRITE_TEST)
0|  CP[13] = 51    (CP_FILE_WRITE_TEST_OK)
0|  CP[14] = 12    (CP_CLOUD_CONNECT) ← LAST (even = interrupted)
0|=== END CHECKPOINTS ===
0|Firmware v70 booting...
0|EEPROM loaded...
... normal boot log continues ...

Diagnosis: Test ran to completion, results saved to file, but device
hung during cloud reconnection after the test. The connect_to_cloud()
function never returned.
```

After a clean shutdown (e.g., unplugged while idle after a successful upload):

```
0|=== PREV SESSION CHECKPOINTS (boot #48) ===
0|  CP[0]  = 14    (CP_CLOUD_PUBLISH_VALIDATE)
0|  CP[1]  = 15    (CP_CLOUD_PUBLISH_VALIDATE_OK)
0|  CP[2]  = 16    (CP_CLOUD_PUBLISH_LOAD_ASSAY)
0|  CP[3]  = 17    (CP_CLOUD_PUBLISH_LOAD_ASSAY_OK)
0|  CP[4]  = 70    (CP_TEST_START)
0|  ... full test trail ...
0|  CP[18] = 19    (CP_CLOUD_PUBLISH_UPLOAD_OK) ← LAST (odd = clean)
0|=== END CHECKPOINTS ===
0|Firmware v70 booting...
... normal boot log continues ...
```

### 1B. RAM Log Buffer + File Flush

**What:** A `device_log()` function that replaces key `Log.info()` calls. It writes to serial (real-time), stores in a RAM ring buffer (100 lines), and the buffer is flushed to a file at safe moments — never during test execution.

**RAM buffer structure:**

```cpp
#define LOG_BUFFER_LINES 100
#define LOG_LINE_LENGTH 120

struct LogBuffer {
    char lines[LOG_BUFFER_LINES][LOG_LINE_LENGTH];
    int index;                    // Current write position
    int count;                    // Total lines written (for knowing if buffer has wrapped)

    LogBuffer() : index(0), count(0) {
        memset(lines, 0, sizeof(lines));
    }
};

LogBuffer log_buffer;
```

**RAM usage:** 100 x 120 = **12,000 bytes (~12KB).** The M-SoM has 512KB of RAM, so this is negligible. 100 lines is large enough to hold an entire test's worth of device_log lines without flushing mid-test (~20 lines per test).

**`device_log()` function:**

```cpp
void device_log(const char* fmt, ...) {
    char message[LOG_LINE_LENGTH];
    va_list args;
    va_start(args, fmt);
    vsnprintf(message, LOG_LINE_LENGTH, fmt, args);
    va_end(args);

    // Layer 1: Serial output (real-time)
    Log.info("%s", message);

    // Layer 2: RAM buffer (for file flush)
    unsigned long ms = millis();
    snprintf(log_buffer.lines[log_buffer.index], LOG_LINE_LENGTH,
             "%lu|%s", ms, message);
    log_buffer.index = (log_buffer.index + 1) % LOG_BUFFER_LINES;
    log_buffer.count++;
}
```

**`flush_log_to_file()` function:**

```cpp
void flush_log_to_file() {
    if (log_buffer.count == 0) return;  // nothing to flush

    // Rotate if session.txt exceeds 16KB (half of 32KB cap)
    struct stat st;
    if (stat("/log/session.txt", &st) == 0 && st.st_size >= LOG_FILE_MAX_SIZE / 2) {
        rotate_log_file();
    }

    int fd = open("/log/session.txt", O_WRONLY | O_CREAT | O_APPEND);
    if (fd < 0) {
        Log.error("flush_log_to_file: failed to open, errno: %d", errno);
        return;
    }

    // Write lines in order (oldest to newest)
    int start = log_buffer.count >= LOG_BUFFER_LINES
                ? log_buffer.index    // buffer has wrapped — start from oldest
                : 0;                  // buffer hasn't wrapped — start from beginning
    int lines_to_write = log_buffer.count >= LOG_BUFFER_LINES
                         ? LOG_BUFFER_LINES
                         : log_buffer.count;

    for (int i = 0; i < lines_to_write; i++) {
        int idx = (start + i) % LOG_BUFFER_LINES;
        if (log_buffer.lines[idx][0] != '\0') {
            write(fd, log_buffer.lines[idx], strlen(log_buffer.lines[idx]));
            write(fd, "\n", 1);
        }
    }

    close(fd);

    // Clear buffer after flush
    memset(log_buffer.lines, 0, sizeof(log_buffer.lines));
    log_buffer.index = 0;
    log_buffer.count = 0;
}
```

> **Note:** `CP_FILE_FLUSH_LOG` (56) and `CP_FILE_FLUSH_LOG_OK` (57) checkpoint codes are defined in the header but intentionally **not called** inside `flush_log_to_file()`. During hardware testing, these checkpoints flooded the 40-entry EEPROM ring buffer (flush happens every 30s during idle whenever temperature changes generate log entries), pushing out meaningful crash forensics data. The defines remain reserved in case a future use case warrants them.

**Safe flush points (where `flush_log_to_file()` is called):**

- After `connect_to_cloud()` / `disconnect_from_cloud()` complete
- After `write_test_to_file()` (test is already done at this point)
- After cloud publish callbacks (`response_validate_cartridge`, `response_upload_test`, etc.)
- In `hardware_loop()` when device is IDLE (every ~30 seconds)

**Never during test execution.** No flushes inside `BCODE_loop()` or during spectrophotometer readings. The 100-line RAM buffer is large enough to hold all device_log lines generated during a test. The buffer gets flushed after the test completes.

**Log file management:**

- Log data appends to `/log/session.txt` (persists across reboots — sessions are delimited by session headers)
- First lines of each session are the checkpoint trail from the previous session (see 1A), followed by a session header (see below)
- **Two-file rotation:** When `session.txt` reaches 16KB, it is renamed to `session.old.txt` (overwriting any previous old file), and a fresh `session.txt` is started. Total flash usage capped at ~32KB.
- **Session headers:** Each boot writes a header block to the log identifying the session:
  ```
  ======== SESSION START ========
  Boot #47 | Device: e00fce68...
  Firmware: v71 | Format: v40
  Time: 2026-03-11T15:30:00Z
  ===============================
  ```
  This makes it easy to distinguish sessions when reading multi-session log files.
- **Manual log clearing:** Serial command 413 clears all logs (flash files, EEPROM checkpoint buffer, and RAM buffer). Useful for field debugging before cloud upload pipeline (Build 1C) is implemented.
- **Auto-upload and cleanup (Build 1C — not yet implemented):** When IDLE and cloud-connected, the idle loop will check for a log file to upload. After successful upload to cloud, the file is deleted from flash. If upload fails, the file stays and is retried next cycle.

#### Which `Log.info()` Calls Become `device_log()`

The firmware currently has ~241 Log.info/Log.error/Log.warn calls. The rule is simple: **everything becomes `device_log()` except** a short list of high-volume, low-value-per-line categories that would flood the flash log. `device_log()` calls `Log.info()` internally, so serial output is unchanged — lines just additionally go into the RAM buffer for file flush.

**Final breakdown: ~145 become `device_log()`, ~96 stay `Log.info()`.**

##### What becomes `device_log()` (captured in flash log):

| Category | Examples | Why capture |
|---|---|---|
| **Boot & setup** (all detail) | WiFi connecting, cloud connecting, EEPROM loaded, firmware version, device ID, I2C init, file system init, Particle.variable/function registrations | Full boot sequence is essential for debugging startup failures and understanding device state |
| **State machine transitions** | `transition_to()` calls, state change messages | Core device behavior — need to know every state change |
| **Cloud operations** | Publish calls, subscribe callback entries, connect/disconnect results, webhook data received | Highest-priority diagnostic area per field experience |
| **Test lifecycle** | Test start, cartridge scanned, assay loaded, test complete, test cancelled, results formatted, upload initiated | Need full test narrative |
| **BCODE bookends** | "Starting BCODE execution", "BCODE complete" | Know when test protocol started/finished without logging every step |
| **Spectro bookends** | "Spectro baseline scan starting", "Spectro scan complete" | Know when spectro commands ran without per-channel detail |
| **File I/O (all — success AND error)** | File open, file write, file close, file read, file delete, bytes written, directory created | Complete filesystem audit trail — both success and failure |
| **Assay handling (all — success AND error)** | Assay received, assay parsed, assay verification passed/failed, BCODE loaded, assay saved to flash | Need to know if assay loaded correctly, not just when it failed |
| **Error conditions** | All `Log.error()` and `Log.warn()` calls | Every error and warning is diagnostic gold |
| **Heater events** | Temperature control start/stop, heater_ready changes, overheat detected, thermistor disconnect | Known problem area — need full visibility |
| **Heater temperature** (NEW) | 0.5°C change threshold logging with PID state (see Section 1D) | Catches the "stuck at 49°C" scenario |
| **Hardware loop messages** | Heating status messages, LED state changes, hardware loop state info | Device operational context between tests |
| **Magnetometer** | BLE connect/disconnect, well readings, validation results | Diagnostic context for magnet validation issues |
| **Cartridge validation** | Barcode type identified, validation request sent, response received | Need to trace cartridge flow |

##### What stays as `Log.info()` only (serial only, NOT in flash log):

| Category | Examples | Why exclude |
|---|---|---|
| **Individual BCODE step commands** | "Delay 5000ms", "Move stage 8000", "Oscillate 10 cycles", "Turn LED on" | ~50-120 commands per test, each already has a BCODE command number in the log. Would flood the flash log. BCODE bookends cover test execution. |
| **Spectro per-reading details** | Individual channel values, raw ADC readings, per-position scan data | ~30 reading cycles per spectro command × 2-3 per test = 60-90 lines. Results are captured in test data. Spectro bookends cover the operation. |
| **Serial command responses** | Echo-back of serial terminal commands (command 1, 2, 3, etc.), serial menu display | Only relevant during live serial debugging, not for post-mortem |
| **PID per-second debug output** | Serial command 10 continuous temperature/power output | Runs every second — would overwhelm log. The 0.5°C threshold logging (Section 1D) captures meaningful temperature changes instead. |
| **BLE scan advertising details** | Individual BLE advertisement packets received during magnetometer scan | High volume, transient. BLE connect/disconnect results are captured. |
| **Directory file listings** | Individual filenames printed during `list_files()` or `list_validation_files()` | Diagnostic clutter. The operation itself (start/complete) is captured. |

##### Summary Rule

> **If it's something you'd want to see in a post-mortem log file after a device misbehaved, it's `device_log()`.
> If it's only useful while actively watching a serial terminal, it stays `Log.info()`.**

### 1C. Log Upload to Cloud

**What:** When the device is idle and cloud-connected, it automatically uploads the session log file and deletes it from flash. The session log already contains the checkpoint trail from the previous boot (dumped as first lines on startup), so there is no separate crash report mechanism — everything rides the same pipeline.

**Upload flow:**

```
idle loop (every ~30-60 seconds):
  1. Is there a /log/session.txt on flash?  (stat() call — essentially free)
  2. Is the device cloud-connected?
  3. If both yes → upload file as device-log Particle event
  4. If upload confirmed → delete /log/session.txt from flash
  5. If upload fails → leave file, retry next cycle
```

**Upload function:**

```cpp
void try_upload_session_log() {
    // Check if log file exists
    struct stat st;
    if (stat("/log/session.txt", &st) != 0) return;  // no file
    if (!Particle.connected()) return;                 // no cloud

    // Upload using same binary pattern as upload-test
    // Lambda receives and stores in MongoDB device_logs collection
    // Lambda parses checkpoint block at top to detect crashes
    // and can store crash data in device_crashes collection

    // After confirmed upload:
    // unlink("/log/session.txt");
}
```

**Note:** Exact upload implementation depends on answers to open questions about payload size limits and preferred upload mechanism (binary upload via `event.loadData()` or chunked via `payload_buffer` pattern).

**Four serial commands for debugging (work before cloud upload is implemented):**

| Command | What it does |
|---|---|
| **410: Dump checkpoint buffer** | Prints all 40 EEPROM checkpoint entries to serial. Shows the live checkpoint trail from the current session. Returns boot count. |
| **411: Dump flash log** | Prints the contents of both `/log/session.old.txt` and `/log/session.txt` to serial with byte counts. Shows the accumulated session log including previous session checkpoint trails. |
| **412: Flush RAM buffer** | Immediately flushes the RAM log buffer to `/log/session.txt`. Useful when you want to capture recent logs without waiting for the next idle flush. |
| **413: Clear all logs** | Deletes both flash log files, zeros the EEPROM checkpoint buffer, and clears the RAM buffer. Use this to start fresh. |

These give full diagnostic visibility over serial without needing cloud upload — useful during development and for field debugging with a USB connection.

### 1D. Heater Temperature Monitoring

**What:** Temperature-change-triggered logging via the `device_log()` system. Instead of logging every PID cycle (once per second = spam), only log when temperature changes by 0.5C or when notable heater events occur.

**Why this matters:** We've observed devices getting stuck at elevated temperatures (e.g., 49C) where `heater_ready` is false (temp above target) and the device sits in HEATING mode. The PID correctly sets power to 0, but passive cooling is slow. Without temperature logs, we have no visibility into these scenarios.

**How the heater system works (background):**

The heater is a PID-controlled heating pad targeting 45.0C. A thermistor reads temperature, and a PID controller adjusts heater PWM power once per second. The heater is briefly turned off during spectrophotometer readings to avoid electrical interference.

Key heater code locations:
- PID controller: `pid_controller()` (brevitest-firmware.cpp:2080)
- Temperature reading: `get_heater_temperature()` (brevitest-firmware.cpp:2038)
- Heater control struct: `HeatingElement` (brevitest-firmware.h:246)
- PID gains: P=80/4=20, I=1/50000, D=1/5

Where PID runs:
- Main `loop()` → `pid_controller()` when `temperature_control_on` is true
- `BCODE_loop()` → `pid_controller()` directly (runs during tests even when `temperature_control_on` is false)
- Stress test functions → `pid_controller()` directly

**Temperature change logging (0.5C threshold):**

```cpp
// Add to pid_controller() or a wrapper called from the same locations:
static int last_logged_temp = 0;

// After get_heater_temperature() returns:
if (abs(heater.temp_C_10X - last_logged_temp) >= 5) {  // 0.5C change (10X format)
    device_log("HEAT: T=%d.%d target=%d.%d pwr=%d err=%d int=%d",
        heater.temp_C_10X / 10, heater.temp_C_10X % 10,
        heater.target_C_10X / 10, heater.target_C_10X % 10,
        heater.power,
        heater.target_C_10X - heater.temp_C_10X,
        heater.integral);
    last_logged_temp = heater.temp_C_10X;
}
```

**Heater event logging:**

```cpp
// In hardware_loop() where heater_ready is checked:
if (heater_ready != previous_heater_ready) {
    device_log("HEAT: ready=%s T=%d.%d",
        heater_ready ? "YES" : "NO",
        heater.temp_C_10X / 10, heater.temp_C_10X % 10);
}

// In get_heater_temperature() when overheat detected:
if (heater.temp_C_10X > HEATER_MAX_TEMPERATURE) {
    device_log("HEAT: OVERHEAT T=%d.%d — control OFF",
        heater.temp_C_10X / 10, heater.temp_C_10X % 10);
    checkpoint(CP_HEATER_OVERHEAT);
}

// In get_heater_temperature() when thermistor reads 0:
if (heater_reads[i] == 0) {
    device_log("HEAT: THERMISTOR DISCONNECT — control OFF");
}

// In start_temperature_control() / stop_temperature_control():
device_log("HEAT: control %s", starting ? "START" : "STOP");
```

**Example log output during the "stuck at 49C" scenario:**

```
142000|HEAT: T=45.0 target=45.0 pwr=12 err=0 int=200
148000|HEAT: T=45.5 target=45.0 pwr=0 err=-5 int=195
153000|HEAT: ready=NO T=45.5
160000|HEAT: T=46.0 target=45.0 pwr=0 err=-10 int=185
178000|HEAT: T=46.5 target=45.0 pwr=0 err=-15 int=170
...
310000|HEAT: T=49.0 target=45.0 pwr=0 err=-40 int=50
450000|HEAT: T=48.5 target=45.0 pwr=0 err=-35 int=15
(long gap — temperature plateau, passive cooling stalled)
```

This gives full thermal forensics without flooding the log — only ~10-15 entries during a typical heatup, zero entries when stable at target temperature, and detailed traces when something goes wrong.

---

## Build 2: Lambda Logging Migration

### Current State

The Lambda (`index.mjs`) already logs to CouchDB:

```javascript
const log_entry = {
    _id: `log_${new Date().toISOString()}`,
    schema: 'log',
    department: 'log',
    loggedOn: new Date(),
    deviceId: device.id,
    type: eventType,        // 'validate-cartridge', etc.
    status: responseStatus, // 'SUCCESS', 'FAILURE', etc.
    data: responsePayload
};
```

### What Needs to Change

1. **Migrate log writes from CouchDB to MongoDB** (as part of the broader DB migration)

2. **Capture the full incoming request**, not just the response:

```javascript
const log_entry = {
    deviceId: device.id,
    deviceName: device.name,
    eventName: eventType,
    timestamp: new Date(),
    firmwareVersion: device.firmwareVersion,  // if available from Particle

    // NEW: Full request context
    request: {
        raw: event.body,          // raw Particle webhook payload
        parsed: parsedData,       // what the Lambda extracted
        particleEventId: event.id // Particle's event ID for correlation
    },

    // Existing: Response
    response: {
        status: responseStatus,
        data: responsePayload,
        processingTimeMs: endTime - startTime
    },

    // NEW: Error context if something went wrong
    error: errorDetails || null,

    // NEW: Database operations performed
    dbOperations: [
        { action: 'read', collection: 'cartridges', docId: cartridgeId, success: true },
        { action: 'update', collection: 'cartridges', docId: cartridgeId, success: true }
    ]
};
```

3. **Add a new route for `device-log` events** from firmware:

```javascript
case 'device-log':
    // Firmware is sending its session log file (includes checkpoint trail)
    await handleDeviceLog(device, parsedData);
    break;
```

```javascript
async function handleDeviceLog(device, data) {
    // Parse log lines
    const logLines = data.lines;

    // Store full session log
    await db.collection('device_logs').insertOne({
        deviceId: device.id,
        sessionId: data.sessionId,
        timestamp: new Date(),
        logLines: logLines,
        cartridgeId: data.cartridgeId || null,
        firmwareVersion: data.firmwareVersion
    });

    // Check for crash: parse checkpoint block at top of log
    // Look for "INTERRUPTED at checkpoint X" in early lines
    const interruptedLine = logLines.find(l => l.message.includes('INTERRUPTED at checkpoint'));
    if (interruptedLine) {
        const checkpointLines = logLines
            .filter(l => l.message.match(/CP\[\d+\]\s*=\s*\d+/))
            .map(l => parseInt(l.message.match(/=\s*(\d+)/)[1]));

        await db.collection('device_crashes').insertOne({
            deviceId: device.id,
            timestamp: new Date(),
            lastCheckpoint: checkpointLines[checkpointLines.length - 1],
            checkpointSequence: checkpointLines,
            firmwareVersion: data.firmwareVersion,
            sessionLogId: logEntry._id  // link back to full log
        });
    }
}
```

### Implementation Effort

- Moderate — requires updating the existing Lambda handler and adding MongoDB connection
- Should be coordinated with the CouchDB to MongoDB migration to avoid doing the work twice

---

## Build 3: Particle Event Catch-All

### What

A second Particle webhook integration that fires on ALL device events (wildcard `*`) and archives them to MongoDB. This captures every `Particle.publish()` from every device without any firmware changes.

### How

1. **Create a new Particle integration** in the Particle Console:
   - Event name: (leave blank or use `*` for all events)
   - URL: A new Lambda endpoint or route in existing Lambda
   - Method: POST

2. **Lambda handler:**

```javascript
async function archiveEvent(particleEvent) {
    await db.collection('device_events').insertOne({
        deviceId: particleEvent.coreid,
        eventName: particleEvent.event,
        data: particleEvent.data,
        publishedAt: new Date(particleEvent.published_at),
        archivedAt: new Date()
    });
}
```

3. **Index for fast queries:**

```javascript
db.device_events.createIndex({ deviceId: 1, publishedAt: -1 });
db.device_events.createIndex({ eventName: 1, publishedAt: -1 });
db.device_events.createIndex({ "data.cartridgeId": 1 });
```

### Implementation Effort

- Small — Particle Console configuration + simple Lambda route + MongoDB collection
- No firmware changes required
- Could be done first as a quick win

### Note

This catches `Particle.publish()` events only. It does NOT capture `Log.info()` serial output (that's what Build 1 handles).

---

## Build 4: Admin Dashboard Diagnostics View

### What

A new page/section in the Svelte admin dashboard that provides a unified timeline view of all device activity, pulling from all three MongoDB collections (`device_events`, `device_logs`, `device_crashes`).

### Features

1. **Device Timeline View**
   - Select a device -> see all events, logs, and crashes in chronological order
   - Color-coded by source (firmware log = blue, cloud event = green, crash = red)
   - Expandable entries for full detail

2. **Cartridge Journey View**
   - Enter a cartridge ID -> see everything that happened with it across device + cloud + server
   - Timeline: inserted -> barcode scanned -> validated -> test started -> BCODE steps -> test completed -> uploaded -> result
   - Highlights any errors or anomalies

3. **Crash Dashboard**
   - List of all crash events across all devices
   - Checkpoint sequence visualization
   - Frequency analysis (is the same checkpoint causing crashes repeatedly?)
   - Filter by device, time range, checkpoint code

4. **Heater History View**
   - Temperature traces extracted from device session logs (HEAT: entries)
   - Overlay target temperature for comparison
   - Flag sessions where temperature exceeded thresholds or heater_ready took abnormally long

5. **Live View** (optional / future)
   - Real-time event stream from Particle SSE (Server-Sent Events)
   - Particle provides an SSE endpoint for live events

### Implementation Effort

- Moderate to large — new Svelte components, MongoDB queries, API routes
- But as noted: "with some vibe coding shouldn't be hard to spin up"
- Can be built incrementally — start with device timeline, add crash dashboard, add cartridge journey

---

## MongoDB Schema Design

### Collection: `device_events`

Archives every Particle cloud event.

```javascript
{
  _id: ObjectId,
  deviceId: String,              // Particle device ID
  eventName: String,             // "validate-cartridge", "upload-test", "device-log", etc.
  data: Mixed,                   // Event payload (varies by event type)
  publishedAt: Date,             // When device published the event
  archivedAt: Date,              // When we stored it

  // Extracted for indexing (denormalized from data)
  cartridgeId: String || null,   // If event relates to a cartridge
  assayId: String || null        // If event relates to an assay
}

// Indexes
{ deviceId: 1, publishedAt: -1 }
{ eventName: 1, publishedAt: -1 }
{ cartridgeId: 1 }
{ publishedAt: -1 }  // TTL index if we want auto-cleanup after N days
```

### Collection: `device_logs`

Firmware session logs uploaded after tests or on reboot.

```javascript
{
  _id: ObjectId,
  deviceId: String,
  sessionId: String,             // Boot timestamp or UUID
  firmwareVersion: Number,
  bootTime: Date,
  uploadedAt: Date,

  // The actual log content
  logLines: [
    {
      ms: Number,                // millis() timestamp
      level: String,             // "INFO", "ERROR", "WARN"
      message: String            // Log message text
    }
  ],

  // Context
  cartridgeId: String || null,   // If a test was run during this session
  assayId: String || null,
  testDuration: Number || null,  // Seconds

  // Summary (computed on insert for quick dashboard display)
  lineCount: Number,
  errorCount: Number,
  firstLine: String,
  lastLine: String
}

// Indexes
{ deviceId: 1, bootTime: -1 }
{ cartridgeId: 1 }
{ uploadedAt: -1 }
```

### Collection: `device_crashes`

Crash checkpoint data extracted by Lambda from the session log's checkpoint block. When the Lambda receives a device log upload, it parses the checkpoint trail at the top of the file. If it finds "INTERRUPTED at checkpoint X", it creates a crash record here in addition to storing the full log in `device_logs`.

```javascript
{
  _id: ObjectId,
  deviceId: String,
  firmwareVersion: Number,
  detectedAt: Date,              // When the crash was detected (boot time)
  bootCount: Number,             // How many times this device has booted

  // Checkpoint data (parsed from session log's checkpoint block)
  lastCheckpoint: Number,        // The checkpoint code where it crashed
  lastCheckpointName: String,    // Human-readable name (e.g., "CP_CLOUD_CONNECT")
  checkpointSequence: [Number],  // Full checkpoint trail from session log

  // Link to full session log
  sessionLogId: ObjectId,        // Reference to device_logs document

  // Analysis (could be computed on insert)
  crashCategory: String          // "CLOUD", "I2C", "BCODE", "FILE_IO", "HARDWARE", "HEATER"
}

// Indexes
{ deviceId: 1, detectedAt: -1 }
{ lastCheckpoint: 1 }           // Find all crashes at same checkpoint
{ crashCategory: 1 }
{ detectedAt: -1 }
```

### Collection: `webhook_logs`

Enhanced Lambda request/response logging (replaces CouchDB `log` database).

```javascript
{
  _id: ObjectId,
  deviceId: String,
  eventName: String,             // "validate-cartridge", "upload-test", etc.
  timestamp: Date,
  processingTimeMs: Number,

  request: {
    raw: String,                 // Raw event body from Particle
    parsed: Mixed                // Extracted fields
  },

  response: {
    status: String,              // "SUCCESS", "FAILURE", "ERROR", "INVALID"
    data: Mixed,                 // Full response payload
    errorMessage: String || null
  },

  // Database operations performed during this webhook
  dbOperations: [{
    action: String,              // "read", "update", "insert"
    collection: String,
    docId: String,
    success: Boolean,
    error: String || null
  }],

  // Correlation
  cartridgeId: String || null,
  assayId: String || null,
  requestId: String || null      // Idempotency request ID
}

// Indexes
{ deviceId: 1, timestamp: -1 }
{ cartridgeId: 1 }
{ eventName: 1, timestamp: -1 }
{ "response.status": 1 }
```

---

## Open Questions for Senior Engineer

### Firmware Questions

1. **~~EEPROM struct change~~** — **RESOLVED.** New checkpoint fields are appended at the END of `Particle_EEPROM` (never inserted in the middle) to preserve existing field offsets. Bumping `DATA_FORMAT_VERSION` is sufficient — `setup_eeprom()` detects the mismatch, calls `reset_eeprom()`, which correctly reads `lifetime_stress_test_cycles` from its original offset and preserves it. Firmware updates always trigger a reboot, and devices are cloud-disconnected during tests, so interrupted-test data loss during migration is not a practical concern.

2. **~~Log file size limit~~** — **RESOLVED.** Two-file rotation implemented: when `session.txt` hits 16KB, it rotates to `session.old.txt`. Total flash cap is ~32KB. Old data is preserved until overwritten by the next rotation.

3. **Log upload mechanism** — The firmware currently uploads test data as binary via `event.loadData()`. Should the session log use the same pattern (binary upload), or use the multi-part `payload_buffer` pattern used by `load-assay` responses? Or a new pattern?

4. **~~Which `Log.info()` calls get replaced with `device_log()`?~~** — **RESOLVED.** See Section 1B "Which `Log.info()` Calls Become `device_log()`" for the complete breakdown. ~145 calls become `device_log()`, ~96 stay `Log.info()`. Rule: everything except individual BCODE steps, spectro per-reading details, serial command responses, PID per-second debug, BLE scan details, and directory file listings.

5. **Heater integral windup** — During temperature overshoot, the PID integral accumulates negative error. When temperature eventually drops below target, the large negative integral may prevent the heater from responding adequately. Should we add integral clamping (anti-windup) to the PID controller? This is separate from the logging work but was identified during this analysis.

### Lambda / Infrastructure Questions

6. **Lambda architecture** — The existing Lambda handles all webhook types in one function. Should the catch-all event archiver be a separate Lambda (simpler, isolated) or a new route in the existing Lambda (fewer deployments to manage)?

7. **MongoDB connection from Lambda** — Is there already a MongoDB connection/client in the Lambda environment, or does this need to be set up from scratch? Connection pooling considerations for Lambda cold starts?

8. **Dual-write during migration** — During the CouchDB to MongoDB migration, should the logging system write to both databases temporarily? Or is this a "new system goes to MongoDB only" situation?

9. **Event volume and cost** — The catch-all Particle integration will generate one Lambda invocation per device event. At current device count, what's the estimated event volume per day? Any cost concerns with Lambda invocations + MongoDB writes?

### Dashboard Questions

10. **API layer** — Does the Svelte dashboard talk directly to MongoDB, or through an API? If there's no API layer, the diagnostic queries would need to be Vercel serverless functions.

11. **Real-time vs polling** — For the device timeline, is polling (refresh every N seconds) acceptable, or do we want real-time updates via SSE/WebSocket? Particle provides an SSE endpoint for live events.

12. **Data retention** — How long should we keep device_events and device_logs? Suggest 90 days with TTL index for auto-cleanup. Crash reports kept indefinitely. Does this seem right?

---

## Risk Assessment

| Build | Risk Level | What Could Go Wrong | Mitigation |
|---|---|---|---|
| **1A: EEPROM checkpoints** | Low (2/10) | Wrong EEPROM address corrupts existing data | `DATA_FORMAT_VERSION` bump triggers clean EEPROM reset. Existing interrupted-test recovery handles gracefully. |
| **1B: RAM buffer + file flush** | Low (2/10) | RAM usage increase (~12KB) | M-SoM has 512KB RAM. Negligible. |
| **1B: File flush** | Low (3/10) | Flash filesystem fills up | 32KB file size cap. Auto-delete after successful cloud upload. |
| **1C: Log upload** | Medium (4/10) | Large log files overwhelm Particle publish rate limits | Chunk uploads. Implement backoff. Retry on next idle cycle if upload fails. |
| **1D: Heater monitoring** | Low (1/10) | Extra device_log() calls during temperature changes | 0.5C threshold keeps volume low. ~10-15 entries during heatup, zero when stable. |
| **2: Lambda logging** | Low (2/10) | MongoDB write failures | Catch errors, don't fail the webhook response. Logging failure should never block normal operation. |
| **3: Event catch-all** | Low (1/10) | Slightly increased Lambda costs | Monitor invocation count. Can disable if cost is unexpected. |
| **4: Dashboard** | Low (1/10) | Slow queries on large collections | Proper indexes. Pagination. Time-range filters. |

### Critical Rule

**Logging must NEVER interfere with normal device operation.** If a log write fails, the checkpoint write fails, or the file flush fails — the device must continue operating normally. All logging operations should be best-effort with error handling that silently continues.

---

## Implementation Priority

### Recommended order:

| Priority | Build | Effort | Impact | Dependencies | Status |
|---|---|---|---|---|---|
| **1st** | Build 1A: EEPROM checkpoints | Small | High — crash forensics immediately available | None | **DONE** — Firmware v71 |
| **2nd** | Build 1B: RAM buffer + file flush | Medium | High — detailed logs captured locally | None | **DONE** — Firmware v71 |
| **3rd** | Build 1D: Heater monitoring | Small | Medium — temperature visibility for known heater issues | Build 1B (uses device_log) | **DONE** — Firmware v71 |
| **4th** | Build 3: Event catch-all | Small | Medium — archive all cloud events with no firmware change | MongoDB connection from Lambda | Not started |
| **5th** | Build 2: Lambda logging migration | Medium | Medium — enhanced server-side context | CouchDB to MongoDB migration | Not started |
| **6th** | Build 1C: Log upload to cloud | Medium | High — device logs reach MongoDB/dashboard | Builds 1B + 2 | Not started |
| **7th** | Build 4: Dashboard diagnostics | Medium-Large | High — unified visibility | Builds 1-3 | Not started |

### Phase 1 (Firmware only) — COMPLETE:
- Build 1A (EEPROM checkpoints) — **Shipped in firmware v71**
- Build 1B (RAM buffer + file flush) — **Shipped in firmware v71** (includes two-file rotation, session headers, serial commands 410-413)
- Build 1D (Heater monitoring) — **Shipped in firmware v71**

### Phase 2 (Short-term — cloud infrastructure):
- Build 3 (event catch-all) — Quick Particle Console + Lambda setup
- Build 2 (Lambda logging) — Coordinate with MongoDB migration

### Phase 3 (Medium-term — full integration):
- Build 1C (log upload) — Connect firmware logs to cloud
- Build 4 (dashboard) — Unified diagnostics view

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **Breadcrumb logging** | Logging what is ABOUT to happen before a risky operation, not just what happened after |
| **Checkpoint** | A numeric code written to EEPROM before a risky operation, indicating "I was doing X" |
| **Ring buffer** | A fixed-size array that wraps around — when full, new entries overwrite the oldest |
| **Safe moment** | A point in code execution where it's safe to perform I/O (file writes, log flushes) without interfering with time-sensitive operations |
| **EEPROM wear** | Physical degradation of flash memory from repeated write cycles. Not a concern on M-SoM due to wear-leveled flash emulation. |
| **Idempotency** | The property that performing an operation multiple times has the same effect as performing it once. Already implemented in the Lambda middleware for webhook retries. |
| **TTL index** | MongoDB feature that automatically deletes documents after a specified time period |
| **PID controller** | Proportional-Integral-Derivative control algorithm used to maintain heater temperature at target |
| **Integral windup** | A PID problem where the integral term accumulates to extreme values when the controller output is saturated, causing sluggish response when conditions change |
| **I2C** | Inter-Integrated Circuit bus — 2-wire communication protocol connecting M-SoM to spectrophotometer sensors and power switch. Can hang if a sensor holds the data line low. |

## Appendix B: Complete Checkpoint Quick Reference

| Code | Name | Meaning |
|---|---|---|
| 10 | `CP_CLOUD_DISCONNECT` | About to disconnect from cloud |
| 11 | `CP_CLOUD_DISCONNECT_OK` | Disconnect succeeded |
| 12 | `CP_CLOUD_CONNECT` | About to reconnect to cloud |
| 13 | `CP_CLOUD_CONNECT_OK` | Reconnect succeeded |
| 14 | `CP_CLOUD_PUBLISH_VALIDATE` | About to publish validate-cartridge |
| 15 | `CP_CLOUD_PUBLISH_VALIDATE_OK` | Publish succeeded |
| 16 | `CP_CLOUD_PUBLISH_LOAD_ASSAY` | About to publish load-assay |
| 17 | `CP_CLOUD_PUBLISH_LOAD_ASSAY_OK` | Publish succeeded |
| 18 | `CP_CLOUD_PUBLISH_UPLOAD` | About to publish upload-test |
| 19 | `CP_CLOUD_PUBLISH_UPLOAD_OK` | Publish succeeded |
| 20 | `CP_CLOUD_PUBLISH_RESET` | About to publish reset-cartridge |
| 21 | `CP_CLOUD_PUBLISH_RESET_OK` | Publish succeeded |
| 22 | `CP_WEBHOOK_RESPONSE_RECEIVED` | Webhook response callback fired |
| 23 | `CP_WEBHOOK_TIMEOUT` | Cloud operation timed out |
| 30 | `CP_BCODE_START` | Entering process_BCODE() |
| 31 | `CP_BCODE_COMPLETE` | BCODE finished successfully |
| 40 | `CP_SPECTRO_READING_START` | Starting spectro BCODE command |
| 41 | `CP_SPECTRO_READING_COMPLETE` | Spectro command finished |
| 50 | `CP_FILE_WRITE_TEST` | Writing test results to flash |
| 51 | `CP_FILE_WRITE_TEST_OK` | Test results written |
| 52 | `CP_FILE_READ_ASSAY` | Reading assay from flash |
| 53 | `CP_FILE_READ_ASSAY_OK` | Assay read succeeded |
| 54 | `CP_FILE_WRITE_ASSAY` | Writing assay to flash |
| 55 | `CP_FILE_WRITE_ASSAY_OK` | Assay write succeeded |
| 56 | `CP_FILE_FLUSH_LOG` | *(Reserved — not used. Removed during testing to prevent EEPROM buffer flooding)* |
| 57 | `CP_FILE_FLUSH_LOG_OK` | *(Reserved — not used)* |
| 60 | `CP_STAGE_RESET` | Resetting stage (move until limit switch) |
| 61 | `CP_STAGE_RESET_OK` | Stage reset completed |
| 62 | `CP_BARCODE_SCAN` | Scanning barcode |
| 63 | `CP_BARCODE_SCAN_OK` | Barcode scanned |
| 64 | `CP_I2C_BUS_INIT` | Initializing I2C bus |
| 65 | `CP_I2C_BUS_INIT_OK` | I2C bus ready |
| 70 | `CP_TEST_START` | run_test() called |
| 71 | `CP_TEST_HARDWARE_SETUP` | Test hardware setup phase |
| 80 | `CP_HEATER_OVERHEAT` | Temperature exceeded 60C max |
