# Architect Lab Testing Log

Architect Lab is moving through product phases first. Automated test coverage should be finished in
a final hardening pass once the main workflows are in place, rather than blocking every phase on
browser and platform coverage.

This file is the backlog of scenarios that matter. Keep it current as implementation changes.

## Current Manual Verification

- Local Architect Lab tldraw sync has been manually verified.
- The room can be opened locally, edited, and shared across browser tabs.
- Phase 3 semantic resource palette and code panel have been manually verified with visible
  semantic nodes and selected-resource snippets.
- Phase 3 latest/published KV read model has been manually verified through the local API.
- Phase 4 fake AI prompt flow has been manually verified locally: prompt submission returns `202`,
  the local Queue consumer runs, generated resource nodes/arrows/annotations appear on the canvas,
  the first generated resource is selected, and the code panel shows highlighted `effect-cf` code.
- Phase 4 streaming fake AI flow has been manually verified locally: the prompt route keeps the
  request open while room-owned tool calls apply progressively, the side panel shows
  reasoning/tool-call/completion activity summaries, and a browser reload reports no console
  warnings or page errors.
- Phase 4 room activity broadcast has been manually smoke-tested locally: a second tab in the same
  room receives AI application and queue status events over the room activity socket while the first
  tab runs the fake architect.
- Phase 5 trace/review flow has been manually smoke-tested locally: after generating an
  architecture, Trace completes with active edge selection plus data-shape details in the side panel,
  Review returns an actionable finding, and accepting it emits the expected room activity event with
  no browser console errors.
- The fake AI provider now runs through the `effect/unstable/ai` `LanguageModel`/`Toolkit` contract;
  final hardening should keep coverage on provider parity rather than only canned output shape.
- Current browser accessibility audit still reports serious findings from tldraw internals and the
  Expect overlay, plus conservative focus-style warnings on Architect Lab controls. Keep these in
  the final hardening pass instead of blocking phase work.

## Existing Automated Coverage

- Domain schema contract tests.
- API Worker room creation and room health tests through the typed room namespace.
- Web Worker shell and typed service-binding forwarding tests.
- API Worker latest and published architecture read-model tests through KV.
- API Worker fake AI prompt submission tests assert returned activity trace event kinds and disable
  artificial fake-provider latency through test config.
- Room Durable Object metadata persistence and health tests.
- Room Durable Object AI tool-call validation and accepted-application event tests.
- `effect-cf` Durable Object SQLite SQL layer tests.
- Semantic resource catalog and snippet template tests.

## Final Hardening Backlog

### Phase 1 And 2 Foundation

- Browser smoke test that starts the local app, opens a room, and verifies the tldraw canvas renders
  nonblank.
- Fresh-checkout dev smoke test that verifies `examples/architect-lab/web` builds local
  `effect-cf` package output before Wrangler starts.
- Two-tab browser sync test: create or edit a shape in one tab and verify it appears in the other.
- Reload/reconnect test: create a representative document, reload the room, and verify the latest
  document state is restored.
- Conflict/concurrent-edit test appropriate to tldraw sync-core.
- Durable Object or integration test for applying and replaying/persisting representative tldraw
  document changes.
- Hibernation/resume test for sockets with serialized tldraw session snapshots.

### Phase 3 Semantic Model

- Additional unit tests for semantic edge schemas and invalid resource metadata.
- Additional unit tests for code generation templates across every supported resource kind.
- Browser smoke test for selecting a diagram element and seeing the matching code panel snippet.
- Browser smoke test for saving latest read-model updates and publishing a room.

### Phase 4 AI Jobs

- Unit tests for fake provider outputs.
- Unit tests for the fake `LanguageModel` layer and toolkit tool-call mapping.
- Runtime tests for Queue message decoding and acknowledgement.
- Additional Durable Object tests for direct room-owned tldraw mutation once accepted AI tool calls
  stop being rendered by the browser.
- Browser smoke test for submitting the default prompt and seeing generated canvas edits and
  multi-client activity events. Initial manual smoke exists; automate it in final hardening.

### Phase 5 Trace And Review

- Unit tests for trace definitions. Initial coverage exists.
- Durable Object test for trace broadcast state. Initial coverage exists.
- Durable Object alarm test for checkpoint or cleanup scheduling. Initial coverage exists.
- Browser smoke test for trace mode updating the canvas and side panel.

### Phase 6 Export

- Workflow test for successful manifest generation. Initial API/Workflow coverage exists.
- Workflow test for failure status persistence.
- R2 test for generated file and manifest writes. Initial API/Workflow coverage exists.
- Browser smoke test for starting an export and seeing durable status updates.

### Phase 7 Deployed Provider

- Unit tests for provider selection from config. Initial coverage exists.
- Unit tests for fake provider parity with the real provider interface. Initial real-provider
  decoding coverage exists; broaden parity coverage during final hardening.
- No tests should require real provider credentials.

### Phase 8 Replacement Validation

- Root `vp check`. Current pass exists.
- Root `vp test`. Current pass exists.
- Targeted Architect Lab tests. Current root pass includes them.
- Preserved example pattern traceability review. Current review is recorded in
  [Preserved Example Patterns](./preserved-example-patterns.md).

### Phase 9 Voice Collaboration

- Browser smoke test for dictating an AI prompt and submitting the transcript through the normal
  prompt route.
- Unit tests for transcript event and voice-agent suggestion schemas. Initial coverage exists.
- Integration test that transcript-derived suggestions remain proposed edits until accepted.
  Initial API coverage exists.
- Browser smoke test for accepting a voice-agent suggestion and seeing validated canvas edits.
- Permission/undo test before enabling any automatic voice-driven apply mode.
