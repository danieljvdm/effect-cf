import { Config, ConfigProvider, Context, Effect, type Layer, Predicate } from "effect";

export type WorkerEnv = Cloudflare.Env;

/**
 * Context service for reading worker bindings from the current `env` object.
 */
export class WorkerEnvironment extends Context.Service<WorkerEnvironment, WorkerEnv>()(
  "effect-cf/WorkerEnvironment",
) {}

type ScalarConfigValue = string | number | boolean;

type ScalarConfigKey = Extract<
  {
    readonly [Key in keyof Cloudflare.Env]-?: NonNullable<
      Cloudflare.Env[Key]
    > extends ScalarConfigValue
      ? Key
      : never;
  }[keyof Cloudflare.Env],
  string
>;

export namespace WorkerConfig {
  export type Scalar = ScalarConfigValue;

  export type Key = ScalarConfigKey;

  /** Read a scalar Cloudflare var or secret as a string. */
  export const string = <const Name extends Key>(name: Name) => Config.string(name);

  /** Read a scalar Cloudflare secret as a redacted string. */
  export const redacted = <const Name extends Key>(name: Name) => Config.redacted(name);

  /** Read a scalar Cloudflare var or secret as a number. */
  export const number = <const Name extends Key>(name: Name) => Config.number(name);

  /** Read a scalar Cloudflare var or secret as an integer. */
  export const integer = <const Name extends Key>(name: Name) => Config.int(name);

  /** Read a scalar Cloudflare var or secret as a boolean. */
  export const boolean = <const Name extends Key>(name: Name) => Config.boolean(name);

  export interface ProviderOptions {
    /**
     * Keep empty-string env values as explicit `""` config values.
     *
     * By default (absent or `false`), empty strings are treated as missing
     * config, matching `ConfigProvider.fromEnvRecord`.
     */
    readonly preserveEmptyStrings?: boolean;
  }

  /**
   * Build a `ConfigProvider` from a Cloudflare worker `env` object.
   *
   * Scalar vars and secrets use Effect's environment-record semantics;
   * Cloudflare binding objects are ignored.
   *
   * Empty-string values are treated as missing config by default; pass
   * `{ preserveEmptyStrings: true }` to keep them as explicit values.
   */
  export const providerFromEnv = (env: WorkerEnv, options?: ProviderOptions) => {
    const record: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
        record[key] = String(value);
      }
    }

    return ConfigProvider.fromEnvRecord(record, options);
  };

  export const providerWith = (makeProvider: (env: WorkerEnv) => ConfigProvider.ConfigProvider) =>
    Effect.map(WorkerEnvironment, makeProvider);

  export const provider = providerWith(providerFromEnv);

  /**
   * Replace the active Effect `ConfigProvider` with one backed by the current
   * Cloudflare worker `env` object.
   */
  export const providerLayer: Layer.Layer<never, never, WorkerEnvironment> =
    ConfigProvider.layer(provider);

  export const layerWith = (
    makeProvider: (env: WorkerEnv) => ConfigProvider.ConfigProvider,
  ): Layer.Layer<never, never, WorkerEnvironment> =>
    ConfigProvider.layer(providerWith(makeProvider));
}
