/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type * as EffectArtifacts from "../src/Artifacts";
import type * as TestWorkerModule from "./worker-fixture";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_COUNTER_DO?: DurableObjectNamespace<TestWorkerModule.TestCounterDurableObject>;
      TEST_KV?: KVNamespace;
      TEST_DB?: D1Database;
      TEST_SECRET?: SecretsStoreSecret;
      TEST_WORKFLOW?: Workflow<TestWorkerModule.TestWorkflowPayload>;
      TEST_BUCKET?: R2Bucket;
      EMAIL?: SendEmail;
      HYPERDRIVE?: Hyperdrive;
      IMAGES?: ImagesBinding;
      AI?: Ai;
      REQUEST_ANALYTICS?: AnalyticsEngineDataset;
      ARTIFACTS?: EffectArtifacts.ArtifactsBinding;
      RECIPE_VECTORS?: Vectorize;
      MYBROWSER?: unknown;
      DATABASE_URL?: string;
      CLOUDFLARE_ACCOUNT_ID?: string;
      CLOUDFLARE_API_TOKEN?: string;
      ACCOUNT_ID?: string;
      API_TOKEN?: string;
      SECRET_VALUE?: string;
      APP_NAME?: string;
      APP_PORT?: string;
      FEATURE_ENABLED?: string;
      SAMPLE_RATE?: number;
      OPTIONAL_SCALAR?: string;
    }

    interface GlobalProps {
      mainModule: typeof TestWorkerModule;
      durableNamespaces: "TestCounterDurableObject";
    }
  }
}
