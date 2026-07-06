# [ac2-open-claw-reference@1.0.0-canary.5](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.4...ac2-open-claw-reference@1.0.0-canary.5) (2026-07-06)


### Features

* add x402 OpenClaw integration ([e7bbb2a](https://github.com/algorandfoundation/ac2/commit/e7bbb2ac378ffdca96da288bb06390f5ddbdf48c))

# [ac2-open-claw-reference@1.0.0-canary.4](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.3...ac2-open-claw-reference@1.0.0-canary.4) (2026-07-06)


### Bug Fixes

* enhance LiquidAuthChannelProvider with ICE candidate handling ([#8](https://github.com/algorandfoundation/ac2/issues/8)) ([899c917](https://github.com/algorandfoundation/ac2/commit/899c91781441b7660485afbb8fb98d5046216c00))

# [ac2-open-claw-reference@1.0.0-canary.3](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.2...ac2-open-claw-reference@1.0.0-canary.3) (2026-07-02)


### Bug Fixes

* drop rebuild:node-datachannel script from consumer-facing package.json ([f62134b](https://github.com/algorandfoundation/ac2/commit/f62134b24c90272afe19f6857d4b27306220f7f4))
* update install script to include node-datachannel rebuild step ([abd4f3a](https://github.com/algorandfoundation/ac2/commit/abd4f3ae89d531d35d4f4b495efe0e113e4d51fd))
* update README with instructions for building node-datachannel against libnice for TURN support ([b8201d7](https://github.com/algorandfoundation/ac2/commit/b8201d7b1812c4d7ce6466992f3976edea3fbcd0))
* use libnice ICE backend for TURN TCP/TLS transport support ([b75e76e](https://github.com/algorandfoundation/ac2/commit/b75e76e40a0b4ad28f28748e3dd3b2fe6fca50c9))

# [ac2-open-claw-reference@1.0.0-canary.2](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.1...ac2-open-claw-reference@1.0.0-canary.2) (2026-06-12)


### Bug Fixes

* update README to include installation instructions ([063818a](https://github.com/algorandfoundation/ac2/commit/063818a5711f792a1308f080e9ad65c06d04392b))

# ac2-open-claw-reference@1.0.0-canary.1 (2026-06-12)


### Bug Fixes

* coverage for `SigningRejected` ([0290664](https://github.com/algorandfoundation/ac2/commit/02906641a9ad35cd798cbb0c0dfb04b27ff5c7a4))
* DOM type shim for dataChannels initialization ([c784964](https://github.com/algorandfoundation/ac2/commit/c7849647f452188c73f927de44f5e4b203be8bde))
* remove hallucinated type properties ([5e17fe7](https://github.com/algorandfoundation/ac2/commit/5e17fe701bd43adaa7ba9d79493abf581c06df7f))
* SigningRejected and SigningRequest types, tests ([2984739](https://github.com/algorandfoundation/ac2/commit/2984739b8ced1441739ce31bf33ee022b454aa88))
* **tests:** refine unit tests, coverage, remove duplicates ([c039539](https://github.com/algorandfoundation/ac2/commit/c039539bbffcd690eb66cdd861297986f0dce099))
* update package name and README references to @algorandfoundation/ac2-sdk ([363638d](https://github.com/algorandfoundation/ac2/commit/363638daa3d3056e5a65d08a49882311d37dbb38))
* update type definitions in handleMessage tests ([e0f25c5](https://github.com/algorandfoundation/ac2/commit/e0f25c5f50e465f0650dd591f5d95e99d100757f))


### Features

* ac2 protocol client, transports and channel handlers. ([bd023c7](https://github.com/algorandfoundation/ac2/commit/bd023c7c5245ed6994f11f19641c41fafa5a0a7e))
* add optional key_type, display_hint, and sig_hint to SigningRequestBody schema and validation tests ([35cde74](https://github.com/algorandfoundation/ac2/commit/35cde7404471ee4674a2550db5d3c044f16eb025))
* enhance KeyRequest schema with derivation_path and update purpose to an array ([9b793a7](https://github.com/algorandfoundation/ac2/commit/9b793a7a289f53a352b95d3825dc78cf7e8b462a))
* open-claw reference/ac2-controller integration with SDK ([25e1552](https://github.com/algorandfoundation/ac2/commit/25e15528d4c7397c87b51a980558d13befd10c3d))
* update KeyResponseBody schema to include status, key_type, material, public_key, derivation_path, and reason fields; adjust tests accordingly ([6a7129a](https://github.com/algorandfoundation/ac2/commit/6a7129a76178ba6281da5723bdaf237ff3d2de6f))
