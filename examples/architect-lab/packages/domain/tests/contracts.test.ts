import { describe, expect, test } from "vitest";
import { Schema as S } from "effect";

import { ArchitectureResource, architectureResourceTemplates } from "../src/architecture.ts";
import { RoomMetadata, PresenceSnapshot } from "../src/contracts.ts";
import { renderResourceSnippet } from "../src/snippets.ts";

describe("architect-lab domain contracts", () => {
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
});
