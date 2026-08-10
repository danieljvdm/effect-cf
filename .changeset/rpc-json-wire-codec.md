---
"effect-cf": minor
---

Encode RPC method schemas through their canonical JSON codec at the Workers RPC boundary. Declaration schemas such as `Schema.Result` keep their container instance in their encoded form, so Durable Object, Worker entrypoint, and service binding RPC methods declared with them crashed in production with `DataCloneError` even though local same-isolate calls worked. Wire values are now plain JSON in both directions: clients encode arguments and decode results back into real instances, servers decode arguments and encode results, and codec failures still surface as tagged errors naming the definition and method. The `Method.EncodedArgs` and `Method.EncodedSuccess` utility types now report the JSON wire form.
