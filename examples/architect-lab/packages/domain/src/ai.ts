import { Schema as S } from "effect";

import {
  ArchitectureEdgeKind,
  ArchitectureReadModelInput,
  ArchitectureResourceKind,
} from "./architecture";

export const AiGatewayModelIds = [
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "grok/grok-4-fast-non-reasoning",
] as const;
export type AiGatewayModelId = (typeof AiGatewayModelIds)[number];
export const DefaultAiGatewayModelId: AiGatewayModelId = "openai/gpt-5-mini";
export const AiGatewayModel = S.Literals(AiGatewayModelIds);

export const AiModelProfiles = [
  {
    gatewayModelId: "openai/gpt-5-mini",
    provider: "openai",
    providerModelId: "gpt-5-mini",
    reasoningEffort: "minimal",
  },
  {
    gatewayModelId: "openai/gpt-5-nano",
    provider: "openai",
    providerModelId: "gpt-5-nano",
    reasoningEffort: "minimal",
  },
  {
    gatewayModelId: "grok/grok-4-fast-non-reasoning",
    provider: "grok",
    providerModelId: "grok-4-fast-non-reasoning",
  },
] as const;

export type AiModelProfile = (typeof AiModelProfiles)[number];

export const resolveAiGatewayModelId = (model: string | undefined): string =>
  AiModelProfiles.find(
    (profile) => profile.gatewayModelId === model || profile.providerModelId === model,
  )?.gatewayModelId ??
  model ??
  DefaultAiGatewayModelId;

export const resolveAiProviderModelId = (model: string | undefined): string =>
  AiModelProfiles.find(
    (profile) => profile.gatewayModelId === model || profile.providerModelId === model,
  )?.providerModelId ??
  model ??
  "gpt-5-mini";

export const reasoningEffortForAiModel = (model: string): "minimal" | undefined => {
  const profile = AiModelProfiles.find(
    (profile) => profile.gatewayModelId === model || profile.providerModelId === model,
  );
  return profile !== undefined && "reasoningEffort" in profile
    ? profile.reasoningEffort
    : undefined;
};

export const AiPromptRequest = S.Struct({
  prompt: S.String,
  actor: S.optional(S.String),
  model: S.optional(AiGatewayModel),
  readModel: S.optional(ArchitectureReadModelInput),
});
export type AiPromptRequest = S.Schema.Type<typeof AiPromptRequest>;

export const AiJob = S.Struct({
  id: S.String,
  roomId: S.String,
  prompt: S.String,
  model: S.optional(AiGatewayModel),
  actor: S.String,
  submittedAt: S.String,
  readModel: ArchitectureReadModelInput,
});
export type AiJob = S.Schema.Type<typeof AiJob>;

export const AiResourcePosition = S.Struct({
  x: S.Number,
  y: S.Number,
});
export type AiResourcePosition = S.Schema.Type<typeof AiResourcePosition>;

export const AiAddResourceNodeToolCall = S.Struct({
  type: S.Literal("add_resource_node"),
  id: S.String,
  kind: ArchitectureResourceKind,
  name: S.String,
  bindingName: S.String,
  description: S.String,
  position: AiResourcePosition,
});
export type AiAddResourceNodeToolCall = S.Schema.Type<typeof AiAddResourceNodeToolCall>;

export const AiConnectResourcesToolCall = S.Struct({
  type: S.Literal("connect_resources"),
  id: S.String,
  kind: ArchitectureEdgeKind,
  sourceId: S.String,
  targetId: S.String,
  label: S.String,
});
export type AiConnectResourcesToolCall = S.Schema.Type<typeof AiConnectResourcesToolCall>;

export const AiAnnotateResourceToolCall = S.Struct({
  type: S.Literal("annotate_resource"),
  id: S.String,
  subjectId: S.String,
  note: S.String,
  position: AiResourcePosition,
});
export type AiAnnotateResourceToolCall = S.Schema.Type<typeof AiAnnotateResourceToolCall>;

export const AiToolCall = S.Union([
  AiAddResourceNodeToolCall,
  AiConnectResourcesToolCall,
  AiAnnotateResourceToolCall,
]);
export type AiToolCall = S.Schema.Type<typeof AiToolCall>;

export const AiPromptTraceEvent = S.Struct({
  kind: S.Literals(["reasoning", "tool-call", "completion"] as const),
  message: S.String,
  detail: S.optional(S.String),
});
export type AiPromptTraceEvent = S.Schema.Type<typeof AiPromptTraceEvent>;

export const AiPromptResult = S.Struct({
  jobId: S.String,
  roomId: S.String,
  status: S.Literal("queued"),
  summary: S.String,
  toolCalls: S.Array(AiToolCall),
  traceEvents: S.Array(AiPromptTraceEvent),
});
export type AiPromptResult = S.Schema.Type<typeof AiPromptResult>;

export const AiToolCallApplyRequest = S.Struct({
  jobId: S.String,
  roomId: S.String,
  actor: S.String,
  summary: S.String,
  readModel: ArchitectureReadModelInput,
  toolCalls: S.Array(AiToolCall),
});
export type AiToolCallApplyRequest = S.Schema.Type<typeof AiToolCallApplyRequest>;

export const AiProviderMode = S.Literals(["fake", "real"] as const);
export type AiProviderMode = S.Schema.Type<typeof AiProviderMode>;

export const resolveAiProviderMode = (value: string | undefined): AiProviderMode =>
  value === "real" ? "real" : "fake";
