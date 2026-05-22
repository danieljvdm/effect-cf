import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";

import type { AiPromptRequest } from "@architect-lab/domain/ai";
import type { ArchitectureReadModelInput } from "@architect-lab/domain/architecture";
import { ArchitectHttpApi } from "@architect-lab/domain/http-api";

import {
  aiRunningAtom,
  aiStatusAtom,
  creatingAtom,
  readModelStatusAtom,
  roomIdAtom,
} from "./state";

const ArchitectClient = AtomHttpApi.Service()("ArchitectClient", {
  api: ArchitectHttpApi,
  httpClient: FetchHttpClient.layer,
});

const createRoomRequestAtom = ArchitectClient.mutation("api", "createRoom").pipe(Atom.keepAlive);
const saveReadModelRequestAtom = ArchitectClient.mutation("api", "saveReadModel").pipe(
  Atom.keepAlive,
);
const submitAiPromptRequestAtom = ArchitectClient.mutation("api", "submitAiPrompt").pipe(
  Atom.keepAlive,
);

export const createRoomAtom = ArchitectClient.runtime
  .fn<void>()(
    Effect.fn("ArchitectWebApi.createRoomAtom")(function* (_, get) {
      yield* Effect.sync(() => get.set(creatingAtom, true));

      return yield* Effect.gen(function* () {
        const room = yield* get.setResult(createRoomRequestAtom, {});

        yield* Effect.sync(() => {
          history.pushState(null, "", `/room/${room.roomId}`);
          get.set(roomIdAtom, room.roomId);
        });

        return room;
      }).pipe(Effect.ensuring(Effect.sync(() => get.set(creatingAtom, false))));
    }),
  )
  .pipe(Atom.keepAlive);

export interface SaveSemanticReadModelArgs {
  readonly readModel: ArchitectureReadModelInput;
  readonly roomId: string;
}

export const saveSemanticReadModelAtom = ArchitectClient.runtime
  .fn<SaveSemanticReadModelArgs>()(
    Effect.fn("ArchitectWebApi.saveSemanticReadModelAtom")(function* ({ readModel, roomId }, get) {
      if (roomId === "") {
        return;
      }

      yield* Effect.sync(() => get.set(readModelStatusAtom, "saving"));
      yield* get
        .setResult(saveReadModelRequestAtom, {
          params: { roomId },
          payload: readModel,
          reactivityKeys: ["read-model", roomId],
        })
        .pipe(
          Effect.tap(() => Effect.sync(() => get.set(readModelStatusAtom, "saved"))),
          Effect.catch(() => Effect.sync(() => get.set(readModelStatusAtom, "error"))),
        );
    }),
  )
  .pipe(Atom.keepAlive);

export interface SubmitAiPromptArgs {
  readonly prompt: AiPromptRequest;
  readonly roomId: string;
}

export const submitAiPromptAtom = ArchitectClient.runtime
  .fn<SubmitAiPromptArgs>()(
    Effect.fn("ArchitectWebApi.submitAiPromptAtom")(function* ({ prompt, roomId }, get) {
      if (roomId === "" || prompt.prompt.trim() === "") {
        return;
      }

      yield* Effect.sync(() => {
        get.set(aiRunningAtom, true);
        get.set(aiStatusAtom, "Queueing fake AI job");
      });

      yield* get
        .setResult(submitAiPromptRequestAtom, {
          params: { roomId },
          payload: prompt,
          reactivityKeys: ["ai-prompt", roomId],
        })
        .pipe(
          Effect.tap((result) => Effect.sync(() => get.set(aiStatusAtom, result.summary))),
          Effect.catch(() => Effect.sync(() => get.set(aiStatusAtom, "AI prompt failed"))),
          Effect.ensuring(Effect.sync(() => get.set(aiRunningAtom, false))),
        );
    }),
  )
  .pipe(Atom.keepAlive);
