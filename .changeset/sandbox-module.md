---
"effect-cf": minor
---

Add `effect-cf/sandbox`: an Effect-native client for the Cloudflare Sandbox SDK 1.0 API (`@cloudflare/sandbox@next`, an optional peer dependency loaded lazily on first use).

`Sandbox.Tag`/`Sandbox.make` create a typed service for a Sandbox Durable Object namespace binding, and `layer({ binding })` validates the binding from `WorkerEnvironment`. The instance client covers the complete `ISandbox` contract plus lifecycle, preview-port, tunnel, bucket-mount, and backup operations: `exec` returns a process handle with typed log `Stream`s and interruption-aware waits, `watch` decodes file-watch Server-Sent Events into an Effect `Stream`, `readFileStream` streams raw bytes, and terminals are wrapped as Effect handles. Failures are reported as a typed `SandboxOperationError` that preserves the SDK's error classes as `cause`, and `Sandbox.proxyToSandbox` routes preview-URL traffic as an `Option<Response>` Effect.
