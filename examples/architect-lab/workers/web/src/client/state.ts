import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { Editor } from "tldraw";

import type { ArchitectureResource } from "@architect-lab/domain/architecture";

import { getInitialRoomId, randomLabel } from "./lib/identity";

const getStoredLabel = () =>
  typeof localStorage === "undefined"
    ? randomLabel()
    : (localStorage.getItem("architect:label") ?? randomLabel());

export const atomRegistry = AtomRegistry.make();

export const roomIdAtom = Atom.make<string>(getInitialRoomId()).pipe(Atom.keepAlive);
export const labelAtom = Atom.make<string>(getStoredLabel()).pipe(Atom.keepAlive);
export const creatingAtom = Atom.make(false).pipe(Atom.keepAlive);
export const editorAtom = Atom.make<Editor | null>(null).pipe(Atom.keepAlive);
export const selectedResourceAtom = Atom.make<ArchitectureResource | null>(null).pipe(
  Atom.keepAlive,
);
export const resourceCountsAtom = Atom.make<Record<string, number>>({}).pipe(Atom.keepAlive);
export const readModelStatusAtom = Atom.make("not synced").pipe(Atom.keepAlive);
export const aiPromptAtom = Atom.make("Draw an AI architecture canvas").pipe(Atom.keepAlive);
export const aiStatusAtom = Atom.make("Fake provider ready").pipe(Atom.keepAlive);
export const aiRunningAtom = Atom.make(false).pipe(Atom.keepAlive);

export const useAtomValue = <A>(atom: Atom.Atom<A>): A =>
  useSyncExternalStore(
    (notify) => atomRegistry.subscribe(atom, notify),
    () => atomRegistry.get(atom),
    () => atomRegistry.get(atom),
  );

export const useAtomSet = <R, W>(atom: Atom.Writable<R, W>) => {
  useEffect(() => atomRegistry.mount(atom), [atom]);

  return useCallback((value: W) => atomRegistry.set(atom, value), [atom]);
};

export const saveLabelAtom = Atom.fnSync<string>()((value, get) => {
  get.set(labelAtom, value);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("architect:label", value);
  }
}).pipe(Atom.keepAlive);
