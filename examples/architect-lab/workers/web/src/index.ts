import { Effect } from "effect";
import { Worker, WorkerEnvironment } from "effect-cf";

import { ApiWorker } from "@architect-lab/domain/runtime";

const ApiLayer = ApiWorker.layer({ binding: "API" });

interface AssetsBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

type WebEnvironment = Cloudflare.Env & {
  readonly ASSETS: AssetsBinding;
};

const getClientAssetRequest = (request: Request, url: URL): Request => {
  if (url.pathname === "/" || url.pathname.startsWith("/room/")) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/index.html";
    assetUrl.search = "";
    return new Request(assetUrl, request);
  }

  return request;
};

const routeFetch = Effect.gen(function* () {
  const request = yield* Worker.NativeRequest;
  const env = (yield* WorkerEnvironment) as WebEnvironment;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    return yield* ApiWorker.fetch(request);
  }

  if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
    const apiUrl = new URL(request.url);
    apiUrl.pathname = `/api${url.pathname}`;
    return yield* ApiWorker.fetch(new Request(apiUrl, request));
  }

  return yield* Effect.promise(() => env.ASSETS.fetch(getClientAssetRequest(request, url)));
});

export default Worker.make(ApiLayer, {
  fetch: routeFetch,
});
