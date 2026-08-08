---
"effect-cf": patch
---

Route `Worker.make` fetch handlers through `HttpEffect.toHandled`, matching the first-party Effect HTTP adapters.

- Pre-response handlers (`HttpEffect.appendPreResponseHandler`, and things built on it such as `HttpApiBuilder.securitySetCookie`) now run before `HttpServerResponse` results are rendered. Previously they were silently dropped, which broke cookie-based auth flows on Workers.
- Streaming response bodies keep request-scoped resources alive until the stream completes, instead of finalizing them as soon as the `Response` is returned.
- `HttpServerResponse` bodies are suppressed for `HEAD` requests.
- Handler failures are now rendered as HTTP error responses (with the cause reported) instead of rejecting the `fetch` promise. Note that exceptions no longer escape `fetch`, so `passThroughOnException` will not trigger origin fallback for Effect-level failures.
- Native `Response` values returned from a fetch handler continue to bypass all response processing, including pre-response handlers — WebSocket upgrade responses and app-level `HttpEffect.toHandled` wrappers pass through untouched.
