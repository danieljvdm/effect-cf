import { expect, test } from "vitest";

import WebWorker from "../src/index.ts";

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const makeWorker = (assetsFetch: (request: Request) => Promise<Response>) =>
  new WebWorker(executionContext, {
    API: {
      fetch: async () => Response.json({ ok: true }),
    },
    ASSETS: {
      fetch: assetsFetch,
    },
  } as unknown as Cloudflare.Env);

test("serves client routes from the static assets binding", async () => {
  const seen: Array<string> = [];
  const worker = makeWorker(async (request: Request) => {
    seen.push(new URL(request.url).pathname);
    return new Response("<!doctype html><title>Architect Lab</title>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  const response = await worker.fetch(new Request("https://architect.test/room/room_a"));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(html).toContain("Architect Lab");
  expect(seen).toEqual(["/index.html"]);
});

test("serves Vite client assets from the static assets binding", async () => {
  const seen: Array<string> = [];
  const worker = makeWorker(async (request: Request) => {
    seen.push(new URL(request.url).pathname);
    return new Response("console.log('client')", {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  });

  const response = await worker.fetch(new Request("https://architect.test/assets/app.js"));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/javascript");
  await expect(response.text()).resolves.toContain("client");
  expect(seen).toEqual(["/assets/app.js"]);
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
    ASSETS: {
      fetch: async () => new Response("not expected", { status: 500 }),
    },
  } as unknown as Cloudflare.Env);

  const response = await worker.fetch(new Request("https://architect.test/api/health"));

  expect(response.status).toBe(200);
  expect(seen).toEqual(["/api/health"]);
});
