# Brevitest Idempotency Implementation Guide

## 1. Log Analysis: What Went Wrong

### The Error Sequence

```
Device publishes:  {"requestId":"...-1328210-0","uuid":"c5e0083f-..."}
Middleware returns: {"status":"FAILURE","errorMessage":"assay is not defined"}
Device receives:    3 copies of the same FAILURE response
```

### Root Cause: Three Bugs Working Together

#### Bug 1: Middleware `ReferenceError` in Idempotency Check

The error `"assay is not defined"` is a **JavaScript `ReferenceError`**, not a business logic error. In the original (non-idempotent) middleware, the validation flow is:

```javascript
// Original flow (works):
const cartridge = await loadCartridgeById(cartridgeId);
if (cartridge.used) throw new Error('already used');        // ← status checks
if (cartridge.status !== 'linked') throw new Error('not linked');
const assay = await loadDocumentById(assayId, ...);         // ← assay loaded HERE
const checksum = util.checksum(bcodeCompile(assay.BCODE.code));
```

The idempotency modification likely added a check before the assay is loaded:

```javascript
// Probable buggy idempotency addition:
const cartridge = await loadCartridgeById(cartridgeId);

// ❌ IDEMPOTENCY CHECK INSERTED HERE - BUT assay ISN'T LOADED YET
if (cartridge.status === 'underway') {
    // Trying to return cached result for an already-in-progress validation
    const checksum = util.checksum(bcodeCompile(assay.BCODE.code));  // 💥 ReferenceError!
    response = await send_response(..., 'SUCCESS', { cartridgeId, assayId, checksum });
    return response;
}

if (cartridge.used) throw new Error('already used');
// ... rest of validation
const assay = await loadDocumentById(assayId, ...);  // ← too late, already crashed
```

The fix must load the assay **before** referencing it in the idempotency path.

#### Bug 2: Middleware Never Returns `requestId`

The firmware generates a `requestId` and includes it in the publish payload:
```cpp
// Firmware sends:
validation_request_id = device_id + "-" + millis() + "-" + retry_count;
data.set("requestId", validation_request_id);
```

But the middleware's `send_response()` function **never echoes it back**:
```javascript
// Middleware send_response():
response.body = JSON.stringify({
    status,          // ← only status
    ...data          // ← only { cartridgeId, assayId, checksum } or { errorMessage }
});
// requestId is NEVER included in any response path
```

This means the firmware's request ID correlation logic at line ~2218-2256 can **never** match. The log confirms:
```
WARN: Response missing both request ID and cartridgeId - may be from old request
```

This warning fires every single time because no response will ever contain a requestId.

#### Bug 3: FAILURE Responses Don't Include `cartridgeId`

Looking at the two response paths in the middleware:

| Path | Payload | Contains `cartridgeId`? | Contains `requestId`? |
|------|---------|------------------------|----------------------|
| SUCCESS | `{ cartridgeId, assayId, checksum }` | Yes | No |
| FAILURE | `{ errorMessage: error.message }` | No | No |

When validation fails, the firmware has **no way to correlate the response** to the request. It can't match by requestId (never returned) or by cartridgeId (not in FAILURE responses). The firmware falls through to the "missing both" warning and processes the response anyway - this is a silent correctness bug that happens to work by coincidence (because the device only has one outstanding validation at a time).

### Additional Observation: Triple Response Delivery

The Particle event system delivered the webhook response **3 times**:
```
0001332133 [app] INFO: Validation response received...  ← Processed (first)
0001332280 [app] INFO: Validation response received...  ← Ignored (stale - mode changed to ERROR_STATE)
0001332307 [app] INFO: Validation response received...  ← Ignored (stale - mode changed to ERROR_STATE)
```

The firmware's mode-check guard handled this correctly. However, this confirms that **Particle's event system has at-least-once delivery** and idempotency is critical on both sides.

---

## 2. The Real Scenario That Requires Idempotency

The most dangerous scenario isn't the bug above - it's what happens when validation **succeeds on the middleware but the response is lost**:

```
Timeline:
1. Device publishes validate-cartridge with UUID X
2. Middleware receives request
3. Middleware marks cartridge as used=true, status='underway' in CouchDB ← SIDE EFFECT COMMITTED
4. Middleware sends SUCCESS response
5. Response is lost (network issue, Particle cloud hiccup, device offline momentarily)
6. Device times out after 45 seconds
7. Device retries validation with same UUID X
8. Middleware receives retry request
9. Middleware loads cartridge: used=true ← BOOM: "Cartridge already used"
   OR: status='underway' ← BOOM: "Cartridge is not linked"
10. Device gets FAILURE, cartridge is permanently stuck
```

**Without idempotency**: The cartridge is bricked. The side effect (marking as underway) persists, but the device never got the response it needs to proceed with the test. The user has to manually reset the cartridge via `reset_cartridge`.

**With proper idempotency**: Step 9 recognizes this is a retry for an in-progress validation and returns the same SUCCESS response with the assay data.

---

## 3. Correct Idempotency Implementation

### 3.1 Middleware: `validate_cartridge` (The Critical Fix)

```javascript
const validate_cartridge = async (device, body) => {
    let response;
    try {
        const data = JSON.parse(body.data);
        const cartridgeId = data?.uuid ?? '';
        const requestId = data?.requestId ?? '';  // ← EXTRACT REQUEST ID

        if (!cartridgeId) {
            throw new Error('FAILURE: Cartridge ID is missing.');
        }

        const today = new Date();
        const cartridge = await loadCartridgeById(cartridgeId);

        if (!cartridge) {
            throw new Error(`Cartridge ${cartridgeId} missing, may be deleted`);
        }

        // ══════════════════════════════════════════════
        // IDEMPOTENCY CHECK - Must come BEFORE status validation
        // If cartridge is already 'underway' for THIS device, this is a retry
        // ══════════════════════════════════════════════
        if (cartridge.status === 'underway' &&
            cartridge.used === true &&
            cartridge.device?.id === device.id) {

            console.log(`Idempotent retry detected for cartridge ${cartridgeId} on device ${device.id}`);

            // Load the assay BEFORE referencing it (this was the original bug)
            const assayId = cartridge.assayId;
            const assay = await loadDocumentById(
                assayId,
                cartridge.siteId === 'research' ? 'research' : 'admin'
            );

            if (!assay) {
                throw new Error(`Error reading assay ${assayId} during idempotent retry`);
            }

            // Return the same SUCCESS response the original request would have returned
            const checksum = util.checksum(bcodeCompile(assay.BCODE.code));
            response = await send_response(
                device.id,
                'validate-cartridge',
                'SUCCESS',
                { cartridgeId, assayId, checksum, requestId }  // ← ECHO REQUEST ID
            );
            return response;
        }

        // ══════════════════════════════════════════════
        // NORMAL VALIDATION (first-time request)
        // ══════════════════════════════════════════════
        if (cartridge.used) {
            throw new Error(`Cartridge ${cartridgeId} already used`);
        } else if (new Date(cartridge.expirationDate) < today) {
            throw new Error(`Cartridge ${cartridgeId} is expired`);
        } else if (cartridge.status !== 'linked') {
            throw new Error(`Cartridge ${cartridgeId} is not linked`);
        }

        const assayId = cartridge.assayId;
        const assay = await loadDocumentById(
            assayId,
            cartridge.siteId === 'research' ? 'research' : 'admin'
        );
        if (!assay) {
            throw new Error(`Error reading assay ${assayId}`);
        }

        const when = new Date().toISOString();
        const who = 'brevitest-cloud';
        const where = { city_name: 'Houston' };
        cartridge.device = device;
        cartridge.assay = assay;
        cartridge.assay.duration = parseInt(bcodeDuration(assay.BCODE.code) / 1000, 10);
        cartridge.status = 'underway';
        cartridge.used = true;
        cartridge.checkpoints.underway = { when, who, where };
        cartridge.statusUpdatedOn = when;
        await saveDocument(cartridge, cartridge.siteId);

        const checksum = util.checksum(bcodeCompile(assay.BCODE.code));
        response = await send_response(
            device.id,
            'validate-cartridge',
            'SUCCESS',
            { cartridgeId, assayId, checksum, requestId }  // ← ECHO REQUEST ID
        );
    } catch (error) {
        const requestId = (() => {
            try { return JSON.parse(body.data)?.requestId ?? ''; } catch { return ''; }
        })();

        if (error.message) {
            response = await send_response(
                device.id,
                'validate-cartridge',
                'FAILURE',
                { errorMessage: error.message, cartridgeId: data?.uuid, requestId }  // ← INCLUDE BOTH
            );
        } else {
            response = await send_response(
                device.id,
                'validate-cartridge',
                'ERROR',
                { errorMessage: error, cartridgeId: data?.uuid, requestId }
            );
        }
    }
    return response;
};
```

### Key Points of the Fix

1. **Idempotency check comes after `loadCartridgeById` but before status validation** - the cartridge document must be loaded first so we can inspect its current state
2. **Assay is loaded inside the idempotency branch** - fixes the `ReferenceError`
3. **Device ID is checked** - prevents a different device from claiming another device's in-progress validation
4. **`requestId` is echoed in ALL response paths** (SUCCESS, FAILURE, ERROR) - enables firmware correlation
5. **`cartridgeId` is included in FAILURE/ERROR paths** - enables fallback correlation

### 3.2 Middleware: `test_upload` Idempotency

The original `test_upload` has the same class of problem. On retry:
1. The device re-sends the binary test payload
2. The middleware parses it, loads the cartridge from CouchDB
3. The cartridge is already `status: 'completed'` from the first (successful) upload
4. The code proceeds to overwrite `cartridge.rawData`, re-run `evaluate()`, and re-save
5. This is **silently non-idempotent** - it works but wastes compute and risks CouchDB `_rev` conflicts

If the idempotency check was added the same way as `validate_cartridge` (referencing a variable
before it's defined), it will crash the same way. Here's the correct full implementation:

```javascript
const test_upload = async (device, body) => {
    let response;
    try {
        const result = parsePayload(body);
        if (!result.cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID uploaded in device ${device.id} is missing.`);
        }

        const cartridgeId = result.cartridgeId;  // ← Save before delete
        const cartridge = await loadCartridgeById(result.cartridgeId);
        delete result.cartridgeId;

        if (!cartridge) {
            throw new Error(`Cartridge ${cartridgeId} missing, may be deleted`);
        }

        // ══════════════════════════════════════════════
        // IDEMPOTENCY CHECK - Detect duplicate upload
        // If cartridge already has results from THIS device, return cached status
        // ══════════════════════════════════════════════
        if ((cartridge.status === 'completed' || cartridge.status === 'cancelled') &&
            cartridge.rawData &&
            cartridge.device?.id === device.id) {

            console.log(`Idempotent retry detected for test upload: cartridge ${cartridge._id}, status: ${cartridge.status}`);

            // Return the same response type the original upload would have returned
            // Check validationErrors to return INVALID vs SUCCESS (same logic as original)
            if (cartridge.validationErrors && cartridge.validationErrors.length > 0) {
                response = await send_response(
                    device.id,
                    'upload-test',
                    'INVALID',
                    { cartridgeId: cartridge._id }
                );
            } else {
                response = await send_response(
                    device.id,
                    'upload-test',
                    'SUCCESS',
                    { cartridgeId: cartridge._id }
                );
            }
            return response;
        }

        // ══════════════════════════════════════════════
        // NORMAL UPLOAD (first-time request)
        // ══════════════════════════════════════════════
        const when = new Date().toISOString();
        const who = 'brevitest-cloud';
        const where = cartridge.checkpoints.underway && cartridge.checkpoints.underway.where;
        cartridge.statusUpdatedOn = when;
        cartridge.status = result.numberOfReadings === 0 ? 'cancelled' : 'completed';
        cartridge.rawData = result;
        cartridge.day = Math.round(cartridge.hour / 24);
        cartridge.checkpoints.completed = { when, who, where };
        cartridge.validationErrors = [];
        if (cartridge.siteId !== 'research') {
            cartridge.hour = util.calculateCartridgeHours(cartridge);
            cartridge.checkpoints.completed = { when, who, where };
            cartridge.validationErrors = [];
            const recalc = evaluate(cartridge);
            if (recalc) {
                const mutatedAttrs = Object.keys(recalc).filter((attr) => mutableAttrs.includes(attr));
                mutatedAttrs.forEach((attr) => (cartridge[attr] = recalc[attr]));
            }
        }
        const updatedCartridge = await saveDocument(cartridge, cartridge.siteId || cartridge.department);
        if (updatedCartridge.validationErrors && updatedCartridge.validationErrors.length > 0) {
            response = await send_response(device.id, 'upload-test', 'INVALID', { cartridgeId: cartridge._id });
        } else {
            response = await send_response(device.id, 'upload-test', 'SUCCESS', { cartridgeId: cartridge._id });
        }
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'upload-test', 'FAILURE', { errorMessage: error.message });
        } else {
            response = await send_response(device.id, 'upload-test', 'ERROR', { errorMessage: error });
        }
    }
    return response;
};
```

**Key differences from the buggy approach:**
- The idempotency check comes **after** `loadCartridgeById()` so the cartridge document is available
- It checks `cartridge.rawData` exists (proof that data was actually saved, not just status changed)
- It checks `cartridge.device?.id === device.id` to prevent cross-device conflicts
- It re-derives the response type (INVALID vs SUCCESS) from the already-saved `validationErrors`
- It does **not** reference `result`, `evaluate()`, `recalc`, or any other locally-scoped variable from the normal path

### 3.3 Middleware: `send_response` Update

No changes needed to `send_response` itself - it already spreads `...data` into the body. By including `requestId` in the `data` parameter at each call site, it will automatically be included in the response JSON.

### 3.4 Middleware: `reset_cartridge` Idempotency

```javascript
// Inside reset_cartridge, after loading the cartridge:

// IDEMPOTENCY: If cartridge is already 'linked', reset already happened
if (cartridge.status === 'linked') {
    console.log(`Idempotent retry: cartridge ${cartridgeId} already reset to linked`);
    response = await send_response(
        device.id,
        'reset-cartridge',
        'SUCCESS',
        { cartridgeId, requestId }
    );
    return response;
}
```

---

## 4. Firmware-Side Improvements

The firmware already has good guards (mode checks, stale response detection). However, these improvements would strengthen the implementation:

### 4.1 Request ID Correlation Fix

The firmware's correlation logic at `response_validate_cartridge` line ~2218-2256 is correct in structure but currently dead code because the middleware never sends `requestId`. Once the middleware is fixed to echo `requestId`, this code will start working as intended.

**No firmware changes needed** for request ID correlation - it's already implemented correctly.

### 4.2 Distinguish Retryable vs Non-Retryable Failures

Currently the firmware treats ALL `FAILURE` responses the same way (set error state). But some failures are retryable (network issues, transient errors) and some are permanent (expired cartridge, already used). The firmware could inspect the error message:

```cpp
// In response_validate_cartridge, after receiving FAILURE:
String error_msg = json.get("errorMessage").toString();

// Non-retryable errors - don't waste retries
bool is_permanent_failure =
    error_msg.indexOf("already used") >= 0 ||
    error_msg.indexOf("expired") >= 0 ||
    error_msg.indexOf("not linked") >= 0 ||
    error_msg.indexOf("missing") >= 0 ||
    error_msg.indexOf("deleted") >= 0;

if (is_permanent_failure) {
    // Set error immediately, don't retry
    device_state.cartridge_state = CartridgeState::INVALID;
    device_state.set_error(String("Cartridge validation failed: ") + error_msg);
} else {
    // Transient error - retry if possible
    if (validation_retry_count < VALIDATION_MAX_RETRIES) {
        // ... retry logic
    }
}
```

---

## 5. Summary Checklist

### Middleware Changes Required

| Change | File | Priority |
|--------|------|----------|
| Extract `requestId` from request payload | `index.mjs` | Critical |
| Add idempotency check in `validate_cartridge` (load assay FIRST) | `index.mjs` | Critical |
| Echo `requestId` in ALL response paths (SUCCESS, FAILURE, ERROR) | `index.mjs` | Critical |
| Include `cartridgeId` in FAILURE/ERROR responses | `index.mjs` | High |
| Add idempotency check in `test_upload` | `index.mjs` | High |
| Add idempotency check in `reset_cartridge` | `index.mjs` | Medium |

### Firmware Changes (Optional Improvements)

| Change | File | Priority |
|--------|------|----------|
| Distinguish retryable vs permanent failures | `.ino` | Medium |
| No other firmware changes needed - existing correlation logic is correct | - | - |

### Testing Checklist

- [ ] Validate cartridge → response lost → retry succeeds with same data
- [ ] Validate cartridge → cartridge already "underway" by SAME device → returns SUCCESS
- [ ] Validate cartridge → cartridge already "underway" by DIFFERENT device → returns FAILURE
- [ ] Upload test → response lost → retry succeeds (doesn't create duplicate)
- [ ] Reset cartridge → response lost → retry succeeds
- [ ] `requestId` is present in ALL webhook responses
- [ ] `cartridgeId` is present in FAILURE responses
- [ ] Triple-delivered responses are all handled correctly

---

## 6. Why the Existing Error Happened (Plain English)

1. A cartridge was previously validated (marked as `status: 'underway'` in CouchDB)
2. Either the response was lost and the device retried, OR the cartridge was re-inserted
3. The idempotency code tried to handle the "already underway" case
4. But it referenced the `assay` variable before loading the assay document from CouchDB
5. JavaScript threw `ReferenceError: assay is not defined`
6. The catch block sent this as a FAILURE response without `requestId` or `cartridgeId`
7. The firmware received the FAILURE (3 times due to Particle's at-least-once delivery)
8. The firmware couldn't correlate by requestId or cartridgeId, but processed it anyway
9. The cartridge was marked invalid and the user had to deal with an error state
