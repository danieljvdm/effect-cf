import { Atom } from "effect/unstable/reactivity";
import type { Editor } from "tldraw";

import type { ArchitectureResource } from "@architect-lab/domain/architecture";

import { getInitialRoomId, randomLabel } from "./lib/identity";

const getStoredLabel = () =>
  typeof localStorage === "undefined"
    ? randomLabel()
    : (localStorage.getItem("architect:label") ?? randomLabel());

export const roomIdAtom = Atom.make<string>(getInitialRoomId()).pipe(Atom.keepAlive);
export const labelAtom = Atom.make<string>(getStoredLabel()).pipe(Atom.keepAlive);
export const editorAtom = Atom.make<Editor | null>(null);
export const selectedResourceAtom = Atom.make<ArchitectureResource | null>(null);
export const resourceCountsAtom = Atom.make<Record<string, number>>({});
export const aiPromptAtom = Atom.make("Draw an AI architecture canvas").pipe(Atom.keepAlive);

export const saveLabelAtom = Atom.fnSync<string>()((value, get) => {
  get.set(labelAtom, value);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("architect:label", value);
  }
}).pipe(Atom.keepAlive);
