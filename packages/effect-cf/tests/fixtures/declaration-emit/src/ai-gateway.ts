import { AiGateway } from "effect-cf";

export class Gateway extends AiGateway.Tag<Gateway>()("Gateway") {}

export const bindingLayer = Gateway.layer({ binding: "AI", gatewayId: "test" });
