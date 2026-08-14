import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, Email, WorkerEnvironment } from "../src/index";

class TestEmail extends Email.Tag<TestEmail>()("test/TestEmail") {}

interface SendCall {
  readonly message: Email.EmailMessageBuilder;
}

interface FakeEmailOptions {
  readonly send?: (message: Email.EmailMessageBuilder) => Promise<Email.EmailSendResult>;
}

const makeFakeEmail = (options: FakeEmailOptions = {}) =>
  ({
    send:
      options.send ??
      (async () => ({
        messageId: "email-1",
      })),
  }) as SendEmail;

const emailLayer = (email: SendEmail) =>
  TestEmail.layer({ binding: "EMAIL" }).pipe(
    Layer.provide(Layer.succeed(WorkerEnvironment, { EMAIL: email })),
  );

{
  const calls: Array<SendCall> = [];
  const email = makeFakeEmail({
    send: async (message) => {
      calls.push({ message });

      return { messageId: "email-builder-1" };
    },
  });

  layer(emailLayer(email))("Send Email builder messages", (it) => {
    it.effect("wraps builder sends", () =>
      Effect.gen(function* () {
        const email = yield* TestEmail;
        const result = yield* email.send({
          from: { name: "Example", email: "team@example.com" },
          to: ["user@example.com"],
          subject: "Welcome",
          text: "Welcome to Example",
          headers: { "X-Template": "welcome" },
        });

        assert.strictEqual(result.messageId, "email-builder-1");
        assert.deepStrictEqual(calls[0]?.message, {
          from: { name: "Example", email: "team@example.com" },
          to: ["user@example.com"],
          subject: "Welcome",
          text: "Welcome to Example",
          headers: { "X-Template": "welcome" },
        });
      }),
    );
  });
}

test("Send Email layer validates the binding shape", async () => {
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* TestEmail;

        yield* email.send({
          from: "team@example.com",
          to: "user@example.com",
          subject: "Welcome",
          text: "Welcome to Example",
        });
      }).pipe(
        Effect.provide(
          TestEmail.layer({ binding: "EMAIL" }).pipe(
            Layer.provide(Layer.succeed(WorkerEnvironment, { EMAIL: {} as SendEmail })),
          ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(Binding.BindingValidationError);
});

test("Send Email operations map rejected sends", async () => {
  const cause = new Error("smtp rejected");

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* TestEmail;

        yield* email.send({
          from: "team@example.com",
          to: "user@example.com",
          subject: "Welcome",
          text: "Welcome to Example",
        });
      }).pipe(
        Effect.provide(
          emailLayer(
            makeFakeEmail({
              send: async () => {
                throw cause;
              },
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "EmailOperationError",
    binding: "EMAIL",
    operation: "send",
    cause,
  });
});

const recipients = (count: number) =>
  Array.from({ length: count }, (_, index) => `user-${index}@example.com`);

test("Send Email validates builder messages before calling the binding", async () => {
  const calls: Array<SendCall> = [];

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* TestEmail;

        yield* email.send({
          from: "team@example.com",
          to: recipients(Email.sendLimits.maxRecipients + 1),
          subject: "Welcome",
          text: "Welcome to Example",
        });
      }).pipe(
        Effect.provide(
          emailLayer(
            makeFakeEmail({
              send: async (message) => {
                calls.push({ message });

                return { messageId: "email-1" };
              },
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "EmailValidationError",
    binding: "EMAIL",
    operation: "send",
  });

  assert.strictEqual(calls.length, 0);
});

test("Send Email validation reports every violated limit", async () => {
  const violations = Email.validateMessage({
    from: "not-an-address",
    to: [],
    subject: "",
    attachments: Array.from({ length: Email.sendLimits.maxAttachments + 1 }, () => ({
      disposition: "attachment" as const,
      filename: "note.txt",
      type: "text/plain",
      content: "note",
    })),
  });

  assert.deepStrictEqual(violations.map((violation) => violation.path).sort(), [
    "$",
    "$",
    "attachments",
    "from",
    "subject",
  ]);
});

test("Send Email validation can be disabled per layer", async () => {
  const calls: Array<SendCall> = [];
  const email = makeFakeEmail({
    send: async (message) => {
      calls.push({ message });

      return { messageId: "email-unvalidated" };
    },
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* TestEmail;

      return yield* client.send({
        from: "team@example.com",
        to: recipients(Email.sendLimits.maxRecipients + 1),
        subject: "Welcome",
        text: "Welcome to Example",
      });
    }).pipe(
      Effect.provide(
        TestEmail.layer({ binding: "EMAIL", send: { validate: false } }).pipe(
          Layer.provide(Layer.succeed(WorkerEnvironment, { EMAIL: email })),
        ),
      ),
    ),
  );

  assert.strictEqual(result.messageId, "email-unvalidated");
  assert.strictEqual(calls.length, 1);
});

test("EmailOperationError composes binding, operation, code, and cause message", () => {
  const suppressed = new Email.EmailOperationError({
    binding: "EMAIL",
    operation: "send",
    cause: new Error("Cannot send emails to this recipient because it is on the suppression list"),
    code: "E_RECIPIENT_SUPPRESSED",
  });

  assert.strictEqual(
    suppressed.message,
    'Email send failed for binding "EMAIL" (E_RECIPIENT_SUPPRESSED): Cannot send emails to this recipient because it is on the suppression list',
  );

  const codeless = new Email.EmailOperationError({
    binding: "EMAIL",
    operation: "send",
    cause: new Error("smtp rejected"),
  });

  assert.strictEqual(codeless.message, 'Email send failed for binding "EMAIL": smtp rejected');
});

test("Send Email surfaces Cloudflare error codes", async () => {
  const cause = Object.assign(new Error("sender domain is not verified"), {
    code: "E_SENDER_NOT_VERIFIED",
  });

  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* TestEmail;

        yield* email.send({
          from: "team@example.com",
          to: "user@example.com",
          subject: "Welcome",
          text: "Welcome to Example",
        });
      }).pipe(
        Effect.provide(
          emailLayer(
            makeFakeEmail({
              send: async () => {
                throw cause;
              },
            }),
          ),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    _tag: "EmailOperationError",
    binding: "EMAIL",
    operation: "send",
    code: "E_SENDER_NOT_VERIFIED",
  });
});
