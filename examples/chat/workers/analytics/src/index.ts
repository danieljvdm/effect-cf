import { AnalyticsWorker } from "@effect-cf/example-contracts/AnalyticsWorker";
import { ApiWorker } from "@effect-cf/example-contracts/ApiWorker";
import { ChatRoom } from "@effect-cf/example-contracts/ChatRoom";
import { Effect, Layer, Schema } from "effect";
import { Worker } from "effect-cf";

import * as Analytics from "./analytics";

const json = (value: Schema.Json, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);

  headers.set("cache-control", "no-store");

  return Response.json(value, { ...init, headers });
};

const layer = Layer.mergeAll(
  ApiWorker.layer({ binding: "API_WORKER" }),
  ChatRoom.layer({ binding: "CHAT_ROOM" }),
);
const eventLayer = Layer.effectContext(Effect.context<ApiWorker | ChatRoom>());

export const AnalyticsWorkerLive = AnalyticsWorker.make(layer, {
  eventLayer,
  rpc: {
    analyzeRoom: (roomId) => Analytics.analyzeRoom(roomId),
    recordMessage: (input) => Analytics.recordMessage(input),
  },
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/rooms\/([^/]+)\/analysis$/);

    if (request.method === "GET" && match !== null) {
      return json(yield* Analytics.analyzeRoom(decodeURIComponent(match[1])));
    }

    return json({ error: "not found" }, { status: 404 });
  }),
});

export default AnalyticsWorkerLive;
