export class DurableObject<Env = unknown> {
  readonly state: globalThis.DurableObjectState;
  readonly env: Env;

  constructor(state: globalThis.DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  readonly ctx: globalThis.ExecutionContext;
  readonly env: Env;

  constructor(ctx: globalThis.ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint<Env = unknown> {
  readonly ctx: globalThis.ExecutionContext;
  readonly env: Env;

  constructor(ctx: globalThis.ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

export class RpcStub {}
