# Sandbox SDK 1.0.0 development patch

The development dependency `@cloudflare/sandbox-v1` resolves to `@cloudflare/sandbox@1.0.0`. Its `Files.readFile()` waits for an opening control frame on stderr before consuming stdout. The local workerd Docker transport multiplexes both channels over one connection and waits for each output write to be consumed. When file bytes arrive first, stdout blocks the control frame and the SDK deadlocks.

The package-manager patch drains stdout while waiting for the opening frame, retaining those bytes for the returned response. Once that frame arrives, response consumption controls further reads as before. Bytes received before the opening frame are buffered in memory; the patch does not buffer the remaining file after that frame.

[The regression test](../packages/effect-cf/tests/ContainerFiles.worker.test.ts) forces multiple stdout chunks ahead of the control frames using backpressured streams. The real Docker integration also exercises file reads, including background logs and restored files.

This patch applies only to the repository's development dependency. It is not included in the published `effect-cf` package and does not patch consumer SDK installations. Applications using unpatched SDK 1.0.0 can encounter this hang in local Docker development and need the same SDK fix. Remove the patch after an upstream SDK release fixes the ordering problem and both checks pass without it.
