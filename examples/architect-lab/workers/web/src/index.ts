import { Effect } from "effect";
import { Worker } from "effect-cf";

import { ApiWorker } from "@architect-lab/domain";

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

  if (url.pathname === "/" || url.pathname.startsWith("/room/")) {
    return new Response(renderShell(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new Response("Not found", { status: 404 });
});

export default Worker.make(ApiLayer, {
  fetch: routeFetch,
});

const renderShell = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Architect Lab</title>
    <link rel="stylesheet" href="https://esm.sh/tldraw@5.0.1/tldraw.css" />
    <style>
      :root {
        color-scheme: light;
        --ink: #15191d;
        --muted: #5c6670;
        --line: #d6dde3;
        --panel: #fbfcfd;
        --canvas: #f5f7f8;
        --accent: #0f766e;
        --accent-strong: #0b4f4a;
        font-family:
          ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--canvas);
        color: var(--ink);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body,
      #root {
        width: 100%;
        height: 100%;
      }

      body {
        margin: 0;
        overflow: hidden;
      }

      button,
      input {
        font: inherit;
      }

      .app {
        height: 100vh;
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
        background: var(--canvas);
      }

      .sidebar {
        min-width: 0;
        border-right: 1px solid var(--line);
        background: rgba(251, 252, 253, 0.96);
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        gap: 18px;
        padding: 22px;
        z-index: 2;
      }

      .sidebar > * {
        min-width: 0;
      }

      .brand {
        display: grid;
        gap: 8px;
      }

      .brand h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.15;
        letter-spacing: 0;
      }

      .brand p {
        margin: 0;
        color: var(--muted);
        line-height: 1.45;
        font-size: 14px;
      }

      .controls {
        display: grid;
        gap: 10px;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field span,
      .section-label {
        margin: 0;
        color: #3f4952;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      input {
        width: 100%;
        min-width: 0;
        border: 1px solid #c6d0d8;
        border-radius: 6px;
        padding: 10px 11px;
        color: var(--ink);
        background: #ffffff;
      }

      .button-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      button {
        min-width: 0;
        border: 1px solid var(--accent-strong);
        border-radius: 6px;
        padding: 10px 12px;
        color: #ffffff;
        background: var(--accent);
        cursor: pointer;
        font-weight: 650;
      }

      button.secondary {
        color: var(--ink);
        background: #ffffff;
        border-color: #c6d0d8;
      }

      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      button:focus,
      input:focus,
      button:focus-visible,
      input:focus-visible {
        outline: 3px solid #14b8a6;
        outline-offset: 2px;
      }

      .status {
        display: grid;
        gap: 10px;
        align-content: start;
      }

      .status-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 0;
        border-bottom: 1px solid #e4e9ee;
        color: var(--muted);
        font-size: 14px;
      }

      .status-row strong {
        color: var(--ink);
        font-weight: 700;
        min-width: 0;
        overflow: hidden;
        overflow-wrap: anywhere;
        text-overflow: ellipsis;
        text-align: right;
      }

      .note {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .canvas-stage {
        position: relative;
        min-width: 0;
        min-height: 0;
        background:
          linear-gradient(#e0e6eb 1px, transparent 1px),
          linear-gradient(90deg, #e0e6eb 1px, transparent 1px),
          var(--canvas);
        background-size: 28px 28px;
      }

      .tldraw-host {
        position: absolute;
        inset: 0;
      }

      .empty-room {
        height: 100%;
        display: grid;
        place-items: center;
        padding: 28px;
      }

      .empty-panel {
        width: min(480px, 100%);
        display: grid;
        gap: 14px;
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.88);
        box-shadow: 0 18px 60px rgba(21, 25, 29, 0.08);
      }

      .empty-panel h2 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        letter-spacing: 0;
      }

      .empty-panel p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .sync-banner {
        position: absolute;
        left: 16px;
        bottom: 16px;
        z-index: 3;
        max-width: min(420px, calc(100% - 32px));
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.94);
        color: var(--muted);
        font-size: 13px;
        box-shadow: 0 12px 36px rgba(21, 25, 29, 0.08);
      }

      .sync-banner.error {
        color: #7f1d1d;
        border-color: #fecaca;
        background: #fff7f7;
      }

      @media (max-width: 820px) {
        body {
          overflow: auto;
        }

        .app {
          min-height: 100vh;
          height: auto;
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(620px, 1fr);
        }

        .sidebar {
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
      }
    </style>
  </head>
  <body>
    <main id="root"></main>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19.2.6",
          "react-dom/client": "https://esm.sh/react-dom@19.2.6/client",
          "tldraw": "https://esm.sh/tldraw@5.0.1?deps=react@19.2.6,react-dom@19.2.6",
          "@tldraw/sync": "https://esm.sh/@tldraw/sync@5.0.1?deps=react@19.2.6,react-dom@19.2.6,tldraw@5.0.1"
        }
      }
    </script>
    <script type="module">
      import React, { useMemo, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { Tldraw } from "tldraw";
      import { useSync } from "@tldraw/sync";

      const e = React.createElement;
      const randomLabel = () => "Guest " + Math.floor(Math.random() * 1000);
      const getInitialRoomId = () =>
        location.pathname.startsWith("/room/") ? location.pathname.slice("/room/".length) : "";
      const userId = localStorage.getItem("architect:userId") || "user_" + crypto.randomUUID().slice(0, 8);
      localStorage.setItem("architect:userId", userId);

      const inlineAssetStore = {
        async upload(_asset, file) {
          return {
            src: await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            }),
          };
        },
        resolve(asset) {
          return asset.props.src;
        },
      };

      function App() {
        const [roomId, setRoomId] = useState(getInitialRoomId);
        const [label, setLabel] = useState(() => localStorage.getItem("architect:label") || randomLabel());
        const [creating, setCreating] = useState(false);

        const createRoom = async () => {
          setCreating(true);
          try {
            const response = await fetch("/api/rooms", { method: "POST" });
            const body = await response.json();
            history.pushState(null, "", "/room/" + body.roomId);
            setRoomId(body.roomId);
          } finally {
            setCreating(false);
          }
        };

        const saveLabel = (event) => {
          setLabel(event.target.value);
          localStorage.setItem("architect:label", event.target.value);
        };

        const copyUrl = () => navigator.clipboard?.writeText(location.href);

        return e(
          "div",
          { className: "app" },
          e(
            "aside",
            { className: "sidebar", "aria-label": "Architect Lab room controls" },
            e(
              "div",
              { className: "brand" },
              e("h1", null, "Architect Lab"),
              e("p", null, "Multiplayer tldraw rooms backed by an Effect Durable Object."),
            ),
            e(
              "div",
              { className: "controls" },
              e(
                "label",
                { className: "field", htmlFor: "display-name" },
                e("span", null, "Display name"),
                e("input", {
                  id: "display-name",
                  value: label,
                  onChange: saveLabel,
                }),
              ),
              e(
                "div",
                { className: "button-row" },
                e("button", { onClick: createRoom, disabled: creating }, creating ? "Creating" : "Create room"),
                e("button", { className: "secondary", onClick: copyUrl, disabled: !roomId }, "Copy URL"),
              ),
            ),
            e(
              "section",
              { className: "status", "aria-label": "Room status" },
              e("h2", { className: "section-label" }, "Room"),
              e("div", { className: "status-row" }, e("span", null, "Id"), e("strong", null, roomId || "none")),
              e("div", { className: "status-row" }, e("span", null, "User"), e("strong", null, label || "Guest")),
              e("p", { className: "note" }, "Open this URL in another tab to verify shared shapes, cursors, selection, and reload persistence."),
            ),
            e("p", { className: "note" }, "Assets are stored inline for this phase; R2-backed uploads are deferred."),
          ),
          e(
            "section",
            { className: "canvas-stage" },
            roomId
              ? e(RoomCanvas, { roomId, label })
              : e(
                  "div",
                  { className: "empty-room" },
                  e(
                    "div",
                    { className: "empty-panel" },
                    e("h2", null, "Create a room to start drawing"),
                    e("p", null, "The canvas will connect to a room Durable Object and persist tldraw records in Durable Object SQLite."),
                    e("button", { onClick: createRoom, disabled: creating }, creating ? "Creating" : "Create room"),
                  ),
                ),
          ),
        );
      }

      function RoomCanvas({ roomId, label }) {
        const uri = useMemo(() => {
          const protocol = location.protocol === "https:" ? "wss:" : "ws:";
          const url = new URL(protocol + "//" + location.host + "/api/rooms/" + roomId + "/ws");
          url.searchParams.set("label", label || "Guest");
          url.searchParams.set("userId", userId);
          return url.toString();
        }, [roomId, label]);

        const remote = useSync({
          uri,
          assets: inlineAssetStore,
        });

        if (remote.status === "loading") {
          return e("div", { className: "sync-banner" }, "Connecting tldraw sync...");
        }

        if (remote.status === "error") {
          return e("div", { className: "sync-banner error" }, remote.error?.message || "Unable to connect tldraw sync.");
        }

        return e(
          React.Fragment,
          null,
          e("div", { className: "tldraw-host" }, e(Tldraw, { store: remote.store })),
          e("div", { className: "sync-banner" }, "Tldraw sync connected. Document changes and presence are room-scoped."),
        );
      }

      createRoot(document.getElementById("root")).render(e(App));
    </script>
  </body>
</html>`;
