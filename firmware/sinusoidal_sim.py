#!/usr/bin/env python3
"""
Sinusoidal Oscillation Simulator for Brevitest Firmware

Simulates BCODE commands:
  cmd 4: Sinusoidal Oscillate (microns, period_ms, cycles)
  cmd 5: Sinusoidal Move (microns, half_period_ms)

Previews motion profiles before deploying to device.

Usage:
  python sinusoidal_sim.py 1000 500              # 1000um, 500ms half-period
  python sinusoidal_sim.py 1000 500 -c 3          # 3 full oscillation cycles
  python sinusoidal_sim.py 1000 500 --step-table  # print every step delay
  python sinusoidal_sim.py 1000 500 --no-plot     # stats only, no plot
"""

import numpy as np
import matplotlib.pyplot as plt
import argparse
import sys

# Firmware constants (must match brevitest-firmware.h)
MOTOR_MICRONS_PER_EIGHTH_STEP = 25
MOTOR_MINIMUM_STEP_DELAY = 250   # us - firmware clamp
MOTOR_SAFE_STEP_DELAY = 350      # us - practical minimum to avoid skipping


def compute_half_stroke(microns, half_period_ms):
    """
    Compute the sinusoidal motion profile for one half-stroke.

    Position follows: x(t) = D/2 * (1 - cos(pi * t / T))
    Time at step i:   t_i  = T/pi * acos(1 - 2*i/N)
    Step delay:        dt_i = t_{i+1} - t_i   (split into two phases for the stepper)

    Returns dict with all computed arrays, or None if invalid.
    """
    abs_microns = abs(microns)
    N = abs_microns // MOTOR_MICRONS_PER_EIGHTH_STEP

    if N == 0:
        print(f"Error: {abs_microns} microns is less than one step ({MOTOR_MICRONS_PER_EIGHTH_STEP} um)")
        return None

    T_half_us = half_period_ms * 1000.0

    # Compute acos at each step boundary: theta_i = acos(1 - 2i/N)
    fractions = np.arange(N + 1, dtype=float) / N          # 0/N, 1/N, ..., N/N
    thetas = np.arccos(1.0 - 2.0 * fractions)              # 0 to pi

    # Time at each step boundary (microseconds)
    times_us = (T_half_us / np.pi) * thetas                # 0 to T_half

    # Total time per step
    step_times_us = np.diff(times_us)

    # Phase delay = half the step time (stepper does HIGH then LOW)
    phase_delays = (step_times_us / 2.0).astype(int)

    # Clamp to firmware minimum
    clamped_mask = phase_delays < MOTOR_MINIMUM_STEP_DELAY
    phase_delays_clamped = np.maximum(phase_delays, MOTOR_MINIMUM_STEP_DELAY)

    # Recompute actual timing with clamped delays
    actual_step_times_us = phase_delays_clamped * 2.0
    cumulative_time_us = np.concatenate([[0], np.cumsum(actual_step_times_us)])

    # Positions at each step boundary
    positions = np.arange(N + 1) * MOTOR_MICRONS_PER_EIGHTH_STEP

    # Velocity at each step midpoint (microns per millisecond)
    velocities = np.where(
        actual_step_times_us > 0,
        MOTOR_MICRONS_PER_EIGHTH_STEP / (actual_step_times_us / 1000.0),
        0.0
    )

    return {
        "N": N,
        "T_half_us": T_half_us,
        "phase_delays": phase_delays,
        "phase_delays_clamped": phase_delays_clamped,
        "clamped_mask": clamped_mask,
        "step_times_us": step_times_us,
        "actual_step_times_us": actual_step_times_us,
        "cumulative_time_us": cumulative_time_us,
        "positions": positions,
        "velocities": velocities,
        "total_time_us": cumulative_time_us[-1],
        "total_time_ms": cumulative_time_us[-1] / 1000.0,
    }


def print_summary(profile, microns, half_period_ms, cycles):
    """Print summary statistics for the motion profile."""
    print(f"\n{'=' * 64}")
    print(f"  Sinusoidal Motion Profile")
    print(f"{'=' * 64}")
    print(f"  Distance (half-stroke): {abs(microns)} microns")
    print(f"  Total steps:            {profile['N']}  ({MOTOR_MICRONS_PER_EIGHTH_STEP} um/step)")
    print(f"  Requested half-period:  {half_period_ms} ms")
    print(f"  Actual half-period:     {profile['total_time_ms']:.2f} ms")
    print(f"  Requested full period:  {half_period_ms * 2} ms")
    print(f"  Actual full period:     {profile['total_time_ms'] * 2:.2f} ms")
    total_ms = profile["total_time_ms"] * 2 * cycles
    print(f"  Total time ({cycles} cycle{'s' if cycles != 1 else ''}):    {total_ms:.2f} ms ({total_ms / 1000:.3f} s)")
    print()
    print(f"  Min phase delay (computed):  {profile['phase_delays'].min()} us")
    print(f"  Max phase delay (computed):  {profile['phase_delays'].max()} us")
    print(f"  Min phase delay (clamped):   {profile['phase_delays_clamped'].min()} us")
    print(f"  Steps clamped to minimum:    {profile['clamped_mask'].sum()} of {profile['N']}")
    print(f"  Peak velocity:               {profile['velocities'].max():.2f} um/ms")

    # Warnings
    unsafe = (profile["phase_delays"] < MOTOR_SAFE_STEP_DELAY).sum()
    if unsafe > 0:
        print(f"\n  WARNING: {unsafe} steps have phase delay < {MOTOR_SAFE_STEP_DELAY} us")
        print(f"           May cause step skipping on hardware!")

    if profile["clamped_mask"].sum() > 0:
        print(f"\n  WARNING: {profile['clamped_mask'].sum()} steps hit firmware minimum ({MOTOR_MINIMUM_STEP_DELAY} us)")
        print(f"           Waveform will deviate from true sinusoid at peak velocity!")

    time_error = abs(profile["total_time_ms"] - half_period_ms)
    if time_error > 1.0:
        print(f"\n  NOTE: Actual half-period deviates from requested by {time_error:.2f} ms")
        print(f"        (due to integer rounding and/or delay clamping)")

    print(f"{'=' * 64}")


def build_oscillation_arrays(profile, microns, cycles):
    """
    Build full position/time arrays for multi-cycle oscillation plotting.
    Each cycle = forward half-stroke + backward half-stroke.
    """
    N = profile["N"]
    half_times = profile["cumulative_time_us"]   # N+1 points, 0 to T_half
    half_positions = profile["positions"]         # N+1 points, 0 to amplitude

    all_times = []
    all_positions = []
    t_offset = 0.0

    for cycle in range(cycles):
        # Forward half: 0 -> amplitude
        t_fwd = half_times + t_offset
        p_fwd = half_positions.copy()

        # Backward half: amplitude -> 0
        t_bwd = half_times + t_fwd[-1]
        p_bwd = float(abs(microns)) - half_positions

        if cycle == 0 and len(all_times) == 0:
            all_times.append(t_fwd)
            all_positions.append(p_fwd)
        else:
            all_times.append(t_fwd[1:])        # skip duplicate junction point
            all_positions.append(p_fwd[1:])

        all_times.append(t_bwd[1:])
        all_positions.append(p_bwd[1:])

        t_offset = t_bwd[-1]

    return (
        np.concatenate(all_times) / 1000.0,      # convert to ms
        np.concatenate(all_positions),
    )


def plot_profile(profile, microns, half_period_ms, cycles):
    """Plot position, velocity, and step delay profiles."""
    fig, axes = plt.subplots(3, 1, figsize=(12, 10))
    period_ms = half_period_ms * 2
    fig.suptitle(
        f"Sinusoidal Motion Profile: {abs(microns)} um amplitude, "
        f"{period_ms} ms period, {cycles} cycle(s)",
        fontsize=13,
    )

    # --- Position vs Time ---
    time_ms, positions = build_oscillation_arrays(profile, microns, cycles)

    # Ideal sine for comparison
    total_time = time_ms[-1]
    t_ideal = np.linspace(0, total_time, 1000)
    ideal_freq = 1.0 / (profile["total_time_ms"] * 2.0)
    p_ideal = (abs(microns) / 2.0) * (1.0 - np.cos(2.0 * np.pi * ideal_freq * t_ideal))

    axes[0].plot(t_ideal, p_ideal, "b--", linewidth=1, alpha=0.4, label="Ideal sine")
    axes[0].plot(time_ms, positions, "b-", linewidth=2, label="Actual (stepped)")
    axes[0].set_ylabel("Position (um)")
    axes[0].set_title("Position vs Time")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # --- Velocity vs Time (single half-stroke) ---
    step_midtimes = (
        profile["cumulative_time_us"][:-1] + profile["cumulative_time_us"][1:]
    ) / 2000.0  # midpoint of each step, in ms
    axes[1].plot(step_midtimes, profile["velocities"], "r-", linewidth=2)
    axes[1].set_ylabel("Velocity (um/ms)")
    axes[1].set_title("Velocity vs Time (single half-stroke)")
    axes[1].grid(True, alpha=0.3)

    # --- Phase Delay vs Step ---
    steps = np.arange(profile["N"])
    axes[2].plot(steps, profile["phase_delays"], "g-", linewidth=1, alpha=0.5, label="Computed")
    axes[2].plot(steps, profile["phase_delays_clamped"], "g-", linewidth=2, label="Clamped")
    axes[2].axhline(
        y=MOTOR_SAFE_STEP_DELAY, color="orange", linestyle="--",
        label=f"Safe min ({MOTOR_SAFE_STEP_DELAY} us)",
    )
    axes[2].axhline(
        y=MOTOR_MINIMUM_STEP_DELAY, color="red", linestyle="--",
        label=f"Firmware min ({MOTOR_MINIMUM_STEP_DELAY} us)",
    )
    axes[2].set_ylabel("Phase Delay (us)")
    axes[2].set_xlabel("Step Number")
    axes[2].set_title("Step Phase Delay (single half-stroke)")
    axes[2].legend()
    axes[2].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.show()


def print_step_table(profile):
    """Print delay for every step."""
    print(f"\n{'Step':>5} {'Pos(um)':>8} {'Delay(us)':>10} {'Clamped':>8} {'Time(ms)':>10}")
    print("-" * 48)
    for i in range(profile["N"]):
        pos = (i + 1) * MOTOR_MICRONS_PER_EIGHTH_STEP
        flag = "*" if profile["clamped_mask"][i] else ""
        t = profile["cumulative_time_us"][i + 1] / 1000.0
        print(f"{i:5d} {pos:8d} {profile['phase_delays_clamped'][i]:10d} {flag:>8} {t:10.3f}")


def main():
    parser = argparse.ArgumentParser(
        description="Simulate sinusoidal oscillation for Brevitest BCODE commands 4 & 5",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python sinusoidal_sim.py 1000 500             # 1000um, 500ms half-period (1s full cycle)
  python sinusoidal_sim.py 1000 500 -c 3        # 3 full oscillation cycles
  python sinusoidal_sim.py 2000 1000 --no-plot   # just print stats
  python sinusoidal_sim.py 500 250 --step-table  # print every step delay

BCODE usage:
  cmd 4: Sinusoidal Oscillate  ->  4:microns,period_ms,cycles,|
         (period_ms = 2 * half_period_ms)
  cmd 5: Sinusoidal Move       ->  5:microns,half_period_ms,|
        """,
    )

    parser.add_argument("microns", type=int, help="Half-stroke amplitude in microns")
    parser.add_argument("half_period_ms", type=int, help="Time for one half-stroke (ms)")
    parser.add_argument("-c", "--cycles", type=int, default=1, help="Number of full oscillation cycles (default: 1)")
    parser.add_argument("--no-plot", action="store_true", help="Skip plot, just print stats")
    parser.add_argument("--step-table", action="store_true", help="Print delay for every step")

    args = parser.parse_args()

    profile = compute_half_stroke(args.microns, args.half_period_ms)
    if profile is None:
        sys.exit(1)

    print_summary(profile, args.microns, args.half_period_ms, args.cycles)

    if args.step_table:
        print_step_table(profile)

    if not args.no_plot:
        plot_profile(profile, args.microns, args.half_period_ms, args.cycles)


if __name__ == "__main__":
    main()
