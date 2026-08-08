---
name: build-effect-clis
description: Build and maintain command-line applications entirely with Effect. Use when creating or changing CLI commands, arguments, flags, subcommands, prompts, help, JSON output, dry-run or confirmation flows, platform services, child processes, Node/Bun entrypoints, or CLI integration tests.
---

# Build Effect CLIs

Treat a CLI as an Effect application: the `Command` tree owns the user-facing
contract, handlers adapt decoded input into application workflows, services own
capabilities, and the executable entrypoint supplies platform Layers and runs
the program. Do not introduce a separate CLI framework for new command work.

Effect CLI and process APIs are version-sensitive. Read the target repository's
`node_modules/effect/AGENTS.md` completely, follow its CLI and child-process
references, and confirm exact signatures from the installed declarations before
editing.

## Build the command boundary

1. Inventory the existing executable entrypoints, package scripts, command
   tree, shared flags, prompts, application services, platform Layers, output
   modes, and subprocess helpers. Finish when every way to invoke and test the
   CLI is known.
2. Read [command-design.md](references/command-design.md). Define arguments and
   flags with `Argument` and `Flag`, compose commands with `Command`, and give
   every public input useful help. Use `Effect.fn` handlers and yield the root
   command when a subcommand needs shared parent input.
3. Keep handlers thin. Decode user and file input at the boundary, enforce
   cross-input invariants, then call an application service. Keep persistence,
   network calls, orchestration, retries, and transactions in services.
4. Keep expected operational failures typed with `Schema.TaggedError`; map
   platform failures into application-owned errors near the adapter that knows
   what the operation means. Let defects remain defects.
5. Read [entrypoints-and-testing.md](references/entrypoints-and-testing.md).
   Export the command tree without running it, wire one Node or Bun entrypoint,
   and verify help, parsing, successful execution, expected failure, JSON
   output, and every dry-run or confirmation path.

## Optional branches

- Read [processes-and-platform.md](references/processes-and-platform.md) when a
  command reads files, inspects the environment, starts child processes,
  streams their output, or differs between Node and Bun.
- Use `Prompt` only for an intentionally interactive path. Keep required inputs
  expressible as arguments or flags so automation never depends on a terminal.
- Add `--dry-run` for commands that mutate important state and `--yes` for
  explicitly authorized non-interactive confirmation. Never prompt in JSON or
  CI-oriented modes.

## CLI ownership rules

- Let `Command`, `Argument`, and `Flag` own syntax, defaults, aliases, examples,
  and help text.
- Let schemas own untrusted structured input and machine-readable output.
- Let handlers own CLI-to-application mapping and presentation selection.
- Let services own reusable behavior and external capabilities.
- Let Layers own implementations and runtime dependencies.
- Let the executable entrypoint own `Command.run`, platform provisioning,
  scopes, signal handling, and `NodeRuntime.runMain` or `BunRuntime.runMain`.
- Keep stdout stable for primary or machine-readable output. Send diagnostics
  and progress elsewhere; never mix prose into JSON output.
