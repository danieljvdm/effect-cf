import { describe, expect, test } from "vitest";
import { ConfigProvider, Effect, Redacted } from "effect";

import { AiGatewayChatCompletionsEndpoint, AiGatewayConfig } from "../src/runtime.ts";

describe("architect-lab runtime config", () => {
  test("reads Cloudflare AI Gateway config from Worker env", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AiGatewayConfig;
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              AI_GATEWAY_ACCOUNT_ID: "account-id",
              AI_GATEWAY_API_KEY: "gateway-key",
              AI_GATEWAY_AUTH_TOKEN: "gateway-auth-token",
              AI_GATEWAY_CHAT_COMPLETIONS_ENDPOINT:
                "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions",
              AI_GATEWAY_GATEWAY_ID: "effect-cf",
              AI_GATEWAY_MODEL: "openai/gpt-test",
            }),
          ),
        ),
      ),
    );

    expect(config.accountId).toBe("account-id");
    expect(Redacted.value(config.apiKey)).toBe("gateway-key");
    expect(Redacted.value(config.authToken)).toBe("gateway-auth-token");
    expect(config.chatCompletionsEndpoint).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions",
    );
    expect(config.gatewayId).toBe("effect-cf");
    expect(config.model).toBe("openai/gpt-test");
  });

  test("defaults Cloudflare AI Gateway endpoint", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AiGatewayConfig;
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    );

    expect(Redacted.value(config.apiKey)).toBe("");
    expect(Redacted.value(config.authToken)).toBe("");
    expect(config.accountId).toBe("");
    expect(config.chatCompletionsEndpoint).toBe("");
    expect(config.gatewayId).toBe("default");
    expect(AiGatewayChatCompletionsEndpoint).toContain(
      "api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions",
    );
    expect(config.model).toBe("openai/gpt-5-mini");
  });
});
