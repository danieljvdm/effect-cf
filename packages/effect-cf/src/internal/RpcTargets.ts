import * as Context from "effect/Context";

export interface Targets {
  get<A extends object, Owner extends object>(owner: Owner, address: string, create: () => A): A;
  invalidate<Target extends object>(target: Target): void;
}

export class CurrentTargets extends Context.Service<CurrentTargets, Targets>()(
  "effect-cf/RpcTargets",
) {}
