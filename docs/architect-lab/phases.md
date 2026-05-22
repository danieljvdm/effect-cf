# Phased Roadmap: Architect Lab

The roadmap is split into standalone phase files under [phases/](./phases/).

## Phase Index

- [Phase 0: Spec And Decisions](./phases/phase-0-spec-and-decisions.md) - Complete
- [Phase 1: Cloudflare Scaffold And Transports](./phases/phase-1-cloudflare-scaffold-and-transports.md) - Complete
- [Phase 2: Tldraw Sync](./phases/phase-2-tldraw-sync.md) - Implemented and manually verified; automated coverage tracked for final hardening
- [Phase 3: Semantic Architecture And Code Panel](./phases/phase-3-semantic-architecture-and-code-panel.md) - Implemented and manually verified; browser coverage tracked for final hardening
- [Phase 4: AI Architect With Fake Provider](./phases/phase-4-ai-architect-with-fake-provider.md) - Complete; fake-provider/Queue flow, room-broadcast activity traces, edge snippets, and broader canned plans implemented and manually verified
- [Phase 5: Trace Mode And Architecture Review](./phases/phase-5-trace-mode-and-architecture-review.md) - Complete; schema-backed traces, room-broadcast trace state, review findings, accept/reject actions, and maintenance alarms implemented
- [Phase 6: Export Workflow](./phases/phase-6-export-workflow.md) - Complete; typed Workflow
  export, D1 status persistence, R2 artifacts/manifests, side-panel status, reload recovery, and
  room activity events implemented
- [Phase 7: Real AI Provider And Deployed Mode](./phases/phase-7-real-ai-provider-and-deployed-mode.md) - Not merge-ready; OpenAI-compatible real-provider mode is config-gated and strict tool-call validation is implemented, but live OpenAI validation is blocked by the available key returning `insufficient_quota`
- [Phase 8: Validate Architect Lab As The Replacement](./phases/phase-8-replace-existing-examples.md) - Not merge-ready while Phase 7 live real-provider validation is blocked
- [Phase 9: Voice Collaboration](./phases/phase-9-voice-collaboration.md) - Complete; browser dictation fills the prompt, transcript events are room activity, passive voice suggestions require accept/reject, and auto-act remains disabled
