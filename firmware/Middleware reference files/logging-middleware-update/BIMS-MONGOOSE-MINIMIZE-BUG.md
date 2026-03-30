# Bug: Mongoose `minimize` Stripping Empty `params` from Assay BCODE

## Problem

When assays are created or synced into MongoDB through the BIMS, Mongoose silently strips empty objects like `params: {}` from BCODE commands. This causes the Lambda middleware's BCODE compiler to crash with `Cannot convert undefined or null to object` when it tries to compile the assay for a device.

## Example

Assay `AB024599` ("Bait Assay COPY") in CouchDB (research side):
```json
{
  "command": "Start Test",
  "params": {}
}
```

Same assay in MongoDB after BIMS sync/creation:
```json
{
  "command": "Start Test"
}
```

The `params: {}` field is gone. Commands with actual params (like `Move Microns` with `microns`, `step_delay_us`) are unaffected because they have content.

## Root Cause

Mongoose has a `minimize` option that defaults to `true`. When `minimize: true`, Mongoose removes empty objects from documents before saving to MongoDB. An empty `params: {}` gets stripped because it has no keys.

From the Mongoose docs: "Mongoose will, by default, minimize schemas by removing empty objects. This behavior can be overridden by setting minimize option to false."

## Impact

Any assay with parameterless BCODE commands (`Start Test`, `Finish Test`, `Repeat` wrapper, `Comment`) will have their `params: {}` stripped when saved through Mongoose. When the Lambda middleware tries to compile the BCODE, `compileInstruction(cmd, bcode.params)` receives `undefined` instead of `{}`, and `Object.keys(undefined)` throws.

This affects:
- Assays created directly in the BIMS
- Assays synced/migrated from CouchDB to MongoDB
- Any assay copy operations that go through Mongoose

## Fix

On the AssayDefinition schema (or whatever schema stores assay documents with BCODE), set `minimize: false`:

```typescript
const AssayDefinitionSchema = new Schema({
    // ... fields ...
}, {
    minimize: false,   // <-- ADD THIS: preserve empty objects like params: {}
    collection: 'assay_definitions'
});
```

This tells Mongoose to keep empty objects as-is instead of stripping them.

## Middleware Defensive Fix (Already Applied)

The Lambda middleware has been patched to handle missing params gracefully:

```javascript
// Before:
return compiledCode + compileInstruction(cmd, bcode.params);

// After:
return compiledCode + compileInstruction(cmd, bcode.params || {});
```

This prevents the crash regardless of whether `params` is present. But the Mongoose fix should still be applied to preserve data integrity — other code that reads assay BCODE may also expect `params` to exist.

## Verification

After applying the schema fix, re-save an affected assay and verify that `params: {}` is preserved in MongoDB:

```javascript
const assay = await AssayDefinition.findById('AB024599').lean();
console.log(assay.BCODE.code[0]);
// Should show: { command: "Start Test", params: {} }
// Not:         { command: "Start Test" }
```

Existing assays already in MongoDB will need to be re-saved (or a migration script run) to restore the stripped `params: {}` fields.
