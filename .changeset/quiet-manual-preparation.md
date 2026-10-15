---
"effect-cf": minor
---

Add prepared manual alarm handlers that commit queue retry debits and scheduler claims together before dispatch. Retain the native recovery guard when incoming events make logical alarms due.
