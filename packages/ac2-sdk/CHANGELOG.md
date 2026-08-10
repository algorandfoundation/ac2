# [ac2-sdk@1.0.0-canary.5](https://github.com/algorandfoundation/ac2/compare/ac2-sdk@1.0.0-canary.4...ac2-sdk@1.0.0-canary.5) (2026-08-07)


### Bug Fixes

* always retry connections with backoff and improve debug logs ([c7bce44](https://github.com/algorandfoundation/ac2/commit/c7bce44c76a7105bb1cb1e868b1a5cacb7514007))

# [ac2-sdk@1.0.0-canary.4](https://github.com/algorandfoundation/ac2/compare/ac2-sdk@1.0.0-canary.3...ac2-sdk@1.0.0-canary.4) (2026-08-06)


### Features

* ac2-cli and agent runtime isolation ([98ac62f](https://github.com/algorandfoundation/ac2/commit/98ac62f05080d227ff36aad01c41f1b04bd01cac))

# [ac2-sdk@1.0.0-canary.3](https://github.com/algorandfoundation/ac2/compare/ac2-sdk@1.0.0-canary.2...ac2-sdk@1.0.0-canary.3) (2026-07-27)


### Features

* presence of peers, identity lockdown, subagent details ([6067d60](https://github.com/algorandfoundation/ac2/commit/6067d60a032c32bbf1433e5274079b1a81237b0a))

# [ac2-sdk@1.0.0-canary.2](https://github.com/algorandfoundation/ac2/compare/ac2-sdk@1.0.0-canary.1...ac2-sdk@1.0.0-canary.2) (2026-07-07)


### Features

* **ac2-open-claw-reference:** use @roamhq/wrtc for WebRTC transport ([124f4b2](https://github.com/algorandfoundation/ac2/commit/124f4b2cf0f4016320c5593f5fff55cbf8903ac9))

# ac2-sdk@1.0.0-canary.1 (2026-06-08)


### Bug Fixes

* coverage for `SigningRejected` ([0290664](https://github.com/algorandfoundation/ac2/commit/02906641a9ad35cd798cbb0c0dfb04b27ff5c7a4))
* remove hallucinated type properties ([5e17fe7](https://github.com/algorandfoundation/ac2/commit/5e17fe701bd43adaa7ba9d79493abf581c06df7f))
* SigningRejected and SigningRequest types, tests ([2984739](https://github.com/algorandfoundation/ac2/commit/2984739b8ced1441739ce31bf33ee022b454aa88))
* **tests:** refine unit tests, coverage, remove duplicates ([c039539](https://github.com/algorandfoundation/ac2/commit/c039539bbffcd690eb66cdd861297986f0dce099))
* update package name and README references to @algorandfoundation/ac2-sdk ([363638d](https://github.com/algorandfoundation/ac2/commit/363638daa3d3056e5a65d08a49882311d37dbb38))
* update type definitions in handleMessage tests ([e0f25c5](https://github.com/algorandfoundation/ac2/commit/e0f25c5f50e465f0650dd591f5d95e99d100757f))


### Features

* ac2 protocol client, transports and channel handlers. ([bd023c7](https://github.com/algorandfoundation/ac2/commit/bd023c7c5245ed6994f11f19641c41fafa5a0a7e))
* add optional key_type, display_hint, and sig_hint to SigningRequestBody schema and validation tests ([35cde74](https://github.com/algorandfoundation/ac2/commit/35cde7404471ee4674a2550db5d3c044f16eb025))
* enhance KeyRequest schema with derivation_path and update purpose to an array ([9b793a7](https://github.com/algorandfoundation/ac2/commit/9b793a7a289f53a352b95d3825dc78cf7e8b462a))
* update KeyResponseBody schema to include status, key_type, material, public_key, derivation_path, and reason fields; adjust tests accordingly ([6a7129a](https://github.com/algorandfoundation/ac2/commit/6a7129a76178ba6281da5723bdaf237ff3d2de6f))
