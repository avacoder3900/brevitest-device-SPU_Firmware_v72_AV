# SPU Microscope-Gantry Firmware — Handoff / Bring-Up Guide

> Audience: a new AI assistant (or human) on a **different machine** picking up the
> microscope-gantry stepper work. Everything you need is in the git repo — this doc
> tells you the current state and how to run the first motion tests.

---

## 1. Project in one paragraph

The microscope gantry is driven by **SPU boards** (in-house Particle **M-SoM** based
controllers, one stepper driver per board, DRV8825-class). The end goal is a beam
coupled at both ends, driven by **two** SPU boards moving in lockstep: the **leader**
board generates motion and echoes every 1/8-step pulse over a wire; the **follower**
mirrors each pulse in an interrupt (µs latency — no cloud/serial messaging in the
motion path). Each board homes to its **own** endstop, which self-squares the beam.
Before any of that, you can bring up **one board + one motor + one pulley** alone —
the sketch supports that directly (see §5).

## 2. Repo / branch status

| | |
|---|---|
| Repo | `github.com/avacoder3900/brevitest-device-SPU_Firmware_v72_AV` |
| Branch | **`gantry-firmware`** (pushed; up to date as of 2026-07-22) |
| Head | `d77d0ab` — "feat(motion): dual-motor lockstep bench sketch for coupled steppers" |
| Based on | `press-firmware` (product firmware v81 lineage) |
| Platform / target | Particle `msom`, Device-OS **6.3.3** (see `firmware/project.properties`) |
| Build status | Verified compiling clean for msom @ 6.3.3 on 2026-07-22 (~9.6 KB flash) |

Key files (all committed on the branch):

- `firmware/testing/DualMotorLockstep/DualMotorLockstep.ino` — the self-contained
  bench sketch. **This is what you flash.** No dependency on the main firmware.
- `firmware/testing/DualMotorLockstep/README.md` — wiring tables + two-board test
  sequence.
- `firmware/Docs/MULTI_SPU_SYNC_PRD.md` — full design + calibration plan. (Note:
  the PRD body still describes an earlier single-controller variant; the shipped
  sketch is the 2-board step-echo peer version. The sketch + its README are the
  source of truth.)

## 3. Environment setup (fresh console)

```bash
git clone https://github.com/avacoder3900/brevitest-device-SPU_Firmware_v72_AV.git
cd brevitest-device-SPU_Firmware_v72_AV
git checkout gantry-firmware

# Particle CLI (if not installed): https://docs.particle.io/getting-started/developer-tools/cli/
particle login        # brevitest Particle account

# Compile the bench sketch (cloud compile — no local toolchain needed)
cd firmware/testing/DualMotorLockstep
particle compile msom . --target 6.3.3 --saveTo lockstep.bin
```

Flash over USB (board in DFU mode — blinking yellow; hold MODE, tap RESET, release
MODE when blinking yellow — or just let the CLI trigger it):

```bash
particle flash --usb lockstep.bin
# or, one step, from this folder:
particle usb dfu && particle flash --local
```

Watch the board:

```bash
particle serial monitor --follow      # 115200 baud
```

## 4. Wiring the board under test

Per-board motor wiring (same pins as production v72 firmware — if the board came
off an SPU, the motor wiring is already correct):

| Signal | Pin | Notes |
|---|---|---|
| STEP | `D13` | to driver STEP |
| DIR | `D8` | to driver DIR |
| SLEEP | `D12` | driver sleeps between moves |
| RESET | `D11` | held HIGH |
| Home endstop | `D26` | **NC switch to GND** (internal pull-up; LOW = triggered) |
| Role strap | `D2` | **jumper to GND = LEADER**; open = follower |

⚠ **The endstop must be connected before power-up.** The sketch homes on boot:
it drives toward home until `D26` reads LOW. With no switch wired, it runs a guard
distance (~45 mm equivalent) and then stops wherever it is. Motor and endstop first,
then power.

The board waits up to 8 s for USB serial after reset, then homes. Open the serial
monitor right after reset to see the whole boot sequence.

## 5. First test: ONE board, one stepper, one pulley

Strap `D2 → GND` so the board boots as **LEADER** (a leader runs standalone —
the echo outputs just go nowhere). You'll see:

```
== ROLE: LEADER ==
cmds: h=home  m<microns>=move(+distal/-home)  s=status  a=abort  r=release
homing...
homed (pos=0)
```

Then, over the serial console (commands are single lines, 115200 baud):

| Command | Effect |
|---|---|
| `m2000` | move 2000 µm *commanded* distal (away from home) — **see §6 caveat** |
| `m-2000` | move back toward home |
| `s` | print position estimate, abort state, role |
| `h` | re-home (fast approach → 1 mm backoff → slow re-approach) |
| `a` / `r` | assert / release abort (motion freezes / resumes being allowed) |

Suggested sequence:

1. Boot → confirm it homes into the switch, backs off, re-approaches slowly, prints `homed (pos=0)`.
2. `m2000` → carriage moves away from home smoothly; `s` shows `pos=2000`.
3. `m-2000` → returns; `s` shows `pos=0`.
4. `m2000` then `a` mid-move next time → motor freezes; `r` then `h` to recover.
5. Soft distal limit is **45 mm** (`TRAVEL_LIMIT_UM`); moves clamp there. Toward
   home it stops at the switch or pos 0, whichever first.

## 6. ⚠ Known caveats — read before trusting distances

1. **Pulley scale factor is stale.** `MICRONS_PER_EIGHTH_STEP = 25` in the sketch
   (line ~54) is the old **20-tooth** pulley value. The hardware moved to a
   **40-tooth** pulley (2026-07-16), so **every commanded distance travels ~2×** —
   `m2000` moves ~4 mm. For bring-up either mentally halve your commands, or set
   the constant to `50` and recompile. Either way, **calibrate before trusting
   microns**: command a large move, measure actual travel, compute true µm per
   1/8-step, set the constant. (Confirm which pulley is on *your* unit first.)
2. **Backlash is unmeasured.** Always approach a target from the same direction.
3. **Homing guard uses the same constant** — with the 40T pulley the guard travel
   is also ~2×, which is harmless for homing but explains longer-than-expected
   guard runs.
4. Blocking moves, conservative fixed speed (`STEP_DELAY_US = 350`). This is a
   bring-up sketch — no acceleration ramps, no cloud, no heater/spectro code.

## 7. Second test: TWO boards in lockstep (when ready)

Full procedure is in the sketch's `README.md`. Summary: flash the **identical
binary** to both boards; strap `D2→GND` on the leader only; connect 4 wires between
boards — `D14→D14` (STEP_ECHO), `D15→D15` (DIR_ECHO), `D16↔D16` (ABORT, wired-OR),
and **common GND** (required). Each board keeps its own motor + its own endstop.
Both home themselves on boot (that squares the beam). Drive from the **leader**
console with the same `m`/`s`/`h` commands — both motors must step together with no
skew. If the follower turns the wrong way, set `FOLLOWER_INVERT_DIR = true` and
reflash **the follower only**. Either board hitting its home switch mid-move, or
`a` on either console, halts the pair.

## 8. Open items (in priority order)

1. Calibrate `MICRONS_PER_EIGHTH_STEP` on real hardware (the §6 measurement).
2. Measure backlash; adopt same-direction final approach.
3. Define the micron tolerance target for the gantry (Phase-0 gate — still TBD).
4. Hardening from the PRD, not yet in the sketch: missed-step detection, per-board
   calibration stored in EEPROM, end-of-run position compare between boards.
