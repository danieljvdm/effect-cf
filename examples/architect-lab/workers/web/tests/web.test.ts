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
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(html).toContain("Architect Lab");
  expect(html).toContain("/assets/app.css");
  expect(html).toContain("/assets/app.js");
});

test("serves embedded React client assets", async () => {
  const worker = new WebWorker(executionContext, {
    API: {
      fetch: async () => Response.json({ ok: true }),
    },
  } as unknown as Cloudflare.Env);

  const script = await worker.fetch(new Request("https://architect.test/assets/app.js"));
  const styles = await worker.fetch(new Request("https://architect.test/assets/app.css"));

  expect(script.headers.get("content-type")).toContain("text/javascript");
  await expect(script.text()).resolves.toContain("createRoot");
  expect(styles.headers.get("content-type")).toContain("text/css");
  await expect(styles.text()).resolves.toContain("tldraw");
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
