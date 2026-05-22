# Phase 9: Voice Collaboration

## Purpose

Make the AI architect usable during live architecture discussions without changing the earlier
typed-prompt product path.

## Status

Complete. Voice collaboration starts with browser speech-to-text prompt composition, stores
schema-backed transcript events as room activity, supports transcript-aware typed AI prompts, and
adds passive voice-derived suggestions that must be accepted before room-authoritative tool-call
application. Auto-act mode remains disabled by default and is not implemented.

## Product Requirement

Users can speak architectural intent into the room, optionally let the room remember discussion
context, and eventually allow an AI collaborator to propose canvas edits from live discussion.

## Technical Requirement

- Voice input starts as speech-to-text prompt entry in the browser.
- Transcription events are schema-backed room events, not raw audio stored by default.
- The room can keep a lightweight transcript and rolling summary for AI context.
- Passive listening starts in suggest mode: the AI proposes structured tool calls for user approval.
- Auto-apply behavior, if added, must be guarded by room-level permissions, visible activity logs,
  and undo/reject affordances.
- STT should run in the browser, API Worker, or a provider-specific Worker boundary; the room
  Durable Object should receive transcript events rather than perform transcription directly.

## Deliverables

- Mic input for prompt composition.
- Transcript event schema.
- Room transcript/activity surface.
- Transcript-aware AI prompts.
- Passive voice-agent suggest mode.
- Optional auto-act mode with permissions and undo. Deferred; auto-act remains disabled by default.

## Resource Coverage Added

- None required by default. A deployed STT/provider path may add provider-specific Worker config or
  service bindings later.

## Acceptance Criteria

- A user can dictate a prompt and send it through the same AI architect flow as typed prompts.
- Transcript events are visible enough to explain why an AI suggestion appeared.
- The passive agent proposes constrained canvas tool calls, not arbitrary tldraw JSON.
- Suggested voice-derived edits follow the same room-authoritative validation path as typed AI
  edits.
- Auto-act mode is disabled by default.

## Testing Notes

- Domain tests cover transcript and suggestion schemas.
- API Worker tests record transcripts, create passive suggestions, and verify suggestions follow
  the accept path before applying tool calls.
- Browser STT availability depends on the browser; unsupported browsers keep typed prompts and
  passive suggestions available.
