import type {
  EmailAddress as CloudflareEmailAddress,
  EmailAttachment as CloudflareEmailAttachment,
  EmailMessage as CloudflareEmailMessage,
  EmailSendResult as CloudflareEmailSendResult,
  SendEmail as CloudflareSendEmail,
} from "@cloudflare/workers-types";
import { Context, Data, Effect, type Layer } from "effect";

import * as Binding from "./Binding";
import type { WorkerEnvironment } from "./Environment";

const expectedSendEmailBinding = "Send Email binding with send()";

/** Error raised when a Cloudflare Send Email operation fails. */
export class EmailOperationError extends Data.TaggedError("EmailOperationError")<{
  readonly binding: string;
  readonly operation: string;
  readonly cause: unknown;
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

interface EmailRuntimeBinding {
  readonly send: (message: EmailSendInput) => Promise<EmailSendResult>;
}

export interface EmailClient {
  readonly send: {
    (message: EmailMessage): Effect.Effect<EmailSendResult, EmailOperationError>;
    (builder: EmailMessageBuilder): Effect.Effect<EmailSendResult, EmailOperationError>;
  };
  readonly unsafeRaw: Effect.Effect<EmailBinding>;
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

const emailError = (binding: string, operation: string, cause: unknown) =>
  new EmailOperationError({ binding, operation, cause });

const tryEmailPromise = <A>(
  binding: string,
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, EmailOperationError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => emailError(binding, operation, cause),
  });

export const isEmailBinding = (value: unknown): value is EmailBinding => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resource = value as Record<string, unknown>;

  return typeof resource.send === "function";
};

export const makeClient =
  (definition: EmailDefinition) =>
  (email: EmailBinding): EmailClient => {
    const runtime = email as EmailRuntimeBinding;
    const send = ((message: EmailSendInput) =>
      tryEmailPromise(definition.binding, "send", () =>
        runtime.send(message),
      )) as EmailClient["send"];

    return {
      definition,
      send,
      unsafeRaw: Effect.succeed(email),
    };
  };

export const layer = <Self>(tag: Context.Service<Self, EmailClient>, definition: EmailDefinition) =>
  Binding.layer(tag, definition.binding, isEmailBinding, makeClient(definition), {
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
