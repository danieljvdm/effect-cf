import { ServiceBinding } from "effect-cf";

export interface Api {
  ping(message: string): Promise<string>;
}

export class Remote extends ServiceBinding.Service<Remote, Api>()("Remote", {
  binding: "REMOTE",
}) {}

export const bindingLayer = Remote.layer;

export const called = Remote.call("ping", "hello");
export const rawResult = Remote.rpc("ping", "hello");
export const scopedResult = Remote.scopedCall("ping", "hello");
export const fetched = Remote.fetch("https://example.com");
export const call = Remote.call;
export const rpc = Remote.rpc;
export const scopedCall = Remote.scopedCall;
