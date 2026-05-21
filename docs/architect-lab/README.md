# Effect-CF Architect Lab Specs

Effect-CF Architect Lab is the proposed replacement for the current collection of examples: a
single, compelling, locally runnable demo application that uses `effect-cf` to build a multiplayer
AI architecture canvas.

The demo should be self-referential:

- The application is implemented with Cloudflare Workers, Durable Objects, D1, R2, KV, Queues,
  Workflows, service bindings, Images, and optional Hyperdrive through `effect-cf`.
- The application helps users design Cloudflare architectures and generates `effect-cf` code from
  the diagrams they create.

## Documents

- [Product Requirements](./prd.md) defines the user experience, target users, core workflows,
  success criteria, and non-goals.
- [Technical Requirements](./trd.md) describes the proposed architecture, resource mapping,
  data model, room protocol, AI tool model, local development approach, and validation strategy.
- [Phased Roadmap](./phases.md) breaks the implementation into incremental, reviewable phases.
- [Phase PRD/TRD Matrix](./phase-prd-trd.md) gives each phase its product promise, technical
  scope, and acceptance criteria.
- [AI Canvas Agent](./ai-canvas-agent.md) specifies how the agent should interact with the canvas,
  code panel, and architecture review model.
- [Preserved Example Patterns](./preserved-example-patterns.md) records useful patterns from the
  removed examples that should shape Architect Lab.

## Working Name

Use `Architect Lab` in docs and planning. The example directory can later be named
`examples/architect-lab` unless a stronger product name emerges.

## Primary Demo Script

1. Start the app locally.
2. Open the same room in two browser tabs.
3. Ask the AI architect to design a Cloudflare application.
4. Watch the AI draw resource nodes and request flows on the shared canvas.
5. Select nodes to inspect generated `effect-cf` snippets.
6. Ask for a change and watch the AI update the architecture.
7. Run trace mode to animate a request through the system.
8. Export a generated architecture package.
