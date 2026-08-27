import { DurableObjectWebSocket } from "../src/index";

declare const raw: WebSocket;

const typed = DurableObjectWebSocket.fromWebSocket<{ readonly id: string }>(raw);

typed.serializeAttachment({ id: "socket-1" });
typed.serializeAttachment<{ readonly id: string }>({ id: "socket-1" });

// @ts-expect-error typed sockets reject attachments outside their declared shape.
typed.serializeAttachment({ clientId: 1 });
// @ts-expect-error explicit serializer type arguments must also satisfy the attachment shape.
typed.serializeAttachment<string>("socket-1");

const unknown = DurableObjectWebSocket.fromWebSocket(raw);

unknown.serializeAttachment<{ readonly id: string }>({ id: "socket-1" });
