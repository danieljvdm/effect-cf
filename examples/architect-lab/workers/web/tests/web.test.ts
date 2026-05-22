import { expect, test } from "vitest";

import WebWorker from "../src/index.ts";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

test("serves the phase 1 web shell", async () => {
  const worker = new WebWorker(executionContext, {
    API: {
      fetch: async () => Response.json({ ok: true }),
    },
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://architect.test/room/room_a"));

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain("Architect Lab");
});

test("serves the semantic resource palette and code panel", async () => {
  const worker = new WebWorker(executionContext, {
    API: {
      fetch: async () => Response.json({ ok: true }),
    },
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://architect.test/room/room_a"));
  const html = await response.text();

  expect(html).toContain("Resource palette");
  expect(html).toContain("AI architect");
  expect(html).toContain("Durable Object");
  expect(html).toContain("Generated code");
  expect(html).toContain("renderResourceSnippet");
});

test("forwards API traffic through the typed service binding", async () => {
  const seen: Array<string> = [];
  const worker = new WebWorker(executionContext, {
    API: {
      fetch: async (request: Request) => {
        seen.push(new URL(request.url).pathname);
        return Response.json({ ok: true });
      },
    },
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://architect.test/api/health"));

  expect(response.status).toBe(200);
  expect(seen).toEqual(["/api/health"]);
});
