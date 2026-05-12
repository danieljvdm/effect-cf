import type {
  ChatArtifact,
  ChatMessage,
  ChatPeer,
  ChatServerEvent,
  ChatSnapshot,
  User,
} from "@effect-cf/example-contracts/Schemas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const apiBase =
  (import.meta.env.VITE_CHAT_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

const usersFallback: ReadonlyArray<User> = [
  { id: "ada", name: "Ada Lovelace", plan: "pro" },
  { id: "grace", name: "Grace Hopper", plan: "pro" },
  { id: "linus", name: "Linus Torvalds", plan: "free" },
];

const clientSeeds = [
  { id: "client-a", label: "North console", userId: "ada", draft: "Ada online from panel A." },
  {
    id: "client-b",
    label: "Relay console",
    userId: "grace",
    draft: "Grace joined over a second socket.",
  },
  {
    id: "client-c",
    label: "Edge console",
    userId: "linus",
    draft: "Linus is watching the hibernation counter.",
  },
  {
    id: "client-d",
    label: "Observer",
    userId: "ada",
    draft: "A fourth tab without a fourth browser window.",
  },
] as const;

type ClientStatus = "idle" | "connecting" | "open" | "closed" | "error";

interface ClientState {
  readonly id: string;
  readonly label: string;
  readonly userId: string;
  readonly draft: string;
  readonly status: ClientStatus;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly peers: ReadonlyArray<ChatPeer>;
  readonly self?: ChatPeer;
  readonly restoredConnections: number;
  readonly lastHeartbeat?: string;
  readonly lastPong?: string;
  readonly log: ReadonlyArray<string>;
}

const initialClients: ReadonlyArray<ClientState> = clientSeeds.map((client) => ({
  ...client,
  status: "idle",
  messages: [],
  peers: [],
  restoredConnections: 0,
  log: ["not connected"],
}));

const apiUrl = (path: string) => `${apiBase}${path}`;

const socketUrl = (roomId: string, userId: string) => {
  const path = `${apiBase}/rooms/${encodeURIComponent(roomId)}/socket?userId=${encodeURIComponent(
    userId,
  )}`;

  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path.replace(/^http/, "ws");
  }

  const base = new URL(path, window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return base.toString();
};

const nowStamp = () =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

const shortTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));

const appendLog = (log: ReadonlyArray<string>, entry: string) =>
  [`${nowStamp()} · ${entry}`, ...log].slice(0, 5);

export default function App() {
  const [roomId, setRoomId] = useState("general");
  const [users, setUsers] = useState<ReadonlyArray<User>>(usersFallback);
  const [clients, setClients] = useState(initialClients);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | undefined>();
  const [analysis, setAnalysis] = useState<ChatArtifact | undefined>();
  const [httpDraft, setHttpDraft] = useState("Message routed over HTTP → API Worker → DO RPC.");
  const [activeClientId, setActiveClientId] = useState<string>(clientSeeds[0].id);
  const sockets = useRef(new Map<string, WebSocket>());

  const connectedCount = clients.filter((client) => client.status === "open").length;
  const activeClient = clients.find((client) => client.id === activeClientId) ?? clients[0];
  const latestMessages = useMemo(
    () =>
      Array.from(
        new Map(
          [...(snapshot?.messages ?? []), ...clients.flatMap((client) => client.messages)]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .map((message) => [message.id, message]),
        ).values(),
      ).slice(-12),
    [clients, snapshot],
  );
  const visiblePeers = clients.find((client) => client.peers.length > 0)?.peers ?? [];

  const updateClient = useCallback(
    (clientId: string, update: (client: ClientState) => ClientState) => {
      setClients((current) =>
        current.map((client) => (client.id === clientId ? update(client) : client)),
      );
    },
    [],
  );

  const disconnect = useCallback(
    (clientId: string) => {
      const socket = sockets.current.get(clientId);
      if (socket !== undefined) {
        socket.close(1000, "client requested disconnect");
        sockets.current.delete(clientId);
      }
      updateClient(clientId, (client) => ({
        ...client,
        status: "closed",
        log: appendLog(client.log, "closed local socket"),
      }));
    },
    [updateClient],
  );

  const handleServerEvent = useCallback(
    (clientId: string, event: ChatServerEvent) => {
      updateClient(clientId, (client) => {
        switch (event.type) {
          case "ready":
            return {
              ...client,
              status: "open",
              self: event.self,
              peers: event.peers,
              messages: event.snapshot.messages,
              restoredConnections: event.hibernation.restoredConnections,
              log: appendLog(
                client.log,
                `ready · ${event.peers.length} peer(s), ${event.hibernation.restoredConnections} restored`,
              ),
            };
          case "message":
            return {
              ...client,
              messages: [...client.messages, event.message].slice(-50),
              log: appendLog(client.log, `message ${event.message.id.slice(0, 8)}`),
            };
          case "presence":
            return {
              ...client,
              peers: event.peers,
              log: appendLog(client.log, `presence · ${event.connectionCount} live`),
            };
          case "heartbeat":
            return {
              ...client,
              lastHeartbeat: event.at,
              log: appendLog(client.log, `heartbeat · ${event.connectionCount} live`),
            };
          case "error":
            return {
              ...client,
              log: appendLog(client.log, `error · ${event.message}`),
            };
        }
      });
    },
    [updateClient],
  );

  const connect = useCallback(
    (clientId: string) => {
      const client = clients.find((candidate) => candidate.id === clientId);
      if (client === undefined) {
        return;
      }

      disconnect(clientId);
      updateClient(clientId, (current) => ({
        ...current,
        status: "connecting",
        log: appendLog(current.log, `connecting as ${current.userId}`),
      }));

      const socket = new WebSocket(socketUrl(roomId, client.userId));
      sockets.current.set(clientId, socket);

      socket.addEventListener("open", () => {
        if (sockets.current.get(clientId) !== socket) {
          return;
        }

        updateClient(clientId, (current) => ({
          ...current,
          status: "open",
          log: appendLog(current.log, "websocket open"),
        }));
      });

      socket.addEventListener("message", (event) => {
        if (sockets.current.get(clientId) !== socket) {
          return;
        }

        if (event.data === "pong") {
          updateClient(clientId, (current) => ({
            ...current,
            lastPong: new Date().toISOString(),
            log: appendLog(current.log, "auto-response pong"),
          }));
          return;
        }

        if (typeof event.data !== "string") {
          return;
        }

        handleServerEvent(clientId, JSON.parse(event.data) as ChatServerEvent);
      });

      socket.addEventListener("close", () => {
        if (sockets.current.get(clientId) !== socket) {
          return;
        }

        sockets.current.delete(clientId);
        updateClient(clientId, (current) => ({
          ...current,
          status: "closed",
          log: appendLog(current.log, "websocket closed"),
        }));
      });

      socket.addEventListener("error", () => {
        if (sockets.current.get(clientId) !== socket) {
          return;
        }

        updateClient(clientId, (current) => ({
          ...current,
          status: "error",
          log: appendLog(current.log, "websocket error"),
        }));
      });
    },
    [clients, disconnect, handleServerEvent, roomId, updateClient],
  );

  const sendFromClient = useCallback(
    (clientId: string) => {
      const client = clients.find((candidate) => candidate.id === clientId);
      const socket = sockets.current.get(clientId);
      if (client === undefined || socket?.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ type: "message", text: client.draft }));
    },
    [clients],
  );

  const updateDraft = (clientId: string, draft: string) => {
    updateClient(clientId, (client) => ({ ...client, draft }));
  };

  const setClientUser = (clientId: string, userId: string) => {
    updateClient(clientId, (client) => ({
      ...client,
      userId,
      log: appendLog(client.log, `selected ${userId}; reconnect to apply`),
    }));
  };

  const sendPing = (clientId: string) => {
    const socket = sockets.current.get(clientId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send("ping");
    }
  };

  const sendHeartbeat = (clientId: string) => {
    const socket = sockets.current.get(clientId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "heartbeat" }));
    }
  };

  const refreshHttpState = useCallback(async () => {
    const [snapshotResponse, analysisResponse] = await Promise.all([
      fetch(apiUrl(`/rooms/${encodeURIComponent(roomId)}`)),
      fetch(apiUrl(`/rooms/${encodeURIComponent(roomId)}/analysis`)),
    ]);
    setSnapshot((await snapshotResponse.json()) as ChatSnapshot);
    setAnalysis((await analysisResponse.json()) as ChatArtifact);
  }, [roomId]);

  const sendViaHttp = async () => {
    await fetch(apiUrl(`/rooms/${encodeURIComponent(roomId)}/messages?userId=grace`), {
      method: "POST",
      body: httpDraft,
    });
    await refreshHttpState();
  };

  useEffect(() => {
    fetch(apiUrl("/users"))
      .then((response) => response.json() as Promise<{ users: ReadonlyArray<User> }>)
      .then((body) => setUsers(body.users))
      .catch(() => setUsers(usersFallback));
  }, []);

  useEffect(() => {
    void refreshHttpState();
  }, [refreshHttpState]);

  useEffect(
    () => () => {
      for (const socket of sockets.current.values()) {
        socket.close(1000, "demo unmounted");
      }
      sockets.current.clear();
    },
    [],
  );

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Effect Cloudflare chat demo</p>
          <h1>Live chat room</h1>
          <p className="lede">
            Send messages over WebSockets, connect multiple demo clients, and inspect Durable Object
            hibernation details when you need them.
          </p>
        </div>
        <div className="room-card" aria-label="Room controls">
          <label>
            Room
            <input value={roomId} onChange={(event) => setRoomId(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={() => clients.forEach((client) => connect(client.id))}>
              connect all
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => clients.forEach((client) => disconnect(client.id))}
            >
              close all
            </button>
          </div>
        </div>
      </section>

      <section className="metrics compact" aria-label="Chat metrics">
        <Metric label="sockets" value={connectedCount.toString()} />
        <Metric
          label="messages"
          value={(snapshot?.messageCount ?? latestMessages.length).toString()}
        />
        <Metric label="users" value={(analysis?.knownUsers.length ?? 0).toString()} />
        <Metric
          label="restored"
          value={clients
            .reduce((total, client) => Math.max(total, client.restoredConnections), 0)
            .toString()}
        />
      </section>

      <section className="main-grid">
        <article className="chat-panel">
          <header>
            <div>
              <p>chat</p>
              <h2>#{roomId}</h2>
            </div>
            <button type="button" className="ghost" onClick={() => void refreshHttpState()}>
              refresh
            </button>
          </header>

          <div className="messages chat-messages" aria-live="polite">
            {latestMessages.length === 0 ? (
              <div className="empty-state">
                Connect a client and send a message. This area is the actual chat transcript.
              </div>
            ) : (
              latestMessages.map((message) => (
                <div className="message" key={message.id}>
                  <span>{message.userId}</span>
                  <p>{message.text}</p>
                  <time>{shortTime(message.createdAt)}</time>
                </div>
              ))
            )}
          </div>

          <div className="composer">
            <label>
              send as
              <select
                value={activeClientId}
                onChange={(event) => setActiveClientId(event.target.value)}
              >
                {clients.map((client) => (
                  <option value={client.id} key={client.id}>
                    {client.label} · {client.userId} · {client.status}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              value={activeClient.draft}
              onChange={(event) => updateDraft(activeClient.id, event.target.value)}
              placeholder="Type a chat message…"
            />
            <div className="button-row wrap">
              <button type="button" onClick={() => connect(activeClient.id)}>
                connect selected
              </button>
              <button type="button" onClick={() => sendFromClient(activeClient.id)}>
                send WebSocket message
              </button>
              <button type="button" className="ghost" onClick={() => sendPing(activeClient.id)}>
                ping hibernation auto-response
              </button>
            </div>
          </div>
        </article>

        <aside className="side-stack">
          <article className="presence">
            <header>
              <p>presence</p>
              <span>{visiblePeers.length} peer(s)</span>
            </header>
            <ul>
              {visiblePeers.map((peer) => (
                <li key={peer.id}>
                  <strong>{peer.userId}</strong>
                  <span>{peer.id.slice(0, 8)}</span>
                  {peer.restored ? <em>restored after hibernation</em> : <em>fresh socket</em>}
                </li>
              ))}
            </ul>
          </article>

          <article className="http-card">
            <header>
              <p>HTTP path</p>
            </header>
            <input value={httpDraft} onChange={(event) => setHttpDraft(event.target.value)} />
            <button type="button" onClick={() => void sendViaHttp()}>
              send via API Worker
            </button>
          </article>
        </aside>
      </section>

      <section className="client-strip" aria-label="Demo clients">
        {clients.map((client) => (
          <article className={`client-card ${client.status}`} key={client.id}>
            <header>
              <div>
                <p>{client.label}</p>
                <h2>{client.userId}</h2>
              </div>
              <span>{client.status}</span>
            </header>

            <label className="select-label">
              identity
              <select
                value={client.userId}
                onChange={(event) => setClientUser(client.id, event.target.value)}
              >
                {users.map((user) => (
                  <option value={user.id} key={user.id}>
                    {user.name} · {user.plan}
                  </option>
                ))}
              </select>
            </label>

            <div className="button-row wrap compact-actions">
              <button type="button" onClick={() => connect(client.id)}>
                connect
              </button>
              <button type="button" className="ghost" onClick={() => sendHeartbeat(client.id)}>
                heartbeat
              </button>
            </div>

            <dl className="socket-facts">
              <div>
                <dt>self</dt>
                <dd>{client.self?.id.slice(0, 8) ?? "—"}</dd>
              </div>
              <div>
                <dt>pong</dt>
                <dd>{client.lastPong === undefined ? "—" : shortTime(client.lastPong)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>
    </main>
  );
}

function Metric(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
