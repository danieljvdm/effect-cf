import * as Data from "effect/Data";

export class NonRetryableError extends Data.TaggedError("NonRetryableError")<{
  readonly message: string;
}> {
  constructor(message: string, name = "NonRetryableError") {
    super({ message });
    this.name = name;
  }
}
