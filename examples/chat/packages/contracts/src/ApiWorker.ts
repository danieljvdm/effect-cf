import { Schema as S } from "effect";
import { Worker } from "effect-cf";

import { User } from "./Schemas";

export class ApiWorker extends Worker.Tag<ApiWorker>()("ApiWorker", {
  getUser: Worker.method({
    args: [S.String] as const,
    success: S.NullOr(User),
  }),
  listUsers: Worker.method({
    success: S.Array(User),
  }),
}) {}

export type ApiWorkerApi = Worker.Api<typeof ApiWorker>;
