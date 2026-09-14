import * as Sandbox from "effect-cf/sandbox";

export class Sandboxes extends Sandbox.Tag<Sandboxes>()("Sandboxes") {}

export const bindingLayer = Sandboxes.layer({ binding: "SANDBOXES" });
