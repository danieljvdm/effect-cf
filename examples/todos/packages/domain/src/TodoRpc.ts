import { Rpc, RpcGroup } from "effect/unstable/rpc";

import { DatabaseError, TodoStats } from "./TodoApi";

export const TodoRpcGroup = RpcGroup.make(
  Rpc.make("GetStats", {
    success: TodoStats,
    error: DatabaseError,
  }),
  Rpc.make("ClearCompleted", {
    success: TodoStats,
    error: DatabaseError,
  }),
);
