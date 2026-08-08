---
"effect-cf": minor
---

Add Cloudflare Email Service sending support to `Email`.

Structured messages sent through a `send_email` binding are now validated against documented Email Sending limits — combined `to`/`cc`/`bcc` recipients, attachment count, custom header sizes, and required fields — and fail with `EmailValidationError` before the binding is called. Opt out with `layer({ binding, send: { validate: false } })`. Raw RFC 5322 `EmailMessage` values are still passed through untouched, so the legacy `cloudflare:email` API keeps working.

Cloudflare's `E_*` error codes are now reported on `EmailOperationError.code`, with the documented set exported as `Email.emailErrorCodes` and `Email.EmailErrorCode`. Documented limits are exported as `Email.sendLimits`.
