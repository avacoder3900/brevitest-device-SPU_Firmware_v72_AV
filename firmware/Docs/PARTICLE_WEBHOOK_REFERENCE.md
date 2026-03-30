# Particle Webhook Integration Reference

**Product:** Acuity Multiplex Development (Sandbox)
**Documented:** March 27, 2026
**Lambda Target:** `https://3ef8a74opb.execute-api.us-east-1.amazonaws.com/v1/particle-multiplex-middleware`

---

## Summary

All 4 webhooks share the same configuration pattern:
- **Target:** Single AWS Lambda via API Gateway (same endpoint for all events)
- **Method:** POST, JSON format
- **SSL:** Enforced
- **Response Topic:** `{{PARTICLE_DEVICE_ID}}/hook-response/{{PARTICLE_EVENT_NAME}}` (device-scoped)
- **Payload Template:** Identical across all 4 (see below)

### Shared Payload Template

```json
{
    "event_id": "{{{PARTICLE_EVENT_ID}}}",
    "event": "{{{PARTICLE_EVENT_NAME}}}",
    "data": "{{{PARTICLE_EVENT_VALUE}}}",
    "device_id": "{{{PARTICLE_DEVICE_ID}}}",
    "product_id": "{{{PRODUCT_ID}}}",
    "fw_version": "{{{PRODUCT_VERSION}}}",
    "published_at": "{{{PARTICLE_PUBLISHED_AT}}}"
}
```

### Shared Headers

```json
{
    "Content-Type": "application/json",
    "Accept": "application/json"
}
```

---

## Webhooks

| # | Name | Event Name | Integration ID | Created | Updated |
|---|------|-----------|----------------|---------|---------|
| 1 | validate-cartridge-webhook | `validate-cartridge` | `6771f4276557a197a5217fd3` | Dec 29, 2024 | Jun 9, 2025 |
| 2 | load-assay-webhook | `load-assay` | (not captured) | (not captured) | (not captured) |
| 3 | upload-test-webhook | `upload-test` | `6772b09431f35f427c2bb876` | Dec 30, 2024 | Jun 9, 2025 |
| 4 | reset-cartridge-webhook | `reset-cartridge` | `6771e1fcdfecdb08ce9a496e` | Dec 29, 2024 | Jun 9, 2025 |
| 5 | device-log-webhook | `device-log` | `69c709d6268e6e1104ac7ca8` | Mar 27, 2026 | Mar 27, 2026 |

### Response Event Name Pattern

Because the Response Topic is `{{PARTICLE_DEVICE_ID}}/hook-response/{{PARTICLE_EVENT_NAME}}`, the actual response event names delivered to devices look like:

```
e00fce68abcd1234/hook-response/validate-cartridge
e00fce68abcd1234/hook-response/load-assay
e00fce68abcd1234/hook-response/upload-test
e00fce68abcd1234/hook-response/reset-cartridge
```

Each device only receives its own responses. Other devices on the same account do NOT receive these events.

### Recommended Firmware Subscribe Pattern

Particle's example code for these webhooks shows:

```cpp
Particle.subscribe(System.deviceID() + "/hook-response/load-assay/", myHandler, MY_DEVICES);
```

Since all 4 webhooks use the same `DEVICE_ID/hook-response/EVENT_NAME` pattern, a single prefix subscription handles all of them:

```cpp
Particle.subscribe(System.deviceID() + "/hook-response/", response_webhook, MY_DEVICES);
```

This uses 1 of 4 available subscription slots instead of 4 of 4.

---

## Secrets & Parameters (Shared)

| Key | Value |
|-----|-------|
| `LAMBDA_API_GATEWAY_ENDPOINT` | `https://3ef8a74opb.execute-api.us-east-1.amazonaws.com/v1/particle-multiplex-middleware` |
| `AWS_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | (configured in Particle Console) |
| `AWS_SECRET_ACCESS_KEY` | (configured in Particle Console) |

---

## Adding the device-log Webhook

To complete the logging pipeline, create a 5th webhook in Particle Console:

| Field | Value |
|-------|-------|
| **Name** | `device-log-webhook` |
| **Event Name** | `device-log` |
| **Target URL** | `https://3ef8a74opb.execute-api.us-east-1.amazonaws.com/v1/particle-multiplex-middleware` |
| **Method** | POST |
| **Format** | JSON |
| **Payload** | Same template as existing webhooks |
| **Response Topic** | `{{PARTICLE_DEVICE_ID}}/hook-response/{{PARTICLE_EVENT_NAME}}` |
| **Headers** | Same as existing |
| **SSL** | Yes |
| **Secrets** | Same AWS credentials |

No changes to the Lambda URL — the middleware already handles `device-log` events in the updated `index.mjs`. The webhook just routes the Particle event to the same Lambda.
