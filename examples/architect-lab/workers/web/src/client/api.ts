import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

import type { AiPromptRequest } from "@architect-lab/domain/ai";
import type { ArchitectureReadModelInput } from "@architect-lab/domain/architecture";
import { ArchitectHttpApi } from "@architect-lab/domain/http-api";

import { roomIdAtom } from "./state";

const ArchitectClient = AtomHttpApi.Service()("ArchitectClient", {
  api: ArchitectHttpApi,
  httpClient: FetchHttpClient.layer,
});

const createRoomRequestAtom = ArchitectClient.mutation("api", "createRoom");
const saveReadModelRequestAtom = ArchitectClient.mutation("api", "saveReadModel");
const submitAiPromptRequestAtom = ArchitectClient.mutation("api", "submitAiPrompt");

export const createRoomAtom = ArchitectClient.runtime.fn<void>()(
  Effect.fn("ArchitectWebApi.createRoomAtom")(function* (_, get) {
    const room = yield* get.setResult(createRoomRequestAtom, {});

    yield* Effect.sync(() => {
      history.pushState(null, "", `/room/${room.roomId}`);
      get.set(roomIdAtom, room.roomId);
    });

    return room;
  }),
);

export interface SaveSemanticReadModelArgs {
  readonly readModel: ArchitectureReadModelInput;
  readonly roomId: string;
}

export const saveSemanticReadModelAtom = ArchitectClient.runtime.fn<SaveSemanticReadModelArgs>()(
  Effect.fn("ArchitectWebApi.saveSemanticReadModelAtom")(function* ({ readModel, roomId }, get) {
    if (roomId === "") {
      return undefined;
    }

    return yield* get.setResult(saveReadModelRequestAtom, {
      params: { roomId },
      payload: readModel,
    });
  }),
);

export interface SubmitAiPromptArgs {
  readonly prompt: AiPromptRequest;
  readonly roomId: string;
}

export const submitAiPromptAtom = ArchitectClient.runtime.fn<SubmitAiPromptArgs>()(
  Effect.fn("ArchitectWebApi.submitAiPromptAtom")(function* ({ prompt, roomId }, get) {
    if (roomId === "" || prompt.prompt.trim() === "") {
      return undefined;
    }

    return yield* get.setResult(submitAiPromptRequestAtom, {
      params: { roomId },
      payload: prompt,
    });
  }),
);
