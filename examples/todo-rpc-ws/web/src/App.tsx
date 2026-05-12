import type { Todo, TodoStats } from "@effect-cf/todo-rpc-ws-domain/TodoRpc";
import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runClient, TodoRpcClient } from "./clients";

const listTodos = Effect.gen(function* () {
  const client = yield* TodoRpcClient;
  return yield* client.ListTodos();
});
const getStats = Effect.gen(function* () {
  const client = yield* TodoRpcClient;
  return yield* client.GetStats();
});
const createTodo = (title: string) =>
  Effect.gen(function* () {
    const client = yield* TodoRpcClient;
    return yield* client.CreateTodo({ title });
  });
const updateTodo = (todo: Todo) =>
  Effect.gen(function* () {
    const client = yield* TodoRpcClient;
    return yield* client.UpdateTodo({ id: todo.id, title: undefined, completed: !todo.completed });
  });
const removeTodo = (todo: Todo) =>
  Effect.gen(function* () {
    const client = yield* TodoRpcClient;
    return yield* client.DeleteTodo({ id: todo.id });
  });
const clearCompletedTodos = Effect.gen(function* () {
  const client = yield* TodoRpcClient;
  return yield* client.ClearCompleted();
});

const initialTitles = [
  "Split the transport-specific demos",
  "Keep one managed runtime boundary",
  "Validate with Vite+",
];

export default function App() {
  const [todos, setTodos] = useState<ReadonlyArray<Todo>>([]);
  const [stats, setStats] = useState<TodoStats | undefined>();
  const [draft, setDraft] = useState("Ship a focused Effect RPC over WebSocket todo demo");
  const [status, setStatus] = useState("Booting Effect RPC over WebSocket client…");
  const [isBusy, setIsBusy] = useState(false);
  const orderedTodos = useMemo(
    () => [...todos].sort((l, r) => Number(l.completed) - Number(r.completed)),
    [todos],
  );
  const load = useCallback(async () => {
    const [list, nextStats] = await runClient(Effect.all([listTodos, getStats]));
    setTodos(list.todos);
    setStats(nextStats);
    setStatus(`Synced ${list.todos.length} todo(s) via Effect RPC over WebSocket`);
  }, []);
  useEffect(() => {
    load().catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : String(error)),
    );
  }, [load]);
  const run = async (label: string, effect: Effect.Effect<void, unknown, TodoRpcClient>) => {
    setIsBusy(true);
    setStatus(label);
    try {
      await runClient(effect);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };
  const addTodo = () =>
    run(
      "Creating todo through WebSocket RpcClient CreateTodo…",
      createTodo(draft).pipe(
        Effect.tap(() => Effect.sync(() => setDraft(""))),
        Effect.asVoid,
      ),
    );
  const toggleTodo = (todo: Todo) =>
    run("Updating todo through Effect RPC over WebSocket…", updateTodo(todo).pipe(Effect.asVoid));
  const deleteTodo = (todo: Todo) =>
    run("Deleting todo through Effect RPC over WebSocket…", removeTodo(todo).pipe(Effect.asVoid));
  const seedTodos = () =>
    run(
      "Seeding todos through Effect RPC over WebSocket…",
      Effect.forEach(initialTitles, (title) => createTodo(title), { discard: true }),
    );
  const clearCompleted = () =>
    run(
      "Clearing completed todos through Effect RPC over WebSocket…",
      clearCompletedTodos.pipe(
        Effect.tap((s) => Effect.sync(() => setStats(s))),
        Effect.asVoid,
      ),
    );
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Effect Cloudflare · Durable Object · WebSocket · RpcGroup</p>
        <h1>A tiny stateful socket todo room</h1>
        <p className="lede">
          Every todo operation travels through Effect RPC over a WebSocket. The API Worker only
          forwards the /api/ws upgrade to one named Durable Object, where
          DurableObjectRpcWebSocket.layer adapts hibernation lifecycle events to RpcServer.Protocol.
        </p>
      </section>
      <section className="console">
        <div className="stat-card">
          <span>Total</span>
          <strong>{stats?.total ?? todos.length}</strong>
        </div>
        <div className="stat-card acid">
          <span>Open</span>
          <strong>{stats?.open ?? todos.filter((t) => !t.completed).length}</strong>
        </div>
        <div className="stat-card ink">
          <span>Done</span>
          <strong>{stats?.completed ?? todos.filter((t) => t.completed).length}</strong>
        </div>
      </section>
      <section className="composer">
        <input
          aria-label="New todo title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim() !== "") void addTodo();
          }}
          placeholder="What should survive the edge?"
        />
        <button disabled={isBusy || draft.trim() === ""} onClick={() => void addTodo()}>
          Commit
        </button>
        <button className="secondary" disabled={isBusy} onClick={() => void seedTodos()}>
          Seed demo
        </button>
        <button className="secondary" disabled={isBusy} onClick={() => void clearCompleted()}>
          Clear done
        </button>
      </section>
      <section className="board">
        {orderedTodos.length === 0 ? (
          <article className="empty">
            <span>∅</span>
            <h2>No rows yet</h2>
            <p>Seed the demo or create a todo to write the first row.</p>
          </article>
        ) : (
          orderedTodos.map((todo) => (
            <article className={todo.completed ? "todo done" : "todo"} key={todo.id}>
              <label>
                <input
                  checked={todo.completed}
                  onChange={() => void toggleTodo(todo)}
                  type="checkbox"
                />
                <span>{todo.title}</span>
              </label>
              <small>{new Date(todo.updatedAt).toLocaleString()}</small>
              <button className="delete" onClick={() => void deleteTodo(todo)}>
                Delete
              </button>
            </article>
          ))
        )}
      </section>
      <footer className="status" aria-live="polite">
        {status}
      </footer>
    </main>
  );
}
