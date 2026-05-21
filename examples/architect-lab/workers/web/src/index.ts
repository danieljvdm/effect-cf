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
    <style>
      :root {
        color-scheme: light;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #eef2f5;
        color: #17202a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
      }

      button,
      input {
        font: inherit;
      }

      .app {
        min-height: 100vh;
        display: grid;
        grid-template-columns: minmax(280px, 360px) 1fr;
      }

      .sidebar {
        background: #ffffff;
        border-right: 1px solid #d9e0e7;
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .brand h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.2;
      }

      .brand p {
        margin: 8px 0 0;
        color: #5b6673;
        line-height: 1.45;
      }

      .controls {
        display: grid;
        gap: 10px;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field span {
        color: #46515d;
        font-size: 13px;
        font-weight: 600;
      }

      input {
        width: 100%;
        border: 1px solid #c9d3dc;
        border-radius: 8px;
        padding: 10px 11px;
        color: #17202a;
        background: #fbfcfd;
      }

      button {
        border: 1px solid #17202a;
        border-radius: 8px;
        padding: 10px 12px;
        color: #ffffff;
        background: #17202a;
        cursor: pointer;
      }

      button.secondary {
        color: #17202a;
        background: #ffffff;
        border-color: #c9d3dc;
      }

      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .status {
        display: grid;
        gap: 8px;
        padding-top: 4px;
        color: #46515d;
        font-size: 14px;
      }

      .canvas {
        position: relative;
        overflow: hidden;
        background:
          linear-gradient(#dce3ea 1px, transparent 1px),
          linear-gradient(90deg, #dce3ea 1px, transparent 1px),
          #f8fafb;
        background-size: 32px 32px;
        display: grid;
        place-items: center;
        padding: 32px;
      }

      .room-shell {
        width: min(860px, 100%);
        min-height: 460px;
        border: 1px solid #ccd6df;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.86);
        display: grid;
        grid-template-rows: auto 1fr auto;
      }

      .room-header,
      .room-footer {
        padding: 18px 20px;
        border-bottom: 1px solid #dce3ea;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .room-footer {
        border-top: 1px solid #dce3ea;
        border-bottom: 0;
      }

      .room-header h2 {
        margin: 0;
        font-size: 18px;
      }

      .room-body {
        padding: 20px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        align-content: start;
      }

      .panel {
        border: 1px solid #d9e0e7;
        border-radius: 8px;
        background: #ffffff;
        padding: 16px;
        min-height: 150px;
      }

      .panel h3 {
        margin: 0 0 12px;
        font-size: 14px;
        color: #46515d;
      }

      .presence {
        display: grid;
        gap: 8px;
      }

      .member {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 10px;
        border-radius: 8px;
        background: #eef2f5;
      }

      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }

      @media (max-width: 760px) {
        .app {
          grid-template-columns: 1fr;
        }

        .room-body {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main id="app" class="app"></main>
    <script type="module">
      const state = {
        roomId: location.pathname.startsWith("/room/") ? location.pathname.slice("/room/".length) : "",
        socket: null,
        presence: [],
        status: "idle",
        lastPong: "none",
        label: "Guest " + Math.floor(Math.random() * 1000),
      };

      const app = document.querySelector("#app");

      const render = () => {
        app.innerHTML = \`
          <section class="sidebar">
            <div class="brand">
              <h1>Architect Lab</h1>
              <p>Cloudflare room transport scaffold.</p>
            </div>
            <div class="controls">
              <label class="field">
                <span>Display name</span>
                <input id="label" value="\${escapeHtml(state.label)}" />
              </label>
              <button id="create">Create Room</button>
              <button id="connect" class="secondary" \${state.roomId ? "" : "disabled"}>Connect</button>
              <button id="ping" class="secondary" \${state.socket ? "" : "disabled"}>Ping Room</button>
            </div>
            <div class="status">
              <div>Room: <span class="mono">\${state.roomId || "none"}</span></div>
              <div>Socket: \${state.status}</div>
              <div>Last pong: <span class="mono">\${state.lastPong}</span></div>
            </div>
          </section>
          <section class="canvas">
            <div class="room-shell">
              <div class="room-header">
                <h2>\${state.roomId ? "Connected room shell" : "Create a room"}</h2>
                <span class="mono">\${state.presence.length} present</span>
              </div>
              <div class="room-body">
                <div class="panel">
                  <h3>Presence</h3>
                  <div class="presence">
                    \${state.presence.map((member) => \`
                      <div class="member">
                        <span>\${escapeHtml(member.label)}</span>
                        <span class="mono">\${escapeHtml(member.userId)}</span>
                      </div>
                    \`).join("") || "<span>No active sockets</span>"}
                  </div>
                </div>
                <div class="panel">
                  <h3>Transport</h3>
                  <p>Worker to API service binding to Room Durable Object.</p>
                  <p class="mono">/api/rooms/\${state.roomId || ":roomId"}/ws</p>
                </div>
              </div>
              <div class="room-footer">
                <span>Phase 1 shell</span>
                <button id="copy" class="secondary" \${state.roomId ? "" : "disabled"}>Copy URL</button>
              </div>
            </div>
          </section>
        \`;

        document.querySelector("#label").addEventListener("input", (event) => {
          state.label = event.target.value;
          if (state.socket?.readyState === WebSocket.OPEN) {
            state.socket.send(JSON.stringify({ type: "presence.update", label: state.label }));
          }
        });
        document.querySelector("#create").addEventListener("click", createRoom);
        document.querySelector("#connect").addEventListener("click", connectRoom);
        document.querySelector("#ping").addEventListener("click", pingRoom);
        document.querySelector("#copy").addEventListener("click", () => navigator.clipboard?.writeText(location.href));
      };

      const createRoom = async () => {
        const response = await fetch("/api/rooms", { method: "POST" });
        const body = await response.json();
        history.pushState(null, "", "/room/" + body.roomId);
        state.roomId = body.roomId;
        state.presence = [];
        render();
        connectRoom();
      };

      const connectRoom = () => {
        if (!state.roomId) return;
        state.socket?.close();
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const url = new URL(protocol + "//" + location.host + "/api/rooms/" + state.roomId + "/ws");
        url.searchParams.set("label", state.label);
        state.socket = new WebSocket(url);
        state.status = "connecting";
        render();

        state.socket.addEventListener("open", () => {
          state.status = "open";
          state.socket.send(JSON.stringify({ type: "presence.update", label: state.label }));
          render();
        });
        state.socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "server.presence.snapshot") {
            state.presence = message.members;
          }
          if (message.type === "server.transport.pong") {
            state.lastPong = message.receivedAt;
          }
          render();
        });
        state.socket.addEventListener("close", () => {
          state.status = "closed";
          state.socket = null;
          render();
        });
      };

      const pingRoom = () => {
        state.socket?.send(JSON.stringify({ type: "transport.ping", nonce: crypto.randomUUID() }));
      };

      const escapeHtml = (value) =>
        String(value).replace(/[&<>"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        })[char]);

      render();
      if (state.roomId) connectRoom();
    </script>
  </body>
</html>`;
