import type { User } from "@effect-cf/example-contracts/Schemas";
import { Effect, Option } from "effect";

import { UserCache } from "./bindings";

const users = new Map<string, User>([
  ["ada", { id: "ada", name: "Ada Lovelace", plan: "pro" }],
  ["grace", { id: "grace", name: "Grace Hopper", plan: "pro" }],
  ["linus", { id: "linus", name: "Linus Torvalds", plan: "free" }],
]);

export const listUsers = Effect.sync(() => Array.from(users.values()));

export const getUser = (userId: string) =>
  Effect.gen(function* () {
    const cached = yield* UserCache.get(userId);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const user = users.get(userId);
    if (user !== undefined) {
      yield* UserCache.put(userId, user);
      return user;
    }

    return null;
  });
