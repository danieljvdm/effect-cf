import type { WorkspaceHandle } from "@cloudflare/computer";

const hosts = new WeakMap<globalThis.DurableObjectState, WorkspaceHandle>();

export const register = (state: globalThis.DurableObjectState, host: WorkspaceHandle): void => {
  hosts.set(state, host);
};

export const lookup = (state: globalThis.DurableObjectState): WorkspaceHandle | undefined =>
  hosts.get(state);
