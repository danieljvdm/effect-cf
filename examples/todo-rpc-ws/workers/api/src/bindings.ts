import { TodoStore } from "@effect-cf/todo-rpc-ws-domain";

export const TodoStores = TodoStore.namespace("todo-rpc-ws-api/TodoStores", {
  binding: "TODO_STORE",
});
