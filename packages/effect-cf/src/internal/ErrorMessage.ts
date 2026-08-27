/**
 * Renders the most useful human-readable description of an unknown `cause`
 * for use in tagged error `message` getters.
 */
export const causeMessage = (cause: unknown): string => {
  if (
    Predicate.hasProperty(cause, "message") &&
    Predicate.isString(cause.message) &&
    cause.message.length > 0
  ) {
    return cause.message;
  }

  try {
    return String(cause);
  } catch {
    return "unknown cause";
  }
};

export const violationsMessage = (
  violations: ReadonlyArray<{ readonly path: string; readonly message: string }>,
): string => violations.map((violation) => `${violation.path}: ${violation.message}`).join("; ");
import { Predicate } from "effect";
