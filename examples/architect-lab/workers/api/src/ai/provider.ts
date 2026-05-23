import { Duration, Effect, Layer, Schedule, Schema as S, Stream } from "effect";
import { AiError, LanguageModel, Response, Tool, Toolkit, type Prompt } from "effect/unstable/ai";

import {
  ArchitectureEdgeKind,
  ArchitectureResourceKind,
  getArchitectureResourceTemplate,
} from "@architect-lab/domain/architecture";
import {
  AiAddResourceNodeToolCall,
  AiAnnotateResourceToolCall,
  AiConnectResourcesToolCall,
  AiJob,
  AiPromptRequest,
  AiPromptResult,
  AiResourcePosition,
  AiToolCall,
  reasoningEffortForAiModel,
} from "@architect-lab/domain/ai";

export interface RealArchitectProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly chatCompletionsEndpoint?: string;
  readonly gatewayId?: string;
  readonly gatewayAuthToken?: string;
  readonly maxEstimatedCostCents: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly model: string;
  readonly retryAttempts: number;
  readonly timeoutMs: number;
}

export const resolveRealProviderChatCompletionsEndpoint = (
  options: Pick<RealArchitectProviderOptions, "baseUrl" | "chatCompletionsEndpoint">,
) => options.chatCompletionsEndpoint ?? `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;

const AddResourceNodeTool = Tool.make("add_resource_node", {
  description: "Add a semantic Cloudflare architecture resource to the canvas.",
  parameters: S.Struct({
    id: S.String,
    kind: ArchitectureResourceKind,
    name: S.String,
    bindingName: S.String,
    description: S.String,
    position: AiResourcePosition,
  }),
  success: S.Struct({ accepted: S.Boolean }),
});

const ConnectResourcesTool = Tool.make("connect_resources", {
  description: "Connect two semantic architecture resources with a labeled relationship.",
  parameters: S.Struct({
    id: S.String,
    kind: ArchitectureEdgeKind,
    sourceId: S.String,
    targetId: S.String,
    label: S.String,
  }),
  success: S.Struct({ accepted: S.Boolean }),
});

const AnnotateResourceTool = Tool.make("annotate_resource", {
  description: "Attach an architecture review note to a resource or edge.",
  parameters: S.Struct({
    id: S.String,
    subjectId: S.String,
    note: S.String,
    position: AiResourcePosition,
  }),
  success: S.Struct({ accepted: S.Boolean }),
});

export const ArchitectToolkit = Toolkit.make(
  AddResourceNodeTool,
  ConnectResourcesTool,
  AnnotateResourceTool,
);

type ArchitectToolCallPart = Response.ToolCallParts<Toolkit.Tools<typeof ArchitectToolkit>>;
export type ArchitectStreamPart = Response.StreamPart<Toolkit.Tools<typeof ArchitectToolkit>>;

export interface FakeArchitectLanguageModelOptions {
  readonly responseDelay?: Duration.Input;
  readonly streamPartDelay?: Duration.Input;
  readonly simulateLatency?: boolean;
}

const defaultFakeArchitectLanguageModelOptions = {
  responseDelay: "850 millis",
  streamPartDelay: "140 millis",
} satisfies FakeArchitectLanguageModelOptions;

const withFakeLatency = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: FakeArchitectLanguageModelOptions,
): Effect.Effect<A, E, R> =>
  options.simulateLatency === false
    ? effect
    : Effect.sleep(
        options.responseDelay ?? defaultFakeArchitectLanguageModelOptions.responseDelay,
      ).pipe(Effect.andThen(effect));

interface ResourcePlan {
  readonly key: string;
  readonly kind: AiAddResourceNodeToolCall["kind"];
  readonly name: string;
  readonly description: string;
  readonly position: AiResourcePosition;
}

interface EdgePlan {
  readonly key: string;
  readonly kind: AiConnectResourcesToolCall["kind"];
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly label: string;
}

interface FakePlan {
  readonly summary: string;
  readonly resources: ReadonlyArray<ResourcePlan>;
  readonly edges: ReadonlyArray<EdgePlan>;
  readonly annotations: ReadonlyArray<{
    readonly key: string;
    readonly subjectKey: string;
    readonly note: string;
    readonly position: AiResourcePosition;
  }>;
}

export const makeAiJob = (roomId: string, request: AiPromptRequest, now = new Date()): AiJob => ({
  id: `ai_job_${crypto.randomUUID()}`,
  roomId,
  prompt: request.prompt,
  model: request.model,
  actor: request.actor?.trim() || "Guest",
  submittedAt: now.toISOString(),
  readModel: request.readModel ?? { resources: [], edges: [] },
});

const makeFakeArchitectLanguageModelService = (
  job: AiJob,
  serviceOptions: FakeArchitectLanguageModelOptions = {},
) =>
  LanguageModel.make({
    generateText: (options) =>
      withFakeLatency(
        Effect.succeed(renderFakeModelParts(job, promptText(options.prompt))),
        serviceOptions,
      ),
    streamText: (streamOptions) => {
      const stream = Stream.fromIterable(
        renderFakeModelStreamParts(job, promptText(streamOptions.prompt)),
      );
      return serviceOptions.simulateLatency === false
        ? stream
        : stream.pipe(
            Stream.schedule(
              Schedule.spaced(
                serviceOptions.streamPartDelay ??
                  defaultFakeArchitectLanguageModelOptions.streamPartDelay,
              ),
            ),
          );
    },
  });

export const FakeArchitectLanguageModel = (
  job: AiJob,
  options?: FakeArchitectLanguageModelOptions,
) => Layer.effect(LanguageModel.LanguageModel, makeFakeArchitectLanguageModelService(job, options));

const provideFakeArchitectLanguageModel = <A, E>(
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel>,
  job: AiJob,
  options?: FakeArchitectLanguageModelOptions,
) =>
  Effect.provideServiceEffect(
    effect,
    LanguageModel.LanguageModel,
    makeFakeArchitectLanguageModelService(job, options),
  );

const generateFakeAiPromptResultEffect = Effect.fn("generateFakeAiPromptResult")(function* (
  job: AiJob,
  options?: FakeArchitectLanguageModelOptions,
) {
  const response = yield* LanguageModel.generateText({
    prompt: [
      {
        role: "system",
        content: "You are the Architect Lab fake provider. Return structured tool calls only.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roomId: job.roomId,
              jobId: job.id,
              prompt: job.prompt,
              readModel: job.readModel,
            }),
          },
        ],
      },
    ],
    toolkit: ArchitectToolkit,
    toolChoice: {
      mode: "required",
      oneOf: ["add_resource_node", "connect_resources", "annotate_resource"],
    },
    disableToolCallResolution: true as const,
  }).pipe((effect) => provideFakeArchitectLanguageModel(effect, job, options), Effect.orDie);

  return yield* S.decodeEffect(AiPromptResult)({
    jobId: job.id,
    roomId: job.roomId,
    status: "queued" as const,
    summary: response.text || selectFakePlan(job.prompt).summary,
    toolCalls: response.toolCalls.map(toAiToolCall),
    traceEvents: response.toolCalls.map((part) => {
      const toolCall = toAiToolCall(part);
      return {
        kind: "tool-call" as const,
        message: describeAiToolCall(toolCall),
        detail: toolCall.type,
      };
    }),
  }).pipe(Effect.orDie);
});

export const generateFakeAiPromptResult = (
  job: AiJob,
  options?: FakeArchitectLanguageModelOptions,
) => generateFakeAiPromptResultEffect(job, options);

export const streamFakeAiPromptParts = (job: AiJob, options?: FakeArchitectLanguageModelOptions) =>
  LanguageModel.streamText({
    prompt: [
      {
        role: "system",
        content: "You are the Architect Lab fake provider. Return structured tool calls only.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roomId: job.roomId,
              jobId: job.id,
              prompt: job.prompt,
              readModel: job.readModel,
            }),
          },
        ],
      },
    ],
    toolkit: ArchitectToolkit,
    toolChoice: {
      mode: "required",
      oneOf: ["add_resource_node", "connect_resources", "annotate_resource"],
    },
    disableToolCallResolution: true as const,
  }).pipe(
    Stream.provideServiceEffect(
      LanguageModel.LanguageModel,
      makeFakeArchitectLanguageModelService(job, options),
    ),
    Stream.orDie,
  );

const generateRealAiPromptResultEffect = Effect.fn("generateRealAiPromptResult")(function* (
  job: AiJob,
  options: RealArchitectProviderOptions,
) {
  const response = yield* LanguageModel.generateText({
    prompt: architectPrompt(job),
    toolkit: ArchitectToolkit,
    toolChoice: {
      mode: "required",
      oneOf: ["add_resource_node", "connect_resources", "annotate_resource"],
    },
    disableToolCallResolution: true as const,
  }).pipe((effect) => provideRealArchitectLanguageModel(effect, job, options));
  const toolCalls = response.toolCalls.slice(0, options.maxToolCalls).map(toAiToolCall);

  if (toolCalls.length === 0) {
    return yield* Effect.fail(new Error("Real provider returned no valid architecture tool calls"));
  }

  return yield* S.decodeEffect(AiPromptResult)({
    jobId: job.id,
    roomId: job.roomId,
    status: "queued" as const,
    summary: response.text || "Real provider returned architecture tool calls.",
    toolCalls,
    traceEvents: toolCalls.map((toolCall) => ({
      kind: "tool-call" as const,
      message: describeAiToolCall(toolCall),
      detail: toolCall.type,
    })),
  });
});

export const generateRealAiPromptResult = (job: AiJob, options: RealArchitectProviderOptions) =>
  generateRealAiPromptResultEffect(job, options);

const makeRealArchitectLanguageModelService = (job: AiJob, options: RealArchitectProviderOptions) =>
  LanguageModel.make({
    generateText: () =>
      Effect.gen(function* () {
        const response = yield* requestOpenAiCompatibleChatCompletions(job, options);
        const totalTokens = response.usage?.total_tokens ?? 0;
        const estimatedCostCents = estimateCostCents(totalTokens);

        if (estimatedCostCents > options.maxEstimatedCostCents) {
          return yield* aiProviderError(
            `Estimated provider cost ${estimatedCostCents.toFixed(4)} cents exceeded configured cap`,
          );
        }

        return yield* realProviderResponseParts(response, options);
      }),
    streamText: () =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const response = yield* requestOpenAiCompatibleChatCompletions(job, options);
          const totalTokens = response.usage?.total_tokens ?? 0;
          const estimatedCostCents = estimateCostCents(totalTokens);

          if (estimatedCostCents > options.maxEstimatedCostCents) {
            return yield* aiProviderError(
              `Estimated provider cost ${estimatedCostCents.toFixed(4)} cents exceeded configured cap`,
            );
          }

          return yield* realProviderStreamParts(response, options);
        }),
      ).pipe(Stream.flatMap(Stream.fromIterable)),
  });

const provideRealArchitectLanguageModel = <A, E>(
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel>,
  job: AiJob,
  options: RealArchitectProviderOptions,
) =>
  Effect.provideServiceEffect(
    effect,
    LanguageModel.LanguageModel,
    makeRealArchitectLanguageModelService(job, options),
  );

const RealProviderToolCall = S.Struct({
  id: S.optional(S.String),
  type: S.optional(S.String),
  function: S.Struct({
    arguments: S.String,
    name: S.String,
  }),
});
type RealProviderToolCall = S.Schema.Type<typeof RealProviderToolCall>;

const RealProviderResponse = S.Struct({
  choices: S.Array(
    S.Struct({
      finish_reason: S.optional(S.NullOr(S.String)),
      message: S.optional(
        S.Struct({
          content: S.optional(S.NullOr(S.String)),
          tool_calls: S.optional(S.NullOr(S.Array(RealProviderToolCall))),
        }),
      ),
    }),
  ),
  usage: S.optional(
    S.Struct({
      completion_tokens: S.optional(S.Number),
      completion_tokens_details: S.optional(
        S.Struct({
          reasoning_tokens: S.optional(S.Number),
        }),
      ),
      prompt_tokens: S.optional(S.Number),
      total_tokens: S.optional(S.Number),
    }),
  ),
});
type RealProviderResponse = S.Schema.Type<typeof RealProviderResponse>;

const requestOpenAiCompatibleChatCompletions = (
  job: AiJob,
  options: RealArchitectProviderOptions,
): Effect.Effect<RealProviderResponse, AiError.AiError> => {
  const request = Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      if (options.apiKey.trim() !== "") {
        headers.authorization = `Bearer ${options.apiKey}`;
      }

      if (options.gatewayAuthToken?.trim()) {
        headers["cf-aig-authorization"] = `Bearer ${options.gatewayAuthToken}`;
      }

      if (options.gatewayId?.trim() && options.gatewayId.trim() !== "default") {
        headers["cf-aig-gateway-id"] = options.gatewayId.trim();
      }

      try {
        let lastError: unknown;
        for (let attempt = 0; attempt <= options.retryAttempts; attempt += 1) {
          try {
            const response = await fetch(resolveRealProviderChatCompletionsEndpoint(options), {
              body: JSON.stringify({
                max_completion_tokens: options.maxOutputTokens,
                messages: [
                  {
                    role: "system",
                    content:
                      "You are Architect Lab. Return concise text and function tool calls for the Cloudflare architecture canvas.",
                  },
                  {
                    role: "user",
                    content: JSON.stringify({
                      jobId: job.id,
                      prompt: job.prompt,
                      readModel: job.readModel,
                      roomId: job.roomId,
                    }),
                  },
                ],
                model: options.model,
                parallel_tool_calls: false,
                ...reasoningOptionsForModel(options.model),
                tool_choice: "required",
                tools: realProviderTools,
              }),
              headers,
              method: "POST",
              signal: controller.signal,
            });

            if (!response.ok) {
              const body = await response.text();
              lastError = AiError.make({
                method: "chat.completions",
                module: "OpenAICompatibleChatCompletions",
                reason: AiError.reasonFromHttpStatus({
                  status: response.status,
                  description: `Provider returned ${response.status}: ${body}`,
                }),
              });
              continue;
            }

            return await response.json();
          } catch (error) {
            lastError = error;
          }
        }

        throw lastError instanceof Error ? lastError : new Error("Provider request failed");
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (cause) => providerCauseToAiError(cause),
  });

  return request.pipe(
    Effect.flatMap((json) =>
      S.decodeUnknownEffect(RealProviderResponse)(json).pipe(
        Effect.mapError((error) =>
          providerCauseToAiError(new Error(`Provider response decode failed: ${error.message}`)),
        ),
      ),
    ),
  );
};

const realProviderTools = [
  {
    type: "function",
    function: {
      name: "add_resource_node",
      description: "Add a semantic Cloudflare architecture resource to the canvas.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "name", "bindingName", "description", "position"],
        properties: {
          id: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "worker",
              "durable-object",
              "d1",
              "r2",
              "kv",
              "queue",
              "workflow",
              "images",
              "service-binding",
            ],
          },
          name: { type: "string" },
          bindingName: { type: "string" },
          description: { type: "string" },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_resources",
      description: "Connect two semantic architecture resources with a labeled relationship.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "sourceId", "targetId", "label"],
        properties: {
          id: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "http",
              "service-binding",
              "websocket",
              "queue-message",
              "workflow-start",
              "storage-read",
              "storage-write",
            ],
          },
          sourceId: { type: "string" },
          targetId: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "annotate_resource",
      description: "Attach an architecture review note to a resource or edge.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id", "subjectId", "note", "position"],
        properties: {
          id: { type: "string" },
          subjectId: { type: "string" },
          note: { type: "string" },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
          },
        },
      },
    },
  },
] as const;

const reasoningOptionsForModel = (model: string): { readonly reasoning_effort: "minimal" } | {} => {
  const reasoningEffort = reasoningEffortForAiModel(model);
  return reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort };
};

const readRealProviderToolCall = Effect.fn("readRealProviderToolCall")(function* (
  toolCall: RealProviderToolCall,
) {
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(toolCall.function.arguments),
    catch: (cause) =>
      providerCauseToAiError(
        new Error(
          `Provider returned invalid JSON for tool ${toolCall.function.name}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      ),
  });
  const parsedRecord =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;

  if (parsedRecord === undefined) {
    return yield* aiProviderError(
      `Provider returned non-object arguments for tool ${toolCall.function.name}`,
    );
  }

  switch (toolCall.function.name) {
    case "add_resource_node":
      return yield* S.decodeUnknownEffect(AiAddResourceNodeToolCall)({
        type: "add_resource_node",
        ...parsedRecord,
      }).pipe(
        Effect.mapError((error) => providerToolCallDecodeError(toolCall.function.name, error)),
      );
    case "connect_resources":
      return yield* S.decodeUnknownEffect(AiConnectResourcesToolCall)({
        type: "connect_resources",
        ...parsedRecord,
      }).pipe(
        Effect.mapError((error) => providerToolCallDecodeError(toolCall.function.name, error)),
      );
    case "annotate_resource":
      return yield* S.decodeUnknownEffect(AiAnnotateResourceToolCall)({
        type: "annotate_resource",
        ...parsedRecord,
      }).pipe(
        Effect.mapError((error) => providerToolCallDecodeError(toolCall.function.name, error)),
      );
    default:
      return yield* aiProviderError(`Provider returned unknown tool ${toolCall.function.name}`);
  }
});

const realProviderResponseParts = Effect.fn("realProviderResponseParts")(function* (
  response: RealProviderResponse,
  options: RealArchitectProviderOptions,
) {
  const message = response.choices[0]?.message;
  const finishReason = response.choices[0]?.finish_reason;
  const parts: Array<Response.PartEncoded> = [];

  if (finishReason !== undefined && finishReason !== null && finishReason !== "tool_calls") {
    return yield* aiProviderError(`Provider finished with ${finishReason} instead of tool_calls`);
  }

  if (typeof message?.content === "string" && message.content.trim() !== "") {
    parts.push({ type: "text", text: message.content });
  }

  for (const [index, toolCall] of (message?.tool_calls ?? [])
    .slice(0, options.maxToolCalls)
    .entries()) {
    const decoded = yield* readRealProviderToolCall(toolCall);
    parts.push(aiToolCallToPart(decoded, `real_${index}_call`));
  }

  parts.push(finishPartFromUsage(response.usage));

  return parts;
});

const realProviderStreamParts = (
  response: RealProviderResponse,
  options: RealArchitectProviderOptions,
): Effect.Effect<Array<Response.StreamPartEncoded>, AiError.AiError> =>
  realProviderResponseParts(response, options).pipe(
    Effect.map((parts) => {
      const streamParts: Array<Response.StreamPartEncoded> = [];
      const textPart = parts.find((part) => part.type === "text");

      for (const part of parts) {
        if (part.type === "tool-call") {
          streamParts.push(part);
        }
      }

      if (textPart?.type === "text") {
        streamParts.push(
          { type: "text-start", id: "real_summary" },
          { type: "text-delta", id: "real_summary", delta: textPart.text },
          { type: "text-end", id: "real_summary" },
        );
      }

      const finishPart = parts.find((part) => part.type === "finish");
      if (finishPart?.type === "finish") {
        streamParts.push(finishPart);
      }

      return streamParts;
    }),
  );

const aiToolCallToPart = (toolCall: AiToolCall, id: string): Response.PartEncoded => {
  switch (toolCall.type) {
    case "add_resource_node":
      return {
        type: "tool-call",
        id,
        name: "add_resource_node",
        providerExecuted: false,
        params: {
          id: toolCall.id,
          kind: toolCall.kind,
          name: toolCall.name,
          bindingName: toolCall.bindingName,
          description: toolCall.description,
          position: toolCall.position,
        },
      };
    case "connect_resources":
      return {
        type: "tool-call",
        id,
        name: "connect_resources",
        providerExecuted: false,
        params: {
          id: toolCall.id,
          kind: toolCall.kind,
          sourceId: toolCall.sourceId,
          targetId: toolCall.targetId,
          label: toolCall.label,
        },
      };
    case "annotate_resource":
      return {
        type: "tool-call",
        id,
        name: "annotate_resource",
        providerExecuted: false,
        params: {
          id: toolCall.id,
          subjectId: toolCall.subjectId,
          note: toolCall.note,
          position: toolCall.position,
        },
      };
  }
};

const finishPartFromUsage = (
  usage: RealProviderResponse["usage"] | undefined,
): Response.PartEncoded => ({
  type: "finish",
  reason: "tool-calls",
  response: undefined,
  usage: {
    inputTokens: {
      uncached: undefined,
      total: usage?.prompt_tokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.completion_tokens,
      text: undefined,
      reasoning: usage?.completion_tokens_details?.reasoning_tokens,
    },
  },
});

const aiProviderError = (description: string): Effect.Effect<never, AiError.AiError> =>
  Effect.fail(
    AiError.make({
      method: "generateText",
      module: "OpenAICompatibleChatCompletions",
      reason: new AiError.InvalidRequestError({ description }),
    }),
  );

const providerToolCallDecodeError = (toolName: string, error: Error): AiError.AiError =>
  AiError.make({
    method: "chat.completions",
    module: "OpenAICompatibleChatCompletions",
    reason: new AiError.InvalidRequestError({
      description: `Provider returned invalid arguments for tool ${toolName}: ${error.message}`,
    }),
  });

const providerCauseToAiError = (cause: unknown): AiError.AiError => {
  if (AiError.isAiError(cause)) {
    return cause;
  }

  return AiError.make({
    method: "chat.completions",
    module: "OpenAICompatibleChatCompletions",
    reason: new AiError.UnknownError({
      description: cause instanceof Error ? cause.message : "Provider request failed",
    }),
  });
};

const estimateCostCents = (totalTokens: number): number => (totalTokens / 1000) * 0.1;

export const isAiToolCallPart = (part: ArchitectStreamPart): part is ArchitectToolCallPart =>
  part.type === "tool-call";

export const aiToolCallFromPart = (part: ArchitectToolCallPart): AiToolCall => toAiToolCall(part);

export const describeAiToolCall = (toolCall: AiToolCall): string => {
  switch (toolCall.type) {
    case "add_resource_node":
      return `Placed ${resourceLabel(toolCall.kind)} "${toolCall.name}"`;
    case "connect_resources":
      return `Connected ${toolCall.sourceId} to ${toolCall.targetId}`;
    case "annotate_resource":
      return `Annotated ${toolCall.subjectId}`;
  }
};

const resourceLabel = (kind: AiAddResourceNodeToolCall["kind"]) =>
  getArchitectureResourceTemplate(kind).label;

const renderFakeModelParts = (
  job: AiJob,
  providerPromptText: string,
): Array<Response.PartEncoded> => {
  const plan = selectFakePlan(providerPromptText || job.prompt);
  const prefix = stablePrefix(job.id);
  const resourceIds = new Map<string, string>();
  const parts: Array<Response.PartEncoded> = [
    {
      type: "text",
      text: plan.summary,
    },
  ];

  for (const resource of plan.resources) {
    const id = `${prefix}_${resource.key}`;
    resourceIds.set(resource.key, id);
    parts.push({
      type: "tool-call",
      id: `${id}_call`,
      name: "add_resource_node",
      providerExecuted: false,
      params: {
        id,
        kind: resource.kind,
        name: resource.name,
        bindingName: bindingNameFor(resource.kind, resource.name),
        description: resource.description,
        position: resource.position,
      },
    });
  }

  for (const edge of plan.edges) {
    const sourceId = resourceIds.get(edge.sourceKey);
    const targetId = resourceIds.get(edge.targetKey);

    if (sourceId !== undefined && targetId !== undefined) {
      parts.push({
        type: "tool-call",
        id: `${prefix}_${edge.key}_call`,
        name: "connect_resources",
        providerExecuted: false,
        params: {
          id: `${prefix}_${edge.key}`,
          kind: edge.kind,
          sourceId,
          targetId,
          label: edge.label,
        },
      });
    }
  }

  for (const annotation of plan.annotations) {
    const subjectId = resourceIds.get(annotation.subjectKey);

    if (subjectId !== undefined) {
      parts.push({
        type: "tool-call",
        id: `${prefix}_${annotation.key}_call`,
        name: "annotate_resource",
        providerExecuted: false,
        params: {
          id: `${prefix}_${annotation.key}`,
          subjectId,
          note: annotation.note,
          position: annotation.position,
        },
      });
    }
  }

  parts.push({
    type: "finish",
    reason: "tool-calls",
    response: undefined,
    usage: {
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
    },
  });

  return parts;
};

const renderFakeModelStreamParts = (
  job: AiJob,
  providerPromptText: string,
): Array<Response.StreamPartEncoded> => {
  const parts = renderFakeModelParts(job, providerPromptText);
  const streamParts: Array<Response.StreamPartEncoded> = [];
  const textId = `${stablePrefix(job.id)}_summary`;
  const reasoningId = `${stablePrefix(job.id)}_reasoning`;
  const textPart = parts.find((part) => part.type === "text");
  const finishPart = parts.find((part) => part.type === "finish");

  streamParts.push(
    { type: "reasoning-start", id: reasoningId },
    {
      type: "reasoning-delta",
      id: reasoningId,
      delta: "Reading the prompt, current canvas read model, and available Cloudflare primitives.",
    },
    { type: "reasoning-end", id: reasoningId },
  );

  for (const part of parts) {
    if (part.type === "tool-call") {
      const toolCall = toAiToolCall(part as ArchitectToolCallPart);
      streamParts.push(
        { type: "reasoning-start", id: `${part.id}_reasoning` },
        {
          type: "reasoning-delta",
          id: `${part.id}_reasoning`,
          delta: describeAiToolCall(toolCall),
        },
        { type: "reasoning-end", id: `${part.id}_reasoning` },
      );
      streamParts.push(part);
    }
  }

  if (textPart?.type === "text") {
    streamParts.push(
      { type: "text-start", id: textId },
      { type: "text-delta", id: textId, delta: textPart.text },
      { type: "text-end", id: textId },
    );
  }

  if (finishPart?.type === "finish") {
    streamParts.push(finishPart);
  }

  return streamParts;
};

const toAiToolCall = (part: ArchitectToolCallPart): AiToolCall => {
  switch (part.name) {
    case "add_resource_node":
      return {
        type: "add_resource_node",
        ...part.params,
      };
    case "connect_resources":
      return {
        type: "connect_resources",
        ...part.params,
      };
    case "annotate_resource":
      return {
        type: "annotate_resource",
        ...part.params,
      };
  }
};

const promptText = (prompt: Prompt.Prompt): string => {
  const chunks: Array<string> = [];

  for (const message of prompt.content) {
    if (typeof message.content === "string") {
      chunks.push(message.content);
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n");
};

const architectPrompt = (job: AiJob) =>
  [
    {
      role: "system",
      content:
        "You are Architect Lab. Return concise text and function tool calls for the Cloudflare architecture canvas.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            jobId: job.id,
            prompt: job.prompt,
            readModel: job.readModel,
            roomId: job.roomId,
          }),
        },
      ],
    },
  ] as const;

const stablePrefix = (jobId: string): string => jobId.replace(/[^A-Za-z0-9_]/g, "_");

const bindingNameFor = (kind: AiAddResourceNodeToolCall["kind"], name: string): string => {
  const template = getArchitectureResourceTemplate(kind);
  const words = name.match(/[A-Za-z0-9]+/g) ?? [template.bindingPrefix];
  const binding = words.join("_").toUpperCase();
  return binding === "" ? template.bindingPrefix : binding;
};

const selectFakePlan = (prompt: string): FakePlan => {
  const normalized = prompt.toLowerCase();

  if (normalized.includes("image") || normalized.includes("publish")) {
    return imagePipelinePlan;
  }

  if (
    normalized.includes("shop") ||
    normalized.includes("checkout") ||
    normalized.includes("commerce") ||
    normalized.includes("order")
  ) {
    return commerceCheckoutPlan;
  }

  if (
    normalized.includes("auth") ||
    normalized.includes("login") ||
    normalized.includes("session") ||
    normalized.includes("identity")
  ) {
    return identityGatewayPlan;
  }

  if (
    normalized.includes("api gateway") ||
    normalized.includes("microservice") ||
    normalized.includes("service binding")
  ) {
    return apiGatewayPlan;
  }

  if (normalized.includes("chat") || normalized.includes("analytics")) {
    return chatAnalyticsPlan;
  }

  if (normalized.includes("asset") || normalized.includes("review")) {
    return assetReviewPlan;
  }

  return aiCanvasPlan;
};

const aiCanvasPlan: FakePlan = {
  summary: "Queued a local fake AI plan for a collaborative architecture canvas.",
  resources: [
    {
      key: "web",
      kind: "worker",
      name: "Canvas Web Worker",
      description: "Serves the room UI and forwards API traffic.",
      position: { x: -380, y: -160 },
    },
    {
      key: "api",
      kind: "worker",
      name: "Architect API Worker",
      description: "Owns room commands, prompt submission, and read models.",
      position: { x: -80, y: -160 },
    },
    {
      key: "room",
      kind: "durable-object",
      name: "Room Durable Object",
      description: "Stores tldraw sync state and room events.",
      position: { x: 220, y: -160 },
    },
    {
      key: "queue",
      kind: "queue",
      name: "AI Job Queue",
      description: "Runs prompt jobs asynchronously without external credentials.",
      position: { x: -80, y: 40 },
    },
    {
      key: "kv",
      kind: "kv",
      name: "Architecture Read Models",
      description: "Caches latest and published diagram read models.",
      position: { x: 220, y: 40 },
    },
  ],
  edges: [
    {
      key: "web-api",
      kind: "service-binding",
      sourceKey: "web",
      targetKey: "api",
      label: "Service binding API calls",
    },
    {
      key: "api-room",
      kind: "websocket",
      sourceKey: "api",
      targetKey: "room",
      label: "Tldraw sync WebSocket",
    },
    {
      key: "api-queue",
      kind: "queue-message",
      sourceKey: "api",
      targetKey: "queue",
      label: "Prompt job",
    },
    {
      key: "api-kv",
      kind: "storage-write",
      sourceKey: "api",
      targetKey: "kv",
      label: "Latest read model",
    },
  ],
  annotations: [
    {
      key: "review-note",
      subjectKey: "queue",
      note: "Fake provider uses the same tool-call contract as the real provider phase.",
      position: { x: -80, y: 230 },
    },
  ],
};

const assetReviewPlan: FakePlan = {
  summary: "Queued a local fake AI plan for a collaborative asset review system.",
  resources: [
    {
      key: "ingest",
      kind: "worker",
      name: "Review Ingest Worker",
      description: "Receives uploads and review commands.",
      position: { x: -390, y: -160 },
    },
    {
      key: "bucket",
      kind: "r2",
      name: "Asset Bucket",
      description: "Stores originals and review artifacts.",
      position: { x: -90, y: -160 },
    },
    {
      key: "room",
      kind: "durable-object",
      name: "Review Room",
      description: "Coordinates reviewers and live annotations.",
      position: { x: 210, y: -160 },
    },
    {
      key: "queue",
      kind: "queue",
      name: "Review Job Queue",
      description: "Runs thumbnail and policy checks.",
      position: { x: -90, y: 40 },
    },
    {
      key: "db",
      kind: "d1",
      name: "Review Database",
      description: "Indexes assets, reviewers, and decisions.",
      position: { x: 210, y: 40 },
    },
  ],
  edges: [
    {
      key: "upload",
      kind: "storage-write",
      sourceKey: "ingest",
      targetKey: "bucket",
      label: "Upload asset",
    },
    {
      key: "live",
      kind: "websocket",
      sourceKey: "ingest",
      targetKey: "room",
      label: "Live review session",
    },
    {
      key: "jobs",
      kind: "queue-message",
      sourceKey: "ingest",
      targetKey: "queue",
      label: "Generate review tasks",
    },
    {
      key: "index",
      kind: "storage-write",
      sourceKey: "queue",
      targetKey: "db",
      label: "Persist review result",
    },
  ],
  annotations: [
    {
      key: "consistency",
      subjectKey: "room",
      note: "Keep fast collaboration in the Durable Object; keep searchable history in D1.",
      position: { x: 210, y: 230 },
    },
  ],
};

const chatAnalyticsPlan: FakePlan = {
  summary: "Queued a local fake AI plan for real-time chat with analytics.",
  resources: [
    {
      key: "chat",
      kind: "worker",
      name: "Chat Worker",
      description: "Terminates HTTP and WebSocket chat traffic.",
      position: { x: -390, y: -130 },
    },
    {
      key: "room",
      kind: "durable-object",
      name: "Chat Room",
      description: "Coordinates live members and ordered messages.",
      position: { x: -90, y: -130 },
    },
    {
      key: "queue",
      kind: "queue",
      name: "Analytics Queue",
      description: "Buffers message analytics events.",
      position: { x: 210, y: -130 },
    },
    {
      key: "db",
      kind: "d1",
      name: "Analytics Database",
      description: "Stores aggregate room metrics.",
      position: { x: 210, y: 70 },
    },
  ],
  edges: [
    {
      key: "socket",
      kind: "websocket",
      sourceKey: "chat",
      targetKey: "room",
      label: "Chat WebSocket",
    },
    {
      key: "events",
      kind: "queue-message",
      sourceKey: "room",
      targetKey: "queue",
      label: "Message event",
    },
    {
      key: "metrics",
      kind: "storage-write",
      sourceKey: "queue",
      targetKey: "db",
      label: "Aggregate metrics",
    },
  ],
  annotations: [
    {
      key: "retry",
      subjectKey: "queue",
      note: "Queue retries protect analytics without slowing chat delivery.",
      position: { x: -90, y: 90 },
    },
  ],
};

const imagePipelinePlan: FakePlan = {
  summary: "Queued a local fake AI plan for image processing and publishing.",
  resources: [
    {
      key: "web",
      kind: "worker",
      name: "Publisher Worker",
      description: "Accepts uploads and serves published image pages.",
      position: { x: -390, y: -160 },
    },
    {
      key: "images",
      kind: "images",
      name: "Image Transformer",
      description: "Applies Cloudflare Images transforms.",
      position: { x: -90, y: -160 },
    },
    {
      key: "bucket",
      kind: "r2",
      name: "Published Image Bucket",
      description: "Stores generated renditions and manifests.",
      position: { x: 210, y: -160 },
    },
    {
      key: "workflow",
      kind: "workflow",
      name: "Publish Workflow",
      description: "Coordinates multi-step processing and rollback.",
      position: { x: -90, y: 40 },
    },
    {
      key: "kv",
      kind: "kv",
      name: "Public Cache",
      description: "Caches published image metadata.",
      position: { x: 210, y: 40 },
    },
  ],
  edges: [
    {
      key: "transform",
      kind: "storage-read",
      sourceKey: "web",
      targetKey: "images",
      label: "Transform request",
    },
    {
      key: "write",
      kind: "storage-write",
      sourceKey: "images",
      targetKey: "bucket",
      label: "Write rendition",
    },
    {
      key: "publish",
      kind: "workflow-start",
      sourceKey: "web",
      targetKey: "workflow",
      label: "Publish workflow",
    },
    {
      key: "cache",
      kind: "storage-write",
      sourceKey: "workflow",
      targetKey: "kv",
      label: "Update public cache",
    },
  ],
  annotations: [
    {
      key: "preview",
      subjectKey: "images",
      note: "Images is represented now; generated preview assets belong to the export phase.",
      position: { x: -90, y: 230 },
    },
  ],
};

const commerceCheckoutPlan: FakePlan = {
  summary: "Queued a local fake AI plan for a checkout and order-processing system.",
  resources: [
    {
      key: "storefront",
      kind: "worker",
      name: "Storefront Worker",
      description: "Serves product pages and checkout requests.",
      position: { x: -430, y: -170 },
    },
    {
      key: "cart",
      kind: "durable-object",
      name: "Cart Session",
      description: "Keeps per-customer cart state close to the edge.",
      position: { x: -130, y: -170 },
    },
    {
      key: "orders",
      kind: "queue",
      name: "Order Queue",
      description: "Buffers checkout work and payment reconciliation.",
      position: { x: 170, y: -170 },
    },
    {
      key: "fulfillment",
      kind: "workflow",
      name: "Fulfillment Workflow",
      description: "Coordinates inventory, payment, email, and rollback steps.",
      position: { x: 170, y: 40 },
    },
    {
      key: "db",
      kind: "d1",
      name: "Order Database",
      description: "Stores orders, line items, and fulfillment state.",
      position: { x: -130, y: 40 },
    },
    {
      key: "cache",
      kind: "kv",
      name: "Product Cache",
      description: "Caches catalog and price display data.",
      position: { x: -430, y: 40 },
    },
  ],
  edges: [
    {
      key: "catalog",
      kind: "storage-read",
      sourceKey: "storefront",
      targetKey: "cache",
      label: "Read catalog cache",
    },
    {
      key: "cart-session",
      kind: "websocket",
      sourceKey: "storefront",
      targetKey: "cart",
      label: "Live cart session",
    },
    {
      key: "checkout",
      kind: "queue-message",
      sourceKey: "storefront",
      targetKey: "orders",
      label: "Checkout command",
    },
    {
      key: "fulfill",
      kind: "workflow-start",
      sourceKey: "orders",
      targetKey: "fulfillment",
      label: "Start fulfillment",
    },
    {
      key: "persist",
      kind: "storage-write",
      sourceKey: "fulfillment",
      targetKey: "db",
      label: "Persist order state",
    },
  ],
  annotations: [
    {
      key: "checkout-boundary",
      subjectKey: "fulfillment",
      note: "Workflow owns compensating steps so checkout stays fast and retryable.",
      position: { x: 170, y: 230 },
    },
  ],
};

const identityGatewayPlan: FakePlan = {
  summary: "Queued a local fake AI plan for an identity-aware API gateway.",
  resources: [
    {
      key: "gateway",
      kind: "worker",
      name: "Identity Gateway",
      description: "Terminates requests, validates sessions, and routes API calls.",
      position: { x: -390, y: -160 },
    },
    {
      key: "sessions",
      kind: "kv",
      name: "Session Store",
      description: "Caches short-lived session metadata.",
      position: { x: -90, y: -160 },
    },
    {
      key: "profile",
      kind: "service-binding",
      name: "Profile Service",
      description: "Typed service binding for user profile lookups.",
      position: { x: 210, y: -160 },
    },
    {
      key: "audit",
      kind: "queue",
      name: "Audit Queue",
      description: "Streams auth events into asynchronous audit processing.",
      position: { x: -90, y: 40 },
    },
    {
      key: "db",
      kind: "d1",
      name: "Audit Database",
      description: "Stores login attempts and security review events.",
      position: { x: 210, y: 40 },
    },
  ],
  edges: [
    {
      key: "session-read",
      kind: "storage-read",
      sourceKey: "gateway",
      targetKey: "sessions",
      label: "Validate session",
    },
    {
      key: "profile-call",
      kind: "service-binding",
      sourceKey: "gateway",
      targetKey: "profile",
      label: "Load profile",
    },
    {
      key: "audit-event",
      kind: "queue-message",
      sourceKey: "gateway",
      targetKey: "audit",
      label: "Audit event",
    },
    {
      key: "audit-write",
      kind: "storage-write",
      sourceKey: "audit",
      targetKey: "db",
      label: "Persist audit record",
    },
  ],
  annotations: [
    {
      key: "session-risk",
      subjectKey: "sessions",
      note: "Keep session values small and expire aggressively; durable user state belongs elsewhere.",
      position: { x: -90, y: 230 },
    },
  ],
};

const apiGatewayPlan: FakePlan = {
  summary: "Queued a local fake AI plan for a service-binding API gateway.",
  resources: [
    {
      key: "gateway",
      kind: "worker",
      name: "API Gateway Worker",
      description: "Validates requests and routes to internal services.",
      position: { x: -390, y: -140 },
    },
    {
      key: "billing",
      kind: "service-binding",
      name: "Billing Service",
      description: "Handles account and invoice commands through typed RPC.",
      position: { x: -90, y: -220 },
    },
    {
      key: "content",
      kind: "service-binding",
      name: "Content Service",
      description: "Serves product and CMS read paths through a binding.",
      position: { x: -90, y: -60 },
    },
    {
      key: "limits",
      kind: "durable-object",
      name: "Rate Limit Bucket",
      description: "Coordinates per-tenant rate limit counters.",
      position: { x: 210, y: -140 },
    },
    {
      key: "metrics",
      kind: "queue",
      name: "Metrics Queue",
      description: "Buffers request metrics for asynchronous aggregation.",
      position: { x: 210, y: 70 },
    },
  ],
  edges: [
    {
      key: "billing-call",
      kind: "service-binding",
      sourceKey: "gateway",
      targetKey: "billing",
      label: "Billing RPC",
    },
    {
      key: "content-call",
      kind: "service-binding",
      sourceKey: "gateway",
      targetKey: "content",
      label: "Content RPC",
    },
    {
      key: "limit-check",
      kind: "http",
      sourceKey: "gateway",
      targetKey: "limits",
      label: "Rate limit check",
    },
    {
      key: "metrics-event",
      kind: "queue-message",
      sourceKey: "gateway",
      targetKey: "metrics",
      label: "Request metric",
    },
  ],
  annotations: [
    {
      key: "gateway-note",
      subjectKey: "gateway",
      note: "Keep routing and policy at the gateway; move domain behavior into bound services.",
      position: { x: -390, y: 80 },
    },
  ],
};
