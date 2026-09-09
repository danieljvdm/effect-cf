interface EdgeBindings {
  readonly [name: string]: { readonly fetch: (request: Request) => Promise<Response> } | undefined;
}

let isolateId: string | undefined;
let invocation = 0;

// The shared native edge keeps its own application runtime out of the target
// comparison and provides one hostname for all paired arms.
export default {
  async fetch(request: Request, env: EdgeBindings): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/ready") {
      return Response.json({ ready: true });
    }
    const arm = request.headers.get("x-bench-arm") ?? "";
    const target = env[arm];

    if (target === undefined) return new Response("Unknown benchmark arm", { status: 400 });
    isolateId ??= crypto.randomUUID();
    const marker = {
      kind: "effect-cf-hot-benchmark",
      role: "edge",
      benchId: request.headers.get("x-bench-id") ?? "unlabelled",
      invocation: ++invocation,
      isolateId,
      arm,
    };

    console.log(JSON.stringify({ ...marker, phase: "start" }));
    const response = await target.fetch(request);

    console.log(JSON.stringify({ ...marker, phase: "complete", status: response.status }));

    return response;
  },
};
