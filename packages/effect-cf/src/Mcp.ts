import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
  type CallToolResult,
  type CreateMcpHandlerOptions,
  type JSONObject,
  type ServerContext,
  type ServerOptions,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { JsonSchema, Scope } from "effect";
import * as AiError from "effect/ai/AiError";
import * as Tool from "effect/ai/Tool";
import type { Toolkit } from "effect/ai";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as McpTool from "./McpTool";
import { NativeRequest } from "./Worker";

export { McpProgressError, reportProgress, ToolContext, type Progress } from "./McpTool";

/**
 * CORS headers applied to MCP responses.
 */
export interface CorsOptions {
  readonly origin?: string;
  readonly methods?: string;
  readonly headers?: string;
  readonly maxAge?: number;
  readonly exposeHeaders?: string;
}

/**
 * Options for {@link fromToolkit}.
 *
 * Extends the MCP SDK `createMcpHandler` options (`legacy`, `responseMode`,
 * `onerror`, ...) with the server identity advertised to MCP clients and the
 * Worker edge options (`route`, `corsOptions`, `allowedHostnames`,
 * `allowedOriginHostnames`).
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
  /** Pathname served by the MCP handler. @default "/mcp" */
  readonly route?: string;
  /** CORS headers applied to every MCP response. Pass `false` to disable. */
  readonly corsOptions?: CorsOptions | false;
  /**
   * Restrict `Host` headers to these hostnames. Localhost and `workers.dev`
   * endpoints receive matching defaults; custom domains rely on Cloudflare
   * routing unless this option is set.
   */
  readonly allowedHostnames?: ReadonlyArray<string>;
  /**
   * Restrict present browser `Origin` headers to these hostnames. Requests
   * without an Origin (including non-browser MCP clients) remain valid. The
   * default includes localhost-class Origins, the endpoint's `workers.dev`
   * hostname, and a concrete `corsOptions.origin` hostname. Pass `"*"` only
   * when equivalent Origin validation runs in trusted middleware upstream.
   */
  readonly allowedOriginHostnames?: ReadonlyArray<string> | "*";
}

/**
 * Services required to execute the tools of a toolkit: the tool handlers plus
 * every service those handlers and their parameter/result codecs need, except
 * `McpTool.ToolContext`, which the bridge supplies separately for each call.
 */
export type ToolkitServices<Tools extends Record<string, Tool.Any>> =
  | Tool.HandlersFor<Tools>
  | Exclude<Tool.HandlerServices<Tools[keyof Tools]>, McpTool.ToolContext>;

/**
 * Context required by the Effect returned from {@link fromToolkit}: the native
 * request and HTTP scope provided by `Worker.make` plus the toolkit services.
 */
export type FromToolkitContext<Tools extends Record<string, Tool.Any>> =
  | NativeRequest
  | Scope.Scope
  | ToolkitServices<Tools>;

const DEFAULT_CORS_OPTIONS: Required<CorsOptions> = {
  origin: "*",
  headers:
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  methods: "GET, POST, DELETE, OPTIONS",
  exposeHeaders: "mcp-session-id",
  maxAge: 86400,
};

const corsHeaders = (options: CorsOptions): Headers => {
  const merged = { ...DEFAULT_CORS_OPTIONS, ...options };

  return new Headers({
    "Access-Control-Allow-Headers": merged.headers,
    "Access-Control-Allow-Methods": merged.methods,
    "Access-Control-Allow-Origin": merged.origin,
    "Access-Control-Expose-Headers": merged.exposeHeaders,
    "Access-Control-Max-Age": String(merged.maxAge),
  });
};

const withCors = (response: Response, options: CorsOptions | false | undefined): Response => {
  if (options === false) {
    return response;
  }

  const headers = new Headers(response.headers);

  for (const [headerName, value] of corsHeaders(options ?? {})) {
    headers.set(headerName, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const corsOriginHostname = (corsOptions: CorsOptions | false | undefined): string | undefined => {
  const origin = corsOptions === false ? undefined : corsOptions?.origin;

  if (origin === undefined || !URL.canParse(origin)) {
    return undefined;
  }

  const url = new URL(origin);

  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== ""
    ? url.hostname
    : undefined;
};

interface EdgeGuardOptions {
  readonly corsOptions: CorsOptions | false | undefined;
  readonly allowedHostnames: ReadonlyArray<string> | undefined;
  readonly allowedOriginHostnames: ReadonlyArray<string> | "*" | undefined;
}

/**
 * `Host` and `Origin` validation for the MCP route, using the MCP SDK's
 * validation primitives with the same defaults Cloudflare applies: localhost
 * and `workers.dev` endpoints validate the `Host` header against themselves,
 * and present browser `Origin` headers must match localhost-class Origins, the
 * endpoint's `workers.dev` hostname, or a concrete configured CORS origin.
 */
const edgeGuardResponse = (
  request: Request,
  requestUrl: URL,
  options: EdgeGuardOptions,
): Response | undefined => {
  const localEndpoint = localhostAllowedHostnames().includes(requestUrl.hostname);
  const workersDevEndpoint = requestUrl.hostname.endsWith(".workers.dev");
  const acceptedHostnames =
    options.allowedHostnames ??
    (localEndpoint
      ? localhostAllowedHostnames()
      : workersDevEndpoint
        ? [requestUrl.hostname]
        : undefined);

  if (acceptedHostnames !== undefined) {
    const hostRejection = hostHeaderValidationResponse(request, [...acceptedHostnames]);

    if (hostRejection !== undefined) {
      return hostRejection;
    }
  }

  if (options.allowedOriginHostnames === "*") {
    return undefined;
  }

  let acceptedOriginHostnames = options.allowedOriginHostnames;

  if (acceptedOriginHostnames === undefined) {
    const defaults = new Set(localhostAllowedOrigins());

    if (workersDevEndpoint) {
      defaults.add(requestUrl.hostname);
    }

    const configuredOriginHostname = corsOriginHostname(options.corsOptions);

    if (configuredOriginHostname !== undefined) {
      defaults.add(configuredOriginHostname);
    }

    acceptedOriginHostnames = [...defaults];
  }

  return originValidationResponse(request, [...acceptedOriginHostnames]);
};

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
  signal: AbortSignal,
) => Promise<CallToolResult>;

const handleToolCall = <Tools extends Record<string, Tool.Any>>(
  built: Toolkit.WithHandler<Tools>,
  tool: Tool.Any,
  params: Tool.Parameters<Tools[keyof Tools]>,
  toolCallId: string,
): Effect.Effect<CallToolResult, never, Tool.HandlerServices<Tools[keyof Tools]>> => {
  const isDeclaredFailure = Schema.is(tool.failureSchema);

  // SAFETY: registerToolkitTool only registers tools taken from `built.tools`,
  // so the tool name is a key of the toolkit's tools record.
  return built.handle(tool.name as keyof Tools, params, toolCallId).pipe(
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

const makeToolContext = (context: ServerContext): McpTool.ToolContext["Service"] => {
  const progressToken = context.mcpReq._meta?.progressToken;

  return {
    requestId: context.mcpReq.id,
    signal: context.mcpReq.signal,
    progressToken,
    reportProgress: (progress) =>
      progressToken === undefined
        ? Effect.void
        : Effect.tryPromise({
            try: () =>
              context.mcpReq.notify({
                method: "notifications/progress",
                params: { ...progress, progressToken },
              }),
            catch: (cause) => new McpTool.McpProgressError({ cause }),
          }),
  };
};

const registerToolkitTool = <Tools extends Record<string, Tool.Any>>(
  server: McpServer,
  built: Toolkit.WithHandler<Tools>,
  tool: Tool.Any,
  run: RunToolCallback<Exclude<Tool.HandlerServices<Tools[keyof Tools]>, McpTool.ToolContext>>,
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
    (args, context) => {
      // SAFETY: the SDK validated the arguments with the tool input schema,
      // whose `validate` keeps the encoded input, and the toolkit decodes the
      // parameters with the tool's Effect `Schema` before invoking the
      // handler.
      const params = (args ?? {}) as Tool.Parameters<Tools[keyof Tools]>;

      return run(
        handleToolCall(built, tool, params, String(context.mcpReq.id)).pipe(
          Effect.provideService(McpTool.ToolContext, makeToolContext(context)),
        ),
        context.mcpReq.signal,
      );
    },
  );
};

/**
 * Creates an Effect that serves a toolkit over MCP with the MCP SDK's
 * stateless Streamable HTTP handler (`createMcpHandler` from
 * `@modelcontextprotocol/server`), plus the Worker edge concerns Cloudflare's
 * remote MCP deployments expect: CORS, `Host` header validation, and browser
 * `Origin` validation.
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
 * Streaming responses return while tool calls are still running. The response
 * body owns the HTTP request scope, keeping tool fibers and event-layer services
 * alive until the body finishes or is canceled. Consume or cancel the returned
 * body to release those resources.
 *
 * Tools can declare `McpTool.ToolContext` in their dependencies and call
 * `McpTool.reportProgress` to send progress notifications. The bridge injects
 * the service per call and uses the client's progress token. For modern clients,
 * the default `responseMode: "auto"` streams notifications and `"json"` suppresses
 * them. The legacy compatibility transport always uses SSE for tool calls.
 * Toolkit preliminary results remain separate from MCP progress; only the
 * final encoded result becomes the `CallToolResult`.
 *
 * **Example**
 *
 * ```ts
 * import { Effect, Layer, Option } from "effect"
 * import { HttpRouter } from "effect/http"
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
  const {
    name,
    version,
    title,
    serverOptions,
    route = "/mcp",
    corsOptions,
    allowedHostnames,
    allowedOriginHostnames,
    ...handlerOptions
  } = options;
  const serverInfo = { name, version, title };

  return Effect.gen(function* () {
    const request = yield* NativeRequest;
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname !== route) {
      return Option.none();
    }

    const rejection = edgeGuardResponse(request, requestUrl, {
      corsOptions,
      allowedHostnames,
      allowedOriginHostnames,
    });

    if (rejection !== undefined) {
      return Option.some(withCors(rejection, corsOptions));
    }

    if (request.method === "OPTIONS" && corsOptions !== false) {
      return Option.some(new Response(null, { headers: corsHeaders(corsOptions ?? {}) }));
    }

    const built = yield* toolkit;

    const run = yield* FiberSet.makeRuntimePromise<
      Exclude<Tool.HandlerServices<Tools[keyof Tools]>, McpTool.ToolContext>,
      CallToolResult,
      never
    >();
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createMcpHandler(() => {
          const server = new McpServer(serverInfo, serverOptions);

          for (const tool of Object.values(built.tools)) {
            registerToolkitTool(server, built, tool, (effect, signal) => run(effect, { signal }));
          }

          return server;
        }, handlerOptions),
      ),
      (handler) => Effect.promise(() => handler.close()),
    );
    const response = yield* Effect.tryPromise(() => handler.fetch(request));
    const context = yield* Effect.context<never>();

    // Worker.make passes native Responses through. Transfer its HTTP scope here
    // so returning the headers cannot interrupt tools or release their services.
    return Option.some(
      HttpServerResponse.toWeb(
        HttpEffect.scopeTransferToStream(
          HttpServerResponse.fromWeb(withCors(response, corsOptions)),
        ),
        { context },
      ),
    );
  });
};
