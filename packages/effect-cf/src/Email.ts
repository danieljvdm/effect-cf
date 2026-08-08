import type {
  EmailAddress as CloudflareEmailAddress,
  EmailAttachment as CloudflareEmailAttachment,
  EmailMessage as CloudflareEmailMessage,
  EmailSendResult as CloudflareEmailSendResult,
  SendEmail as CloudflareSendEmail,
} from "@cloudflare/workers-types";
import { type Redacted, Config, Context, Data, Effect, Layer, Schema as S } from "effect";
import {
  FetchHttpClient,
  type Headers,
  HttpClient,
  type HttpClientResponse,
  HttpClientRequest,
} from "effect/unstable/http";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedSendEmailBinding = "Send Email binding with send()";
const defaultSendingApiBaseUrl = "https://api.cloudflare.com/client/v4";
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

/** Error codes reported by Cloudflare Email Sending. */
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

const sendingApiErrorSchema = S.Struct({
  code: S.Number,
  message: S.String,
});

const sendingResultSchema = S.Struct({
  delivered: S.Array(S.String),
  permanent_bounces: S.Array(S.String),
  queued: S.Array(S.String),
});

const sendingResponseSchema = S.Struct({
  success: S.Boolean,
  errors: S.Array(sendingApiErrorSchema),
  result: S.NullOr(sendingResultSchema),
});

const decodeSendingResponse = S.decodeUnknownEffect(sendingResponseSchema);

/** Error raised when a Cloudflare Send Email operation fails. */
export class EmailOperationError extends Data.TaggedError("EmailOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
  /** Cloudflare error code taken from the thrown error, when present. */
  readonly code?: EmailErrorCode | (string & {});
}> {}

/** A single message field that violates a documented Email Sending limit. */
export interface EmailViolation {
  readonly path: string;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}

/** Error raised when a message violates documented Cloudflare Email Sending limits. */
export class EmailValidationError extends Data.TaggedError("EmailValidationError")<{
  /** Binding name for binding sends, or Cloudflare account id for REST sends. */
  readonly source: string;
  readonly operation: string;
  readonly violations: ReadonlyArray<EmailViolation>;
}> {}

/** Error raised when a Cloudflare Email Sending REST API request fails. */
export class EmailSendingError extends Data.TaggedError("EmailSendingError")<{
  readonly operation: string;
  readonly accountId: string;
  readonly message: string;
  readonly status?: number;
  readonly errors?: ReadonlyArray<EmailSendingApiError>;
  readonly body?: string;
  readonly cause?: unknown;
}> {}

/** Typed Cloudflare Send Email binding definition. */
export interface EmailDefinition {
  /** Binding name as configured in `wrangler.jsonc`. */
  readonly binding: string;
}

export type EmailAddress = CloudflareEmailAddress;
export type EmailAttachment = CloudflareEmailAttachment;
export type EmailMessage = CloudflareEmailMessage;
export type EmailMessageBuilder = Parameters<CloudflareSendEmail["send"]>[0];
export type EmailSendInput = EmailMessage | EmailMessageBuilder;
export type EmailSendResult = CloudflareEmailSendResult;
export type EmailBinding = CloudflareSendEmail;
export type EmailRecipients = string | EmailAddress | ReadonlyArray<string | EmailAddress>;
export type EmailSendError = EmailOperationError | EmailValidationError;
export type EmailSendingApiError = S.Schema.Type<typeof sendingApiErrorSchema>;

/** Per-recipient delivery status returned by the Email Sending REST API. */
export interface EmailSendingResult {
  /** Addresses the message was delivered to immediately. */
  readonly delivered: ReadonlyArray<string>;
  /** Addresses that permanently bounced. */
  readonly permanentBounces: ReadonlyArray<string>;
  /** Addresses whose delivery was queued for later. */
  readonly queued: ReadonlyArray<string>;
}

export interface EmailSendOptions {
  /** Validates builder messages against documented limits. Defaults to `true`. */
  readonly validate?: boolean;
}

interface EmailRuntimeBinding {
  readonly send: (message: EmailSendInput) => Promise<EmailSendResult>;
}

export interface EmailClient {
  readonly send: {
    (message: EmailMessage): Effect.Effect<EmailSendResult, EmailSendError>;
    (builder: EmailMessageBuilder): Effect.Effect<EmailSendResult, EmailSendError>;
  };
  readonly unsafeRaw: Effect.Effect<EmailBinding>;
  readonly definition: EmailDefinition;
}

/** Cloudflare Email Sending REST API definition. */
export interface EmailSendingDefinition {
  /** Cloudflare account id that owns the onboarded sending domain. */
  readonly accountId: string;
  /** API token with the Email Sending permission. */
  readonly apiToken: Redacted.Redacted<string>;
  /** Base Cloudflare API URL. Defaults to `https://api.cloudflare.com/client/v4`. */
  readonly apiBaseUrl?: string | URL;
  /** Validates messages against documented limits. Defaults to `true`. */
  readonly validate?: boolean;
}

export interface EmailSendingOptions {
  /** Additional request headers. Authorization is always derived from `apiToken`. */
  readonly headers?: Headers.Input;
}

export interface EmailSendingClient {
  readonly send: (
    message: EmailMessageBuilder,
    options?: EmailSendingOptions,
  ) => Effect.Effect<EmailSendingResult, EmailSendingError | EmailValidationError | S.SchemaError>;
  readonly raw: (
    message: EmailMessageBuilder,
    options?: EmailSendingOptions,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    EmailSendingError | EmailValidationError
  >;
  readonly definition: EmailSendingDefinition;
}

declare const EmailServiceTypeId: unique symbol;
declare const EmailSendingServiceTypeId: unique symbol;

/** Nominal service marker for Send Email services created with {@link make}. */
export interface EmailService<Id extends string> {
  readonly [EmailServiceTypeId]: {
    readonly id: Id;
  };
}

/** Nominal service marker for Email Sending REST services created with {@link makeSending}. */
export interface EmailSendingService<Id extends string> {
  readonly [EmailSendingServiceTypeId]: {
    readonly id: Id;
  };
}

export type LayerOptions = {
  readonly binding: string;
  readonly send?: EmailSendOptions;
};

export type SendingConfigOptions = {
  readonly accountId?: Config.Config<string>;
  readonly apiToken?: Config.Config<Redacted.Redacted<string>>;
  readonly apiBaseUrl?: Config.Config<string>;
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

export interface SendingTagClass<Self, Id extends string> extends Context.ServiceClass<
  Self,
  Id,
  EmailSendingClient
> {
  readonly id: Id;
  readonly layer: (
    definition: EmailSendingDefinition,
  ) => Layer.Layer<Self, never, HttpClient.HttpClient>;
  readonly fetchLayer: (definition: EmailSendingDefinition) => Layer.Layer<Self>;
  readonly layerConfig: (
    config?: Config.Config<EmailSendingDefinition>,
  ) => Layer.Layer<Self, Config.ConfigError, HttpClient.HttpClient>;
  readonly fetchLayerConfig: (
    config?: Config.Config<EmailSendingDefinition>,
  ) => Layer.Layer<Self, Config.ConfigError>;
}

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
  source: string,
  operation: string,
  violations: ReadonlyArray<EmailViolation>,
) => new EmailValidationError({ source, operation, violations });

const emailSendingError = (
  definition: EmailSendingDefinition,
  operation: string,
  message: string,
  options?: {
    readonly status?: number;
    readonly errors?: ReadonlyArray<EmailSendingApiError>;
    readonly body?: string;
    readonly cause?: unknown;
  },
) =>
  new EmailSendingError({
    operation,
    accountId: definition.accountId,
    message,
    status: options?.status,
    errors: options?.errors,
    body: options?.body,
    cause: options?.cause,
  });

const tryEmailPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, EmailOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => emailError(binding, operation, cause),
  });

const builderFields = [
  "subject",
  "html",
  "text",
  "cc",
  "bcc",
  "replyTo",
  "attachments",
  "headers",
] as const;

/**
 * Distinguishes structured Email Sending messages from raw MIME `EmailMessage`
 * values, which only carry envelope `from` and `to` addresses.
 */
export const isEmailMessageBuilder = (message: EmailSendInput): message is EmailMessageBuilder => {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  return builderFields.some((field) => Reflect.get(message, field) !== undefined);
};

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
  source: string,
  operation: string,
  message: EmailMessageBuilder,
): Effect.Effect<EmailMessageBuilder, EmailValidationError> => {
  const violations = validateMessage(message);

  return violations.length > 0
    ? Effect.fail(emailValidationError(source, operation, violations))
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
    const send = ((message: EmailSendInput) => {
      const dispatch = () =>
        tryEmailPromise(definition.binding, "send", () => runtime.send(message));

      if (!validate || !isEmailMessageBuilder(message)) {
        return dispatch();
      }

      return validateSendInput(definition.binding, "send", message).pipe(Effect.flatMap(dispatch));
    }) as EmailClient["send"];

    return {
      definition,
      send,
      unsafeRaw: Effect.succeed(email),
    };
  };

const base64 = (content: ArrayBuffer | ArrayBufferView) => {
  const bytes =
    content instanceof ArrayBuffer
      ? new Uint8Array(content)
      : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
};

const sendingAddress = (value: string | EmailAddress) => {
  if (typeof value === "string") {
    return value;
  }

  return value.name === undefined || value.name === ""
    ? { address: value.email }
    : { address: value.email, name: value.name };
};

const sendingRecipients = (value: EmailRecipients) =>
  Array.isArray(value) ? value.map(sendingAddress) : sendingAddress(value as string | EmailAddress);

const sendingAttachment = (attachment: EmailAttachment) => ({
  content: typeof attachment.content === "string" ? attachment.content : base64(attachment.content),
  filename: attachment.filename,
  type: attachment.type,
  disposition: attachment.disposition,
  ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
});

/**
 * Converts a structured Workers message into the Cloudflare Email Sending REST
 * API payload, which uses `address` keys and snake_case fields.
 */
export const toSendingPayload = (message: EmailMessageBuilder): Record<string, unknown> => {
  const fields = message as {
    readonly to?: EmailRecipients;
    readonly cc?: EmailRecipients;
    readonly bcc?: EmailRecipients;
    readonly from: string | EmailAddress;
    readonly replyTo?: string | EmailAddress;
    readonly subject: string;
    readonly text?: string;
    readonly html?: string;
    readonly attachments?: ReadonlyArray<EmailAttachment>;
    readonly headers?: Record<string, string>;
  };

  return {
    from: sendingAddress(fields.from),
    subject: fields.subject,
    ...(fields.to === undefined ? {} : { to: sendingRecipients(fields.to) }),
    ...(fields.cc === undefined ? {} : { cc: sendingRecipients(fields.cc) }),
    ...(fields.bcc === undefined ? {} : { bcc: sendingRecipients(fields.bcc) }),
    ...(fields.replyTo === undefined ? {} : { reply_to: sendingAddress(fields.replyTo) }),
    ...(fields.text === undefined ? {} : { text: fields.text }),
    ...(fields.html === undefined ? {} : { html: fields.html }),
    ...(fields.attachments === undefined
      ? {}
      : { attachments: fields.attachments.map(sendingAttachment) }),
    ...(fields.headers === undefined ? {} : { headers: fields.headers }),
  };
};

const sendingApiUrl = (definition: EmailSendingDefinition) => {
  const baseUrl = new URL(definition.apiBaseUrl ?? defaultSendingApiBaseUrl);
  const pathname = baseUrl.pathname.replace(/\/+$/, "");

  baseUrl.pathname = `${pathname}/accounts/${definition.accountId}/email/sending/send`;

  return baseUrl.href;
};

const sendingRequest = (
  definition: EmailSendingDefinition,
  message: EmailMessageBuilder,
  options?: EmailSendingOptions,
) => {
  let request = HttpClientRequest.post(sendingApiUrl(definition)).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJsonUnsafe(toSendingPayload(message)),
  );

  if (options?.headers !== undefined) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }

  return HttpClientRequest.bearerToken(request, definition.apiToken);
};

const apiErrors = (body: string): ReadonlyArray<EmailSendingApiError> | undefined => {
  const parsed = (() => {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return undefined;
    }
  })();

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const errors = Reflect.get(parsed, "errors");

  if (!Array.isArray(errors)) {
    return undefined;
  }

  const decoded = errors.filter(
    (error): error is EmailSendingApiError =>
      typeof error === "object" &&
      error !== null &&
      typeof Reflect.get(error, "code") === "number" &&
      typeof Reflect.get(error, "message") === "string",
  );

  return decoded.length === 0 ? undefined : decoded;
};

const sendingResponseText = (
  definition: EmailSendingDefinition,
  response: HttpClientResponse.HttpClientResponse,
  operation: string,
) =>
  response.text.pipe(
    Effect.catch((cause) =>
      Effect.fail(
        emailSendingError(definition, operation, "Failed to read Email Sending API response body", {
          cause,
        }),
      ),
    ),
  );

const executeSendRequest = (
  definition: EmailSendingDefinition,
  httpClient: HttpClient.HttpClient,
  message: EmailMessageBuilder,
  options?: EmailSendingOptions,
) =>
  Effect.gen(function* () {
    if (definition.validate ?? true) {
      yield* validateSendInput(definition.accountId, "send", message);
    }

    const response = yield* httpClient
      .execute(sendingRequest(definition, message, options))
      .pipe(
        Effect.mapError((cause) =>
          emailSendingError(definition, "send", "Email Sending API request failed", { cause }),
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      const body = yield* sendingResponseText(definition, response, "sendErrorBody");

      return yield* Effect.fail(
        emailSendingError(
          definition,
          "send",
          `Email Sending API returned HTTP ${response.status}`,
          { status: response.status, body, errors: apiErrors(body) },
        ),
      );
    }

    return response;
  });

const makeSendingClientWith = (
  definition: EmailSendingDefinition,
  httpClient: HttpClient.HttpClient,
): EmailSendingClient => {
  const raw = (message: EmailMessageBuilder, options?: EmailSendingOptions) =>
    executeSendRequest(definition, httpClient, message, options);

  const send = (message: EmailMessageBuilder, options?: EmailSendingOptions) =>
    Effect.gen(function* () {
      const response = yield* raw(message, options);
      const json = yield* response.json.pipe(
        Effect.catch((cause) =>
          Effect.fail(
            emailSendingError(
              definition,
              "json",
              "Failed to read Email Sending API JSON response body",
              { cause },
            ),
          ),
        ),
      );
      const decoded = yield* decodeSendingResponse(json);

      if (!decoded.success || decoded.result === null) {
        return yield* Effect.fail(
          emailSendingError(definition, "send", "Email Sending API reported a failed send", {
            status: response.status,
            errors: decoded.errors,
          }),
        );
      }

      return {
        delivered: decoded.result.delivered,
        permanentBounces: decoded.result.permanent_bounces,
        queued: decoded.result.queued,
      } satisfies EmailSendingResult;
    });

  return { definition, raw, send };
};

export const makeSendingClient = (definition: EmailSendingDefinition) =>
  Effect.map(HttpClient.HttpClient, (httpClient) => makeSendingClientWith(definition, httpClient));

export const sendingConfig = (options?: SendingConfigOptions) =>
  Config.all({
    accountId: options?.accountId ?? Config.string("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: options?.apiToken ?? Config.redacted("CLOUDFLARE_API_TOKEN"),
    apiBaseUrl:
      options?.apiBaseUrl ??
      Config.string("CLOUDFLARE_API_BASE_URL").pipe(Config.withDefault(defaultSendingApiBaseUrl)),
  });

export const layer = <Self>(tag: Context.Service<Self, EmailClient>, definition: LayerOptions) =>
  Binding.layer(tag, definition.binding, isEmailBinding, makeClient(definition, definition.send), {
    expected: expectedSendEmailBinding,
  });

export const sendingLayer = <Self>(
  tag: Context.Service<Self, EmailSendingClient>,
  definition: EmailSendingDefinition,
) => Layer.effect(tag, makeSendingClient(definition));

export const sendingFetchLayer = <Self>(
  tag: Context.Service<Self, EmailSendingClient>,
  definition: EmailSendingDefinition,
) => sendingLayer(tag, definition).pipe(Layer.provide(FetchHttpClient.layer));

export const sendingLayerConfig = <Self>(
  tag: Context.Service<Self, EmailSendingClient>,
  config: Config.Config<EmailSendingDefinition> = sendingConfig(),
) =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const definition = yield* config;

      return yield* makeSendingClient(definition);
    }),
  );

export const sendingFetchLayerConfig = <Self>(
  tag: Context.Service<Self, EmailSendingClient>,
  config: Config.Config<EmailSendingDefinition> = sendingConfig(),
) => sendingLayerConfig(tag, config).pipe(Layer.provide(FetchHttpClient.layer));

export const make = <Id extends string>(id: Id) => Tag<EmailService<Id>>()<Id>(id);

export const makeSending = <Id extends string>(id: Id) =>
  SendingTag<EmailSendingService<Id>>()<Id>(id);

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

export const SendingTag =
  <Self>() =>
  <Id extends string>(id: Id) => {
    const tag = Context.Service<Self, EmailSendingClient>()(id);
    const makeLayer = (definition: EmailSendingDefinition) => sendingLayer(tag, definition);
    const makeFetchLayer = (definition: EmailSendingDefinition) =>
      sendingFetchLayer(tag, definition);
    const makeLayerConfig = (config?: Config.Config<EmailSendingDefinition>) =>
      sendingLayerConfig(tag, config);
    const makeFetchLayerConfig = (config?: Config.Config<EmailSendingDefinition>) =>
      sendingFetchLayerConfig(tag, config);

    return Object.assign(tag, {
      id,
      layer: makeLayer,
      fetchLayer: makeFetchLayer,
      layerConfig: makeLayerConfig,
      fetchLayerConfig: makeFetchLayerConfig,
    }) as SendingTagClass<Self, Id>;
  };
