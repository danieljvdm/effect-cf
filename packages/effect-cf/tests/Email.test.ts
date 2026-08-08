import { assert, expect, layer, test } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { Binding, Email, WorkerEnvironment } from "../src/index";

class TestEmail extends Email.Tag<TestEmail>()("test/TestEmail") {}

class TestEmailSending extends Email.SendingTag<TestEmailSending>()("test/TestEmailSending") {}

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

const recipients = (count: number) =>
  Array.from({ length: count }, (_, index) => `user-${index}@example.com`);

const fetchLayer = (request: typeof fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, request)));

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
    source: "EMAIL",
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

test("Email Sending payload converts Workers fields to the REST shape", () => {
  const payload = Email.toSendingPayload({
    from: { name: "Support Team", email: "support@example.com" },
    to: ["plain@example.com", { name: "Jane Doe", email: "jane@example.com" }],
    cc: "manager@example.com",
    replyTo: { name: "Support", email: "help@example.com" },
    subject: "Team update",
    html: "<h1>Monthly update</h1>",
    headers: { "X-Campaign-ID": "monthly" },
    attachments: [
      {
        disposition: "inline",
        contentId: "logo",
        filename: "logo.png",
        type: "image/png",
        content: new Uint8Array([1, 2, 3]),
      },
    ],
  });

  assert.deepStrictEqual(payload, {
    from: { address: "support@example.com", name: "Support Team" },
    subject: "Team update",
    to: ["plain@example.com", { address: "jane@example.com", name: "Jane Doe" }],
    cc: "manager@example.com",
    reply_to: { address: "help@example.com", name: "Support" },
    html: "<h1>Monthly update</h1>",
    attachments: [
      {
        content: "AQID",
        filename: "logo.png",
        type: "image/png",
        disposition: "inline",
        content_id: "logo",
      },
    ],
    headers: { "X-Campaign-ID": "monthly" },
  });
});

test("Email Sending client posts messages and decodes delivery status", async () => {
  const seen: Array<{
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const raw =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : "null";

    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(raw) as unknown,
    });

    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        delivered: ["recipient@example.com"],
        permanent_bounces: [],
        queued: ["queued@example.com"],
      },
    });
  };

  const client = await Effect.runPromise(
    Email.makeSendingClient({
      accountId: "account-1",
      apiToken: Redacted.make("secret-token"),
    }).pipe(Effect.provide(fetchLayer(request))),
  );

  const result = await Effect.runPromise(
    client.send({
      from: "welcome@example.com",
      to: "recipient@example.com",
      subject: "Welcome to our service!",
      text: "Welcome! Thanks for signing up.",
    }),
  );

  assert.deepStrictEqual(result, {
    delivered: ["recipient@example.com"],
    permanentBounces: [],
    queued: ["queued@example.com"],
  });
  assert.strictEqual(
    seen[0]?.url,
    "https://api.cloudflare.com/client/v4/accounts/account-1/email/sending/send",
  );
  assert.strictEqual(seen[0]?.headers.authorization, "Bearer secret-token");
  assert.deepStrictEqual(seen[0]?.body, {
    from: "welcome@example.com",
    to: "recipient@example.com",
    subject: "Welcome to our service!",
    text: "Welcome! Thanks for signing up.",
  });
});

test("Email Sending client validates messages before requesting the API", async () => {
  let requested = false;
  const request: typeof fetch = async () => {
    requested = true;

    return Response.json({ success: true, errors: [], result: null });
  };

  const client = await Effect.runPromise(
    Email.makeSendingClient({
      accountId: "account-1",
      apiToken: Redacted.make("secret-token"),
    }).pipe(Effect.provide(fetchLayer(request))),
  );

  await expect(
    Effect.runPromise(
      client.send({
        from: "welcome@example.com",
        to: "recipient@example.com",
        subject: "Welcome to our service!",
      }),
    ),
  ).rejects.toMatchObject({
    _tag: "EmailValidationError",
    source: "account-1",
    operation: "send",
  });

  assert.strictEqual(requested, false);
});

test("Email Sending client reports Cloudflare API errors", async () => {
  const request: typeof fetch = async () =>
    Response.json(
      {
        success: false,
        errors: [{ code: 10001, message: "email.sending.error.invalid_request_schema" }],
        messages: [],
        result: null,
      },
      { status: 400 },
    );

  const client = await Effect.runPromise(
    Email.makeSendingClient({
      accountId: "account-1",
      apiToken: Redacted.make("secret-token"),
    }).pipe(Effect.provide(fetchLayer(request))),
  );

  await expect(
    Effect.runPromise(
      client.send({
        from: "welcome@example.com",
        to: "recipient@example.com",
        subject: "Welcome to our service!",
        text: "Welcome! Thanks for signing up.",
      }),
    ),
  ).rejects.toMatchObject({
    _tag: "EmailSendingError",
    accountId: "account-1",
    status: 400,
    errors: [{ code: 10001, message: "email.sending.error.invalid_request_schema" }],
  });
});

test("Email Sending layer reads config through the active ConfigProvider", async () => {
  const seen: Array<string> = [];
  const request: typeof fetch = async (input) => {
    seen.push(typeof input === "string" || input instanceof URL ? input.toString() : input.url);

    return Response.json({
      success: true,
      errors: [],
      result: { delivered: ["recipient@example.com"], permanent_bounces: [], queued: [] },
    });
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sending = yield* TestEmailSending;

      return yield* sending.send({
        from: "welcome@example.com",
        to: "recipient@example.com",
        subject: "Welcome to our service!",
        text: "Welcome! Thanks for signing up.",
      });
    }).pipe(
      Effect.provide(TestEmailSending.layerConfig().pipe(Layer.provide(fetchLayer(request)))),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CLOUDFLARE_ACCOUNT_ID: "account-2",
            CLOUDFLARE_API_TOKEN: "secret-token",
          }),
        ),
      ),
    ),
  );

  assert.deepStrictEqual(result.delivered, ["recipient@example.com"]);
  assert.strictEqual(
    seen[0],
    "https://api.cloudflare.com/client/v4/accounts/account-2/email/sending/send",
  );
});
