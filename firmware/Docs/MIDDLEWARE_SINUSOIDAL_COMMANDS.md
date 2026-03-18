# Middleware Changes for Sinusoidal BCODE Commands

Firmware v72 adds two new BCODE commands (4 and 5) for sinusoidal stage motion. The middleware must be updated to recognize these commands so assays using them can be compiled and loaded onto devices.

## Error Without These Changes

Loading an assay containing sinusoidal commands will fail with:

```
{"status":"FAILURE","errorMessage":"Cannot read properties of undefined (reading 'params')"}
```

This happens because `getBcodeCommand()` returns `undefined` for unrecognized command names, and then `compileInstruction()` tries to access `.params` on it.

## Changes Required

### 1. Add command definitions to `bcodeCommands` array

Add these two entries to the `bcodeCommands` array (after the existing `OSCILLATE STAGE` entry):

```javascript
{
    num: '4',
    name: 'SINUSOIDAL OSCILLATE',
    params: ['microns', 'period_ms', 'cycles'],
    description: 'Oscillates with sinusoidal velocity profile. Period is full cycle time in milliseconds.'
}, {
    num: '5',
    name: 'SINUSOIDAL MOVE',
    params: ['microns', 'half_period_ms'],
    description: 'Moves stage with sinusoidal velocity profile (one half-stroke). Half_period_ms is time for this move.'
}
```

### 2. Add duration estimates to `instructionTime()`

Add these cases to the `switch (command)` block in `instructionTime()`:

```javascript
case 'SINUSOIDAL OSCILLATE':
    return parseInt(params.period_ms, 10) * parseInt(params.cycles, 10);
case 'SINUSOIDAL MOVE':
    return parseInt(params.half_period_ms, 10);
```

## Assay JSON Format

Once the middleware is updated, assays can use the new commands like this:

```json
{
    "command": "Sinusoidal Oscillate",
    "params": {
        "comment": "Smooth mix sample in well",
        "microns": 3000,
        "period_ms": 500,
        "cycles": 100
    }
}
```

```json
{
    "command": "Sinusoidal Move",
    "params": {
        "comment": "Smooth half-stroke forward",
        "microns": 3000,
        "half_period_ms": 250
    }
}
```

The `comment` field in params is optional and is stripped out during compilation (same as all other commands).

## Compiled BCODE Output

The middleware compiler will produce these BCODE strings:

- Sinusoidal Oscillate: `4,3000,500,100:`
- Sinusoidal Move: `5,3000,250:`

## Parameter Reference

| Command | Param | Description |
|---|---|---|
| Sinusoidal Oscillate | microns | Half-stroke amplitude in microns |
| Sinusoidal Oscillate | period_ms | Time for one full back-and-forth cycle (ms) |
| Sinusoidal Oscillate | cycles | Number of full oscillation cycles |
| Sinusoidal Move | microns | Distance to move (positive = distal, negative = proximal) |
| Sinusoidal Move | half_period_ms | Time for this single half-stroke (ms) |

## How It Works

Unlike the existing square-wave oscillate (cmd 3) which moves at constant speed with instant reversals, the sinusoidal commands produce smooth acceleration/deceleration. The stage position follows a cosine profile, resulting in zero velocity at reversal points and peak velocity at the midpoint of each stroke. The firmware precomputes per-step delays using `acos()` to achieve a true sinusoidal position profile.

A Python simulation tool is available at `firmware/sinusoidal_sim.py` to preview motion profiles before deploying:

```
python sinusoidal_sim.py 3000 250 -c 3
```
