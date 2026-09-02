import { Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { Worker } from "effect-cf";

import { Archive, Documents } from "./document";

export { DocumentDurableObject } from "./document";

export default Worker.make(
  Layer.merge(Documents.layer({ binding: "DOCUMENTS" }), Archive.layer({ binding: "ARCHIVE" })),
  {
    fetch: Effect.gen(function* () {
      const request = yield* Worker.NativeRequest;
      const path = new URL(request.url).pathname;

      if (request.method === "GET" && path.startsWith("/archive/")) {
        const archive = yield* Archive;
        const object = yield* archive.get(path.slice("/archive/".length));

        return Option.isSome(object)
          ? new Response(yield* object.value.text)
          : new Response("Not archived yet", { status: 404 });
      }
      const documents = yield* Documents;
      const document = documents.byName(path.slice(1));

      if (request.method === "PUT") {
        const body = yield* HttpServerRequest.fromWeb(request).text;
        const key = yield* document.save(body);

        return Response.json({ archive: `/archive/${key}` }, { status: 202 });
      }
      if (request.method === "GET") {
        const snapshot = yield* document.read();

        return Response.json(snapshot, { status: snapshot === null ? 404 : 200 });
      }

      return new Response("Use PUT to save or GET to read", {
        status: 405,
        headers: { Allow: "PUT, GET" },
      });
    }),
  },
);
