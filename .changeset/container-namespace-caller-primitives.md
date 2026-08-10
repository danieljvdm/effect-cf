---
"effect-cf": minor
---

Extend the `ContainerNamespace` client with the remaining caller-side Container primitives: `waitForPort` (preserving the native retry-count result), the runtime host-policy operations (`setAllowedHosts`, `setDeniedHosts`, `allowHost`, `denyHost`, `removeAllowedHost`, `removeDeniedHost`), and numeric stop signals alongside the named ones. `ContainerNamespace.Tag` now accepts an optional exact native namespace type (for example `DurableObjectNamespace<CodexSandbox>`) so `rawUnsafe` on the namespace and on named instances preserves the exact native namespace and stub types, including extra subclass methods. Existing consumers compile unchanged via default type parameters.
