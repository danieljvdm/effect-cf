import { Schema as S } from "effect";
import { Worker } from "effect-cf";

import { ChatArtifact, RecordMessageRequest } from "./Schemas";

export class AnalyticsWorker extends Worker.Tag<AnalyticsWorker>()("AnalyticsWorker", {
  analyzeRoom: Worker.method({
    args: [S.String] as const,
    success: ChatArtifact,
  }),
  recordMessage: Worker.method({
    args: [RecordMessageRequest] as const,
    success: ChatArtifact,
  }),
}) {}

export type AnalyticsWorkerApi = Worker.Api<typeof AnalyticsWorker>;
