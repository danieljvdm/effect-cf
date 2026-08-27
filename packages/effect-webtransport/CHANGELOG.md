# effect-webtransport

## 0.2.1

### Patch Changes

- [#127](https://github.com/danieljvdm/effect-cf/pull/127) [`40b64e3`](https://github.com/danieljvdm/effect-cf/commit/40b64e3411adc959393733fe25f2752b6a11b635) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Trim package guides and API comments to setup, core usage, and behavioral constraints. Public APIs and runtime behavior are unchanged.

## 0.2.0

### Minor Changes

- [#108](https://github.com/danieljvdm/effect-cf/pull/108) [`735b6d9`](https://github.com/danieljvdm/effect-cf/commit/735b6d95e4b62c7ade598a7f18ba2d8b4ee60f87) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Require the Effect 4.0.0-rc.110 family — dependency ranges move from `^4.0.0-beta.107 <4.0.0-rc.0` to `^4.0.0-rc.110`.

## 0.1.1

### Patch Changes

- [#102](https://github.com/danieljvdm/effect-cf/pull/102) [`1b32c54`](https://github.com/danieljvdm/effect-cf/commit/1b32c54757bf404c2454389b0386e0996974cdc6) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Harden Cloudflare and WebTransport runtime boundaries with receiver-safe invocation, truthful return types, validated external data, and stricter event-layer requirements.

## 0.1.0

### Minor Changes

- [#94](https://github.com/danieljvdm/effect-cf/pull/94) [`8a7ec63`](https://github.com/danieljvdm/effect-cf/commit/8a7ec630ecb2ddc2b55348cb6c701f5a9ce42d3b) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Initial release: an Effect-native WebTransport library. Acquire sessions as scoped resources through a feature-detected, test-substitutable `WebTransportConstructor` service; open reliable bidirectional and unidirectional streams and use backpressured, bounded datagrams with typed `WebTransportError` reasons; adapt one reliable bidirectional stream to `effect/unstable/socket` `Socket` (and therefore `RpcClient.layerProtocolSocket`); and pin a transport with the `Fallback` module's ordered candidate selection (WebTransport handshake first, WebSocket fallback).

### Patch Changes

- [#96](https://github.com/danieljvdm/effect-cf/pull/96) [`53c3892`](https://github.com/danieljvdm/effect-cf/commit/53c3892a692b646b53b58ffda0046e4de2dcb355) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Preserve reusable incoming-stream sources, report Web Stream lock failures through typed errors, and abort interrupted writes without hanging resource cleanup.
