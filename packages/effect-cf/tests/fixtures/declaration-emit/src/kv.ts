import { Schema } from "effect";
import { Kv } from "effect-cf";

export class Settings extends Kv.Tag<Settings>()("Settings", {
  key: Schema.String,
  value: Schema.Struct({ name: Schema.String }),
}) {}

export const bindingLayer = Settings.layer({ binding: "SETTINGS" });
