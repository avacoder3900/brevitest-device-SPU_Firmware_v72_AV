# Magnetometer System Overview

**Purpose:** Reference document covering the magnetometer subsystem — how data flows from the physical cartridge through firmware to cloud, what's stored where, current gaps, and how the webapp can access it.

---

## What the Magnetometer Does

Each Brevitest cartridge has 5 wells. Before running a test, the device validates that the magnets in each well are strong enough by reading magnetic field data from a separate magnetometer cartridge (a Particle Argon running as a BLE peripheral). The Brevitest SPU (M-SoM) acts as the BLE central device.

---

## Hardware: Two Devices Talking Over BLE

| Device | Role | Chip |
|--------|------|------|
| **Brevitest SPU** | BLE Central (initiator) | Particle M-SoM |
| **Magnetometer Cartridge** | BLE Peripheral (advertiser) | Particle Argon |

The magnetometer cartridge advertises a BLE service with 5 characteristics — one per well. Each characteristic contains tab-separated magnetometer readings (temperature, gauss_x, gauss_y, gauss_z) for 3 channels (sample, control_low, control_high).

### BLE Service & Characteristic UUIDs

Defined in `brevitest-firmware.h` (lines 420-427):

```
Service:  4d2b2311-bb00-43e3-a284-5c73b737c369

Well 1:   b1c14499-8e1d-41b2-b1bc-c89faa88d62a
Well 2:   2216cfb5-38a7-46a3-9509-ad7f287a569a
Well 3:   2230e907-583b-4328-84a4-8f9023a681c1
Well 4:   8c58309c-7c2d-4805-b71f-8137eb4a01f8
Well 5:   b9dc1dd4-a0da-4328-8003-6c72a526a12b
```

---

## Firmware Flow: Step by Step

### Trigger: Magnetometer Cartridge Inserted

1. **Barcode scanned** — the cartridge barcode is 32 chars long and starts with `"MAG-"` prefix
   - `brevitest-firmware.cpp:1135-1138` — barcode classified as `BARCODE_TYPE_MAGNETOMETER`
   - `brevitest-firmware.cpp:5064-5070` — state transitions to `VALIDATING_MAGNETOMETER`

2. **Main loop picks it up** — once heater is ready:
   - `brevitest-firmware.cpp:5462-5468` — calls `magnet_validation_loop()`

### validate_magnets() Function (brevitest-firmware.cpp:1515-1568)

This is the core function. Sequence:

```
1. BLE_scan()
   - Scans for BLE devices
   - scanResultCallback() matches device by:
     a) Device name starts with "Magnetometer"
     b) Custom data ID matches last 24 chars of barcode UUID
   - Stores MAC address in magnetometer_address

2. BLE.connect(magnetometer_address)
   - Attempts connection with up to 10 retries
   - Each retry waits MAGNETOMETER_CONNECT_DELAY (3000ms)

3. reset_stage() + move_stage_to_magnetometer_start_position()
   - Moves physical stage to starting position (12,800 microns)

4. Create validation file
   - Path: /validation/magnet-{unix_timestamp}.txt
   - Writes TSV headers for Channel A, B, C

5. For each of 5 wells:
   - move_stage(well_move[well]) — moves stage to next well
   - BLE read: magnetometer.getCharacteristicByUUID(bleCharUuid[well])
   - characteristic.getValue(result) — gets TSV magnetometer data
   - Writes result to file + Serial output

6. Close file, disconnect BLE, reset stage
7. Return 1 (success) or 0 (failure)
```

### Stage Movement Per Well

Defined in `brevitest-firmware.h:436`:
```cpp
int well_move[5] = { -8000, 8000, 8000, 8000, 8000 };
```
First well moves backwards 8000 steps, then each subsequent well moves forward 8000 steps.

### After validate_magnets() Returns

`magnet_validation_loop()` (line 5104-5110) just transitions state to IDLE. **No cloud publish happens.**

---

## Data Storage

### On-Device File System

Files stored at: `/validation/magnet-{unix_timestamp}.txt`

TSV format with headers:
```
/validation/magnet-1709834567.txt
         Channel A          Channel B          Channel C
Well  T    X    Y     Z    T    X    Y     Z    T    X    Y     Z
1     25.1 1.2  0.8  450.2 25.0 1.1  0.7  389.1 25.2 1.3  0.9  412.5
2     ...
3     ...
4     ...
5     ...
```

Management functions:
- `list_validation_files()` — BCODE command 71
- `clear_validation_files()` — BCODE command 72
- `load_latest_magnet_validation()` — BCODE command 73, also called at startup

Max files: `MAGNETOMETER_MAX_FILES = 50`

### In RAM (Particle.variable)

On startup (`setup()` at line 4725), `load_latest_magnet_validation()` reads the most recent file into:

```cpp
char magnet_validation_data[1024];  // MAGNETOMETER_BUFFER_SIZE
```

This buffer is registered as a Particle cloud variable:
```cpp
Particle.variable("magnet_validation", magnet_validation_data);  // line 4622
```

This means the cloud can read the latest validation data from a live device at any time by polling this variable.

---

## Cloud / Middleware Side

### Middleware Handler (index.mjs:576-614)

The Lambda middleware has a `validate_magnets` handler that:

1. **Parses TSV data** — splits by newline, then by tab
2. **Structures per-well data** — creates objects with `{ well, channel, temperature, gauss_x, gauss_y, gauss_z }`
3. **Validates** via `validate_magnetometer()` (line 535-543):
   ```javascript
   Math.abs(well.gauss_z) > process.env.MAGNET_MINIMUM_Z_GAUSS
   && Math.abs(well.temperature) > process.env.TEMPERATURE_MIN
   ```
4. **Updates device admin document** in database with validation results + timestamp
5. **Sends response** back to device with SUCCESS/ERROR

### Validation Logic

Each well across all channels must pass both checks:
- `|gauss_z|` must exceed `MAGNET_MINIMUM_Z_GAUSS` (environment variable)
- `|temperature|` must exceed `TEMPERATURE_MIN` (environment variable)

If ANY well fails, the entire magnetometer is marked invalid.

---

## Current Gaps / Issues

### 1. No Particle.publish() for validate-magnets

The middleware handler for `validate-magnets` exists (line 676 in index.mjs), and a webhook is presumably configured in the Particle Console, but **the firmware does not currently publish a `validate-magnets` event**. The 4 publish events in firmware are:
- `validate-cartridge`
- `load-assay`
- `reset-cartridge`
- `upload-test`

This means the middleware's `validate_magnets` handler may not be getting triggered. The magnet data is only available via `Particle.variable("magnet_validation")` pull mechanism.

### 2. Device Doesn't Know Cloud Validation Result

Even if the middleware did validate the magnets, there is **no subscription** for a `validate-magnets` response on the device side. The 4 subscriptions (all slots used) are:
- `hook-response/load-assay/`
- `hook-response/validate-cartridge/`
- `hook-response/reset-cartridge/`
- `hook-response/upload-test/`

So the device can never learn whether the cloud determined magnets were invalid. It writes the data to a file, exposes it as a variable, and moves on.

### 3. Validation Data Not Automatically in Database

Because the publish appears to be missing, the magnet validation data may not be automatically stored in the database. The only reliable source is the `Particle.variable()` on the live device, which requires the device to be online.

---

## Webapp Access Options

### Option A: Direct Particle API Pull (Live Data)

The webapp can query `Particle.variable("magnet_validation")` directly from any online device:

```
GET https://api.particle.io/v1/devices/{deviceId}/magnet_validation
Authorization: Bearer {PARTICLE_ACCESS_TOKEN}
```

Returns:
```json
{
  "result": "<TSV string with all 5 wells>",
  "coreInfo": { "deviceID": "abc123", "connected": true }
}
```

**Pros:** No middleware needed, real-time data, simple to implement
**Cons:** Device must be online, no historical data, raw TSV needs parsing

Implementation: A Vercel serverless API route that proxies the Particle API call (keeps access token server-side).

### Option B: Middleware Stores to Database (Historical Data)

Fix the missing `Particle.publish("validate-magnets", ...)` in firmware so the Lambda handler receives and stores validation data in MongoDB.

**Pros:** Historical record, device doesn't need to be online for lookup, validation pass/fail determined server-side
**Cons:** Requires firmware change + uses one of the publish event slots (though it doesn't need a subscription since device doesn't need the response)

### Recommendation

**Both.** Use Option A for a "check device now" button. Use Option B for historical tracking and automated pass/fail logging.

---

## Particle.publish() vs Particle.variable() (Reference)

| Feature | Particle.publish() | Particle.variable() |
|---------|-------------------|---------------------|
| **Direction** | Device pushes event to cloud | Cloud pulls value from device |
| **Timing** | One-time fire, triggers webhooks | Always available while device online |
| **Max size** | ~1 KB per event | 622 bytes (string) |
| **Persistence** | Webhook delivers to backend | Gone on reboot unless reloaded |
| **Delivery** | At-least-once (retries on failure) | No guarantee — just a poll |
| **Use case** | Sending data to be processed/stored | Quick status checks |

---

## Key Code References

| What | File | Lines |
|------|------|-------|
| BLE UUIDs & globals | `brevitest-firmware.h` | 416-445 |
| Magnetometer prefix/defines | `brevitest-firmware.h` | 16, 32, 99, 124, 159-163 |
| BLE scan callback | `brevitest-firmware.cpp` | 1335-1360 |
| BLE_scan() | `brevitest-firmware.cpp` | 1362-1370 |
| load_latest_magnet_validation() | `brevitest-firmware.cpp` | 1372-1421 |
| File management (list/clear/create) | `brevitest-firmware.cpp` | 1423-1494 |
| check_magnets_in_one_well() | `brevitest-firmware.cpp` | 1496-1513 |
| validate_magnets() | `brevitest-firmware.cpp` | 1515-1568 |
| BCODE commands (70-73) | `brevitest-firmware.cpp` | 3421-3431 |
| Particle.variable registration | `brevitest-firmware.cpp` | 4622 |
| Startup load | `brevitest-firmware.cpp` | 4725 |
| State machine handling | `brevitest-firmware.cpp` | 5062-5070 |
| magnet_validation_loop() | `brevitest-firmware.cpp` | 5104-5110 |
| Main loop dispatch | `brevitest-firmware.cpp` | 5462-5468 |
| Middleware validate_magnetometer() | `index.mjs` | 535-543 |
| Middleware update_validation() | `index.mjs` | 545-574 |
| Middleware validate_magnets() | `index.mjs` | 576-614 |
| Middleware event routing | `index.mjs` | 676-677 |
