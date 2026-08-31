import { Predicate } from "effect";

// Native tail callbacks collect the workerd events without adding instrumentation.
const traces: Array<Array<TailStream.TailEvent<TailStream.EventType>>> = [];
const waiters: Array<(events: Array<TailStream.TailEvent<TailStream.EventType>>) => void> = [];

export default {
  tailStream(onset) {
    const events: Array<TailStream.TailEvent<TailStream.EventType>> = [onset];

    return (event) => {
      events.push(event);

      if (event.event.type === "outcome") {
        const resolve = waiters.shift();

        if (resolve) resolve(events);
        else traces.push(events);
      }
    };
  },
  async fetch() {
    const events =
      traces.shift() ??
      (await new Promise<Array<TailStream.TailEvent<TailStream.EventType>>>((resolve) =>
        waiters.push(resolve),
      ));

    return new Response(
      JSON.stringify(events, (_, value) => (Predicate.isBigInt(value) ? value.toString() : value)),
      { headers: { "content-type": "application/json" } },
    );
  },
} satisfies ExportedHandler;
