import { DurableObjectWebSocket } from "../src/index";

declare const raw: WebSocket;

const typed = DurableObjectWebSocket.fromWebSocket<{ readonly id: string }>(raw);

void typed.serializeAttachment({ id: "socket-1" });
void typed.serializeAttachment<{ readonly id: string }>({ id: "socket-1" });

// @ts-expect-error typed sockets reject attachments outside their declared shape.
void typed.serializeAttachment({ clientId: 1 });
// @ts-expect-error explicit serializer type arguments must also satisfy the attachment shape.
void typed.serializeAttachment<string>("socket-1");

const unknown = DurableObjectWebSocket.fromWebSocket(raw);

void unknown.serializeAttachment<{ readonly id: string }>({ id: "socket-1" });
