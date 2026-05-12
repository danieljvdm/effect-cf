import type { Todo, TodoStats } from "@effect-cf/todos-domain";
import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useState } from "react";

import { runClient, TodoApiClient, TodoRpcClient } from "./clients";

const listTodos = Effect.gen(function* () {
  const client = yield* TodoApiClient;
  return yield* client.Todos.listTodos(undefined);
});

const getStats = Effect.gen(function* () {
  const client = yield* TodoRpcClient;
  return yield* client.GetStats();
});

const createTodo = (title: string) =>
  Effect.gen(function* () {
    const client = yield* TodoApiClient;
    return yield* client.Todos.createTodo({ payload: { title } });
  });

const updateTodo = (todo: Todo) =>
  Effect.gen(function* () {
    const client = yield* TodoApiClient;
    return yield* client.Todos.updateTodo({
      params: { id: todo.id },
      payload: { title: undefined, completed: !todo.completed },
    });
  });

const removeTodo = (todo: Todo) =>
  Effect.gen(function* () {
    const client = yield* TodoApiClient;
    return yield* client.Todos.deleteTodo({ params: { id: todo.id } });
  });

const clearCompletedTodos = Effect.gen(function* () {
  const client = yield* TodoRpcClient;
  return yield* client.ClearCompleted();
});

const initialTitles = [
  "Sketch the domain package contracts",
  "Wire HttpApiGroup routes through the API Worker",
  "Call the API Worker over Effect RPC from the web Worker",
];

export default function App() {
  const [todos, setTodos] = useState<ReadonlyArray<Todo>>([]);
  const [stats, setStats] = useState<TodoStats | undefined>();
  const [draft, setDraft] = useState("Ship the Effect-native Cloudflare todo demo");
  const [status, setStatus] = useState("Booting edge runtime…");
  const [isBusy, setIsBusy] = useState(false);

  const orderedTodos = useMemo(
    () => [...todos].sort((left, right) => Number(left.completed) - Number(right.completed)),
    [todos],
  );

  const load = useCallback(async () => {
    const [list, nextStats] = await runClient(Effect.all([listTodos, getStats]));
    setTodos(list.todos);
    setStats(nextStats);
    setStatus(`Synced ${list.todos.length} todo(s) via typed HttpApiClient + RpcClient`);
  }, []);

  useEffect(() => {
    load().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }, [load]);

  const run = async (
    label: string,
    effect: Effect.Effect<void, unknown, TodoApiClient | TodoRpcClient>,
  ) => {
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
      "Creating todo through typed HttpApiClient POST /todos…",
      createTodo(draft).pipe(
        Effect.tap(() => Effect.sync(() => setDraft(""))),
        Effect.asVoid,
      ),
    );

  const toggleTodo = (todo: Todo) =>
    run(
      "Patching todo through typed HttpApiClient PATCH /todos/:id…",
      updateTodo(todo).pipe(Effect.asVoid),
    );

  const deleteTodo = (todo: Todo) =>
    run(
      "Deleting todo through typed HttpApiClient DELETE /todos/:id…",
      removeTodo(todo).pipe(Effect.asVoid),
    );

  const seedTodos = () =>
    run(
      "Seeding todos through typed HttpApiClient POST /todos…",
      Effect.forEach(initialTitles, (title) => createTodo(title), { discard: true }),
    );

  const clearCompleted = () =>
    run(
      "Clearing completed todos through typed Effect RpcClient…",
      clearCompletedTodos.pipe(
        Effect.tap((nextStats) => Effect.sync(() => setStats(nextStats))),
        Effect.asVoid,
      ),
    );

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Effect Cloudflare · D1 · HttpApiClient · RpcClient</p>
        <h1>Ledger of tiny edge commitments</h1>
        <p className="lede">
          A persistent todo list where the browser uses typed Effect HTTP and RPC clients against
          the web Worker API prefix. The API Worker stores data in D1 through
          <code> effect/unstable/sql</code>, serves typed HTTP API routes, and exposes Effect RPC
          procedures that the web Worker bridges over its API service binding.
        </p>
      </section>

      <section className="console">
        <div className="stat-card">
          <span>Total</span>
          <strong>{stats?.total ?? todos.length}</strong>
        </div>
        <div className="stat-card acid">
          <span>Open</span>
          <strong>{stats?.open ?? todos.filter((todo) => !todo.completed).length}</strong>
        </div>
        <div className="stat-card ink">
          <span>Done</span>
          <strong>{stats?.completed ?? todos.filter((todo) => todo.completed).length}</strong>
        </div>
      </section>

      <section className="composer">
        <input
          aria-label="New todo title"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim() !== "") {
              void addTodo();
            }
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
          Effect RPC clear done
        </button>
      </section>

      <section className="board">
        {orderedTodos.length === 0 ? (
          <article className="empty">
            <span>∅</span>
            <h2>No rows yet</h2>
            <p>Seed the demo or create a todo to write the first row into D1.</p>
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
