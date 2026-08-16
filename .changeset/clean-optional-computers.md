---
"effect-cf": major
---

Keep the optional `@cloudflare/computer` integration out of the root bundle so Durable Object and other unrelated consumers can bundle `effect-cf` without installing or externalizing that peer. The synchronous root namespaces could not be preserved without making esbuild resolve the optional dependency before tree-shaking, so update `ComputerWorkspace` imports to `effect-cf/computer-workspace` and `ComputerArtifacts` imports to `effect-cf/computer-artifacts`; `effect-cf/computer-workspace-host` remains unchanged.
