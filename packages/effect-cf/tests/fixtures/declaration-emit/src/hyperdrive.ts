import { Hyperdrive } from "effect-cf";

export class Database extends Hyperdrive.Tag<Database>()("Database") {}

export const bindingLayer = Database.layer({ binding: "DATABASE" });
