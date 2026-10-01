---
"effect-cf": minor
---

Add `ContainerTcpPort.connectScoped` to close native TCP sockets when their Effect scope ends. Cleanup awaits `socket.close()` on success, failure, or interruption and preserves close failures as `ContainerError` defects. The existing `connect` method remains caller-owned.
