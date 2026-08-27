import {
  McpServer,
  type CallToolResult,
  type JSONObject,
  type ServerOptions,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { createMcpHandler, type CreateMcpHandlerOptions } from "agents/mcp/server";
import {
  Cause,
  Context,
  Effect,
  Exit,
  type JsonSchema,
  Option,
  Predicate,
  Schema,
  Sink,
  Stream,
} from "effect";
import { AiError, Tool, type Toolkit } from "effect/unstable/ai";

import { WorkerEnvironment } from "./Environment";
import { ExecutionContext, NativeRequest } from "./Worker";
import { runNativeCallback } from "./internal/NativeCallback";

/**
 * Options for {@link fromToolkit}.
 *
 * Extends Cloudflare's stateless MCP handler options (`route`, `corsOptions`,
 * `allowedHostnames`, `allowedOriginHostnames`, `authContext`, and the MCP SDK
 * handler options) with the server identity advertised to MCP clients.
 */
export interface FromToolkitOptions extends CreateMcpHandlerOptions {
  /** Server name advertised in the MCP implementation info. */
  readonly name: string;
  /** Server version advertised in the MCP implementation info. */
  readonly version: string;
  /** Optional human-readable server title advertised to MCP clients. */
  readonly title?: string;
  /**
   * Options passed to the underlying MCP SDK `McpServer` (capabilities,
   * instructions, ...).
   */
  readonly serverOptions?: ServerOptions;
}

/**
 * Services required to execute the tools of a toolkit: the tool handlers plus
 * every service those handlers and their parameter/result codecs need.
 */
export type ToolkitServices<Tools extends Record<string, Tool.Any>> =
  | Tool.HandlersFor<Tools>
  | Tool.HandlerServices<Tools[keyof Tools]>;

/**
 * Context required by the Effect returned from {@link fromToolkit}: the native
 * fetch-event services provided by `Worker.make` plus the toolkit services.
 */
export type FromToolkitContext<Tools extends Record<string, Tool.Any>> =
  | NativeRequest
  | ExecutionContext
  | WorkerEnvironment
  | ToolkitServices<Tools>;

const INTERNAL_TOOL_ERROR_MESSAGE = "Tool execution failed due to an internal server error.";

const toolErrorResult = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/**
 * Wraps a JSON Schema produced by Effect `Schema` as the Standard Schema shape
 * accepted by MCP SDK v2 `registerTool`, with a passthrough `validate`.
 *
 * Used for output schemas and for dynamic tools whose parameters are already a
 * JSON Schema: the toolkit performs its own decoding, so there is nothing
 * additional to validate here.
 */
const standardSchemaFromJsonSchema = (
  jsonSchema: JsonSchema.JsonSchema,
): StandardSchemaWithJSON => ({
  "~standard": {
    version: 1,
    vendor: "effect-cf",
    validate: (value) => ({ value }),
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
});

/**
 * Builds the tool input schema registered with the MCP SDK.
 *
 * The SDK validates incoming `tools/call` arguments with `~standard.validate`
 * and answers validation failures with an MCP invalid-params error, so the
 * tool's Effect parameters `Schema` backs `validate`. On success the original
 * encoded arguments are kept: the toolkit decodes them itself when the tool
 * handler executes.
 */
const standardInputSchema = (tool: Tool.Any): StandardSchemaWithJSON => {
  const jsonSchema = Tool.getJsonSchema(tool);

  if (!Schema.isSchema(tool.parametersSchema)) {
    return standardSchemaFromJsonSchema(jsonSchema);
  }

  // SAFETY: MCP tool-call arguments arrive without an Effect service context,
  // so the parameters schema must decode without services; the toolkit decodes
  // the same schema service-free when the tool handler executes.
  const parametersSchema = tool.parametersSchema as Schema.Top & Schema.ConstraintDecoder<unknown>;
  const validate = Schema.toStandardSchemaV1(parametersSchema)["~standard"].validate;

  return {
    "~standard": {
      version: 1,
      vendor: "effect-cf",
      validate: (value) => {
        const result = validate(value);

        if (result instanceof Promise) {
          return result.then((awaited) => (awaited.issues === undefined ? { value } : awaited));
        }

        return result.issues === undefined ? { value } : result;
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
};

type RunToolCallback<R> = (
  effect: Effect.Effect<CallToolResult, never, R>,
) => Promise<Exit.Exit<CallToolResult, never>>;

const handleToolCall = <Tools extends Record<string, Tool.Any>>(
  built: Toolkit.WithHandler<Tools>,
  tool: Tool.Any,
  params: Tool.Parameters<Tools[keyof Tools]>,
): Effect.Effect<CallToolResult, never, Tool.HandlerServices<Tools[keyof Tools]>> => {
  const isDeclaredFailure = Schema.is(tool.failureSchema);

  // SAFETY: registerToolkitTool only registers tools taken from `built.tools`,
  // so the tool name is a key of the toolkit's tools record.
  return built.handle(tool.name as keyof Tools, params).pipe(
    Stream.unwrap,
    Stream.run(Sink.last()),
    Effect.flatMap(Effect.fromOption),
    Effect.map((result): CallToolResult => {
      if (result.isFailure) {
        return toolErrorResult(JSON.stringify(result.encodedResult));
      }

      // SAFETY: encodedResult is the Schema-encoded tool result, so a
      // non-array record value is a JSON object.
      const structuredContent = Predicate.isObject(result.encodedResult)
        ? (result.encodedResult as JSONObject)
        : undefined;
      const content: CallToolResult["content"] =
        result.encodedResult === undefined
          ? []
          : [{ type: "text", text: JSON.stringify(result.encodedResult) }];

      if (structuredContent === undefined) {
        return { isError: false, content };
      }

      return { isError: false, structuredContent, content };
    }),
    Effect.tapCause(Effect.logError),
    Effect.catch((error) => {
      if (AiError.isAiError(error)) {
        // SAFETY: isAiError established the value is an AiError; TypeScript
        // cannot narrow the generic handler-error union itself.
        const reason = (error as AiError.AiError).reason;

        return Effect.succeed(
          toolErrorResult(
            reason._tag === "ToolParameterValidationError"
              ? reason.message
              : INTERNAL_TOOL_ERROR_MESSAGE,
          ),
        );
      }

      if (isDeclaredFailure(error)) {
        const message = error instanceof Error ? error.message : INTERNAL_TOOL_ERROR_MESSAGE;

        return Effect.succeed(toolErrorResult(message));
      }

      return Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE));
    }),
    Effect.catchDefect(() => Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE))),
  );
};

const registerToolkitTool = <Tools extends Record<string, Tool.Any>>(
  server: McpServer,
  built: Toolkit.WithHandler<Tools>,
  tool: Tool.Any,
  run: RunToolCallback<Tool.HandlerServices<Tools[keyof Tools]>>,
): void => {
  const outputJsonSchema = Tool.getJsonSchemaFromSchema(tool.successSchema);
  const outputSchema =
    outputJsonSchema.type === "object" ? standardSchemaFromJsonSchema(outputJsonSchema) : undefined;
  const title = Context.getOrUndefined(tool.annotations, Tool.Title);
  const toolMeta = Context.getOrUndefined(tool.annotations, Tool.Meta);

  server.registerTool(
    tool.name,
    {
      title,
      description: Tool.getDescription(tool),
      inputSchema: standardInputSchema(tool),
      outputSchema,
      annotations: {
        title,
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
      _meta: toolMeta,
    },
    async (args) => {
      // SAFETY: the SDK validated the arguments with the tool input schema,
      // whose `validate` keeps the encoded input, and the toolkit decodes the
      // parameters with the tool's Effect `Schema` before invoking the
      // handler.
      const params = (args ?? {}) as Tool.Parameters<Tools[keyof Tools]>;
      const exit = await run(handleToolCall(built, tool, params));

      if (Exit.isSuccess(exit)) {
        return exit.value;
      }

      throw Cause.squash(exit.cause);
    },
  );
};

/**
 * Creates an Effect that serves a toolkit over MCP with Cloudflare's stateless
 * Streamable HTTP handler (`createMcpHandler` from `agents/mcp/server`).
 *
 * **Details**
 *
 * Yield the returned Effect inside a `Worker.make` fetch handler before other
 * routing. When the request pathname matches `route` (default `"/mcp"`), the
 * request is served by a fresh MCP server exposing every tool in the toolkit
 * and the Effect succeeds with `Option.some(response)`. Any other pathname
 * succeeds with `Option.none()` so the request can fall through to the rest of
 * the fetch handler.
 *
 * Tool calls run through the caller's Effect context: provide the toolkit
 * handlers (`toolkit.toLayer(...)`) and their services in the Worker layer or
 * event layer. Tool parameters are decoded and results encoded with each
 * tool's Effect `Schema`; parameter validation failures become MCP
 * invalid-params errors, declared tool failures become tool results with
 * `isError: true`, and unexpected errors are logged and reported to the client
 * as an internal tool error.
 *
 * In-flight tool calls are awaited before the HTTP response is returned, so
 * tool handlers always run to completion inside the fetch event, including on
 * transport lanes that stream results into the response body.
 *
 * **Example**
 *
 * ```ts
 * import { Effect, Layer, Option } from "effect"
 * import { HttpRouter } from "effect/unstable/http"
 * import { Worker } from "effect-cf"
 * import * as Mcp from "effect-cf/mcp"
 *
 * const mcp = Mcp.fromToolkit(ActivityToolkit, {
 *   name: "strava-ingestor",
 *   version: "1.0.0",
 *   route: "/mcp",
 * })
 *
 * const fetch = Effect.gen(function* () {
 *   const response = yield* mcp
 *   if (Option.isSome(response)) return response.value
 *   const router = yield* HttpRouter.HttpRouter
 *   return yield* router.asHttpEffect()
 * })
 *
 * export default Worker.make(
 *   Layer.mergeAll(ApplicationLive, ActivityToolkitLive),
 *   { fetch },
 * )
 * ```
 */
export const fromToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options: FromToolkitOptions,
): Effect.Effect<Option.Option<Response>, unknown, FromToolkitContext<Tools>> => {
  const { name, version, title, serverOptions, route = "/mcp", ...handlerOptions } = options;
  const serverInfo = { name, version, title };

  return Effect.gen(function* () {
    const request = yield* NativeRequest;

    if (new URL(request.url).pathname !== route) {
      return Option.none();
    }

    const env = yield* WorkerEnvironment;
    const executionContext = yield* ExecutionContext;
    const built = yield* toolkit;

    const response = yield* runNativeCallback<
      CallToolResult,
      never,
      Tool.HandlerServices<Tools[keyof Tools]>,
      Response
    >(async (run) => {
      // Some transport lanes (e.g. the 2025-era compatibility lane) resolve
      // the HTTP response before in-flight tool handlers settle and stream the
      // results into the response body afterwards. Track every tool-call
      // effect and drain them before resolving, so the fetch Effect scope does
      // not close (and interrupt them) mid-execution.
      const pending = new Set<Promise<unknown>>();
      const trackedRun: RunToolCallback<Tool.HandlerServices<Tools[keyof Tools]>> = (effect) => {
        const promise = run(effect);

        pending.add(promise);
        void promise.finally(() => pending.delete(promise));

        return promise;
      };
      const handler = createMcpHandler(
        () => {
          const server = new McpServer(serverInfo, serverOptions);

          for (const tool of Object.values(built.tools)) {
            registerToolkitTool(server, built, tool, trackedRun);
          }

          return server;
        },
        { ...handlerOptions, route },
      );
      const response = await handler(request, env, executionContext);

      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }

      return response;
    });

    return Option.some(response);
  });
};
