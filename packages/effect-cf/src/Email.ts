import type {
  EmailAddress as CloudflareEmailAddress,
  EmailAttachment as CloudflareEmailAttachment,
  EmailSendResult as CloudflareEmailSendResult,
  SendEmail as CloudflareSendEmail,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";
import * as ErrorMessage from "./internal/ErrorMessage";

const expectedSendEmailBinding = "Send Email binding with send()";
const textEncoder = new TextEncoder();

/** Documented Cloudflare Email Sending limits. */
export const sendLimits = {
  /** Combined `to`, `cc`, and `bcc` addresses per message. */
  maxRecipients: 50,
  maxAttachments: 32,
  /** Total message size, including attachments. Not enforced client side. */
  maxMessageBytes: 5 * 1024 * 1024,
  maxHeaderNameBytes: 100,
  maxHeaderValueBytes: 2048,
  maxHeadersBytes: 16 * 1024,
  /** Allowlisted custom headers, excluding `X-` prefixed headers. */
  maxAllowlistHeaders: 20,
} as const;

/**
 * Error codes reported by Cloudflare Email Sending.
 *
 * Surfaced on {@link EmailOperationError} `code` on a best-effort basis: the
 * runtime attaches them as a non-standard `code` property on thrown errors,
 * which may be missing depending on the runtime or dev-time proxying
 * (miniflare remote bindings serialize errors and can strip it).
 */
export const emailErrorCodes = [
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
] as const;

/** A documented Cloudflare Email Sending error code. */
export type EmailErrorCode = (typeof emailErrorCodes)[number];

/** Error raised when a Cloudflare Send Email operation fails. */
export class EmailOperationError extends Data.TaggedError("EmailOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
  /**
   * Cloudflare error code taken from the thrown error, when present.
   *
   * Best-effort: may be `undefined` depending on the runtime or dev-time
   * proxying — miniflare remote bindings (`"remote": true`) serialize thrown
   * errors and can strip the non-standard `code` property.
   */
  readonly code?: EmailErrorCode | (string & {});
}> {
  override get message(): string {
    const code = this.code === undefined ? "" : ` (${this.code})`;

    return `Email ${this.operation} failed for binding "${this.binding}"${code}: ${ErrorMessage.causeMessage(this.cause)}`;
  }
}

/** A single message field that violates a documented Email Sending limit. */
export interface EmailViolation {
  readonly path: string;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}

/** Error raised when a message violates documented Cloudflare Email Sending limits. */
export class EmailValidationError extends Data.TaggedError("EmailValidationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly violations: ReadonlyArray<EmailViolation>;
}> {
  override get message(): string {
    return `Email ${this.operation} for binding "${this.binding}" failed validation: ${ErrorMessage.violationsMessage(this.violations)}`;
  }
}

/** Typed Cloudflare Send Email binding definition. */
export interface EmailDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type EmailAddress = CloudflareEmailAddress;
export type EmailAttachment = CloudflareEmailAttachment;
export type EmailMessageBuilder = Parameters<CloudflareSendEmail["send"]>[0];
export type EmailSendResult = CloudflareEmailSendResult;
export type EmailBinding = CloudflareSendEmail;
export type EmailRecipients = string | EmailAddress | ReadonlyArray<string | EmailAddress>;
export type EmailSendError = EmailOperationError | EmailValidationError;

export interface EmailSendOptions {
  /** Validates builder messages against documented limits. Defaults to `true`. */
  readonly validate?: boolean;
}

interface EmailRuntimeBinding {
  readonly send: (message: EmailMessageBuilder) => Promise<EmailSendResult>;
}

export interface EmailClient {
  readonly send: (message: EmailMessageBuilder) => Effect.Effect<EmailSendResult, EmailSendError>;
  readonly rawUnsafe: Effect.Effect<EmailBinding>;
  readonly definition: EmailDefinition;
}

declare const EmailServiceTypeId: unique symbol;

/** Nominal service marker for Send Email services created with {@link make}. */
export interface EmailService<Id extends string> {
  readonly [EmailServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
  readonly send?: EmailSendOptions;
};

export interface TagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  EmailClient
> {
  readonly id: Id;
  readonly layer: (
    options: LayerOptions,
  ) => Layer.Layer<
    Self,
    Binding.BindingNotFoundError | Binding.BindingValidationError,
    WorkerEnvironment
  >;
}

/**
 * Best-effort extraction of the Cloudflare error `code` from a thrown error.
 * Returns `undefined` when the property is absent — e.g. when a dev-time
 * proxy such as a miniflare remote binding (`"remote": true`) serializes the
 * error and strips non-standard properties.
 */
const emailErrorCode = (cause: unknown): EmailOperationError["code"] => {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }

  const code = Reflect.get(cause, "code");

  return typeof code === "string" ? code : undefined;
};

const emailError = (binding: string, operation: string, cause: unknown) =>
  new EmailOperationError({ binding, operation, cause, code: emailErrorCode(cause) });

const emailValidationError = (
  binding: string,
  operation: string,
  violations: ReadonlyArray<EmailViolation>,
) => new EmailValidationError({ binding, operation, violations });

const tryEmailPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, EmailOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => emailError(binding, operation, cause),
  });

const byteLength = (value: string) => textEncoder.encode(value).byteLength;

const limitViolation = (
  path: string,
  label: string,
  actual: number,
  limit: number,
): EmailViolation => ({
  path,
  message: `${label} exceeds Cloudflare Email Sending limit`,
  actual,
  limit,
});

const addressList = (value: EmailRecipients | undefined): ReadonlyArray<string | EmailAddress> => {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value as string | EmailAddress];
};

const addressViolations = (path: string, value: unknown): ReadonlyArray<EmailViolation> => {
  if (typeof value === "string") {
    return value.includes("@") ? [] : [{ path, message: "Email address must contain an @ symbol" }];
  }

  if (typeof value !== "object" || value === null) {
    return [{ path, message: "Email address must be a string or { name, email } object" }];
  }

  const email = Reflect.get(value, "email");

  if (typeof email !== "string" || !email.includes("@")) {
    return [{ path: `${path}.email`, message: "Email address must contain an @ symbol" }];
  }

  return [];
};

const recipientViolations = (
  field: "to" | "cc" | "bcc",
  value: EmailRecipients | undefined,
): ReadonlyArray<EmailViolation> =>
  addressList(value).flatMap((address, index) => addressViolations(`${field}[${index}]`, address));

const attachmentViolations = (
  attachments: ReadonlyArray<EmailAttachment>,
): ReadonlyArray<EmailViolation> => {
  const violations: Array<EmailViolation> = [];

  if (attachments.length > sendLimits.maxAttachments) {
    violations.push(
      limitViolation("attachments", "attachments", attachments.length, sendLimits.maxAttachments),
    );
  }

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const path = `attachments[${index}]`;

    if (typeof attachment !== "object" || attachment === null) {
      violations.push({ path, message: "Attachment must be an object" });
      continue;
    }

    if (typeof attachment.filename !== "string" || attachment.filename === "") {
      violations.push({ path: `${path}.filename`, message: "Attachment filename is required" });
    }

    if (typeof attachment.type !== "string" || attachment.type === "") {
      violations.push({ path: `${path}.type`, message: "Attachment MIME type is required" });
    }

    if (attachment.content === undefined || attachment.content === null) {
      violations.push({ path: `${path}.content`, message: "Attachment content is required" });
    }

    if (attachment.disposition === "inline" && typeof attachment.contentId !== "string") {
      violations.push({
        path: `${path}.contentId`,
        message: "Inline attachments require a contentId",
      });
    }
  }

  return violations;
};

const headerViolations = (headers: Record<string, string>): ReadonlyArray<EmailViolation> => {
  const violations: Array<EmailViolation> = [];
  const entries = Object.entries(headers);
  let totalBytes = 0;
  let allowlistHeaders = 0;

  for (const [name, value] of entries) {
    const path = `headers["${name}"]`;
    const nameBytes = byteLength(name);

    if (nameBytes > sendLimits.maxHeaderNameBytes) {
      violations.push(
        limitViolation(path, "header name bytes", nameBytes, sendLimits.maxHeaderNameBytes),
      );
    }

    if (typeof value !== "string") {
      violations.push({ path, message: "Header value must be a string" });
      continue;
    }

    const valueBytes = byteLength(value);

    if (valueBytes > sendLimits.maxHeaderValueBytes) {
      violations.push(
        limitViolation(path, "header value bytes", valueBytes, sendLimits.maxHeaderValueBytes),
      );
    }

    totalBytes += nameBytes + valueBytes;

    if (!name.toLowerCase().startsWith("x-")) {
      allowlistHeaders += 1;
    }
  }

  if (totalBytes > sendLimits.maxHeadersBytes) {
    violations.push(
      limitViolation("headers", "header bytes", totalBytes, sendLimits.maxHeadersBytes),
    );
  }

  if (allowlistHeaders > sendLimits.maxAllowlistHeaders) {
    violations.push(
      limitViolation(
        "headers",
        "allowlisted custom headers",
        allowlistHeaders,
        sendLimits.maxAllowlistHeaders,
      ),
    );
  }

  return violations;
};

/**
 * Validates a structured message against documented Cloudflare Email Sending
 * limits and returns every violation found. Total message size is not checked
 * because the encoded MIME size is only known once Cloudflare composes it.
 */
export const validateMessage = (message: EmailMessageBuilder): ReadonlyArray<EmailViolation> => {
  const violations: Array<EmailViolation> = [];
  const fields = message as {
    readonly to?: EmailRecipients;
    readonly cc?: EmailRecipients;
    readonly bcc?: EmailRecipients;
    readonly from?: unknown;
    readonly replyTo?: unknown;
    readonly subject?: unknown;
    readonly text?: unknown;
    readonly html?: unknown;
    readonly attachments?: ReadonlyArray<EmailAttachment>;
    readonly headers?: Record<string, string>;
  };

  if (fields.from === undefined) {
    violations.push({ path: "from", message: "A from address is required" });
  } else {
    violations.push(...addressViolations("from", fields.from));
  }

  if (fields.replyTo !== undefined) {
    violations.push(...addressViolations("replyTo", fields.replyTo));
  }

  if (typeof fields.subject !== "string" || fields.subject === "") {
    violations.push({ path: "subject", message: "A subject is required" });
  }

  if (typeof fields.text !== "string" && typeof fields.html !== "string") {
    violations.push({ path: "$", message: "A message requires either text or html content" });
  }

  const recipients =
    addressList(fields.to).length + addressList(fields.cc).length + addressList(fields.bcc).length;

  if (recipients === 0) {
    violations.push({
      path: "$",
      message: "A message requires at least one to, cc, or bcc address",
    });
  }

  if (recipients > sendLimits.maxRecipients) {
    violations.push(
      limitViolation(
        "$",
        "combined to, cc, and bcc addresses",
        recipients,
        sendLimits.maxRecipients,
      ),
    );
  }

  violations.push(...recipientViolations("to", fields.to));
  violations.push(...recipientViolations("cc", fields.cc));
  violations.push(...recipientViolations("bcc", fields.bcc));

  if (fields.attachments !== undefined) {
    violations.push(...attachmentViolations(fields.attachments));
  }

  if (fields.headers !== undefined) {
    violations.push(...headerViolations(fields.headers));
  }

  return violations;
};

const validateSendInput = (
  binding: string,
  operation: string,
  message: EmailMessageBuilder,
): Effect.Effect<EmailMessageBuilder, EmailValidationError> => {
  const violations = validateMessage(message);

  return violations.length > 0
    ? Effect.fail(emailValidationError(binding, operation, violations))
    : Effect.succeed(message);
};

export const isEmailBinding = (value: unknown): value is EmailBinding => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return typeof resource.send === "function";
};

export const makeClient =
  (definition: EmailDefinition, options?: EmailSendOptions) =>
  (email: EmailBinding): EmailClient => {
    const runtime = email as EmailRuntimeBinding;
    const validate = options?.validate ?? true;
    const send = Effect.fn("Email.send")(function* (message: EmailMessageBuilder) {
      if (validate) {
        yield* validateSendInput(definition.binding, "send", message);
      }

      return yield* tryEmailPromise(definition.binding, "send", () => runtime.send(message));
    });

    return {
      definition,
      send,
      rawUnsafe: Effect.succeed(email),
    };
  };

export const layer = <Self>(tag: Context.Service<Self, EmailClient>, definition: LayerOptions) =>
  Binding.layer(tag, definition.binding, isEmailBinding, makeClient(definition, definition.send), {
    expected: expectedSendEmailBinding,
  });

export const make = <Id extends string>(id: Id) => Tag<EmailService<Id>>()<Id>(id);

export const Tag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, EmailClient>()(id);

    const makeLayer = (definition: LayerOptions) => layer(tag, definition);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
    }) as TagClass<Self, Id>;
  };
