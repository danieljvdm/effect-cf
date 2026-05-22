import { Effect } from "effect";
import { Worker } from "effect-cf";

import { ApiWorker } from "@architect-lab/domain/runtime";

import { clientScript, clientStyles } from "./generated/client-assets.js";
import { renderShell } from "./server/render-shell.js";

const ApiLayer = ApiWorker.layer({ binding: "API" });

const routeFetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    return yield* ApiWorker.fetch(request);
  }

  if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
    const apiUrl = new URL(request.url);
    apiUrl.pathname = `/api${url.pathname}`;
    return yield* ApiWorker.fetch(new Request(apiUrl, request));
  }

  if (url.pathname === "/assets/app.js") {
    return new Response(clientScript, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }

  if (url.pathname === "/assets/app.css") {
    return new Response(clientStyles, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/css; charset=utf-8",
      },
    });
  }

  if (url.pathname === "/" || url.pathname.startsWith("/room/")) {
    return new Response(renderShell(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
});

export default Worker.make(ApiLayer, {
  fetch: routeFetch,
});
