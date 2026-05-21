---
"effect-cf": patch
---

Wrap R2 object body reader methods in Effect so `json`, `text`, `bytes`, `arrayBuffer`, and `blob` report read failures as `R2OperationError`.
