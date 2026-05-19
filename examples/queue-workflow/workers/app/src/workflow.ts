import { Effect, Layer, Schema as S } from "effect";
import { Workflow } from "effect-cf";

export const ReportRequest = S.Struct({
  reportId: S.String,
  requestedBy: S.String,
});

export const ReportResult = S.Struct({
  objectKey: S.String,
  notified: S.Boolean,
});

export type ReportRequest = S.Schema.Type<typeof ReportRequest>;
export type ReportResult = S.Schema.Type<typeof ReportResult>;

export class ReportWorkflow extends Workflow.Tag<ReportWorkflow>()("ReportWorkflow", {
  payload: ReportRequest,
  result: ReportResult,
}) {}

export const startReportWorkflow = (payload: ReportRequest, id = payload.reportId) =>
  ReportWorkflow.create(payload, { id });

export const ReportWorkflowEntrypoint = ReportWorkflow.make(Layer.empty, {
  run: (payload: ReportRequest) =>
    Effect.gen(function* () {
      const event = yield* Workflow.WorkflowEvent;
      const objectKey = yield* Workflow.step(
        "render-report",
        Effect.gen(function* () {
          const stepContext = yield* Workflow.WorkflowStepContext;
          return `reports/${payload.reportId}/${event.instanceId}/${stepContext.attempt}.json`;
        }),
        {
          retries: {
            limit: 3,
            delay: "1 second",
            backoff: "exponential",
          },
          timeout: "30 seconds",
        },
      );

      yield* Workflow.step("notify-requester", Effect.succeed(payload.requestedBy.length > 0));

      return {
        objectKey,
        notified: true,
      };
    }),
});
