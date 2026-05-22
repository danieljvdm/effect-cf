# Effect-CF Architect Lab Specs

Effect-CF Architect Lab is the repository's flagship example: a single, locally runnable demo
application that uses `effect-cf` to build a multiplayer architecture canvas.

The demo should be self-referential:

- The implemented app currently covers Cloudflare Workers, service bindings, Durable Objects,
  Durable Object WebSockets, Durable Object storage, Durable Object SQLite, WorkerConfig, tldraw
  sync, and semantic `effect-cf` resource snippets through `effect-cf`.
- Later roadmap phases may add optional Hyperdrive-backed catalog features.
- The application helps users design Cloudflare architectures and generates `effect-cf` code from
  the diagrams they create.

## Current Status

- Phase 0 and Phase 1 are complete.
- Phase 2 is implemented with direct tldraw sync hosted inside the room Durable Object. Browser-level
  two-tab sync, reconnect, conflict, and canvas smoke tests are tracked for final hardening.
- Phase 3 is implemented and manually verified with semantic resource nodes, selection-driven
  snippets, visible canvas/code-panel behavior, and KV-backed latest/published read models.
- Phase 4 is complete. The fake-provider flow adds a prompt composer, broader deterministic AI
  plans backed by `effect/unstable/ai`, Queue-backed local job submission, room event persistence,
  room-authoritative acceptance of generated tool calls, room-owned tldraw mutation, room-broadcast
  activity events, visible generated canvas edits, and resource/edge snippets.
- Phase 5 is complete. Trace mode uses schema-backed semantic edge traces, room-broadcast trace
  state, active canvas edge selection, side-panel step/data updates, deterministic review findings,
  accept/reject review actions, and Durable Object maintenance alarms.
- Phase 6 is complete. Export Workflow starts durable package generation from the room side panel,
  persists status in D1, stores generated files and the manifest in R2, broadcasts export activity,
  and reloads the last export status from persisted state.
- Phase 7 is complete. Fake provider mode remains the credential-free local default, and deployed
  real-provider mode can be enabled through WorkerConfig with documented model, key, timeout,
  retry, token, tool-call, and estimated-cost controls.
- Phase 8 is complete. Architect Lab is the only `examples/` app, the root README points at it as
  the flagship demo, deployed-mode resources are documented, and preserved patterns from the removed
  examples have been reviewed against the implementation.
- Phase 9 is complete. Browser dictation can fill the AI prompt, transcript events are room
  activity, passive voice suggestions require accept/reject, and auto-act remains disabled.

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

## Voice Mode

Voice collaboration layers on top of the normal AI architect path. Browser speech recognition, when
available, writes transcripts into the prompt composer and records transcript events in room
activity. Passive voice suggestions produce constrained AI tool calls that remain pending until a
user accepts or rejects them. Automatic voice-driven edits are not enabled.
