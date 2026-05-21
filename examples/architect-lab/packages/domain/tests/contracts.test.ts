import { describe, expect, test } from "vitest";
import { Schema as S } from "effect";

import { PresenceSnapshot, RoomMetadata } from "../src/index.ts";

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
});
