#!/usr/bin/env python3
"""
Sinusoidal Oscillation Simulator for Brevitest Firmware

Velocity vs position follows: v(x) = v_max * sin(pi * x / D) ^ shape

Period is DERIVED from the shape and peak speed, not an input.

Inputs:
  microns:    half-stroke distance (fixed by cartridge)
  peak_delay: step delay at peak velocity in microseconds (motor constraint)
  shape:      power on sine (1 = pure sine, >1 = narrower, <1 = wider)

Usage:
  python sinusoidal_sim.py 3000 500              # 3000um, 500us peak delay, shape=1
  python sinusoidal_sim.py 3000 500 -s 2         # narrower peak (sin^2)
  python sinusoidal_sim.py 3000 500 -s 0.5       # wider peak (sqrt sine)
  python sinusoidal_sim.py 3000 500 --compare    # compare shapes side by side
  python sinusoidal_sim.py 3000 350 -s 1         # fastest safe peak speed
"""

import numpy as np
import matplotlib.pyplot as plt
import argparse
import sys

# Firmware constants (must match brevitest-firmware.h)
MOTOR_MICRONS_PER_EIGHTH_STEP = 25
MOTOR_MINIMUM_STEP_DELAY = 250   # us - firmware clamp
MOTOR_SAFE_STEP_DELAY = 350      # us - practical minimum to avoid skipping
DEFAULT_CYCLES_TO_PLOT = 2


def compute_half_stroke(microns, peak_delay_us, shape=1.0):
    """
    Compute the motion profile for one half-stroke.

    Velocity vs position: v(x) = v_max * sin(pi * x / D) ^ shape
    v_max is set by peak_delay_us (the step delay at the midpoint).
    Period is derived from the resulting step delays.

    Returns dict with all computed arrays, or None if invalid.
    """
    abs_microns = abs(microns)
    N = abs_microns // MOTOR_MICRONS_PER_EIGHTH_STEP

    if N == 0:
        print(f"Error: {abs_microns} microns is less than one step ({MOTOR_MICRONS_PER_EIGHTH_STEP} um)")
        return None

    # v_max is determined by peak_delay: at midpoint, sin=1, so
    #   peak_delay = step_size / (2 * v_max)
    #   v_max = step_size / (2 * peak_delay)
    v_max = MOTOR_MICRONS_PER_EIGHTH_STEP / (2.0 * peak_delay_us)  # um/us

    # Velocity shape at midpoint of each step
    midpoints = (np.arange(N, dtype=float) + 0.5) / N
    sin_values = np.sin(np.pi * midpoints) ** shape

    # Step times: dt_i = step_size / (v_max * sin_i^shape)
    step_times_us = MOTOR_MICRONS_PER_EIGHTH_STEP / (v_max * sin_values)

    # Phase delay = half the step time
    phase_delays = (step_times_us / 2.0).astype(int)

    # Clamp to firmware minimum
    clamped_mask = phase_delays < MOTOR_MINIMUM_STEP_DELAY
    phase_delays_clamped = np.maximum(phase_delays, MOTOR_MINIMUM_STEP_DELAY)

    # Actual timing with clamped delays
    actual_step_times_us = phase_delays_clamped * 2.0
    cumulative_time_us = np.concatenate([[0], np.cumsum(actual_step_times_us)])

    # Positions at each step boundary
    positions = np.arange(N + 1) * MOTOR_MICRONS_PER_EIGHTH_STEP

    # Actual velocity at each step (um/ms)
    velocities = MOTOR_MICRONS_PER_EIGHTH_STEP / (actual_step_times_us / 1000.0)

    # Derived period
    half_period_us = cumulative_time_us[-1]
    full_period_us = half_period_us * 2.0

    return {
        "N": N,
        "shape": shape,
        "peak_delay_us": peak_delay_us,
        "v_max_um_per_us": v_max,
        "v_max_um_per_ms": v_max * 1000.0,
        "phase_delays": phase_delays,
        "phase_delays_clamped": phase_delays_clamped,
        "clamped_mask": clamped_mask,
        "step_times_us": step_times_us,
        "actual_step_times_us": actual_step_times_us,
        "cumulative_time_us": cumulative_time_us,
        "positions": positions,
        "velocities": velocities,
        "half_period_us": half_period_us,
        "half_period_ms": half_period_us / 1000.0,
        "full_period_ms": full_period_us / 1000.0,
    }


def print_summary(profile, microns, cycles):
    """Print summary statistics for the motion profile."""
    print(f"\n{'=' * 64}")
    print(f"  Sinusoidal Velocity Profile")
    print(f"{'=' * 64}")
    print(f"  Distance (half-stroke): {abs(microns)} microns")
    print(f"  Total steps:            {profile['N']}  ({MOTOR_MICRONS_PER_EIGHTH_STEP} um/step)")
    s = profile["shape"]
    print(f"  Shape:                  {s}  ", end="")
    if s < 1:
        print("(wider than sine)")
    elif s == 1:
        print("(pure sine velocity)")
    elif s <= 2:
        print("(narrower than sine)")
    elif s <= 4:
        print("(narrow peak)")
    else:
        print("(very narrow peak)")
    print(f"  Peak delay:             {profile['peak_delay_us']} us")
    print(f"  Peak velocity:          {profile['v_max_um_per_ms']:.2f} um/ms")
    print()
    print(f"  --- DERIVED TIMING ---")
    print(f"  Half-period:            {profile['half_period_ms']:.2f} ms")
    print(f"  Full period:            {profile['full_period_ms']:.2f} ms")
    total_ms = profile["full_period_ms"] * cycles
    print(f"  Total time ({cycles} cycle{'s' if cycles != 1 else ''}):    {total_ms:.2f} ms ({total_ms / 1000:.3f} s)")
    freq = 1000.0 / profile["full_period_ms"] if profile["full_period_ms"] > 0 else 0
    print(f"  Frequency:              {freq:.2f} Hz")
    print()
    print(f"  Min phase delay:        {profile['phase_delays'].min()} us")
    print(f"  Max phase delay:        {profile['phase_delays'].max()} us")
    vel_ratio = profile["velocities"].max() / max(profile["velocities"].min(), 0.001)
    print(f"  Velocity ratio:         {vel_ratio:.1f}x (max/min)")
    print(f"  Steps clamped:          {profile['clamped_mask'].sum()} of {profile['N']}")

    # Warnings
    if profile["peak_delay_us"] < MOTOR_SAFE_STEP_DELAY:
        print(f"\n  WARNING: Peak delay {profile['peak_delay_us']} us < safe minimum {MOTOR_SAFE_STEP_DELAY} us")
        print(f"           May cause step skipping at peak velocity!")

    if profile["clamped_mask"].sum() > 0:
        print(f"\n  WARNING: {profile['clamped_mask'].sum()} steps hit firmware minimum ({MOTOR_MINIMUM_STEP_DELAY} us)")

    print(f"{'=' * 64}")


def build_oscillation_arrays(profile, microns, cycles):
    """Build full position/time arrays for multi-cycle oscillation."""
    half_times = profile["cumulative_time_us"]
    half_positions = profile["positions"]

    all_times = []
    all_positions = []
    t_offset = 0.0

    for cycle in range(cycles):
        t_fwd = half_times + t_offset
        p_fwd = half_positions.copy()

        t_bwd = half_times + t_fwd[-1]
        p_bwd = float(abs(microns)) - half_positions

        if cycle == 0 and len(all_times) == 0:
            all_times.append(t_fwd)
            all_positions.append(p_fwd)
        else:
            all_times.append(t_fwd[1:])
            all_positions.append(p_fwd[1:])

        all_times.append(t_bwd[1:])
        all_positions.append(p_bwd[1:])

        t_offset = t_bwd[-1]

    return (
        np.concatenate(all_times) / 1000.0,
        np.concatenate(all_positions),
    )


def build_velocity_vs_time(profile, cycles):
    """Build velocity vs time arrays for multi-cycle plotting."""
    N = profile["N"]
    half_midtimes = (profile["cumulative_time_us"][:-1] + profile["cumulative_time_us"][1:]) / 2.0
    half_vels = profile["velocities"]
    half_period = profile["half_period_us"]

    all_times = []
    all_vels = []
    t_offset = 0.0

    for cycle in range(cycles):
        # Forward half: positive velocity
        all_times.append(half_midtimes + t_offset)
        all_vels.append(half_vels.copy())
        t_offset += half_period

        # Backward half: same speed profile (show magnitude)
        all_times.append(half_midtimes + t_offset)
        all_vels.append(half_vels[::-1].copy())
        t_offset += half_period

    return (
        np.concatenate(all_times) / 1000.0,
        np.concatenate(all_vels),
    )


def plot_profile(profile, microns, cycles):
    """Plot position, velocity vs time, step delay, and velocity vs position."""
    fig, axes = plt.subplots(4, 1, figsize=(12, 13))
    fig.suptitle(
        f"{abs(microns)} um | peak={profile['peak_delay_us']}us | "
        f"shape={profile['shape']} | period={profile['full_period_ms']:.0f}ms | "
        f"{cycles} cycles",
        fontsize=12, y=0.995,
    )

    # --- Position vs Time (multi-cycle) ---
    time_ms, positions = build_oscillation_arrays(profile, microns, cycles)
    axes[0].plot(time_ms, positions, "b-", linewidth=1.5)
    axes[0].set_ylabel("Position (um)")
    axes[0].set_xlabel("Time (ms)")
    axes[0].grid(True, alpha=0.3)

    # --- Velocity vs Time (multi-cycle) ---
    vel_time, vel_vals = build_velocity_vs_time(profile, cycles)
    axes[1].plot(vel_time, vel_vals, "r-", linewidth=1.5)
    axes[1].set_ylabel("Velocity (um/ms)")
    axes[1].set_xlabel("Time (ms)")
    axes[1].grid(True, alpha=0.3)

    # --- Phase Delay vs Step (single half-stroke) ---
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
    axes[2].legend(fontsize=8)
    axes[2].grid(True, alpha=0.3)

    # --- Velocity vs Cumulative Distance (multi-cycle, unfolded) ---
    D = abs(microns)
    step_midpositions = (profile["positions"][:-1] + profile["positions"][1:]) / 2.0

    all_pos = []
    all_vel = []
    ideal_pos = []
    ideal_vel = []
    offset = 0.0
    x_one = np.linspace(0, D, 250)
    v_one = profile["v_max_um_per_ms"] * np.sin(np.pi * x_one / D) ** profile["shape"]

    for cycle in range(cycles):
        # Forward half-stroke: positive velocity
        all_pos.append(step_midpositions + offset)
        all_vel.append(profile["velocities"])
        ideal_pos.append(x_one + offset)
        ideal_vel.append(v_one)
        offset += D

        # Backward half-stroke: negative velocity
        all_pos.append(step_midpositions + offset)
        all_vel.append(-profile["velocities"][::-1])
        ideal_pos.append(x_one + offset)
        ideal_vel.append(-v_one[::-1])
        offset += D

    all_pos = np.concatenate(all_pos)
    all_vel = np.concatenate(all_vel)
    ideal_pos = np.concatenate(ideal_pos)
    ideal_vel = np.concatenate(ideal_vel)

    axes[3].plot(ideal_pos, ideal_vel, "m--", linewidth=1.5, alpha=0.6, label="Ideal sine" + (f"^{profile['shape']}" if profile['shape'] != 1 else ""))
    axes[3].plot(all_pos, all_vel, "m-", linewidth=1.5, alpha=0.7, label=f"Actual ({cycles} cycles)")
    axes[3].set_ylabel("Velocity (um/ms)")
    axes[3].set_xlabel("Cumulative Distance (um)")
    axes[3].legend(fontsize=8)
    axes[3].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.show()


def plot_compare(microns, peak_delay_us, shapes):
    """Compare multiple shape values side by side."""
    fig, axes = plt.subplots(4, 1, figsize=(14, 14))
    fig.suptitle(
        f"Shape Comparison: {abs(microns)} um | peak_delay={peak_delay_us} us",
        fontsize=13, y=0.995,
    )

    colors = plt.cm.viridis(np.linspace(0.15, 0.85, len(shapes)))
    D = abs(microns)
    cycles = DEFAULT_CYCLES_TO_PLOT

    for shape, color in zip(shapes, colors):
        profile = compute_half_stroke(microns, peak_delay_us, shape)
        if profile is None:
            continue

        label = f"s={shape} ({profile['full_period_ms']:.0f}ms)"

        # Position vs time (4 cycles)
        time_ms, positions = build_oscillation_arrays(profile, microns, cycles)
        axes[0].plot(time_ms, positions, linewidth=1.5, color=color, label=label)

        # Velocity vs time (4 cycles)
        vel_time, vel_vals = build_velocity_vs_time(profile, cycles)
        axes[1].plot(vel_time, vel_vals, linewidth=1.5, color=color, label=label)

        # Phase delay vs step (single half-stroke)
        steps = np.arange(profile["N"])
        axes[2].plot(steps, profile["phase_delays_clamped"], linewidth=2, color=color, label=label)

        # Velocity vs position (actual + ideal dashed)
        step_midpositions = (profile["positions"][:-1] + profile["positions"][1:]) / 2.0
        axes[3].plot(step_midpositions, profile["velocities"], linewidth=2, color=color, label=label)
        x_ideal = np.linspace(0, D, 500)
        v_ideal = profile["v_max_um_per_ms"] * np.sin(np.pi * x_ideal / D) ** shape
        axes[3].plot(x_ideal, v_ideal, "--", linewidth=1, alpha=0.4, color=color)

    axes[0].set_ylabel("Position (um)")
    axes[0].set_xlabel("Time (ms)")
    axes[0].legend(fontsize=8)
    axes[0].grid(True, alpha=0.3)

    axes[1].set_ylabel("Velocity (um/ms)")
    axes[1].set_xlabel("Time (ms)")
    axes[1].legend(fontsize=8)
    axes[1].grid(True, alpha=0.3)

    axes[2].axhline(y=MOTOR_SAFE_STEP_DELAY, color="orange", linestyle="--", alpha=0.5, label=f"Safe min ({MOTOR_SAFE_STEP_DELAY} us)")
    axes[2].axhline(y=MOTOR_MINIMUM_STEP_DELAY, color="red", linestyle="--", alpha=0.5, label=f"Firmware min ({MOTOR_MINIMUM_STEP_DELAY} us)")
    axes[2].set_ylabel("Phase Delay (us)")
    axes[2].set_xlabel("Step Number")
    axes[2].legend(fontsize=8)
    axes[2].grid(True, alpha=0.3)

    axes[3].set_ylabel("Velocity (um/ms)")
    axes[3].set_xlabel("Position (um)")
    axes[3].legend(fontsize=8)
    axes[3].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.show()


def print_step_table(profile):
    """Print delay for every step."""
    print(f"\n{'Step':>5} {'Pos(um)':>8} {'Delay(us)':>10} {'Vel(um/ms)':>11} {'Clamped':>8} {'Time(ms)':>10}")
    print("-" * 60)
    for i in range(profile["N"]):
        pos = (i + 1) * MOTOR_MICRONS_PER_EIGHTH_STEP
        flag = "*" if profile["clamped_mask"][i] else ""
        t = profile["cumulative_time_us"][i + 1] / 1000.0
        v = profile["velocities"][i]
        print(f"{i:5d} {pos:8d} {profile['phase_delays_clamped'][i]:10d} {v:11.2f} {flag:>8} {t:10.3f}")


def main():
    parser = argparse.ArgumentParser(
        description="Simulate sinusoidal oscillation for Brevitest firmware",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python sinusoidal_sim.py 3000 500              # pure sine, 500us peak delay
  python sinusoidal_sim.py 3000 500 -s 2         # narrower peak (sin^2)
  python sinusoidal_sim.py 3000 500 -s 0.5       # wider/flatter peak
  python sinusoidal_sim.py 3000 350              # fastest safe peak speed
  python sinusoidal_sim.py 3000 500 --compare    # compare shapes side by side

Inputs:
  microns:    half-stroke distance (fixed by cartridge)
  peak_delay: step delay at peak velocity in microseconds
              (350 = safe motor limit, 500+ = conservative)

  shape:      power on sine velocity curve
              0.5 = wider/flatter than sine
              1   = pure sine (default)
              2   = narrower peak, longer period
              3   = narrow peak, much longer period

Output:
  Period is DERIVED from shape and peak speed.
  Narrower shapes = slower endpoints = longer period.
        """,
    )

    parser.add_argument("microns", type=int, help="Half-stroke distance in microns")
    parser.add_argument("peak_delay", type=int, help="Step delay at peak velocity (us)")
    parser.add_argument("-s", "--shape", type=float, default=1.0, help="Power on sine (default: 1.0)")
    parser.add_argument("-c", "--cycles", type=int, default=DEFAULT_CYCLES_TO_PLOT, help=f"Cycles to plot (default: {DEFAULT_CYCLES_TO_PLOT})")
    parser.add_argument("--compare", action="store_true", help="Compare shapes side by side")
    parser.add_argument("--no-plot", action="store_true", help="Skip plot, just print stats")
    parser.add_argument("--step-table", action="store_true", help="Print delay for every step")

    args = parser.parse_args()

    if args.compare:
        shapes = [0.5, 0.75, 1.0, 1.5, 2.0]
        print(f"\nComparing shapes: {shapes}")
        print(f"  {args.microns} um, peak_delay={args.peak_delay} us\n")
        for s in shapes:
            p = compute_half_stroke(args.microns, args.peak_delay, s)
            if p:
                print(f"  shape={s:<4}:  period={p['full_period_ms']:8.0f} ms  "
                      f"({1000/p['full_period_ms']:5.2f} Hz)  "
                      f"max_delay={p['phase_delays'].max():8d} us  "
                      f"clamped={p['clamped_mask'].sum()}/{p['N']}")
        plot_compare(args.microns, args.peak_delay, shapes)
        return

    profile = compute_half_stroke(args.microns, args.peak_delay, args.shape)
    if profile is None:
        sys.exit(1)

    print_summary(profile, args.microns, args.cycles)

    if args.step_table:
        print_step_table(profile)

    if not args.no_plot:
        plot_profile(profile, args.microns, args.cycles)


if __name__ == "__main__":
    main()
