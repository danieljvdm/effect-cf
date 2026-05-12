import type { CreateTodo, Todo, TodoStats, UpdateTodo } from "@effect-cf/todo-http-domain";
import { TodoNotFound } from "@effect-cf/todo-http-domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";

interface TodoRow {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly title: string;
  readonly completed: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface StatsRow {
  readonly [key: string]: unknown;
  readonly total: number;
  readonly completed: number;
}

export interface TodoRepositoryService {
  readonly list: Effect.Effect<ReadonlyArray<Todo>, SqlError.SqlError>;
  readonly create: (input: CreateTodo) => Effect.Effect<Todo, SqlError.SqlError>;
  readonly update: (
    id: string,
    input: UpdateTodo,
  ) => Effect.Effect<Todo, SqlError.SqlError | TodoNotFound>;
  readonly delete: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly stats: Effect.Effect<TodoStats, SqlError.SqlError>;
  readonly clearCompleted: Effect.Effect<TodoStats, SqlError.SqlError>;
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
  "todo-http-api/TodoRepository",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const ensureSchema = sql`
        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;

      const selectTodos = () =>
        Effect.gen(function* () {
          yield* ensureSchema;
          const rows = yield* sql<TodoRow>`
            SELECT id, title, completed, created_at, updated_at
            FROM todos
            ORDER BY completed ASC, created_at DESC
          `;
          return rows.map(fromRow);
        });

      const getStats = Effect.gen(function* () {
        yield* ensureSchema;
        const rows = yield* sql<StatsRow>`
          SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed
          FROM todos
        `;
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
            const rows = yield* sql<TodoRow>`
              INSERT INTO todos (id, title, completed, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${title === "" ? "Untitled todo" : title}, 0, ${now}, ${now})
              RETURNING id, title, completed, created_at, updated_at
            `;
            return fromRow(rows[0]);
          }),
        update: (id, input) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const currentRows = yield* sql<TodoRow>`
              SELECT id, title, completed, created_at, updated_at
              FROM todos
              WHERE id = ${id}
            `;
            const current = currentRows[0];
            if (current === undefined) {
              return yield* Effect.fail(new TodoNotFound({ id }));
            }

            const now = new Date().toISOString();
            const title = input.title === undefined ? current.title : trimTitle(input.title);
            const completed =
              input.completed === undefined ? current.completed : input.completed ? 1 : 0;
            const rows = yield* sql<TodoRow>`
              UPDATE todos
              SET title = ${title === "" ? current.title : title}, completed = ${completed}, updated_at = ${now}
              WHERE id = ${id}
              RETURNING id, title, completed, created_at, updated_at
            `;
            return fromRow(rows[0]);
          }),
        delete: (id) =>
          Effect.gen(function* () {
            yield* ensureSchema;
            const rows = yield* sql<TodoRow>`
              DELETE FROM todos
              WHERE id = ${id}
              RETURNING id, title, completed, created_at, updated_at
            `;
            return rows.length > 0;
          }),
        stats: getStats,
        clearCompleted: Effect.gen(function* () {
          yield* ensureSchema;
          yield* sql`DELETE FROM todos WHERE completed = 1`;
          return yield* getStats;
        }),
      } satisfies TodoRepositoryService;
    }),
  );
}
