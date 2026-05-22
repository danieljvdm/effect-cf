# Effect-CF Architect Lab Specs

Effect-CF Architect Lab is the repository's flagship example: a single, locally runnable demo
application that uses `effect-cf` to build a multiplayer architecture canvas.

The demo should be self-referential:

- The implemented app currently covers Cloudflare Workers, service bindings, Durable Objects,
  Durable Object WebSockets, Durable Object storage, Durable Object SQLite, WorkerConfig, tldraw
  sync, and semantic `effect-cf` resource snippets through `effect-cf`.
- Later roadmap phases add optional Hyperdrive, AI-assisted architecture edits, trace mode, and
  export workflows.
- The application helps users design Cloudflare architectures and generates `effect-cf` code from
  the diagrams they create.

## Current Status

- Phase 0 and Phase 1 are complete.
- Phase 2 is implemented with direct tldraw sync hosted inside the room Durable Object. Browser-level
  two-tab sync, reconnect, conflict, and canvas smoke tests are tracked for final hardening.
- Phase 3 is implemented and manually verified with semantic resource nodes, selection-driven
  snippets, visible canvas/code-panel behavior, and KV-backed latest/published read models.
- Phase 4 is in progress. The first fake-provider slice adds a prompt composer, deterministic AI
  plans backed by `effect/unstable/ai`, Queue-backed local job submission, room event persistence,
  and visible generated canvas edits. The room-authoritative AI apply path and activity log remain
  pending.
- Phase 5 through Phase 7 are planned.
- Phase 8 is mostly complete because Architect Lab is now the only `examples/` app; a final
  traceability pass remains after later resource coverage is implemented or explicitly ruled out.

## Documents

- [Product Requirements](./prd.md) defines the user experience, target users, core workflows,
  success criteria, and non-goals.
- [Technical Requirements](./trd.md) describes the proposed architecture, resource mapping,
  data model, room protocol, AI tool model, local development approach, and validation strategy.
- [Phased Roadmap](./phases.md) breaks the implementation into incremental, reviewable phases.
- [Testing Log](./testing.md) tracks important automated coverage to add during final hardening.
- [Phase PRD/TRD Matrix](./phase-prd-trd.md) gives each phase its product promise, technical
  scope, and acceptance criteria.
- [AI Canvas Agent](./ai-canvas-agent.md) specifies how the agent should interact with the canvas,
  code panel, and architecture review model.
- [Preserved Example Patterns](./preserved-example-patterns.md) records useful patterns from the
  removed examples that should shape Architect Lab.

## Name

Use `Architect Lab` in docs and planning. The canonical example directory is
`examples/architect-lab`.

## Primary Demo Script

1. Start the app locally.
2. Open the same room in two browser tabs.
3. Ask the AI architect to design a Cloudflare application.
4. Watch the AI draw resource nodes and request flows on the shared canvas.
5. Select nodes to inspect generated `effect-cf` snippets.
6. Ask for a change and watch the AI update the architecture.
7. Run trace mode to animate a request through the system.
8. Export a generated architecture package.
