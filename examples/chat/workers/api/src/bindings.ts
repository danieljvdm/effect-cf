import { User } from "@effect-cf/example-contracts/Schemas";
import { Schema as S } from "effect";
import { Kv } from "effect-cf";

export class UserCache extends Kv.Tag<UserCache>()("chat-api/UserCache", {
  key: S.String,
  value: User,
}) {}
