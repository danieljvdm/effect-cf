---
"effect-cf": minor
---

Add hibernation-aware Durable Object Effect RPC WebSockets that restore idle connections, reset lost non-resumable operations instead of hanging, and use Cloudflare auto-responses for idle heartbeats. Applications can opt specific cursor-backed streams into logical subscription reconstruction on the same socket and Effect request ID. Declaration schemas validate persisted resume state before reconstruction. Explicit application checkpoints establish the replay boundary, report attachment persistence failures in the typed error channel, and prevent stale stock acknowledgements from advancing a reconstructed stream.
