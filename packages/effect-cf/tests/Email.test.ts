import { assert, expect, layer, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Binding, Email, WorkerEnvironment } from "../src/index";

class TestEmail extends Email.Tag<TestEmail>()("test/TestEmail") {}

interface SendCall {
  readonly message: Email.EmailSendInput;
}

interface FakeEmailOptions {
  readonly send?: (message: Email.EmailSendInput) => Promise<Email.EmailSendResult>;
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

{
  const calls: Array<SendCall> = [];
  const email = makeFakeEmail({
    send: async (message) => {
      calls.push({ message });
      return { messageId: "email-message-1" };
    },
  });

  layer(emailLayer(email))("Send Email native messages", (it) => {
    it.effect("wraps native EmailMessage sends", () =>
      Effect.gen(function* () {
        const email = yield* TestEmail;
        const message = {
          from: "team@example.com",
          to: "user@example.com",
        } satisfies Email.EmailMessage;

        const result = yield* email.send(message);

        assert.strictEqual(result.messageId, "email-message-1");
        assert.deepStrictEqual(calls[0]?.message, message);
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
