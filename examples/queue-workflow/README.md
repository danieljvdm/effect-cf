# Queue and Workflow Example

This example demonstrates the `effect-cf` Queue and Workflow primitives:

- `workers/app/src/queue.ts` defines a typed Queue contract, producer binding, and consumer Worker.
- `workers/app/src/workflow.ts` defines a typed Workflow contract, starter binding, and Workflow entrypoint.
- `workers/app/tests/examples.test.ts` runs both examples with in-memory Cloudflare binding fakes.

From the repo root:

```sh
vp run queue-workflow-app#test
```
