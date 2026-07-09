# PRD — Single-Controller XY Gantry (2×X + 1×Y) on One SPU M-SoM

**Status:** Draft for review
**Author:** Firmware / SPU
**Target firmware:** `brevitest-firmware` v72+ (branch `press-firmware`), Particle M-SoM, Device OS 6.3.3
**Related:** `SERIAL_COMMANDS.md`, `MIDDLEWARE_SINUSOIDAL_COMMANDS.md`, `STATE_MANAGEMENT_GUIDE.md`

---

## 1. Summary

Drive a coupled **XY gantry** — two steppers on the X beam (one per side), one stepper on Y — from a **single M-SoM**, at **micron precision**, using the in-house steppers/rails and the proven `brevitest-firmware` motion code. Motion is **axis-at-a-time** (move X, then Y; no diagonal interpolation) and **linear** (no aggressive dynamics).

Because a single controller owns all three motors, there is **no inter-device synchronization problem** — the earlier multi-SPU sync approach (GO/ABORT/READY lines, leader/follower roles, crystal drift, `BCODE_loop()` skew) is **dropped**. The two X motors stay in lockstep by construction because their STEP pins are toggled in the same code path. The remaining engineering is (a) generalizing the current single-axis motion to a 2-axis (X/Y) gantry with a **doubled, dual-endstop X**, and (b) a **calibration + repeatability regime** to hit and hold micron precision run-to-run.

> **Supersedes** the multi-device synchronization design. Rationale for the change is in §2.

---

## 2. Why a single controller (design decision)

The system is a **dual-motor gantry**: the two X motors drive one rigid beam from both ends. Coupled motors of this kind have one hard rule — they must receive **identical motion**, or the beam **racks** (skews in its rails) and binds. At micron precision, where one step is only a few microns, the tolerance for skew is tiny.

Driving the two coupled X motors from **two independent M-SoM devices was rejected**: even with a hardware start-trigger, each device runs its own `delayMicroseconds` step loop off its own crystal, and any variable-latency work (`BCODE_loop()` heater PID / cartridge poll) that stalls one device's step train mid-move racks the beam by exactly that many steps. This is why CNC/printer firmware never drives a coupled gantry from two brains — it shares the step signal.

**Chosen architecture:** one M-SoM generates all step/dir signals. The two X motors are driven from **two GPIO STEP pins toggled together in the same instruction stream** — as tightly locked as a hardware signal-splitter (sub-µs skew), with **no buffer chip required** (one GPIO drives one driver input). Keeping the two X STEP pins individually addressable is deliberate: it costs nothing for normal moves (toggle both together) and enables **automatic gantry squaring** at homing (let each side stop on its own endstop). This is the standard Marlin/GRBL "dual endstop" pattern.

Motion is sequential (X then Y), so a single controller never needs to generate two step trains at once — the existing blocking `move_stage` loop is reused per axis, unchanged in spirit.

**Result:** zero cross-device timing, zero sync hardware, one deterministic program. The two spare SPUs become backups.

---

## 3. Goals / Non-goals

### Goals
- Single M-SoM drives 2×X (lockstep) + 1×Y as a coordinated gantry.
- **Micron-precision** positioning that is **repeatable run-to-run** within a defined tolerance (target TBD — §9).
- **Automatic gantry squaring** at home via dual X endstops, so the beam returns square every power cycle.
- Per-axis calibration (X and Y independently) persisted in EEPROM.
- Re-home discipline that bounds open-loop error to a single run.

### Non-goals (this phase)
- **Diagonal / interpolated X+Y motion.** Motion is axis-at-a-time. (If coordinated diagonal paths are needed later, add Bresenham interleaving — noted in §10.)
- **Closed-loop feedback (encoders).** Stay open-loop; §7 makes open-loop trustworthy instead.
- **Multi-device synchronization.** Removed by the single-controller decision.
- Changing the BCODE language or the existing single-device test flow.

---

## 4. Mechanical model

```
                 Y endstop
                    │
        X1 ┌────────┴─────────┐ X2         X1, X2 = the two X-beam motors (must move identically)
     (motor)│   ===  BEAM  ===│(motor)      Y      = single Y motor
        │   └──────┬───┬──────┘   │
   X1 endstop      │   │       X2 endstop   Dual X endstops → auto-square the beam at home
        │        Y carriage        │
   ═════╪═════════════════════════╪═════  X rails (beam travels along X)
```

- **X axis = 2 motors, 1 beam.** Normal moves: X1 and X2 step **together** (identical count, identical timing). This is enforced in software, not by trusting two crystals.
- **Squaring:** on home, both X motors drive toward their endstops; whichever side trips first **stops**, the other continues until its own switch trips → the beam is mechanically square to the frame. Then both are re-locked for moves.
- **Y axis = 1 motor**, homes to its own endstop.

---

## 5. Hardware / pin plan

One M-SoM, three drivers (the existing in-house per-stage drivers — each motor keeps its own proven power stage; we share only the **logic** signal for X, and even that is two separate GPIO so each driver has a clean single-load input).

Signals needed (final pins to be confirmed against the M-SoM pinout PDF, avoiding RGB/SWD and the used set A0/A2/A3/A4/A6, D3–D8, D11–D13, D22/D23/D26):

| Signal | Count | Notes |
|---|---|---|
| X1_STEP, X2_STEP | 2 | toggled together for moves; separately during squaring |
| X_DIR (shared) | 1 | both X motors always share direction |
| Y_STEP, Y_DIR | 2 | independent Y axis |
| ENABLE / SLEEP | 1–3 | reuse existing `pinMotorSleep`/`pinMotorReset` pattern; per-axis optional |
| X1_LIMIT, X2_LIMIT | 2 | dual endstops for squaring (`INPUT_PULLUP`, debounced) |
| Y_LIMIT | 1 | Y home switch |

≈ 9–11 GPIO. Free candidates on the M-SoM: `D0`, `D1`, `D2`, `D9`, `D10`, `D14`–`D21`, `A1`, `A5`. Set STEP pins to high drive: `pinSetDriveStrength(pin, DriveStrength::HIGH)` (9 mA vs 2 mA default). Common ground across all three driver stages and the M-SoM.

The existing `pinMotorStep`/`pinMotorDir` (D13/D8) become **X1_STEP / X_DIR** so the current motion code maps onto X with minimal change; X2/Y are additive.

---

## 6. Firmware design

Reuse the existing blocking, deterministic step generator; generalize it from one stage to a small **axis abstraction**.

### 6.1 Axis abstraction
Introduce a lightweight per-axis struct (config + state), replacing the module-global `stage_position`/`microns_error` singletons:

```
struct GantryAxis {
    hal_pin_t step_pin_a;      // X: X1; Y: Y_STEP
    hal_pin_t step_pin_b;      // X: X2; Y: unused (-1)
    hal_pin_t dir_pin;
    hal_pin_t limit_pin_a;     // X1_LIMIT / Y_LIMIT
    hal_pin_t limit_pin_b;     // X2_LIMIT / unused (-1)
    int32_t   position_um;
    int32_t   microns_error;   // fractional-step carry (per axis)
    int32_t   microns_per_eighth_step;  // CALIBRATED, per axis (was the #define 25)
    int32_t   position_limit_um;
    int32_t   backlash_um;     // measured; for unidirectional approach
};
GantryAxis axisX, axisY;
```

- `move_one_eighth_step` → pulses **both** `step_pin_a` and `step_pin_b` for X (single code line = locked). For Y, `step_pin_b == -1` so only one pin toggles.
- `move_stage`, `move_stage_to_position`, `reset_stage` become `move_axis(GantryAxis&, ...)` — same math (`abs_microns / microns_per_eighth_step`, remainder carry), now per axis.
- Sequential API: `move_gantry_to(x_um, y_um)` = `move_axis(axisX, ...)` then `move_axis(axisY, ...)`.

### 6.2 Dual-endstop homing / squaring (X)
New `home_x_and_square()`:
1. Drive X1 and X2 toward home together (fast) until **each** side's endstop trips; a side that trips first stops stepping while the other continues (independent `step_pin_a`/`step_pin_b` control) → beam squared.
2. Back off, slow re-approach each side (removes approach-speed dependence).
3. Zero both X position and `microns_error`.

`home_y()` reuses the existing single-endstop `reset_stage` logic on the Y axis.

### 6.3 BCODE integration
The BCODE interpreter (`process_one_BCODE_command`) is unchanged in structure; motion opcodes gain an **axis argument** (or new opcodes) so a script can address X vs Y:
- `case 2` (Move Microns) → add axis token, route to `move_axis`.
- Homing/oscillate/sinusoidal opcodes similarly parameterized by axis.
- Backward compatible: default axis = X preserves existing single-axis scripts.

### 6.4 Config & entry points
- Extend `Particle_EEPROM` with `axisX`/`axisY` calibration fields (`microns_per_eighth_step`, `backlash_um`, home offsets). EEPROM plumbing (`EEPROM.get/put`, `setup_eeprom`) already exists.
- Cloud/serial functions to run a gantry move, run homing/squaring, and run calibration (mirror the existing `run_test` / serial-command pattern in `SERIAL_COMMANDS.md`).

---

## 7. Calibration & repeatability — hitting micron precision

Open-loop steppers are exact in **step count**, not in **microns**, and not identically across the two axes/mechanics. Micron precision lives or dies here. Five sources, each with a mitigation.

### 7.1 Per-axis steps-per-distance (the old `MOTOR_MICRONS_PER_EIGHTH_STEP = 25`)
A single compile-time constant cannot be right for both X and Y if their screws/microstepping differ. **Promote to per-axis calibrated values** in EEPROM (§6.1). Calibrate empirically: command a large known move, measure actual displacement (dial indicator / gauge / caliper), compute true µm/eighth-step, store per axis. This directly sets absolute accuracy.

### 7.2 Homing repeatability (dominant run-to-run factor)
Everything repeatable rides on **where the endstops trip**, which has mechanical + electrical hysteresis. **Mitigations:**
- **Two-stage homing** (fast approach → back off → slow re-approach) removes approach-speed dependence — current `move_stage_until_proximal_limit` is single-speed.
- **Characterize** each switch: home N = 50×, record trip position, quantify σ. This σ is the floor on achievable repeatability and answers whether open-loop meets the target (§9.2) — **the Phase-0 gate.**
- If mechanical NC-switch σ is too large for microns, move to optical/inductive/Hall home switches.

### 7.3 Backlash / lost motion
`move_stage` has **no backlash compensation**; direction reversals lose steps to slop, differently per axis. **Mitigation:** **always approach any target position from the same direction** (overshoot, then come back), so backlash is a constant that cancels rather than run-to-run noise. Measure `backlash_um` per axis; store it. Critical for micron precision.

### 7.4 Missed steps
A skipped step is **permanent** in open loop and silently offsets that axis (and, on the gantry, would try to rack the beam — the coupled motors then fight until one stalls). **Mitigations:** conservative current margin and speed/accel below the per-axis skip threshold (found empirically); "linear, not too crazy" dynamics keep us far from it; re-home every run so no error accumulates across runs.

### 7.5 Fractional-micron carry
The existing `microns_error` remainder carry is preserved **per axis** (§6.1), so repeated small moves don't lose sub-step fractions. Every run starts from a fresh home (zeroing it).

### 7.6 Calibration artifacts
- A **calibration routine** (per axis) + written measurement protocol (move → measure → compute → store).
- Per-axis calibration record (µm/step, homing σ, backlash, skip-threshold speed) persisted in EEPROM and logged to the cloud for traceability.
- A **verification run**: execute the reference motion; measure final XY position; confirm within tolerance over ≥ 20 repeats.

---

## 8. Work breakdown

### 8.1 Motion / axis
- [ ] `GantryAxis` struct; migrate `stage_position`/`microns_error`/`MOTOR_MICRONS_PER_EIGHTH_STEP` to per-axis (audit every reference).
- [ ] `move_one_eighth_step` toggles both X step pins together; Y single-pin.
- [ ] `move_axis` / `move_gantry_to` (sequential X-then-Y).
- [ ] `home_x_and_square()` (dual endstop) + `home_y()`.
- [ ] Two-stage (fast/slow) homing.
- [ ] Optional unidirectional-approach wrapper for target moves (backlash cancel).

### 8.2 Hardware bring-up
- [ ] Assign & init pins (X1/X2/Y STEP, DIR, ENABLE, 3 limits); high drive on STEP.
- [ ] Verify each X motor direction; confirm X1/X2 move the beam the same way (flip one DIR in firmware if not).
- [ ] Confirm dual-endstop squaring physically squares the beam.

### 8.3 Calibration & config
- [ ] `Particle_EEPROM` per-axis fields + `set`/report cloud functions.
- [ ] `run_calibration` routine + report; measurement protocol doc.

### 8.4 BCODE & control surface
- [ ] Axis-parameterized motion opcodes (backward-compatible default = X).
- [ ] Cloud/serial commands: gantry move, home/square, calibrate.

### 8.5 Safety / observability
- [ ] Refuse any move before a successful home+square this power cycle.
- [ ] Missed-step guardrails (speed/current caps); re-home per run.
- [ ] End-of-run position report + log (traceability).

---

## 9. Open questions (to finalize)

1. **Position tolerance target (µm)?** The single most important number — sets whether open-loop + calibration suffices or encoders are eventually needed, and defines the Phase-0 gate. "Micron precision" — is that ≈ 1 µm, ≈ 5 µm, ≈ 10 µm?
2. **Travel & speed** per axis? (Current firmware envelope: `STAGE_POSITION_LIMIT` = 45 mm, ~≤ 40 mm/s — do the new rails match, or is the range larger?)
3. **Do the in-house drivers accept a single logic input cleanly** (so one GPIO per driver is enough), or is a buffer wanted for noise margin on longer runs?
4. **Dual X endstops available** on both sides of the beam, or only one X switch (→ manual/mechanical squaring instead of automatic)?
5. **Motion profile** — pure indexed moves, or do the oscillate/sinusoidal primitives get used on the gantry?

---

## 10. Phasing

- **Phase 0 — Characterize & gate (one axis, existing firmware):** measure homing σ (N = 50), steps/µm, backlash, skip-threshold speed on one in-house stage. **Gate:** does open-loop repeatability meet the §9.1 tolerance? If not, resolve (better switch / feedback) before building the gantry.
- **Phase 1 — Two-axis firmware (bench, motors on bench, no beam):** `GantryAxis`, `move_axis`, per-axis homing/calibration. Prove X1+X2 move identical counts and Y independent.
- **Phase 2 — Gantry assembly + squaring:** mount the beam; implement/verify dual-endstop auto-square; confirm no racking over full travel.
- **Phase 3 — Calibration & micron verification:** per-axis µm/step + backlash calibration in EEPROM; unidirectional approach; verification run ≥ 20 repeats within tolerance.
- **Phase 4 — Hardening:** re-home discipline, missed-step guardrails, end-of-run position logging, traceability. *(Optional future: Bresenham X+Y interpolation if diagonal motion is ever needed.)*

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Homing scatter exceeds µm tolerance | open-loop approach can't hit spec | Phase-0 gate first; two-stage homing; better home switch |
| Beam racks (X1/X2 not truly identical) | binding, stalls, lost position | same-code-line X stepping; dual-endstop square each home; verify directions |
| Silent missed step | offset position, no alarm | conservative margins; re-home per run; end-of-run position compare |
| X/Y mechanical mismatch | wrong absolute distance | per-axis µm/step calibration in EEPROM |
| Backlash on reversals | run-to-run µm noise | unidirectional final approach; measured per-axis offset |
| Only one X endstop | beam not auto-squared | mechanical shim/setup squaring; document; single-switch home |

---

## 12. Success criteria

1. Single M-SoM drives 2×X (verified lockstep, no racking over full travel) + 1×Y.
2. Beam auto-squares at every home within the endstop repeatability budget.
3. Final XY position repeatable across ≥ 20 runs within the agreed µm tolerance (§9.1).
4. Per-axis calibration persists across power cycles and is logged for traceability.
5. No silent desync survives a run — every run re-homes/squares and reports end position.
