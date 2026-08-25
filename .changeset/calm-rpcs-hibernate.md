---
"effect-cf": minor
---

Add hibernation-aware Durable Object Effect RPC WebSockets that restore idle connections, reset lost non-resumable operations instead of hanging, and use Cloudflare auto-responses for idle heartbeats. Applications can opt specific cursor-backed streams into logical subscription reconstruction on the same socket and Effect request ID. Explicit application checkpoints establish the replay boundary and prevent stale stock acknowledgements from advancing a reconstructed stream.
