import { expect, test } from "vite-plus/test";
import { Config, Effect, Layer, Redacted } from "effect";

import { WorkerConfig, WorkerEnvironment } from "../src/index";

const AppConfig = Config.all({
  databaseUrl: WorkerConfig.redacted("DATABASE_URL"),
  appName: WorkerConfig.string("APP_NAME"),
  port: WorkerConfig.integer("APP_PORT"),
  featureEnabled: WorkerConfig.boolean("FEATURE_ENABLED"),
  sampleRate: WorkerConfig.number("SAMPLE_RATE"),
});

void WorkerConfig.string("OPTIONAL_SCALAR");
void WorkerConfig.redacted("SECRET_VALUE");

// @ts-expect-error Durable Object namespace bindings are not scalar config keys.
void WorkerConfig.string("TEST_COUNTER_DO");

// @ts-expect-error Unknown keys must be declared on Cloudflare.Env.
void WorkerConfig.string("MISSING_CONFIG_KEY");

test("WorkerConfig.providerFromEnv preserves empty strings when requested", async () => {
  const env = {
    APP_NAME: "",
  } as Cloudflare.Env;

  const result = await Effect.runPromise(
    WorkerConfig.string("APP_NAME").pipe(
      Effect.provide(
        WorkerConfig.layerWith((currentEnv) =>
          WorkerConfig.providerFromEnv(currentEnv, { preserveEmptyStrings: true }),
        ),
      ),
      Effect.provide(Layer.succeed(WorkerEnvironment, env)),
      Effect.orDie,
    ),
  );

  expect(result).toBe("");
});

test("WorkerConfig.layer reads scalar config from WorkerEnvironment", async () => {
  const env = {
    DATABASE_URL: "postgres://example.test/app",
    SECRET_VALUE: "secret",
    APP_NAME: "effect-cf",
    APP_PORT: "8787",
    FEATURE_ENABLED: "yes",
    SAMPLE_RATE: 0.25,
  } as Cloudflare.Env;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AppConfig;

      return {
        ...config,
        databaseUrl: Redacted.value(config.databaseUrl),
      };
    }).pipe(
      Effect.provide(WorkerConfig.layer),
      Effect.provide(Layer.succeed(WorkerEnvironment, env)),
      Effect.orDie,
    ),
  );

  expect(result).toEqual({
    databaseUrl: "postgres://example.test/app",
    appName: "effect-cf",
    port: 8787,
    featureEnabled: true,
    sampleRate: 0.25,
  });
});
