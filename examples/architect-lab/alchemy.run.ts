import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const compatibility = {
  date: "2026-05-14",
  flags: ["nodejs_compat"],
};

const secret = (name: string) => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : Redacted.make(value);
};

const apiSecrets = () => ({
  ...(secret("AI_GATEWAY_API_KEY") === undefined
    ? {}
    : { AI_GATEWAY_API_KEY: secret("AI_GATEWAY_API_KEY") }),
  ...(secret("AI_GATEWAY_AUTH_TOKEN") === undefined
    ? {}
    : { AI_GATEWAY_AUTH_TOKEN: secret("AI_GATEWAY_AUTH_TOKEN") }),
  ...(secret("ARCHITECT_AI_PROVIDER_API_KEY") === undefined
    ? {}
    : { ARCHITECT_AI_PROVIDER_API_KEY: secret("ARCHITECT_AI_PROVIDER_API_KEY") }),
});

export default Alchemy.Stack(
  "ArchitectLab",
  {
    // Alchemy beta.44 includes WorkflowResource in Cloudflare.providers(), but
    // the Stack generic does not infer that provider collection yet.
    providers: Cloudflare.providers() as never,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const rooms = Cloudflare.DurableObjectNamespace("Rooms", {
      className: "RoomDurableObject",
    });
    const readModels = yield* Cloudflare.KVNamespace("ReadModels", {
      title: "architect-lab-read-models-production",
    });
    const exportsDb = yield* Cloudflare.D1Database("ExportsDb", {
      name: "architect-lab-exports-production",
    });
    const exportsBucket = yield* Cloudflare.R2Bucket("Exports", {
      name: "architect-lab-exports-production",
    });
    const aiJobs = yield* Cloudflare.Queue("AiJobs", {
      name: "architect-lab-ai-jobs-production",
    });

    const api = yield* Cloudflare.Worker("Api", {
      name: "architect-lab-api-production",
      main: "./workers/api/src/index.ts",
      compatibility,
      env: apiSecrets(),
      bindings: {
        ROOMS: rooms,
        ARCHITECT_READ_MODELS: readModels,
        ARCHITECT_EXPORTS_DB: exportsDb,
        ARCHITECT_EXPORTS: exportsBucket,
        AI_JOBS: aiJobs,
      },
    });

    yield* api.bind("ARCHITECT_EXPORT_WORKFLOW", {
      bindings: [
        {
          type: "workflow",
          name: "ARCHITECT_EXPORT_WORKFLOW",
          workflowName: "architect-lab-export-workflow-production",
          className: "ExportWorkflow",
        },
      ],
    });

    yield* Cloudflare.WorkflowResource("ExportWorkflow", {
      workflowName: "architect-lab-export-workflow-production",
      className: "ExportWorkflow",
      scriptName: api.workerName,
    });

    yield* Cloudflare.QueueConsumer("AiJobsConsumer", {
      queueId: aiJobs.queueId,
      scriptName: api.workerName,
    });

    const web = yield* Cloudflare.Worker("Web", {
      name: "architect-lab-web-production",
      main: "./workers/web/src/index.ts",
      compatibility,
      assets: {
        directory: "./workers/web/dist/client",
        config: {
          htmlHandling: "none",
          notFoundHandling: "single-page-application",
          runWorkerFirst: true,
        },
      },
      bindings: {
        API: api,
      },
    });

    return {
      apiUrl: api.url,
      webUrl: web.url,
    };
  }),
);
