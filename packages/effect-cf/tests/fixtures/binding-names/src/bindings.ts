import { Effect, Schema } from "effect";
import {
  AiGateway,
  AnalyticsEngine,
  Artifacts,
  Binding,
  BrowserRendering,
  ContainerNamespace,
  D1,
  Email,
  Hyperdrive,
  Images,
  Kv,
  Queue,
  R2,
  ServiceBinding,
  Vectorize,
  Worker,
  WorkersAi,
  Workflow,
} from "effect-cf";
import * as Sandbox from "effect-cf/sandbox";

import { Counters, Onboarding } from "./worker";

export class Archive extends R2.Tag<Archive>()("Archive") {}
export const archiveLayer = Archive.layer({ binding: "ARCHIVE" });
// @ts-expect-error misspelled binding names are rejected.
export const misspelledArchive = Archive.layer({ binding: "ARCHVE" });
// @ts-expect-error a KV namespace cannot back an R2 layer.
export const kvArchive = Archive.layer({ binding: "CACHE" });
export const uncheckedArchive = Archive.layer({ binding: Binding.unchecked("RUNTIME_BUCKET") });

export class Cache extends Kv.Tag<Cache>()("Cache", { key: Schema.String, value: Schema.String }) {}
export const cacheLayer = Cache.layer({ binding: "CACHE" });
// @ts-expect-error an R2 bucket cannot back a KV layer.
export const bucketCache = Cache.layer({ binding: "ARCHIVE" });

export const database = D1.make("Database", { binding: "DB" });

export class Jobs extends Queue.Tag<Jobs>()("Jobs", { message: Schema.String }) {}
export const jobsLayer = Jobs.layer({ binding: "JOBS" });

// Wrangler types same-worker Workflow bindings with the entrypoint's payload.
export const onboardingLayer = Onboarding.layer({ binding: "ONBOARDING" });
export class Billing extends Workflow.Tag<Billing>()("Billing", {
  payload: Schema.Struct({ invoiceId: Schema.Number }),
  result: Schema.String,
}) {}
// @ts-expect-error the payload declared in Env does not accept this schema.
export const billingLayer = Billing.layer({ binding: "ONBOARDING" });

export const countersLayer = Counters.layer({ binding: "COUNTERS" });
// @ts-expect-error a service binding cannot back a Durable Object layer.
export const serviceCounters = Counters.layer({ binding: "AUTH" });
// Same-worker classes are also reachable through `ctx.exports`, without a binding.
export const exportedCountersLayer = Counters.layer({ exportName: "CounterDurableObject" });
// @ts-expect-error Workflow classes are not durable namespaces.
export const workflowCounters = Counters.layer({ exportName: "OnboardingWorkflow" });

export class Auth extends Worker.Tag<Auth>()("Auth", {
  verify: Worker.method({ args: [Schema.String], success: Schema.Boolean }),
}) {}
export const authLayer = Auth.layer({ binding: "AUTH" });
// @ts-expect-error a Durable Object namespace cannot back a service binding layer.
export const namespaceAuth = Auth.layer({ binding: "COUNTERS" });
export class AuthFetch extends ServiceBinding.Service<AuthFetch>()("AuthFetch", {
  binding: "AUTH",
}) {}

export class Ai extends WorkersAi.Tag<Ai>()("Ai") {}
export const aiLayer = Ai.layer({ binding: "AI" });
export class Gateway extends AiGateway.Tag<Gateway>()("Gateway") {}
export const gatewayLayer = Gateway.layer({ binding: "AI", gatewayId: "default" });

export class Vectors extends Vectorize.Tag<Vectors>()("Vectors") {}
export const vectorsLayer = Vectors.layer({ binding: "VECTORS" });

export class Events extends AnalyticsEngine.Tag<Events>()("Events") {}
export const eventsLayer = Events.layer({ binding: "EVENTS" });

export class Postgres extends Hyperdrive.Tag<Postgres>()("Postgres") {}
export const postgresLayer = Postgres.layer({ binding: "HYPERDRIVE" });

export class Pictures extends Images.Tag<Pictures>()("Pictures") {}
export const picturesLayer = Pictures.layer({ binding: "IMAGES" });

export class Mailer extends Email.Tag<Mailer>()("Mailer") {}
export const mailerLayer = Mailer.layer({ binding: "MAILER" });

export class Browser extends BrowserRendering.Tag<Browser>()("Browser") {}
export const browserLayer = Browser.layer({ binding: "BROWSER" });
// @ts-expect-error a text var cannot back a browser layer.
export const textBrowser = Browser.layer({ binding: "APP_NAME" });
// @ts-expect-error an R2 bucket cannot back a browser layer.
export const bucketBrowser = Browser.layer({ binding: "ARCHIVE" });
// @ts-expect-error a service binding cannot back a browser layer.
export const serviceBrowser = Browser.layer({ binding: "AUTH" });

export class Repositories extends Artifacts.Tag<Repositories>()("Repositories") {}
export const repositoriesLayer = Repositories.layer({ binding: "ARTIFACTS" });

export class Containers extends ContainerNamespace.Tag<Containers>()("Containers") {}
export const containersLayer = Containers.layer({ binding: "CONTAINERS" });

export class Sandboxes extends Sandbox.Tag<Sandboxes>()("Sandboxes") {}
export const sandboxesLayer = Sandboxes.layer({ binding: "CONTAINERS" });
export const previewRouting = Effect.gen(function* () {
  return yield* Sandbox.proxyToSandbox(new Request("https://example.com"), {
    binding: "CONTAINERS",
  });
});
