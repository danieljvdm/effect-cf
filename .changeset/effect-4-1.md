---
"effect-cf": minor
---

Require Effect 4.1 and replace the removed `Crypto` service with native `SecureRandom` and `Digest` services in Worker, Durable Object, Workflow, and Vitest runtimes. Use `SecureRandom` for alarm revision identifiers and migrate custom crypto layers to the new services.
