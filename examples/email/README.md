# Cloudflare Email Service

`effect-cf` wraps the `send_email` binding that Cloudflare Email Service exposes
to a Worker. Structured messages are validated against documented Email Sending
limits before the binding is called, and Cloudflare's `E_*` codes are surfaced
on `EmailOperationError.code`, so both failure modes are typed and recoverable.

Before sending, onboard the sending domain under **Compute > Email Service >
Email Sending** in the Cloudflare dashboard. Cloudflare adds the MX, SPF, DKIM,
and DMARC records that authenticate mail from that domain.

```ts
import { Effect, Layer } from "effect";
import { Email, Worker } from "effect-cf";

class TransactionalEmail extends Email.Tag<TransactionalEmail>()("TransactionalEmail") {}

const AppLive = Layer.mergeAll(TransactionalEmail.layer({ binding: "EMAIL" }));

export default Worker.make(AppLive, {
  fetch: Effect.gen(function* () {
    const request = yield* Worker.NativeRequest;
    const to = new URL(request.url).searchParams.get("to");

    if (to === null) {
      return new Response("Missing ?to", { status: 400 });
    }

    const email = yield* TransactionalEmail;
    const result = yield* email.send({
      from: { name: "Example", email: "welcome@example.com" },
      to,
      subject: "Welcome to Example",
      text: "Welcome! Thanks for signing up.",
      html: "<h1>Welcome!</h1><p>Thanks for signing up.</p>",
    });

    return new Response(`Email sent: ${result.messageId}`);
  }).pipe(
    // The message never reached Cloudflare; every broken field is listed.
    Effect.catchTag("EmailValidationError", (error) =>
      Effect.succeed(Response.json({ violations: error.violations }, { status: 400 })),
    ),
    // Cloudflare rejected the send; `code` says whether retrying can help.
    Effect.catchTag("EmailOperationError", (error) =>
      Effect.succeed(
        Response.json(
          { code: error.code ?? "E_INTERNAL_SERVER_ERROR" },
          { status: error.code === "E_RATE_LIMIT_EXCEEDED" ? 429 : 500 },
        ),
      ),
    ),
  ),
});
```

A minimal Wrangler configuration declares the binding. `remote: true` lets
`wrangler dev` send through the real Email Service while the Worker runs
locally:

```jsonc
{
  "name": "email-example",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-25",
  "send_email": [
    {
      "name": "EMAIL",
      "remote": true,
    },
  ],
}
```

Restrict which senders and recipients a binding may use with Cloudflare's
`allowed_destination_addresses` and `destination_address` attributes on the
binding. `EmailOperationError.code` reports `E_RECIPIENT_NOT_ALLOWED` when a
send falls outside those restrictions.

Validation covers the limits Cloudflare documents: at most 50 combined `to`,
`cc`, and `bcc` addresses, at most 32 attachments, custom header name, value,
and total size caps, a required `from` and `subject`, at least one of `text` or
`html`, and a `contentId` on every inline attachment. Pass
`layer({ binding: "EMAIL", send: { validate: false } })` to skip these checks
and let Cloudflare reject the message instead.

Total message size is exposed as `Email.sendLimits.maxMessageBytes` but is not
checked locally, because the encoded MIME size is only known once Cloudflare
composes the message. Oversized messages fail with `E_CONTENT_TOO_LARGE`.
