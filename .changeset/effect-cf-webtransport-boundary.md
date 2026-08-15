---
"effect-cf": minor
---

Add the `WebTransport` module: a truthful WebTransport/HTTP-3 boundary for Workers. `inboundTransport` decodes the HTTP protocol metadata Cloudflare's edge attaches to requests (`httpProtocol`, `clientQuicRtt`, `clientTcpRtt`) with `isHttp3` on top; `capabilities` feature-detects what the runtime provides; and `inboundSessionsUnsupported` is an explicit typed boundary for the inbound WebTransport session API that workerd does not have (cloudflare/workerd#6451).
