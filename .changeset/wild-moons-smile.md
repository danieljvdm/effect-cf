---
"effect-cf": minor
---

Add Cloudflare Email Service sending support to `Email`.

Structured messages sent through a `send_email` binding are now validated against documented Email Sending limits — combined `to`/`cc`/`bcc` recipients, attachment count, custom header sizes, and required fields — and fail with `EmailValidationError` before the binding is called. Opt out with `layer({ binding, send: { validate: false } })`. Raw RFC 5322 `EmailMessage` values are still passed through untouched, and Cloudflare's `E_*` error codes are now reported on `EmailOperationError.code`.

`Email.SendingTag` adds an Email Sending REST API client for sending from outside a Worker or without a binding, with `layer`, `fetchLayer`, `layerConfig`, and `fetchLayerConfig` constructors and `Email.sendingConfig` for account id and redacted API token configuration. Sends return the per-recipient delivery status as `{ delivered, permanentBounces, queued }` and fail with `EmailSendingError` carrying the HTTP status and Cloudflare's error array.
