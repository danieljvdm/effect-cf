import type { CreateTodo, Todo, TodoStats, UpdateTodo } from "@effect-cf/todo-rpc-ws-domain";
import { TodoNotFound } from "@effect-cf/todo-rpc-ws-domain";
import { Context, Effect, Layer } from "effect";
import { DurableObjectState, DurableObjectStorage } from "effect-cf";

type SqlValue = DurableObjectStorage.SqlStorageValue;
interface TodoRow {
  readonly [key: string]: SqlValue;
  readonly id: string;
  readonly title: string;
  readonly completed: number;
  readonly created_at: string;
  readonly updated_at: string;
}
interface StatsRow {
  readonly [key: string]: SqlValue;
  readonly total: number;
  readonly completed: number;
}
export interface TodoRepositoryService {
  readonly list: Effect.Effect<ReadonlyArray<Todo>, DurableObjectStorage.StorageOperationError>;
  readonly create: (
    input: CreateTodo,
  ) => Effect.Effect<Todo, DurableObjectStorage.StorageOperationError>;
  readonly update: (
    id: string,
    input: UpdateTodo,
  ) => Effect.Effect<Todo, DurableObjectStorage.StorageOperationError | TodoNotFound>;
  readonly delete: (
    id: string,
  ) => Effect.Effect<boolean, DurableObjectStorage.StorageOperationError>;
  readonly stats: Effect.Effect<TodoStats, DurableObjectStorage.StorageOperationError>;
  readonly clearCompleted: Effect.Effect<TodoStats, DurableObjectStorage.StorageOperationError>;
}
const fromRow = (row: TodoRow): Todo => ({
  id: row.id,
  title: row.title,
  completed: row.completed === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const trimTitle = (title: string) => title.trim().slice(0, 180);
export class TodoRepository extends Context.Service<TodoRepository, TodoRepositoryService>()(
  "todo-rpc-ws-store/TodoRepository",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const state = yield* DurableObjectState.DurableObjectState;
      const sql = state.storage.sql;
      const ensureSchema = sql.exec(
        `CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      );
      const selectTodos = () =>
        Effect.gen(function* () {
          yield* ensureSchema;
          const cursor = yield* sql.exec<TodoRow>(
            `SELECT id, title, completed, created_at, updated_at FROM todos ORDER BY completed ASC, created_at DESC`,
          );
          return (yield* cursor.toArray()).map(fromRow);
        });
      const getStats = Effect.gen(function* () {
        yield* ensureSchema;
        const cursor = yield* sql.exec<StatsRow>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed FROM todos`,
        );
        const rows = yield* cursor.toArray();
        const row = rows[0] ?? { total: 0, completed: 0 };
        return {
          total: row.total,
          open: row.total - row.completed,
          completed: row.completed,
          generatedAt: new Date().toISOString(),
        } satisfies TodoStats;
      });
      return {
        list: selectTodos(),
        create: (input) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const now = new Date().toISOString();
            const title = trimTitle(input.title);
            const cursor = yield* sql.exec<TodoRow>(
              `INSERT INTO todos (id, title, completed, created_at, updated_at) VALUES (?, ?, 0, ?, ?) RETURNING id, title, completed, created_at, updated_at`,
              crypto.randomUUID(),
              title === "" ? "Untitled todo" : title,
              now,
              now,
            );
            return fromRow(yield* cursor.one());
          }),
        update: (id, input) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const currentCursor = yield* sql.exec<TodoRow>(
              `SELECT id, title, completed, created_at, updated_at FROM todos WHERE id = ?`,
              id,
            );
            const current = (yield* currentCursor.toArray())[0];
            if (current === undefined) return yield* Effect.fail(new TodoNotFound({ id }));
            const now = new Date().toISOString();
            const title = input.title === undefined ? current.title : trimTitle(input.title);
            const completed =
              input.completed === undefined ? current.completed : input.completed ? 1 : 0;
            const cursor = yield* sql.exec<TodoRow>(
              `UPDATE todos SET title = ?, completed = ?, updated_at = ? WHERE id = ? RETURNING id, title, completed, created_at, updated_at`,
              title === "" ? current.title : title,
              completed,
              now,
              id,
            );
            return fromRow(yield* cursor.one());
          }),
        delete: (id) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const cursor = yield* sql.exec<TodoRow>(
              `DELETE FROM todos WHERE id = ? RETURNING id, title, completed, created_at, updated_at`,
              id,
            );
            return (yield* cursor.toArray()).length > 0;
          }),
        stats: getStats,
        clearCompleted: Effect.gen(function* () {
          yield* ensureSchema;
          yield* sql.exec(`DELETE FROM todos WHERE completed = 1`);
          return yield* getStats;
        }),
      } satisfies TodoRepositoryService;
    }),
  );
}
