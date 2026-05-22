# Architect Lab Phases

Each phase is scoped to be useful and reviewable on its own. The implementation should move
through these in order unless a later discovery changes the dependency graph.

## Phase Index

- [Phase 0: Spec And Decisions](./phase-0-spec-and-decisions.md) - Complete
- [Phase 1: Cloudflare Scaffold And Transports](./phase-1-cloudflare-scaffold-and-transports.md) - Complete
- [Phase 2: Tldraw Sync](./phase-2-tldraw-sync.md) - Implemented and manually verified; automated coverage tracked for final hardening
- [Phase 3: Semantic Architecture And Code Panel](./phase-3-semantic-architecture-and-code-panel.md) - Implemented and manually verified; browser coverage tracked for final hardening
- [Phase 4: AI Architect With Fake Provider](./phase-4-ai-architect-with-fake-provider.md) - Complete; streaming fake provider, Queue flow, room-broadcast activity traces, edge snippets, broader canned plans, room-authoritative AI validation, and room-owned tldraw mutation implemented
- [Phase 5: Trace Mode And Architecture Review](./phase-5-trace-mode-and-architecture-review.md) - Complete; schema-backed traces, room-broadcast trace state, side-panel trace details, review findings, accept/reject actions, and maintenance alarms implemented
- [Phase 6: Export Workflow](./phase-6-export-workflow.md) - Complete; typed Workflow export,
  D1 status persistence, R2 artifacts/manifests, side-panel status, reload recovery, and room
  activity events implemented
- [Phase 7: Real AI Provider And Deployed Mode](./phase-7-real-ai-provider-and-deployed-mode.md) - Complete; fake provider remains default, OpenAI-compatible real-provider mode is config-gated, provider limits are explicit, deployed-mode docs list required resources, and Hyperdrive remains optional
- [Phase 8: Validate Architect Lab As The Replacement](./phase-8-replace-existing-examples.md) - Complete; root README, validation, deployed-mode resource docs, and preserved-pattern traceability are updated
- [Phase 9: Voice Collaboration](./phase-9-voice-collaboration.md) - Complete; browser dictation fills the prompt, transcript events are room activity, passive voice suggestions require accept/reject, and auto-act remains disabled
