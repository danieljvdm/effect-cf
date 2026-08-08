/**
 * Renders the most useful human-readable description of an unknown `cause`
 * for use in tagged error `message` getters.
 */
export const causeMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const message = Reflect.get(cause, "message");

    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  try {
    return String(cause);
  } catch {
    return "unknown cause";
  }
};

/** Renders a violation list as a single `path: message; ...` line. */
export const violationsMessage = (
  violations: ReadonlyArray<{ readonly path: string; readonly message: string }>,
): string => violations.map((violation) => `${violation.path}: ${violation.message}`).join("; ");
