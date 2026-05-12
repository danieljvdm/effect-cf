import { AnalyticsWorker } from "@effect-cf/example-contracts/AnalyticsWorker";
import { Effect, Layer } from "effect";
import { Worker } from "effect-cf";

import * as Analytics from "./analytics";
import { ApiWorker, ChatRooms } from "./bindings";

const json = (value: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
};

const layer = Layer.mergeAll(ApiWorker.layer, ChatRooms.layer);

export const AnalyticsWorkerLive = AnalyticsWorker.make(layer, {
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
