import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Progress units are chosen by the tool and must increase on each update. */
export interface Progress {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export class McpProgressError extends Schema.TaggedError<McpProgressError>()("McpProgressError", {
  cause: Schema.Defect(),
}) {}

/**
 * Per-call context supplied by `Mcp.fromToolkit`. Declare it in the tool's
 * `dependencies` when reporting progress. The service belongs to one active
 * request and must not be retained after that call completes.
 */
export class ToolContext extends Context.Service<
  ToolContext,
  {
    readonly requestId: string | number;
    readonly progressToken: string | number | undefined;
    readonly signal: AbortSignal;
    readonly reportProgress: (progress: Progress) => Effect.Effect<void, McpProgressError>;
  }
>()("effect-cf/McpTool/ToolContext") {}

/**
 * Sends `notifications/progress` for the current tool call. Does nothing when
 * the client did not supply a progress token. For modern clients, the default
 * `responseMode: "auto"` streams notifications and `"json"` suppresses them.
 * The legacy compatibility transport always uses SSE for tool calls.
 */
export const reportProgress = Effect.fnUntraced(function* (progress: Progress) {
  const context = yield* ToolContext;

  yield* context.reportProgress(progress);
});
