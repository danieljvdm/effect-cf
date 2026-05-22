import { Effect, Layer, Option, Schema as S, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Worker, WorkerConfig, Workflow } from "effect-cf";

import {
  AiJob,
  AiPromptRequest,
  AiPromptResult,
  AiPromptTraceEvent,
  AiToolCall,
  aiToolCallFromPart,
  describeAiToolCall,
  generateFakeAiPromptResult,
  generateRealAiPromptResult,
  isAiToolCallPart,
  makeAiJob,
  resolveAiProviderMode,
  streamFakeAiPromptParts,
} from "@architect-lab/domain/ai";
import {
  ArchitectureReadModelInput,
  type ArchitectureReadModelInput as ArchitectureReadModelInputType,
  latestArchitectureReadModelKey,
  publishedArchitectureReadModelKey,
} from "@architect-lab/domain/architecture";
import {
  ExportJobStatus,
  ExportManifest,
  type ExportStartRequest,
  type ExportWorkflowPayload,
  exportManifestKey,
  makeExportPackage,
} from "@architect-lab/domain/export";
import {
  AiJobQueue,
  ApiWorker as ApiDefinition,
  ArchitectConfig,
  ArchitectExportWorkflow,
  ExportArtifacts,
  ExportStatusDatabase,
  LatestArchitectureReadModels,
  PublishedArchitectureReadModels,
  RoomDurableObject,
} from "@architect-lab/domain/runtime";
import { type RoomHealth, type RoomId } from "@architect-lab/domain/contracts";
import { ArchitectHttpApi } from "@architect-lab/domain/http-api";
import {
  type ArchitectureReviewFinding,
  type ArchitectureReviewRequest,
  type ReviewFindingDecisionRequest,
  type TraceStartRequest,
  makeArchitectureReviewFindings,
  makeTraceDefinition,
} from "@architect-lab/domain/trace";
import {
  type VoiceSuggestion,
  type VoiceSuggestionDecisionRequest,
  type VoiceSuggestionRequest,
  type VoiceTranscriptRequest,
  makeVoiceTranscriptEvent,
} from "@architect-lab/domain/voice";
export { RoomDurableObject } from "@architect-lab/room";

const ApiLayer = Layer.mergeAll(
  RoomDurableObject.layer({ binding: "ROOMS" }),
  AiJobQueue.layer({ binding: "AI_JOBS" }),
  LatestArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  PublishedArchitectureReadModels.layer({ binding: "ARCHITECT_READ_MODELS" }),
  ExportStatusDatabase.layer,
  ExportArtifacts.layer({ binding: "ARCHITECT_EXPORTS" }),
  ArchitectExportWorkflow.layer({ binding: "ARCHITECT_EXPORT_WORKFLOW" }),
  WorkerConfig.layer,
);

const ExportWorkflowLayer = Layer.mergeAll(
  RoomDurableObject.layer({ binding: "ROOMS" }),
  ExportStatusDatabase.layer,
  ExportArtifacts.layer({ binding: "ARCHITECT_EXPORTS" }),
  WorkerConfig.layer,
);

const decodeAiJob = S.decodeUnknownEffect(AiJob);

const createRoom = Effect.fn("createRoom")(function* () {
  const config = yield* ArchitectConfig;
  const roomId = `room_${crypto.randomUUID()}`;
  const metadata = yield* RoomDurableObject.byName(roomId).getMetadata(roomId);

  return {
    roomId,
    metadata,
    roomUrl: `${config.publicOrigin}/room/${roomId}`,
  };
});

const roomHealth = Effect.fn("roomHealth")(
  (roomId: RoomId): Effect.Effect<RoomHealth, unknown, RoomDurableObject> =>
    RoomDurableObject.byName(roomId).getHealth(roomId),
);

const emptyReadModel = (roomId: RoomId) => ({
  roomId,
  resources: [],
  edges: [],
  updatedAt: new Date().toISOString(),
});

const getLatestReadModel = Effect.fn("getLatestReadModel")(function* (roomId: RoomId) {
  const cache = yield* LatestArchitectureReadModels;
  const cached = yield* cache.get(latestArchitectureReadModelKey(roomId));
  return Option.getOrElse(cached, () => emptyReadModel(roomId));
});

const saveLatestReadModel = Effect.fn("saveLatestReadModel")(function* (
  roomId: RoomId,
  input: ArchitectureReadModelInput,
) {
  const cache = yield* LatestArchitectureReadModels;
  const model = {
    roomId,
    resources: input.resources,
    edges: input.edges,
    updatedAt: new Date().toISOString(),
  };

  yield* cache.put(latestArchitectureReadModelKey(roomId), model);

  return model;
});

const publishReadModel = Effect.fn("publishReadModel")(function* (roomId: RoomId) {
  const config = yield* ArchitectConfig;
  const cache = yield* PublishedArchitectureReadModels;
  const model = yield* getLatestReadModel(roomId);
  const shareSlug = crypto.randomUUID().slice(0, 8);
  const published = {
    shareSlug,
    roomId,
    publishedAt: new Date().toISOString(),
    model,
  };

  yield* cache.put(publishedArchitectureReadModelKey(shareSlug), published);

  return {
    ...published,
    shareUrl: `${config.publicOrigin}/published/${shareSlug}`,
  };
});

interface ExportStatusRow {
  readonly artifact_count: number;
  readonly created_at: string;
  readonly export_id: string;
  readonly manifest_key: string | null;
  readonly manifest_url: string | null;
  readonly message: string;
  readonly room_id: string;
  readonly status: string;
  readonly updated_at: string;
  readonly workflow_id: string | null;
}

const ensureExportTables = Effect.fn("ensureExportTables")(function* () {
  const db = yield* ExportStatusDatabase;

  yield* Effect.tryPromise(() =>
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS architect_exports (
          export_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          status TEXT NOT NULL,
          workflow_id TEXT,
          manifest_key TEXT,
          manifest_url TEXT,
          artifact_count INTEGER NOT NULL DEFAULT 0,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      )
      .run(),
  );
});

const writeExportStatus = Effect.fn("writeExportStatus")(function* (status: ExportJobStatus) {
  const db = yield* ExportStatusDatabase;

  yield* ensureExportTables();
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        `INSERT INTO architect_exports (
          export_id,
          room_id,
          status,
          workflow_id,
          manifest_key,
          manifest_url,
          artifact_count,
          message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(export_id) DO UPDATE SET
          room_id = excluded.room_id,
          status = excluded.status,
          workflow_id = excluded.workflow_id,
          manifest_key = excluded.manifest_key,
          manifest_url = excluded.manifest_url,
          artifact_count = excluded.artifact_count,
          message = excluded.message,
          updated_at = excluded.updated_at`,
      )
      .bind(
        status.exportId,
        status.roomId,
        status.status,
        status.workflowId ?? null,
        status.manifestKey ?? null,
        status.manifestUrl ?? null,
        status.artifactCount,
        status.message,
        status.createdAt,
        status.updatedAt,
      )
      .run(),
  );

  return status;
});

const readExportStatus = Effect.fn("readExportStatus")(function* (
  roomId: RoomId,
  exportId: string,
) {
  const db = yield* ExportStatusDatabase;

  yield* ensureExportTables();
  const row = yield* Effect.tryPromise(() =>
    db
      .prepare("SELECT * FROM architect_exports WHERE room_id = ? AND export_id = ?")
      .bind(roomId, exportId)
      .first<ExportStatusRow>(),
  );

  return row === null ? Option.none<ExportJobStatus>() : Option.some(exportStatusFromRow(row));
});

const exportStatusFromRow = (row: ExportStatusRow): ExportJobStatus => ({
  artifactCount: row.artifact_count,
  createdAt: row.created_at,
  exportId: row.export_id,
  manifestKey: row.manifest_key ?? undefined,
  manifestUrl: row.manifest_url ?? undefined,
  message: row.message,
  roomId: row.room_id,
  status:
    row.status === "queued" ||
    row.status === "running" ||
    row.status === "completed" ||
    row.status === "failed"
      ? row.status
      : "failed",
  updatedAt: row.updated_at,
  workflowId: row.workflow_id ?? undefined,
});

const exportManifestUrl = (roomId: RoomId, exportId: string): string =>
  `/api/rooms/${roomId}/exports/${exportId}/manifest`;

const recordExportEvent = Effect.fn("recordExportEvent")(function* (
  status: ExportJobStatus,
  actor: string,
) {
  yield* RoomDurableObject.byName(status.roomId).recordTransportEvent({
    roomId: status.roomId,
    actor,
    kind: `export.${status.status}`,
    payloadJson: JSON.stringify({ status }),
  });
});

const startExport = Effect.fn("startExport")(function* (roomId: RoomId, input: ExportStartRequest) {
  const actor = input.actor?.trim() || "Guest";
  const exportId = `export_${crypto.randomUUID()}`;
  const requestedAt = new Date().toISOString();
  const queued = yield* writeExportStatus({
    artifactCount: 0,
    createdAt: requestedAt,
    exportId,
    manifestUrl: exportManifestUrl(roomId, exportId),
    message: "Queued export workflow",
    roomId,
    status: "queued",
    updatedAt: requestedAt,
  });
  const instance = yield* ArchitectExportWorkflow.create({
    actor,
    exportId,
    readModel: input.readModel,
    requestedAt,
    roomId,
  });
  const status = yield* writeExportStatus({
    ...queued,
    message: "Workflow instance started",
    updatedAt: new Date().toISOString(),
    workflowId: instance.id,
  });

  yield* recordExportEvent(status, actor);

  return status;
});

const readExportManifest = Effect.fn("readExportManifest")(function* (
  roomId: RoomId,
  exportId: string,
) {
  const bucket = yield* ExportArtifacts;
  const status = yield* readExportStatus(roomId, exportId);

  if (Option.isNone(status) || status.value.manifestKey === undefined) {
    return Option.none<ExportManifest>();
  }

  const object = yield* bucket.get(status.value.manifestKey);
  if (Option.isNone(object)) {
    return Option.none<ExportManifest>();
  }

  const json = yield* object.value.json<unknown>();
  return Option.some(yield* S.decodeUnknownEffect(ExportManifest)(json));
});

const submitAiPrompt = Effect.fn("submitAiPrompt")(function* (
  roomId: RoomId,
  input: AiPromptRequest,
) {
  const config = yield* ArchitectConfig;
  const job = makeAiJob(roomId, input);
  const room = RoomDurableObject.byName(roomId);
  const traceEvents: Array<AiPromptTraceEvent> = [];
  const toolCalls: Array<AiToolCall> = [];
  let summary = "";
  let rollingReadModel: ArchitectureReadModelInputType = job.readModel;

  const trace = (event: AiPromptTraceEvent) => {
    traceEvents.push(event);
    return room.recordTransportEvent({
      roomId,
      actor: "ai-architect",
      kind: `ai.${event.kind}`,
      payloadJson: JSON.stringify({
        jobId: job.id,
        ...event,
      }),
    });
  };

  yield* room.recordTransportEvent({
    roomId,
    actor: job.actor,
    kind: "ai.prompt.submitted",
    payloadJson: JSON.stringify({
      jobId: job.id,
      prompt: job.prompt,
    }),
  });

  if (resolveAiProviderMode(config.aiProviderMode) === "real") {
    yield* trace({
      kind: "reasoning",
      message: `Calling configured real AI provider model ${config.aiProviderModel}`,
      detail: job.prompt,
    });

    if (config.aiProviderApiKey.trim() === "") {
      return yield* Effect.fail(
        new Error("ARCHITECT_AI_PROVIDER_API_KEY is required when ARCHITECT_AI_PROVIDER=real"),
      );
    }

    const result = yield* generateRealAiPromptResult(job, {
      apiKey: config.aiProviderApiKey,
      baseUrl: config.aiProviderBaseUrl,
      maxEstimatedCostCents: config.aiProviderMaxEstimatedCostCents,
      maxOutputTokens: config.aiProviderMaxOutputTokens,
      maxToolCalls: config.aiProviderMaxToolCalls,
      model: config.aiProviderModel,
      retryAttempts: config.aiProviderRetryAttempts,
      timeoutMs: config.aiProviderTimeoutMs,
    });

    for (const event of result.traceEvents) {
      yield* trace(event);
    }

    if (result.toolCalls.length > 0) {
      const accepted = yield* room.applyAiToolCalls({
        jobId: job.id,
        roomId,
        actor: "ai-architect",
        summary: result.summary,
        readModel: rollingReadModel,
        toolCalls: result.toolCalls,
      });

      toolCalls.push(...accepted.toolCalls);
    }

    yield* trace({
      kind: "completion",
      message: result.summary,
      detail: `${toolCalls.length} accepted tool calls`,
    });
    yield* AiJobQueue.send(job);
    yield* room.recordTransportEvent({
      roomId,
      actor: "ai-architect",
      kind: "ai.job.queued",
      payloadJson: JSON.stringify({
        jobId: job.id,
        provider: "real",
        summary: result.summary,
        toolCalls: toolCalls.length,
      }),
    });

    return {
      ...result,
      toolCalls,
      traceEvents,
    };
  }

  yield* trace({
    kind: "reasoning",
    message: "Queued prompt and opened a streaming fake-provider run",
    detail: job.prompt,
  });

  yield* streamFakeAiPromptParts(job, {
    simulateLatency: config.fakeAiStreamDelayMs > 0,
    streamPartDelay: `${config.fakeAiStreamDelayMs} millis`,
  }).pipe(
    Stream.runForEach((part) =>
      Effect.gen(function* () {
        switch (part.type) {
          case "reasoning-delta": {
            yield* trace({
              kind: "reasoning",
              message: part.delta,
            });
            break;
          }
          case "text-delta": {
            summary += part.delta;
            break;
          }
          case "tool-call": {
            if (!isAiToolCallPart(part)) {
              return;
            }

            const toolCall = aiToolCallFromPart(part);
            const message = describeAiToolCall(toolCall);

            yield* trace({
              kind: "tool-call",
              message,
              detail: toolCall.type,
            });
            const accepted = yield* room.applyAiToolCalls({
              jobId: job.id,
              roomId,
              actor: "ai-architect",
              summary: summary || "Streaming fake AI architecture plan",
              readModel: rollingReadModel,
              toolCalls: [toolCall],
            });

            rollingReadModel = addToolCallToReadModel(rollingReadModel, toolCall);
            toolCalls.push(...accepted.toolCalls);
            break;
          }
        }
      }),
    ),
  );

  const finalSummary = summary || "Streaming fake AI architecture plan complete.";

  yield* trace({
    kind: "completion",
    message: finalSummary,
    detail: `${toolCalls.length} accepted tool calls`,
  });
  yield* AiJobQueue.send(job);
  yield* room.recordTransportEvent({
    roomId,
    actor: "ai-architect",
    kind: "ai.job.queued",
    payloadJson: JSON.stringify({
      jobId: job.id,
      toolCalls: toolCalls.length,
      summary: finalSummary,
    }),
  });

  return yield* S.decodeUnknownEffect(AiPromptResult)({
    jobId: job.id,
    roomId,
    status: "queued" as const,
    summary: finalSummary,
    toolCalls,
    traceEvents,
  }).pipe(Effect.orDie);
});

const startTrace = Effect.fn("startTrace")(function* (roomId: RoomId, input: TraceStartRequest) {
  const definition = makeTraceDefinition(roomId, input.readModel, input.name);

  return yield* RoomDurableObject.byName(roomId).startTrace({
    roomId,
    actor: input.actor?.trim() || "Guest",
    definition,
  });
});

const reviewArchitecture = Effect.fn("reviewArchitecture")(function* (
  roomId: RoomId,
  input: ArchitectureReviewRequest,
) {
  const findings = makeArchitectureReviewFindings(roomId, input.readModel);

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor: input.actor?.trim() || "Guest",
    kind: "review.findings.generated",
    payloadJson: JSON.stringify({
      findings,
      count: findings.length,
    }),
  });

  return {
    roomId,
    findings,
  };
});

const acceptReviewFinding = Effect.fn("acceptReviewFinding")(function* (
  roomId: RoomId,
  input: ReviewFindingDecisionRequest,
) {
  const actor = input.actor?.trim() || "Guest";
  const acceptedFinding = withFindingStatus(input.finding, "accepted");
  const result = yield* RoomDurableObject.byName(roomId).applyAiToolCalls({
    roomId,
    jobId: `review_${acceptedFinding.id}`,
    actor,
    summary: acceptedFinding.recommendation,
    readModel: input.readModel,
    toolCalls: acceptedFinding.toolCalls,
  });

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor,
    kind: "review.finding.accepted",
    payloadJson: JSON.stringify({
      finding: acceptedFinding,
      toolCalls: acceptedFinding.toolCalls.length,
    }),
  });

  return result;
});

const rejectReviewFinding = Effect.fn("rejectReviewFinding")(function* (
  roomId: RoomId,
  input: ReviewFindingDecisionRequest,
) {
  const actor = input.actor?.trim() || "Guest";
  const finding = withFindingStatus(input.finding, "rejected");

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor,
    kind: "review.finding.rejected",
    payloadJson: JSON.stringify({ finding }),
  });

  return {
    roomId,
    finding,
  };
});

const recordVoiceTranscript = Effect.fn("recordVoiceTranscript")(function* (
  roomId: RoomId,
  input: VoiceTranscriptRequest,
) {
  const event = makeVoiceTranscriptEvent(roomId, input);

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor: event.actor,
    kind: "voice.transcript.recorded",
    payloadJson: JSON.stringify({ transcript: event }),
  });

  return event;
});

const suggestFromVoice = Effect.fn("suggestFromVoice")(function* (
  roomId: RoomId,
  input: VoiceSuggestionRequest,
) {
  const actor = input.actor?.trim() || "Guest";
  const job = makeAiJob(roomId, {
    actor,
    prompt: `Voice transcript: ${input.transcript}`,
    readModel: input.readModel,
  });
  const result = yield* generateFakeAiPromptResult(job, { simulateLatency: false });
  const suggestion: VoiceSuggestion = {
    actor,
    createdAt: new Date().toISOString(),
    id: `voice_suggestion_${crypto.randomUUID()}`,
    roomId,
    status: "open",
    summary: result.summary,
    toolCalls: result.toolCalls,
    transcript: input.transcript.trim(),
  };

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor,
    kind: "voice.suggestion.created",
    payloadJson: JSON.stringify({ suggestion }),
  });

  return {
    roomId,
    suggestion,
  };
});

const acceptVoiceSuggestion = Effect.fn("acceptVoiceSuggestion")(function* (
  roomId: RoomId,
  input: VoiceSuggestionDecisionRequest,
) {
  const actor = input.actor?.trim() || "Guest";
  const suggestion = withVoiceSuggestionStatus(input.suggestion, "accepted");
  const result = yield* RoomDurableObject.byName(roomId).applyAiToolCalls({
    roomId,
    jobId: `voice_${suggestion.id}`,
    actor,
    summary: suggestion.summary,
    readModel: input.readModel,
    toolCalls: suggestion.toolCalls,
  });

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor,
    kind: "voice.suggestion.accepted",
    payloadJson: JSON.stringify({ suggestion, toolCalls: suggestion.toolCalls.length }),
  });

  return result;
});

const rejectVoiceSuggestion = Effect.fn("rejectVoiceSuggestion")(function* (
  roomId: RoomId,
  input: VoiceSuggestionDecisionRequest,
) {
  const actor = input.actor?.trim() || "Guest";
  const suggestion = withVoiceSuggestionStatus(input.suggestion, "rejected");

  yield* RoomDurableObject.byName(roomId).recordTransportEvent({
    roomId,
    actor,
    kind: "voice.suggestion.rejected",
    payloadJson: JSON.stringify({ suggestion }),
  });

  return {
    roomId,
    suggestion,
  };
});

const withVoiceSuggestionStatus = (
  suggestion: VoiceSuggestion,
  status: VoiceSuggestion["status"],
): VoiceSuggestion => ({
  ...suggestion,
  status,
});

const runExportWorkflow = (payload: ExportWorkflowPayload) =>
  Effect.gen(function* () {
    const actor = payload.actor || "architect-export";
    const running = yield* Workflow.step(
      "mark-export-running",
      writeExportStatus({
        artifactCount: 0,
        createdAt: payload.requestedAt,
        exportId: payload.exportId,
        manifestUrl: exportManifestUrl(payload.roomId, payload.exportId),
        message: "Generating starter package",
        roomId: payload.roomId,
        status: "running",
        updatedAt: new Date().toISOString(),
      }),
    );

    yield* recordExportEvent(running, actor);

    const result = yield* Workflow.step(
      "write-export-artifacts",
      Effect.gen(function* () {
        const bucket = yield* ExportArtifacts;
        const generatedAt = new Date().toISOString();
        const packageExport = makeExportPackage(
          payload.roomId,
          payload.exportId,
          payload.readModel,
          generatedAt,
        );
        const manifestKey = exportManifestKey(payload.roomId, payload.exportId);

        for (const file of packageExport.files) {
          const key =
            file.path === "manifest.json"
              ? manifestKey
              : `exports/${payload.roomId}/${payload.exportId}/${file.path}`;
          yield* bucket.put(key, file.content, {
            httpMetadata: {
              contentType: file.contentType,
            },
          });
        }

        return {
          artifactCount: packageExport.files.length,
          manifestKey,
        };
      }),
    );
    const completed = yield* Workflow.step(
      "mark-export-completed",
      writeExportStatus({
        ...running,
        artifactCount: result.artifactCount,
        manifestKey: result.manifestKey,
        message: "Export package is ready",
        status: "completed",
        updatedAt: new Date().toISOString(),
      }),
    );

    yield* recordExportEvent(completed, actor);

    return {
      artifactCount: result.artifactCount,
      exportId: payload.exportId,
      manifestKey: result.manifestKey,
      roomId: payload.roomId,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const failed = yield* writeExportStatus({
          artifactCount: 0,
          createdAt: payload.requestedAt,
          exportId: payload.exportId,
          manifestUrl: exportManifestUrl(payload.roomId, payload.exportId),
          message: "Export workflow failed",
          roomId: payload.roomId,
          status: "failed",
          updatedAt: new Date().toISOString(),
        });

        yield* recordExportEvent(failed, payload.actor || "architect-export");
        return yield* Effect.failCause(cause);
      }),
    ),
  );

const ExportWorkflowBase = ArchitectExportWorkflow.make(ExportWorkflowLayer, {
  run: runExportWorkflow,
});

export class ExportWorkflow extends ExportWorkflowBase {}

const processAiJob = Effect.fn("processAiJob")(function* (job: AiJob) {
  const config = yield* ArchitectConfig;
  if (resolveAiProviderMode(config.aiProviderMode) === "real") {
    yield* RoomDurableObject.byName(job.roomId).recordTransportEvent({
      roomId: job.roomId,
      actor: "ai-architect",
      kind: "ai.job.processed",
      payloadJson: JSON.stringify({
        jobId: job.id,
        provider: "real",
      }),
    });
    return;
  }

  const result = yield* generateFakeAiPromptResult(job, { simulateLatency: false });

  yield* RoomDurableObject.byName(job.roomId).recordTransportEvent({
    roomId: job.roomId,
    actor: "ai-architect",
    kind: "ai.tool-calls.generated",
    payloadJson: JSON.stringify({
      jobId: job.id,
      summary: result.summary,
      toolCalls: result.toolCalls.length,
    }),
  });
});

const withFindingStatus = (
  finding: ArchitectureReviewFinding,
  status: ArchitectureReviewFinding["status"],
): ArchitectureReviewFinding => ({
  ...finding,
  status,
});

const addToolCallToReadModel = (
  readModel: ArchitectureReadModelInputType,
  toolCall: AiToolCall,
): ArchitectureReadModelInputType => {
  switch (toolCall.type) {
    case "add_resource_node":
      return {
        ...readModel,
        resources: [
          ...readModel.resources,
          {
            bindingName: toolCall.bindingName,
            id: toolCall.id,
            kind: toolCall.kind,
            name: toolCall.name,
          },
        ],
      };
    case "connect_resources":
      return {
        ...readModel,
        edges: [
          ...readModel.edges,
          {
            id: toolCall.id,
            kind: toolCall.kind,
            label: toolCall.label,
            sourceId: toolCall.sourceId,
            targetId: toolCall.targetId,
          },
        ],
      };
    case "annotate_resource":
      return readModel;
  }
};

const getPublishedReadModel = Effect.fn("getPublishedReadModel")(function* (shareSlug: string) {
  const cache = yield* PublishedArchitectureReadModels;
  return yield* cache.get(publishedArchitectureReadModelKey(shareSlug));
});

const health = Effect.fn("health")(function* () {
  const config = yield* ArchitectConfig;
  return {
    ok: true,
    service: "architect-lab-api",
    publicOrigin: config.publicOrigin,
  };
});

const ApiGroupLive = HttpApiBuilder.group(ArchitectHttpApi, "api", (handlers) =>
  handlers
    .handle("health", () => health().pipe(Effect.orDie))
    .handle("createRoom", () => createRoom().pipe(Effect.orDie))
    .handle("getReadModel", ({ params }) => getLatestReadModel(params.roomId).pipe(Effect.orDie))
    .handle("saveReadModel", ({ params, payload }) =>
      saveLatestReadModel(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("publishReadModel", ({ params }) => publishReadModel(params.roomId).pipe(Effect.orDie))
    .handle("submitAiPrompt", ({ params, payload }) =>
      submitAiPrompt(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("startTrace", ({ params, payload }) =>
      startTrace(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("reviewArchitecture", ({ params, payload }) =>
      reviewArchitecture(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("acceptReviewFinding", ({ params, payload }) =>
      acceptReviewFinding(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("rejectReviewFinding", ({ params, payload }) =>
      rejectReviewFinding(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("startExport", ({ params, payload }) =>
      startExport(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("getExportStatus", ({ params }) =>
      readExportStatus(params.roomId, params.exportId).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail({ error: "Export not found" }),
            onSome: Effect.succeed,
          }),
        ),
      ),
    )
    .handle("getExportManifest", ({ params }) =>
      readExportManifest(params.roomId, params.exportId).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail({ error: "Export manifest not found" }),
            onSome: Effect.succeed,
          }),
        ),
      ),
    )
    .handle("recordVoiceTranscript", ({ params, payload }) =>
      recordVoiceTranscript(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("suggestFromVoice", ({ params, payload }) =>
      suggestFromVoice(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("acceptVoiceSuggestion", ({ params, payload }) =>
      acceptVoiceSuggestion(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("rejectVoiceSuggestion", ({ params, payload }) =>
      rejectVoiceSuggestion(params.roomId, payload).pipe(Effect.orDie),
    )
    .handle("getPublishedReadModel", ({ params }) =>
      getPublishedReadModel(params.shareSlug).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail({ error: "Published architecture not found" }),
            onSome: Effect.succeed,
          }),
        ),
      ),
    )
    .handle("roomHealth", ({ params }) => roomHealth(params.roomId).pipe(Effect.orDie)),
);

const ApiRoutes = HttpApiBuilder.layer(ArchitectHttpApi).pipe(
  Layer.provide(ApiGroupLive),
  Layer.provide(HttpServer.layerServices),
);

const routeFetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const url = new URL(request.url);

  const roomSocketMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (request.method === "GET" && roomSocketMatch !== null) {
    const roomId = roomSocketMatch[1];
    const room = yield* RoomDurableObject.getByName(roomId);
    const target = new URL(request.url);
    target.searchParams.set("roomId", roomId);
    return yield* RoomDurableObject.fetch(room, new Request(target, request)).pipe(Effect.orDie);
  }

  const activitySocketMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/activity\/ws$/);
  if (request.method === "GET" && activitySocketMatch !== null) {
    const roomId = activitySocketMatch[1];
    const room = yield* RoomDurableObject.getByName(roomId);
    const target = new URL(request.url);
    target.searchParams.set("roomId", roomId);
    target.searchParams.set("transport", "activity");
    return yield* RoomDurableObject.fetch(room, new Request(target, request)).pipe(Effect.orDie);
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(ApiRoutes);
      return yield* httpEffect.pipe(
        Effect.catch(() =>
          HttpServerResponse.json({ error: "Not found" }, { status: 404 }).pipe(Effect.orDie),
        ),
      );
    }),
  );
});

export default ApiDefinition.make(ApiLayer, {
  fetch: routeFetch,
  queue: (batch) =>
    Effect.gen(function* () {
      for (const message of batch.messages) {
        const job = yield* decodeAiJob(message.body);
        yield* processAiJob(job);
        yield* message.ack;
      }
    }),
  rpc: {
    health: () => health(),
    createRoom: () => createRoom(),
    roomHealth: (roomId) => roomHealth(roomId),
  },
});
