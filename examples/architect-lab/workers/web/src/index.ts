import { Effect } from "effect";
import { Worker } from "effect-cf";

import { architectureResourceTemplates } from "@architect-lab/domain/architecture";
import { ApiWorker } from "@architect-lab/domain/runtime";

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

const renderShell = () => {
  const resourceTemplatesJson = JSON.stringify(architectureResourceTemplates).replaceAll(
    "<",
    "\\u003c",
  );

  return `<!doctype html>
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
        --code-bg: #101418;
        --code-ink: #edf2f7;
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
        grid-template-columns: 320px minmax(0, 1fr) 360px;
        background: var(--canvas);
      }

      .sidebar,
      .inspector {
        min-width: 0;
        background: rgba(251, 252, 253, 0.96);
        z-index: 2;
      }

      .sidebar {
        border-right: 1px solid var(--line);
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        gap: 18px;
        padding: 22px;
      }

      .sidebar > *,
      .inspector > * {
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

      button.resource-button {
        display: grid;
        grid-template-columns: 16px minmax(0, 1fr);
        gap: 9px;
        align-items: start;
        width: 100%;
        padding: 10px;
        color: var(--ink);
        background: #ffffff;
        border-color: #d2dae1;
        text-align: left;
      }

      button.resource-button:hover:not(:disabled) {
        border-color: #8a99a6;
        background: #f7fafc;
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

      .inspector {
        border-left: 1px solid var(--line);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 18px;
        padding: 22px;
        overflow: hidden;
      }

      .palette {
        display: grid;
        gap: 10px;
        align-content: start;
      }

      .palette-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }

      .resource-dot {
        width: 14px;
        height: 14px;
        border-radius: 999px;
        margin-top: 2px;
        background: #64748b;
        border: 1px solid rgba(21, 25, 29, 0.14);
      }

      .resource-copy {
        display: grid;
        gap: 3px;
      }

      .resource-copy strong {
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: 14px;
        line-height: 1.15;
      }

      .resource-copy span {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.3;
        font-weight: 500;
      }

      .code-panel {
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 10px;
      }

      .code-header {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 12px;
      }

      .code-title {
        display: grid;
        gap: 3px;
      }

      .code-title h2 {
        margin: 0;
        font-size: 16px;
        line-height: 1.25;
        letter-spacing: 0;
      }

      .code-title p {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        overflow-wrap: anywhere;
      }

      .code-panel pre {
        min-width: 0;
        min-height: 0;
        margin: 0;
        overflow: auto;
        padding: 14px;
        border-radius: 8px;
        background: var(--code-bg);
        color: var(--code-ink);
        font:
          12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        white-space: pre;
      }

      .code-empty {
        display: grid;
        place-items: center;
        min-height: 220px;
        border: 1px dashed #c6d0d8;
        border-radius: 8px;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.4;
        text-align: center;
        padding: 18px;
        background: rgba(255, 255, 255, 0.7);
      }

      .color-blue {
        background: #2563eb;
      }

      .color-orange {
        background: #ea580c;
      }

      .color-green {
        background: #16a34a;
      }

      .color-violet {
        background: #7c3aed;
      }

      .color-light-blue {
        background: #0284c7;
      }

      .color-yellow {
        background: #ca8a04;
      }

      .color-red {
        background: #dc2626;
      }

      .color-light-violet {
        background: #a855f7;
      }

      .color-grey {
        background: #64748b;
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
          grid-template-rows: auto minmax(620px, 1fr) auto;
        }

        .sidebar {
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }

        .inspector {
          border-left: 0;
          border-top: 1px solid var(--line);
          overflow: visible;
        }

        .code-panel {
          min-height: 380px;
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
      import React, { useCallback, useMemo, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { Tldraw, createShapeId, toRichText } from "tldraw";
      import { useSync } from "@tldraw/sync";

      const e = React.createElement;
      const resourceTemplates = ${resourceTemplatesJson};
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

      const wordsFromName = (name) => {
        const words = String(name || "").match(/[A-Za-z0-9]+/g) || [];
        return words.length === 0 ? ["Resource"] : words;
      };

      const toPascalIdentifier = (name) =>
        wordsFromName(name)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join("")
          .replace(/^[0-9]/, "_$&");

      const toCamelIdentifier = (name) => {
        const pascal = toPascalIdentifier(name);
        const acronymPrefix = pascal.match(/^[A-Z]+(?=[A-Z][a-z])/);
        if (acronymPrefix !== null) {
          return acronymPrefix[0].toLowerCase() + pascal.slice(acronymPrefix[0].length);
        }
        return pascal.charAt(0).toLowerCase() + pascal.slice(1);
      };

      const toBindingName = (name, fallbackPrefix = "RESOURCE") => {
        const binding = wordsFromName(name)
          .join("_")
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .toUpperCase();
        return binding === "RESOURCE" ? fallbackPrefix : binding;
      };

      const classNameSuffixes = {
        worker: "App",
        "durable-object": "Room",
        d1: "Database",
        r2: "Assets",
        kv: "Store",
        queue: "Messages",
        workflow: "Flow",
        images: "Processor",
        "service-binding": "Client",
      };
      const reservedClassNames = new Set([
        "Worker",
        "DurableObject",
        "D1",
        "R2",
        "KV",
        "Kv",
        "Queue",
        "Workflow",
        "Images",
      ]);
      const toResourceClassName = (resource) => {
        const className = toPascalIdentifier(resource.name);
        return reservedClassNames.has(className) ? className + classNameSuffixes[resource.kind] : className;
      };

      const renderResourceSnippet = (resource) => {
        const className = toResourceClassName(resource);
        const valueName = toCamelIdentifier(className);
        const bindingName = resource.bindingName || toBindingName(resource.name);

        switch (resource.kind) {
          case "worker":
            return \`import { Schema as S } from "effect";
import { Worker } from "effect-cf";

export class \${className} extends Worker.Tag<\${className}>()("\${className}", {
  health: Worker.method({
    success: S.Struct({ ok: S.Boolean }),
  }),
}) {}\`;
          case "durable-object":
            return \`import { Schema as S } from "effect";
import { DurableObject } from "effect-cf";

export class \${className} extends DurableObject.Tag<\${className}>()("\${className}", {
  getState: DurableObject.method({
    success: S.Struct({ id: S.String, updatedAt: S.String }),
  }),
}) {}\`;
          case "d1":
            return \`import { D1 } from "effect-cf";

export class \${className} extends D1.Service<\${className}>()("\${className}", {
  binding: "\${bindingName}",
}) {}

export const \${valueName}Sql = \${className}.sqlLayer();\`;
          case "r2":
            return \`import { R2 } from "effect-cf";

export class \${className} extends R2.Tag<\${className}>()("\${className}") {}

export const \${valueName}Layer = \${className}.layer({
  binding: "\${bindingName}",
});\`;
          case "kv":
            return \`import { Schema as S } from "effect";
import { Kv } from "effect-cf";

export class \${className} extends Kv.Tag<\${className}>()("\${className}", {
  key: S.String,
  value: S.Struct({ updatedAt: S.String }),
}) {}

export const \${valueName}Layer = \${className}.layer({
  binding: "\${bindingName}",
});\`;
          case "queue":
            return \`import { Schema as S } from "effect";
import { Queue } from "effect-cf";

export class \${className} extends Queue.Tag<\${className}>()("\${className}", {
  message: S.Struct({ id: S.String }),
}) {}

export const \${valueName}Layer = \${className}.layer({
  binding: "\${bindingName}",
});\`;
          case "workflow":
            return \`import { Schema as S } from "effect";
import { Workflow } from "effect-cf";

export class \${className} extends Workflow.Tag<\${className}>()("\${className}", {
  payload: S.Struct({ id: S.String }),
  result: S.Struct({ ok: S.Boolean }),
}) {}

export const \${valueName}Layer = \${className}.layer({
  binding: "\${bindingName}",
});\`;
          case "images":
            return \`import { Images } from "effect-cf";

export class \${className} extends Images.Tag<\${className}>()("\${className}") {}

export const \${valueName}Layer = \${className}.layer({
  binding: "\${bindingName}",
});\`;
          case "service-binding":
            return \`import { Schema as S } from "effect";
import { Worker } from "effect-cf";

export class \${className} extends Worker.Tag<\${className}>()("\${className}", {
  health: Worker.method({
    success: S.Struct({ ok: S.Boolean }),
  }),
}) {}

export const \${valueName}Layer = \${className}.layer({
  binding: "\${bindingName}",
});\`;
          default:
            return "";
        }
      };

      function App() {
        const [roomId, setRoomId] = useState(getInitialRoomId);
        const [label, setLabel] = useState(() => localStorage.getItem("architect:label") || randomLabel());
        const [creating, setCreating] = useState(false);
        const [editor, setEditor] = useState(null);
        const [selectedResource, setSelectedResource] = useState(null);
        const [resourceCounts, setResourceCounts] = useState({});
        const [readModelStatus, setReadModelStatus] = useState("not synced");

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

        const saveReadModel = useCallback(
          async (readModel) => {
            if (!roomId) {
              return;
            }

            setReadModelStatus("saving");
            try {
              const response = await fetch("/api/rooms/" + roomId + "/read-model", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(readModel),
              });

              if (!response.ok) {
                throw new Error("Unable to save read model");
              }

              setReadModelStatus("saved");
            } catch {
              setReadModelStatus("error");
            }
          },
          [roomId],
        );

        const handleSelectionChange = useCallback((resource) => {
          setSelectedResource(resource);
        }, []);

        const addResource = (template) => {
          if (!editor) {
            return;
          }

          const nextCount = (resourceCounts[template.kind] || 0) + 1;
          const name = nextCount === 1 ? template.label : template.label + " " + nextCount;
          const bindingName = toBindingName(name, template.bindingPrefix);
          const id = createShapeId();
          const bounds = editor.getViewportPageBounds();
          const resource = {
            id,
            kind: template.kind,
            name,
            bindingName,
          };

          editor.createShape({
            id,
            type: "geo",
            x: bounds.x + bounds.w / 2 - 110 + nextCount * 12,
            y: bounds.y + bounds.h / 2 - 52 + nextCount * 12,
            props: {
              w: 220,
              h: 104,
              geo: "rectangle",
              color: template.color,
              fill: "solid",
              dash: "draw",
              size: "m",
              font: "draw",
              align: "middle",
              verticalAlign: "middle",
              richText: toRichText(name),
            },
            meta: {
              architect: resource,
            },
          });
          editor.select(id);
          setResourceCounts((counts) => ({
            ...counts,
            [template.kind]: nextCount,
          }));
          setSelectedResource(resource);
        };

        const selectedSnippet = selectedResource ? renderResourceSnippet(selectedResource) : "";

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
              e("div", { className: "status-row" }, e("span", null, "Read model"), e("strong", null, readModelStatus)),
              e("p", { className: "note" }, "Open this URL in another tab to verify shared shapes, cursors, selection, and reload persistence."),
            ),
            e("p", { className: "note" }, "Assets are stored inline for this phase; R2-backed uploads are deferred."),
          ),
          e(
            "section",
            { className: "canvas-stage" },
            roomId
              ? e(RoomCanvas, {
                  roomId,
                  label,
                  onEditorReady: setEditor,
                  onSelectionChange: handleSelectionChange,
                  onReadModelChange: saveReadModel,
                })
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
          e(
            "aside",
            { className: "inspector", "aria-label": "Architecture resources and code" },
            e(
              "section",
              { className: "palette", "aria-label": "Resource palette" },
              e("h2", { className: "section-label" }, "Resources"),
              e(
                "div",
                { className: "palette-grid" },
                resourceTemplates.map((template) =>
                  e(
                    "button",
                    {
                      key: template.kind,
                      className: "resource-button",
                      onClick: () => addResource(template),
                      disabled: !roomId || !editor,
                    },
                    e("span", { className: "resource-dot color-" + template.color, "aria-hidden": "true" }),
                    e(
                      "span",
                      { className: "resource-copy" },
                      e("strong", null, template.label),
                      e("span", null, template.description),
                    ),
                  ),
                ),
              ),
            ),
            e(
              "section",
              { className: "code-panel", "aria-label": "Generated code" },
              e(
                "div",
                { className: "code-header" },
                e(
                  "div",
                  { className: "code-title" },
                  e("h2", null, selectedResource ? selectedResource.name : "Code"),
                  e("p", null, selectedResource ? selectedResource.bindingName : "Select a semantic resource"),
                ),
              ),
              selectedResource
                ? e("pre", null, e("code", null, selectedSnippet))
                : e("div", { className: "code-empty" }, "Add or select a resource to inspect its effect-cf snippet."),
            ),
          ),
        );
      }

      function RoomCanvas({ roomId, label, onEditorReady, onSelectionChange, onReadModelChange }) {
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

        const handleMount = useCallback(
          (mountedEditor) => {
            onEditorReady(mountedEditor);
            let readModelTimer;

            const updateSelection = () => {
              const selected = mountedEditor.getOnlySelectedShape();
              onSelectionChange(selected?.meta?.architect || null);
            };

            const saveSemanticReadModel = () => {
              const resources = mountedEditor
                .getCurrentPageShapes()
                .map((shape) =>
                  shape?.meta?.architect
                    ? {
                        ...shape.meta.architect,
                        id: String(shape.id),
                      }
                    : null,
                )
                .filter(Boolean);

              onReadModelChange({ resources, edges: [] });
            };

            const scheduleReadModelSave = () => {
              clearTimeout(readModelTimer);
              readModelTimer = setTimeout(saveSemanticReadModel, 400);
            };

            updateSelection();
            scheduleReadModelSave();
            const dispose = mountedEditor.store.listen(() => {
              updateSelection();
              scheduleReadModelSave();
            });

            return () => {
              clearTimeout(readModelTimer);
              dispose?.();
              onSelectionChange(null);
              onEditorReady(null);
            };
          },
          [onEditorReady, onReadModelChange, onSelectionChange],
        );

        if (remote.status === "loading") {
          return e("div", { className: "sync-banner" }, "Connecting tldraw sync...");
        }

        if (remote.status === "error") {
          return e("div", { className: "sync-banner error" }, remote.error?.message || "Unable to connect tldraw sync.");
        }

        return e(
          React.Fragment,
          null,
          e("div", { className: "tldraw-host" }, e(Tldraw, { store: remote.store, onMount: handleMount })),
          e("div", { className: "sync-banner" }, "Tldraw sync connected. Document changes and presence are room-scoped."),
        );
      }

      createRoot(document.getElementById("root")).render(e(App));
    </script>
  </body>
</html>`;
};
