# PID Temperature Control Tuning Changes

**Date:** March 31, 2026
**Firmware:** v78+
**Status:** Testing on single device

## Problem

Two issues with the PID temperature controller:

### 1. Integral Windup (rare, critical)
In rare situations, the heater temperature would overshoot to ~50°C. Because the aluminum heater block has high thermal mass, it cools very slowly. The integral term had accumulated to an enormous value during heating, and the negative error from the overshoot couldn't unwind it fast enough. The device would stay above target with heater_ready=NO (red light) for extended periods.

### 2. Steady-State Error (constant, minor)
The device consistently sat at 44.7°C instead of the 45.0°C target. The integral gain (Ki = 1/50000) was too low to eliminate the 0.3°C steady-state error in any reasonable time. At error=3 (0.3°C in 10x units), the integral would need ~4.6 hours to contribute just 1 additional unit of output.

## Changes Made

### A. Integral Clamping (anti-windup)
**File:** `brevitest-firmware.ino`, pid_controller()

Added a hard limit on the integral term so its contribution can never exceed the output range (0-255):

```cpp
int max_integral = (HEATER_MAX_POWER * heater.k_i_den) / heater.k_i_num;
heater.integral = limit(heater.integral, max_integral, -max_integral);
```

This prevents the integral from growing to extreme values during long heating ramps or error conditions. The integral is bounded to the range where it produces useful output.

### B. Conditional Integration (anti-windup)
**File:** `brevitest-firmware.ino`, pid_controller()

The integral only accumulates when the PID output is within the actuator range (0-255). When the output is saturated (e.g., full power during initial heating), the integral stays at its current value instead of growing:

```cpp
if (output > 0 && output < HEATER_MAX_POWER) {
    heater.integral += (error * dt) / 1000;
}
```

This prevents the integral from building up "debt" during the heating ramp that has to be unwound later, causing overshoot.

### C. Increased Integral Gain (Ki)
**File:** `brevitest-firmware.h`, HeatingElement constructor

Changed Ki from 1/50000 to 1/10:

```
Before: k_i_num = 1, k_i_den = 50000  → Ki = 0.00002
After:  k_i_num = 1, k_i_den = 10     → Ki = 0.1
```

This 5000x increase allows the integral term to actually eliminate steady-state error within minutes instead of hours/days. The conditional integration (change B) makes this safe — the integral doesn't accumulate during the heating ramp when it would cause windup, only in the fine-control zone near the target temperature.

## Why All Three Changes Together

- **Clamping alone** fixes the overshoot/stuck problem but doesn't improve steady-state accuracy
- **Higher Ki alone** would cause massive overshoot because the integral would grow during the heating ramp
- **Conditional integration alone** prevents ramp windup but doesn't fix steady-state error with the old tiny Ki
- **All three together:** the conditional integration makes higher Ki safe, the higher Ki eliminates steady-state error, and the clamp provides a safety net against any remaining edge cases

## Observed Results (Single Device Test)

### Before changes (Ki = 1/50000, no anti-windup):
```
T = 44.7°C, error = 3, integral = climbing forever, output = 60
Steady-state offset: 0.3°C below target
```

### After changes (Ki = 1/10, conditional integration, clamp):
```
T = 44.8-44.9°C, error = 1-2, integral = slowly climbing toward equilibrium, output = 59-82
Steady-state offset: 0.1-0.2°C below target (still settling)
```

Temperature improved from 44.7 to 44.9 within minutes. Integral is growing at a reasonable rate and output is increasing accordingly. Expected to settle at 45.0°C (error=0) once the integral reaches its equilibrium value (~750).

Minor oscillation observed: temperature briefly touches 45.1°C, causing momentary heater_ready=NO (red LED flash for <1 second). The 5-second debounce on heater_ready prevents this from affecting device operation.

## PID Parameters Summary

| Parameter | Before | After | Units |
|-----------|--------|-------|-------|
| Kp | 80/4 = 20.0 | 80/4 = 20.0 | (unchanged) |
| Ki | 1/50000 = 0.00002 | 1/10 = 0.1 | |
| Kd | 1/5 = 0.2 | 1/5 = 0.2 | (unchanged) |
| Control interval | 1000ms | 1000ms | (unchanged) |
| Integral clamp | none | ±(255 × k_i_den / k_i_num) = ±2550 | |
| Conditional integration | no | yes (only when 0 < output < 255) | |

## Risk Assessment

- **Low risk.** Conditional integration prevents the integral from accumulating during heating ramp. Clamping prevents extreme integral values. The higher Ki only acts in the fine-control zone near target.
- **Worst case:** Small oscillation (±0.1-0.2°C) around target, which is tighter than the previous steady-state offset of 0.3°C.
- **Monitoring:** The integral value is logged in the device flash logs (`int:` field in heater temp entries) and visible via serial command 10. Watch for the integral stabilizing vs continuing to grow.

## Next Steps

1. Monitor this device for several hours to confirm the integral stabilizes
2. Observe behavior through a test cycle (heater off during spectro, back on after)
3. If stable, test across multiple devices in different ambient temperatures
4. Roll out to fleet if results are consistent
