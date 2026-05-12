/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type * as TestWorkerModule from "./worker-fixture";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_COUNTER_DO: DurableObjectNamespace<TestWorkerModule.TestCounterDurableObject>;
      DATABASE_URL: string;
      SECRET_VALUE: string;
      APP_NAME: string;
      APP_PORT: string;
      FEATURE_ENABLED: string;
      SAMPLE_RATE: number;
      OPTIONAL_SCALAR?: string;
    }

    interface GlobalProps {
      mainModule: typeof TestWorkerModule;
      durableNamespaces: "TestCounterDurableObject";
    }
  }
}
