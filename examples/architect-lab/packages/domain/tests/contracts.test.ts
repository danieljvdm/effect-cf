import { describe, expect, test } from "vitest";
import { Schema as S } from "effect";

import { AiGatewayModel, AiGatewayModelIds, resolveAiProviderMode } from "../src/ai.ts";
import {
  ArchitectureReadModel,
  ArchitectureResource,
  architectureResourceTemplates,
  latestArchitectureReadModelKey,
  publishedArchitectureReadModelKey,
} from "../src/architecture.ts";
import { RoomMetadata, PresenceSnapshot } from "../src/contracts.ts";
import { renderEdgeSnippet, renderResourceSnippet } from "../src/snippets.ts";
import { makeArchitectureReviewFindings, makeTraceDefinition } from "../src/trace.ts";
import { VoiceSuggestion, makeVoiceTranscriptEvent } from "../src/voice.ts";

describe("architect-lab domain contracts", () => {
  test("limits selectable AI Gateway models to fast modern options", () => {
    expect(AiGatewayModelIds).toEqual([
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
      "grok/grok-4-fast-non-reasoning",
    ]);
    expect(S.decodeUnknownSync(AiGatewayModel)("openai/gpt-5-mini")).toBe("openai/gpt-5-mini");
    expect(() => S.decodeUnknownSync(AiGatewayModel)("openai/gpt-4.1-mini")).toThrow();
  });

  test("decodes room metadata shared across API and Durable Object boundaries", () => {
    const metadata = S.decodeUnknownSync(RoomMetadata)({
      id: "room_123",
      title: "System sketch",
      createdAt: "2026-05-21T12:00:00.000Z",
      updatedAt: "2026-05-21T12:00:00.000Z",
    });

    expect(metadata.id).toBe("room_123");
  });

  test("keeps room presence snapshot messages explicit", () => {
    const snapshot = S.decodeUnknownSync(PresenceSnapshot)({
      type: "server.presence.snapshot",
      roomId: "room_123",
      members: [
        {
          sessionId: "session_1",
          userId: "user_1",
          label: "Browser 1",
          joinedAt: "2026-05-21T12:00:00.000Z",
          lastSeenAt: "2026-05-21T12:00:01.000Z",
        },
      ],
    });

    expect(snapshot.members).toHaveLength(1);
  });

  test("defines the semantic resources surfaced by the canvas palette", () => {
    expect(architectureResourceTemplates.map((template) => template.kind)).toEqual([
      "worker",
      "durable-object",
      "d1",
      "r2",
      "kv",
      "queue",
      "workflow",
      "images",
      "service-binding",
    ]);
  });

  test("renders deterministic snippets from semantic resource metadata", () => {
    const resource = S.decodeUnknownSync(ArchitectureResource)({
      id: "shape:db",
      kind: "d1",
      name: "Room database",
      bindingName: "ROOM_DB",
    });

    const snippet = renderResourceSnippet(resource);

    expect(snippet).toContain("class RoomDatabase extends D1.Service");
    expect(snippet).toContain('binding: "ROOM_DB"');
    expect(snippet).toContain("RoomDatabase.sqlLayer()");
  });

  test("avoids import namespace shadowing for default palette names", () => {
    const resource = S.decodeUnknownSync(ArchitectureResource)({
      id: "shape:d1",
      kind: "d1",
      name: "D1",
      bindingName: "D1",
    });

    const snippet = renderResourceSnippet(resource);

    expect(snippet).toContain("class D1Database extends D1.Service");
    expect(snippet).toContain("D1Database.sqlLayer()");
  });

  test("uses readable default class names for short resource labels", () => {
    const resource = S.decodeUnknownSync(ArchitectureResource)({
      id: "shape:kv",
      kind: "kv",
      name: "KV",
      bindingName: "KV",
    });

    const snippet = renderResourceSnippet(resource);

    expect(snippet).toContain("class KVStore extends Kv.Tag");
    expect(snippet).toContain("kvStoreLayer");
  });

  test("renders deterministic snippets for semantic architecture edges", () => {
    const source = S.decodeUnknownSync(ArchitectureResource)({
      id: "shape:worker",
      kind: "worker",
      name: "Checkout Worker",
      bindingName: "CHECKOUT_WORKER",
    });
    const target = S.decodeUnknownSync(ArchitectureResource)({
      id: "shape:queue",
      kind: "queue",
      name: "Order Queue",
      bindingName: "ORDER_QUEUE",
    });
    const snippet = renderEdgeSnippet(
      {
        id: "shape:edge",
        kind: "queue-message",
        sourceId: source.id,
        targetId: target.id,
        label: "Checkout command",
      },
      [source, target],
    );

    expect(snippet).toContain("Effect.fn");
    expect(snippet).toContain("CheckoutWorker.sendOrderQueue");
    expect(snippet).toContain("queue.send");
  });

  test("decodes the KV latest architecture read model", () => {
    const model = S.decodeUnknownSync(ArchitectureReadModel)({
      roomId: "room_a",
      updatedAt: "2026-05-21T12:00:00.000Z",
      resources: [
        {
          id: "shape:worker",
          kind: "worker",
          name: "Worker",
          bindingName: "WORKER",
        },
      ],
      edges: [],
    });

    expect(model.resources).toHaveLength(1);
    expect(latestArchitectureReadModelKey("room_a")).toBe("room-latest:room_a");
    expect(publishedArchitectureReadModelKey("abc123")).toBe("published:abc123");
  });

  test("creates schema-backed trace definitions from semantic edges", () => {
    const trace = makeTraceDefinition("room_trace", {
      resources: [
        { id: "worker", kind: "worker", name: "API Worker", bindingName: "API" },
        { id: "queue", kind: "queue", name: "Job Queue", bindingName: "JOBS" },
      ],
      edges: [
        {
          id: "worker_queue",
          kind: "queue-message",
          sourceId: "worker",
          targetId: "queue",
          label: "Job message",
        },
      ],
    });

    expect(trace.name).toBe("Simulate request");
    expect(trace.steps[0]).toMatchObject({
      edgeId: "worker_queue",
      title: "API Worker -> Job Queue",
    });
    expect(trace.steps[0]?.dataShape).toContain("retryCount");
  });

  test("creates review findings with accepted canvas tool-call suggestions", () => {
    const findings = makeArchitectureReviewFindings("room_review", {
      resources: [
        { id: "worker", kind: "worker", name: "API Worker", bindingName: "API" },
        { id: "queue", kind: "queue", name: "Job Queue", bindingName: "JOBS" },
      ],
      edges: [],
    });

    expect(findings[0]).toMatchObject({
      subjectId: "queue",
      status: "open",
    });
    expect(findings[0]?.toolCalls[0]?.type).toBe("annotate_resource");
  });

  test("creates schema-backed voice transcript events and suggestions", () => {
    const transcript = makeVoiceTranscriptEvent(
      "room_voice",
      {
        actor: "Dana",
        transcript: "Add a Worker and Queue",
      },
      new Date("2026-05-22T00:00:00.000Z"),
    );
    const suggestion = S.decodeUnknownSync(VoiceSuggestion)({
      actor: "Dana",
      createdAt: transcript.recordedAt,
      id: "voice_suggestion_1",
      roomId: "room_voice",
      status: "open",
      summary: "Suggest Worker and Queue",
      toolCalls: [],
      transcript: transcript.transcript,
    });

    expect(transcript.id).toMatch(/^voice_transcript_/);
    expect(suggestion.status).toBe("open");
  });

  test("selects fake provider mode unless real mode is explicitly configured", () => {
    expect(resolveAiProviderMode(undefined)).toBe("fake");
    expect(resolveAiProviderMode("fake")).toBe("fake");
    expect(resolveAiProviderMode("unknown")).toBe("fake");
    expect(resolveAiProviderMode("real")).toBe("real");
  });
});
