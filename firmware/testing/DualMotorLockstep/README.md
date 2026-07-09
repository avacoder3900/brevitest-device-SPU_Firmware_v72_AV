# DualMotorLockstep — two coupled steppers, two SPU boards

Two SPU M-SoM boards, each driving its own stepper, moving **as one** (both ends of
a coupled beam). They stay locked because the boards **share the step pulses over a
wire**, not by exchanging messages (too slow — the beam would rack). See
`../../Docs/MULTI_SPU_SYNC_PRD.md` for the full design and the calibration plan.

The **same binary flashes to both boards**. Each board decides its role at boot from
one strap jumper.

---

## Wiring (5 wires between the two boards)

| Leader board | → | Follower board | Purpose |
|---|---|---|---|
| `D14` STEP_ECHO (out) | → | `D14` STEP_ECHO (in) | one pulse = one 1/8 step |
| `D15` DIR_ECHO (out)  | → | `D15` DIR_ECHO (in)  | move direction |
| `D16` ABORT           | ↔ | `D16` ABORT          | wired-OR, either board stops the pair |
| `GND`                 | — | `GND`                | **common ground — required** |

Role strap (per board, to that board's own GND):
- **Leader:** jumper `D2` → `GND`.
- **Follower:** leave `D2` open (internal pull-up reads it HIGH).

Each board keeps its **existing** motor wiring (same pins as v72: STEP `D13`, DIR `D8`,
SLEEP `D12`, RESET `D11`) and its **own endstop** on `D26` (NC switch to GND).

> If the follower motor is mounted mirror-image (turns the wrong way relative to the
> leader), set `FOLLOWER_INVERT_DIR = true` in the `.ino` and reflash the follower.

---

## Flash

Particle Workbench or CLI, target platform `msom`:

```
particle flash --local            # from this folder, to each board over USB/DFU
# or open testing/DualMotorLockstep in Workbench and "Flash application (local)"
```

Flash both boards with the identical build. Connect USB serial at **115200** to watch
each board; the leader prints `== ROLE: LEADER ==`, the follower `== ROLE: FOLLOWER ==`.

Both boards **home to their own endstop on boot** — that self-squares the beam.

---

## Test sequence

1. Power both boards, both endstops connected, motors free to move.
2. Confirm roles on the two serial consoles.
3. On boot each board homes. Watch both carriages drive to their switches and stop.
4. On the **leader** console:
   - `m2000`  → move 2 mm distal. **Both motors must step together**; the beam
     should not skew. If it racks, check `FOLLOWER_INVERT_DIR` and that STEP_ECHO/GND
     are solid.
   - `m-2000` → return toward home.
   - `s`      → print position estimate.
   - `a` / `r`→ assert / release abort (both boards should freeze on `a`).
5. On either console, `h` re-homes that board.

---

## Before you trust the microns

`MICRONS_PER_EIGHTH_STEP = 25` is a placeholder copied from v72. For real
micron-accurate motion, calibrate it per the PRD §7: command a large known move,
measure actual travel, compute the true µm per 1/8 step, and set the constant (later:
per-board in EEPROM). Also measure backlash and always approach a target from the same
direction.

## Scope / limits (bring-up sketch)

- Blocking moves, conservative speed — fine for linear, modest motion.
- No cloud/heater/spectro machinery; this is a motion bench sketch only.
- Follower obeys its own home endstop (stops the pair if it hits it) but has no distal
  soft limit — the leader owns the travel limit. Keep test moves within range.
- Coupled-motion hardening (missed-step detection, per-board calibration in EEPROM,
  end-of-run position compare) is in the PRD, not this sketch.
