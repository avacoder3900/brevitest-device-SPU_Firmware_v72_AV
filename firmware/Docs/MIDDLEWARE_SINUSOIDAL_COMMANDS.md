# Middleware Changes for Sinusoidal BCODE Commands

Firmware v72 adds two new BCODE commands (4 and 5) for sinusoidal stage motion.

## Error Without These Changes

```
{"status":"FAILURE","errorMessage":"Cannot read properties of undefined (reading 'params')"}
```

## Changes Required

### 1. Add to `bcodeCommands` array (after OSCILLATE STAGE)

```javascript
}, {
    num: '4',
    name: 'SINUSOIDAL OSCILLATE',
    params: ['microns', 'peak_delay_us', 'shape_pct', 'cycles'],
    description: 'Oscillates with sinusoidal velocity profile. peak_delay_us = step delay at peak speed. shape_pct = 100 for pure sine, <100 wider, >100 narrower. Period is derived.'
}, {
    num: '5',
    name: 'SINUSOIDAL MOVE',
    params: ['microns', 'peak_delay_us', 'shape_pct'],
    description: 'One half-stroke with sinusoidal velocity profile. Period is derived from peak_delay and shape.'
}
```

### 2. Add to `instructionTime()` switch

```javascript
case 'SINUSOIDAL OSCILLATE': {
    const microns = Math.abs(parseInt(params.microns, 10));
    const peakDelay = parseInt(params.peak_delay_us, 10);
    const shape = parseInt(params.shape_pct, 10) / 100.0;
    const cycles = parseInt(params.cycles, 10);
    const N = Math.floor(microns / 25);
    let sumInv = 0;
    for (let i = 0; i < N; i++) {
        sumInv += 1.0 / Math.pow(Math.sin(Math.PI * (i + 0.5) / N), shape);
    }
    return Math.floor(peakDelay * sumInv * 2 * cycles / 1000);
}
case 'SINUSOIDAL MOVE': {
    const microns = Math.abs(parseInt(params.microns, 10));
    const peakDelay = parseInt(params.peak_delay_us, 10);
    const shape = parseInt(params.shape_pct, 10) / 100.0;
    const N = Math.floor(microns / 25);
    let sumInv = 0;
    for (let i = 0; i < N; i++) {
        sumInv += 1.0 / Math.pow(Math.sin(Math.PI * (i + 0.5) / N), shape);
    }
    return Math.floor(peakDelay * sumInv / 1000);
}
```

## Assay JSON Format

```json
{
    "command": "Sinusoidal Oscillate",
    "params": {
        "comment": "Smooth mix in well",
        "microns": 3000,
        "peak_delay_us": 500,
        "shape_pct": 100,
        "cycles": 10
    }
}
```

```json
{
    "command": "Sinusoidal Move",
    "params": {
        "comment": "Smooth half-stroke forward",
        "microns": 3000,
        "peak_delay_us": 500,
        "shape_pct": 100
    }
}
```

## Parameter Reference

| Param | Description |
|---|---|
| microns | Half-stroke distance in microns |
| peak_delay_us | Step delay at peak velocity (us). 350 = safe motor limit, 500+ = conservative |
| shape_pct | Shape as percentage. 100 = pure sine, 50 = wider/flatter, 150 = narrower peak |
| cycles | Number of full back-and-forth oscillation cycles |

## How It Works

Velocity vs position follows: `v(x) = v_max * sin(pi * x / D) ^ (shape_pct / 100)`

The period is NOT an input — it is derived from peak_delay and shape. Narrower shapes (>100) produce longer periods because the endpoint steps are slower. Use the simulation tool to preview:

```
python sinusoidal_sim.py 3000 500              # pure sine (shape=1.0)
python sinusoidal_sim.py 3000 500 -s 0.75      # wider peak
python sinusoidal_sim.py 3000 500 --compare    # compare shapes
```
