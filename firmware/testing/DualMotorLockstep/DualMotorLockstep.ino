/*
 * DualMotorLockstep — two coupled steppers, two SPU M-SoM boards, one shared beam.
 * ------------------------------------------------------------------------------
 * Two motors that must move AS ONE (e.g. both ends of a coupled X beam) driven by
 * two independent SPU boards. The two boards are kept in lockstep by sharing the
 * STEP pulses over a wire — not by messages, which are too slow/jittery and would
 * let the beam rack.
 *
 *   LEADER   generates the motion and, for every 1/8 step, ALSO pulses a shared
 *            STEP_ECHO line (and holds DIR_ECHO for the move direction).
 *   FOLLOWER does no motion planning of its own; an interrupt on STEP_ECHO makes
 *            it emit exactly one 1/8 step on its own motor, in the DIR_ECHO
 *            direction. Follower lags the leader by one ISR latency (~µs) — far
 *            below any step interval, so the two motors are effectively locked.
 *
 * Flash the SAME binary to both boards. Role is chosen at boot from a strap pin:
 *   ROLE_STRAP jumpered to GND  -> LEADER
 *   ROLE_STRAP left open        -> FOLLOWER  (internal pull-up reads HIGH)
 *
 * Homing / squaring: each board homes its OWN motor to its OWN endstop,
 * independently. Because each side stops at its own switch, the beam ends up
 * square — this is the whole reason to keep two endstops.
 *
 * This is a bring-up sketch: no heater/spectro/cloud test machinery, blocking
 * moves, conservative speeds. The deeper calibration/repeatability plan lives in
 * Docs/MULTI_SPU_SYNC_PRD.md.
 */

#include "Particle.h"

SYSTEM_MODE(SEMI_AUTOMATIC); // run on the bench without waiting for WiFi/cloud
SYSTEM_THREAD(ENABLED);

// ===================== LOCAL MOTOR PINS (per board) =====================
// Same pins the v72 firmware already uses to drive each board's own stepper,
// so the existing per-board motor wiring is unchanged.
const pin_t PIN_MOTOR_STEP  = D13;
const pin_t PIN_MOTOR_DIR   = D8;
const pin_t PIN_MOTOR_SLEEP = D12;
const pin_t PIN_MOTOR_RESET = D11;
const pin_t PIN_LIMIT       = D26; // this board's own endstop (NC to GND, pull-up)

// ===================== SYNC LINES (wire the two boards together) =========
// Leader OUTPUT -> Follower INPUT for STEP_ECHO and DIR_ECHO.
// ABORT is wired-OR: idle is INPUT_PULLUP (released); a board asserts by driving LOW.
// Don't forget a COMMON GROUND wire between the two boards.
const pin_t PIN_ROLE_STRAP  = D2;  // GND = leader, open = follower
const pin_t PIN_STEP_ECHO   = D14; // leader: OUTPUT pulse; follower: interrupt IN
const pin_t PIN_DIR_ECHO    = D15; // leader: OUTPUT dir;   follower: read in ISR
const pin_t PIN_ABORT       = D16; // wired-OR, active LOW

// ===================== MOTION CONFIG =====================================
// Calibrate MICRONS_PER_EIGHTH_STEP per the PRD before trusting absolute microns.
const long MICRONS_PER_EIGHTH_STEP = 25;    // v72 default; PLACEHOLDER — calibrate
const int  STEP_DELAY_US           = 350;   // half-period of a 1/8 step pulse
const int  HOME_STEP_DELAY_US      = 500;   // slower during homing
const long TRAVEL_LIMIT_UM         = 45000; // soft distal limit
const int  HOME_BACKOFF_UM         = 1000;  // back off this far after touching home

// If the follower motor is mounted mirror-image to the leader, it must turn the
// OPPOSITE way to move the beam the same way. Flip this on the FOLLOWER board only.
const bool FOLLOWER_INVERT_DIR = false;

// Minimum DRV8825-class STEP pulse high time.
const int STEP_PULSE_HIGH_US = 3;

// ===================== STATE ============================================
bool    isLeader      = false;
volatile long position_um = 0;      // this board's position estimate
volatile bool aborted = false;
long    microns_error = 0;          // fractional-step carry (leader only)

// ---------- shared helpers ----------
inline void pulseLocalStep() {
    digitalWrite(PIN_MOTOR_STEP, HIGH);
    delayMicroseconds(STEP_PULSE_HIGH_US);
    digitalWrite(PIN_MOTOR_STEP, LOW);
}

void wakeMotor() {
    digitalWrite(PIN_MOTOR_SLEEP, HIGH);
    delayMicroseconds(2000); // DRV8825 charge-pump settle
}
void sleepMotor() { digitalWrite(PIN_MOTOR_SLEEP, LOW); }

bool abortAsserted() { return digitalRead(PIN_ABORT) == LOW; }

void assertAbort() {
    pinMode(PIN_ABORT, OUTPUT);
    digitalWrite(PIN_ABORT, LOW);
    aborted = true;
}
void releaseAbort() {
    pinMode(PIN_ABORT, INPUT_PULLUP);
    aborted = false;
}

// ===================== FOLLOWER: mirror one step per echo pulse ==========
void onStepEcho() {
    if (aborted) return;
    // Respect our own endstop: if we're driving into it, stop everything.
    bool dirTowardHome = (digitalRead(PIN_DIR_ECHO) == HIGH); // HIGH = toward home (proximal)
    if (FOLLOWER_INVERT_DIR) {
        // Physical direction is inverted, but the endstop meaning is physical:
        // recompute below from the actual dir pin we set.
    }
    bool localDir = dirTowardHome ^ FOLLOWER_INVERT_DIR;
    digitalWrite(PIN_MOTOR_DIR, localDir ? HIGH : LOW);

    if (dirTowardHome && digitalRead(PIN_LIMIT) == LOW) {
        // reached home switch while moving toward it — assert abort to stop the pair
        assertAbort();
        return;
    }
    pulseLocalStep();
    position_um += dirTowardHome ? -MICRONS_PER_EIGHTH_STEP : MICRONS_PER_EIGHTH_STEP;
}

// ===================== LEADER: one 1/8 step, echoed ======================
// dirTowardHome: true = proximal (toward the home endstop), false = distal
bool leaderOneStep(bool dirTowardHome) {
    if (aborted || abortAsserted()) return false;

    if (dirTowardHome) {
        if (digitalRead(PIN_LIMIT) == LOW) { position_um = 0; return false; }
        if (position_um <= 0) { position_um = 0; return false; }
    } else if (position_um >= TRAVEL_LIMIT_UM) {
        return false;
    }

    // Hold direction on both local + echo BEFORE pulsing so the follower's ISR
    // reads a stable direction.
    digitalWrite(PIN_MOTOR_DIR, dirTowardHome ? HIGH : LOW);
    digitalWrite(PIN_DIR_ECHO, dirTowardHome ? HIGH : LOW);

    // Pulse local step and the echo line together.
    digitalWrite(PIN_MOTOR_STEP, HIGH);
    digitalWrite(PIN_STEP_ECHO,  HIGH);
    delayMicroseconds(STEP_PULSE_HIGH_US);
    digitalWrite(PIN_MOTOR_STEP, LOW);
    digitalWrite(PIN_STEP_ECHO,  LOW);

    position_um += dirTowardHome ? -MICRONS_PER_EIGHTH_STEP : MICRONS_PER_EIGHTH_STEP;
    return true;
}

// Leader: move a signed number of microns (negative = toward home), echoing to
// the follower every step.
void leaderMove(long microns, int step_delay_us) {
    if (aborted) { Serial.println("move blocked: aborted"); return; }
    wakeMotor();
    bool dirTowardHome = (microns < 0);
    long abs_um = (microns < 0 ? -microns : microns) + microns_error;
    long eighths = abs_um / MICRONS_PER_EIGHTH_STEP;
    microns_error = abs_um % MICRONS_PER_EIGHTH_STEP;

    for (long i = 0; i < eighths; i++) {
        if (!leaderOneStep(dirTowardHome)) break;
        delayMicroseconds(step_delay_us);
    }
    Serial.printlnf("leader move done, pos=%ld um", position_um);
}

// ===================== HOMING (each board, independently) ================
// Drive our OWN motor toward our OWN endstop, zero, back off, re-approach slow.
// Runs the SAME on leader and follower — the follower detaches its echo ISR
// while it self-homes, then re-attaches.
void homeThisBoard() {
    Serial.println("homing...");
    releaseAbort();
    if (!isLeader) detachInterrupt(PIN_STEP_ECHO);
    wakeMotor();
    digitalWrite(PIN_MOTOR_DIR, HIGH); // toward home

    long guard = (TRAVEL_LIMIT_UM / MICRONS_PER_EIGHTH_STEP) + 400;
    while (digitalRead(PIN_LIMIT) == HIGH && guard-- > 0) {
        pulseLocalStep();
        delayMicroseconds(HOME_STEP_DELAY_US);
    }
    position_um = 0;
    microns_error = 0;

    // back off (distal) then slow re-approach for a repeatable trip point
    digitalWrite(PIN_MOTOR_DIR, LOW);
    long back = HOME_BACKOFF_UM / MICRONS_PER_EIGHTH_STEP;
    for (long i = 0; i < back; i++) { pulseLocalStep(); delayMicroseconds(HOME_STEP_DELAY_US); }
    digitalWrite(PIN_MOTOR_DIR, HIGH);
    guard = (HOME_BACKOFF_UM * 2 / MICRONS_PER_EIGHTH_STEP) + 200;
    while (digitalRead(PIN_LIMIT) == HIGH && guard-- > 0) {
        pulseLocalStep();
        delayMicroseconds(HOME_STEP_DELAY_US * 2);
    }
    position_um = 0;
    microns_error = 0;

    if (!isLeader) attachInterrupt(PIN_STEP_ECHO, onStepEcho, RISING);
    Serial.println("homed (pos=0)");
}

// ===================== SETUP / LOOP =====================================
void setup() {
    Serial.begin(115200);
    waitFor(Serial.isConnected, 8000);

    pinMode(PIN_ROLE_STRAP, INPUT_PULLUP);
    isLeader = (digitalRead(PIN_ROLE_STRAP) == LOW);

    pinMode(PIN_MOTOR_STEP,  OUTPUT); digitalWrite(PIN_MOTOR_STEP, LOW);
    pinMode(PIN_MOTOR_DIR,   OUTPUT); digitalWrite(PIN_MOTOR_DIR, LOW);
    pinMode(PIN_MOTOR_SLEEP, OUTPUT); digitalWrite(PIN_MOTOR_SLEEP, LOW);
    pinMode(PIN_MOTOR_RESET, OUTPUT); digitalWrite(PIN_MOTOR_RESET, HIGH);
    pinMode(PIN_LIMIT, INPUT_PULLUP);

    // high drive on step lines (M-SoM default is 2 mA)
    pinSetDriveStrength(PIN_MOTOR_STEP, DriveStrength::HIGH);

    releaseAbort(); // ABORT idle = INPUT_PULLUP

    if (isLeader) {
        pinMode(PIN_STEP_ECHO, OUTPUT); digitalWrite(PIN_STEP_ECHO, LOW);
        pinMode(PIN_DIR_ECHO,  OUTPUT); digitalWrite(PIN_DIR_ECHO, LOW);
        pinSetDriveStrength(PIN_STEP_ECHO, DriveStrength::HIGH);
        Serial.println("== ROLE: LEADER ==");
        Serial.println("cmds: h=home  m<microns>=move(+distal/-home)  s=status  a=abort  r=release");
    } else {
        pinMode(PIN_STEP_ECHO, INPUT_PULLDOWN);
        pinMode(PIN_DIR_ECHO,  INPUT_PULLDOWN);
        attachInterrupt(PIN_STEP_ECHO, onStepEcho, RISING);
        Serial.println("== ROLE: FOLLOWER == (mirrors leader; local cmds: h=home s=status)");
    }

    homeThisBoard(); // each board squares to its own endstop on boot
}

String rx;
void handleLine(String line) {
    line.trim();
    if (line.length() == 0) return;
    char c = line.charAt(0);
    if (c == 'h') { homeThisBoard(); return; }
    if (c == 's') { Serial.printlnf("pos=%ld um  aborted=%d  role=%s",
                                    position_um, aborted, isLeader ? "L" : "F"); return; }
    if (c == 'a') { assertAbort(); Serial.println("ABORT asserted"); return; }
    if (c == 'r') { releaseAbort(); Serial.println("abort released"); return; }
    if (isLeader && c == 'm') {
        long um = line.substring(1).toInt();
        Serial.printlnf("move %ld um", um);
        leaderMove(um, STEP_DELAY_US);
        return;
    }
    Serial.println("?");
}

void loop() {
    // shared abort watch (either board pulls the line)
    if (!aborted && abortAsserted()) {
        aborted = true;
        Serial.println("ABORT seen (peer) — motion halted");
    }

    while (Serial.available()) {
        char ch = (char)Serial.read();
        if (ch == '\n' || ch == '\r') { handleLine(rx); rx = ""; }
        else rx += ch;
    }
}
