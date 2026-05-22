import { Config, Schema as S } from "effect";
import { D1, DurableObject, Kv, Queue, R2, Worker, WorkerConfig, Workflow } from "effect-cf";

import { AiJob, AiPromptResult, AiToolCallApplyRequest } from "./ai";
import { ArchitectureReadModel, PublishedArchitectureReadModel } from "./architecture";

import {
  ApiHealth,
  CreateRoomResult,
  RoomHealth,
  RoomId,
  RoomMetadata,
  TransportEventInput,
  TransportEventReceipt,
} from "./contracts";
import { TraceStartRoomRequest, TraceState } from "./trace";
import { ExportWorkflowPayload, ExportWorkflowResult } from "./export";

export const ArchitectConfig = Config.all({
  publicOrigin: WorkerConfig.string("ARCHITECT_PUBLIC_ORIGIN").pipe(
    Config.withDefault("http://localhost:8787"),
  ),
  defaultRoomTitle: WorkerConfig.string("ARCHITECT_DEFAULT_ROOM_TITLE").pipe(
    Config.withDefault("Untitled architecture"),
  ),
  fakeAiStreamDelayMs: WorkerConfig.number("ARCHITECT_FAKE_AI_STREAM_DELAY_MS").pipe(
    Config.withDefault(180),
  ),
  aiProviderMode: WorkerConfig.string("ARCHITECT_AI_PROVIDER").pipe(Config.withDefault("fake")),
  aiProviderBaseUrl: WorkerConfig.string("ARCHITECT_AI_PROVIDER_BASE_URL").pipe(
    Config.withDefault("https://api.openai.com/v1"),
  ),
  aiProviderApiKey: WorkerConfig.string("ARCHITECT_AI_PROVIDER_API_KEY").pipe(
    Config.withDefault(""),
  ),
  aiProviderModel: WorkerConfig.string("ARCHITECT_AI_MODEL").pipe(
    Config.withDefault("gpt-4.1-mini"),
  ),
  aiProviderTimeoutMs: WorkerConfig.number("ARCHITECT_AI_TIMEOUT_MS").pipe(
    Config.withDefault(20_000),
  ),
  aiProviderRetryAttempts: WorkerConfig.number("ARCHITECT_AI_RETRY_ATTEMPTS").pipe(
    Config.withDefault(1),
  ),
  aiProviderMaxToolCalls: WorkerConfig.number("ARCHITECT_AI_MAX_TOOL_CALLS").pipe(
    Config.withDefault(12),
  ),
  aiProviderMaxOutputTokens: WorkerConfig.number("ARCHITECT_AI_MAX_OUTPUT_TOKENS").pipe(
    Config.withDefault(1_200),
  ),
  aiProviderMaxEstimatedCostCents: WorkerConfig.number(
    "ARCHITECT_AI_MAX_ESTIMATED_COST_CENTS",
  ).pipe(Config.withDefault(10)),
});

export class RoomDurableObject extends DurableObject.Tag<RoomDurableObject>()(
  "ArchitectRoomDurableObject",
  {
    getMetadata: DurableObject.method({
      args: [RoomId] as const,
      success: RoomMetadata,
    }),
    getHealth: DurableObject.method({
      args: [RoomId] as const,
      success: RoomHealth,
    }),
    recordTransportEvent: DurableObject.method({
      args: [TransportEventInput] as const,
      success: TransportEventReceipt,
    }),
    applyAiToolCalls: DurableObject.method({
      args: [AiToolCallApplyRequest] as const,
      success: AiPromptResult,
    }),
    startTrace: DurableObject.method({
      args: [TraceStartRoomRequest] as const,
      success: TraceState,
    }),
  },
) {}

export class ApiWorker extends Worker.Tag<ApiWorker>()("ArchitectApiWorker", {
  health: Worker.method({
    success: ApiHealth,
  }),
  createRoom: Worker.method({
    success: CreateRoomResult,
  }),
  roomHealth: Worker.method({
    args: [RoomId] as const,
    success: RoomHealth,
  }),
}) {}

export class LatestArchitectureReadModels extends Kv.Tag<LatestArchitectureReadModels>()(
  "ArchitectLatestArchitectureReadModels",
  {
    key: S.String,
    value: ArchitectureReadModel,
  },
) {}

export class PublishedArchitectureReadModels extends Kv.Tag<PublishedArchitectureReadModels>()(
  "ArchitectPublishedArchitectureReadModels",
  {
    key: S.String,
    value: PublishedArchitectureReadModel,
  },
) {}

export class AiJobQueue extends Queue.Tag<AiJobQueue>()("ArchitectAiJobQueue", {
  message: AiJob,
}) {}

export class ExportStatusDatabase extends D1.Service<ExportStatusDatabase>()(
  "ArchitectExportStatusDatabase",
  {
    binding: "ARCHITECT_EXPORTS_DB",
  },
) {}

export class ExportArtifacts extends R2.Tag<ExportArtifacts>()("ArchitectExportArtifacts") {}

export class ArchitectExportWorkflow extends Workflow.Tag<ArchitectExportWorkflow>()(
  "ArchitectExportWorkflow",
  {
    payload: ExportWorkflowPayload,
    result: ExportWorkflowResult,
  },
) {}
