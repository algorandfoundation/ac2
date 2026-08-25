# [ac2-open-claw-reference@1.0.0-canary.36](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.35...ac2-open-claw-reference@1.0.0-canary.36) (2026-08-25)


### Features

* single-line install script for OpenClaw + AC2 plugin ([#51](https://github.com/algorandfoundation/ac2/issues/51)) ([183cbd1](https://github.com/algorandfoundation/ac2/commit/183cbd178076f6adec579b54afb5387b280b5428))

# [ac2-open-claw-reference@1.0.0-canary.35](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.34...ac2-open-claw-reference@1.0.0-canary.35) (2026-08-19)


### Bug Fixes

* use `public key` over `wallet address` in git signing context ([#57](https://github.com/algorandfoundation/ac2/issues/57)) ([efa0bf0](https://github.com/algorandfoundation/ac2/commit/efa0bf05f1d7637a2868a4391050f279e3d65491))

# [ac2-open-claw-reference@1.0.0-canary.34](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.33...ac2-open-claw-reference@1.0.0-canary.34) (2026-08-18)


### Features

* simplify git signing ([#56](https://github.com/algorandfoundation/ac2/issues/56)) ([81d92c4](https://github.com/algorandfoundation/ac2/commit/81d92c4876aa272b3a47e515c655e353a50111be))

# [ac2-open-claw-reference@1.0.0-canary.33](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.32...ac2-open-claw-reference@1.0.0-canary.33) (2026-08-18)


### Bug Fixes

* rename `ac2 git-resign` to `ac2 git-sign` ([#55](https://github.com/algorandfoundation/ac2/issues/55)) ([962bd3b](https://github.com/algorandfoundation/ac2/commit/962bd3b1066c2cb722dd6e0b4e4c5f334d538660))

# [ac2-open-claw-reference@1.0.0-canary.32](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.31...ac2-open-claw-reference@1.0.0-canary.32) (2026-08-14)


### Features

* **openclaw:** fund x402 payments via atomic opt-in + Tinyman swap ([#50](https://github.com/algorandfoundation/ac2/issues/50)) ([6227cf1](https://github.com/algorandfoundation/ac2/commit/6227cf1f49dbd64849db97f71846c20755ca7ab3))

# [ac2-open-claw-reference@1.0.0-canary.31](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.30...ac2-open-claw-reference@1.0.0-canary.31) (2026-08-12)


### Features

* SSH-based git commit signing bridge ([de9f8dd](https://github.com/algorandfoundation/ac2/commit/de9f8ddc0a2886efc7370eef9b10010776663906))

# [ac2-open-claw-reference@1.0.0-canary.30](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.29...ac2-open-claw-reference@1.0.0-canary.30) (2026-08-11)


### Bug Fixes

* ensure runtime adapter is set correctly, handle out of date daemon gracefully. ([34893b9](https://github.com/algorandfoundation/ac2/commit/34893b9b994de500adba9210b970026ba823172b))

# [ac2-open-claw-reference@1.0.0-canary.29](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.28...ac2-open-claw-reference@1.0.0-canary.29) (2026-08-11)


### Bug Fixes

* adds versions to cli, add hard stop for daemon, handle gateway closing. ([2b3164a](https://github.com/algorandfoundation/ac2/commit/2b3164af55442db0db00e49517beb665b0f82052))
* harden keystore startup ([70ea312](https://github.com/algorandfoundation/ac2/commit/70ea312b624777fdca37a0a6e5e1b5a02a6eda95))

# [ac2-open-claw-reference@1.0.0-canary.28](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.27...ac2-open-claw-reference@1.0.0-canary.28) (2026-08-10)


### Bug Fixes

* **ac2-cli:** guard activeRun clears by run identity in the gateway adapter ([a95e6bc](https://github.com/algorandfoundation/ac2/commit/a95e6bcbd24d4650276fd7e81a18c01f9fe24da3))
* **ac2-sdk:** clamp options-path heartbeatTimeoutMs to the shared 40s floor ([721428e](https://github.com/algorandfoundation/ac2/commit/721428eb43228e002816bc27bde71fc548318173))
* **ac2-sdk:** re-arm a dropped pairing handshake in place instead of waiting forever ([00107b6](https://github.com/algorandfoundation/ac2/commit/00107b6022b8a3c8e5abdaf2060fcfd75960cba7))
* daemon restart will exit explictly ([763d26f](https://github.com/algorandfoundation/ac2/commit/763d26fa4a7f54b2e4a48a90f6deb94c43c1c36a))
* refactor connection handling to address stale peer issues. Increase response times for long-running actions like x402 ([c57061c](https://github.com/algorandfoundation/ac2/commit/c57061c9d156bed2828908551ad97fd2160704d0))

# [ac2-open-claw-reference@1.0.0-canary.27](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.26...ac2-open-claw-reference@1.0.0-canary.27) (2026-08-07)


### Bug Fixes

* always retry connections with backoff and improve debug logs ([c7bce44](https://github.com/algorandfoundation/ac2/commit/c7bce44c76a7105bb1cb1e868b1a5cacb7514007))


### Features

* device identity using service key ([a9c870a](https://github.com/algorandfoundation/ac2/commit/a9c870a4015b454b8bad9de8845ca4dda93bb4ff))

# [ac2-open-claw-reference@1.0.0-canary.26](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.25...ac2-open-claw-reference@1.0.0-canary.26) (2026-08-06)


### Bug Fixes

* darwin keyring, cli-entrypoint and windows fixes ([a460b8e](https://github.com/algorandfoundation/ac2/commit/a460b8edf0aab69174e6dd354a59b1a5237b0ed4))
* macOS names for background service and liveness check from daemon ([4690181](https://github.com/algorandfoundation/ac2/commit/46901819ef3d3f71feb963b0b15a2a70cec0b0d5))

# [ac2-open-claw-reference@1.0.0-canary.25](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.24...ac2-open-claw-reference@1.0.0-canary.25) (2026-08-06)


### Bug Fixes

* resolve keystore packages from the npm registry ([4af3953](https://github.com/algorandfoundation/ac2/commit/4af395394b16549401169cd8da69bb2ce8da8e82))

# [ac2-open-claw-reference@1.0.0-canary.24](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.23...ac2-open-claw-reference@1.0.0-canary.24) (2026-08-06)


### Features

* ac2-cli and agent runtime isolation ([98ac62f](https://github.com/algorandfoundation/ac2/commit/98ac62f05080d227ff36aad01c41f1b04bd01cac))

# [ac2-open-claw-reference@1.0.0-canary.23](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.22...ac2-open-claw-reference@1.0.0-canary.23) (2026-07-28)


### Bug Fixes

* use transaction-algorand sig_hint for human-readable Algorand tx… ([#38](https://github.com/algorandfoundation/ac2/issues/38)) ([c763a3c](https://github.com/algorandfoundation/ac2/commit/c763a3c0753c102d5d03c5329602504cddea43c5))

# [ac2-open-claw-reference@1.0.0-canary.22](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.21...ac2-open-claw-reference@1.0.0-canary.22) (2026-07-28)


### Bug Fixes

* **openclaw:** support AC2 plugin updates ([#37](https://github.com/algorandfoundation/ac2/issues/37)) ([61a3e6f](https://github.com/algorandfoundation/ac2/commit/61a3e6fde0f5c9608887b542db0d95615bc17726))

# [ac2-open-claw-reference@1.0.0-canary.21](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.20...ac2-open-claw-reference@1.0.0-canary.21) (2026-07-27)


### Features

* presence of peers, identity lockdown, subagent details ([6067d60](https://github.com/algorandfoundation/ac2/commit/6067d60a032c32bbf1433e5274079b1a81237b0a))

# [ac2-open-claw-reference@1.0.0-canary.20](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.19...ac2-open-claw-reference@1.0.0-canary.20) (2026-07-16)


### Bug Fixes

* ac2 plugin pairing timeout ([#32](https://github.com/algorandfoundation/ac2/issues/32)) ([acaa89b](https://github.com/algorandfoundation/ac2/commit/acaa89b8056902a11653b61573d55061502f1acd)), closes [SignalClient#peer](https://github.com/SignalClient/issues/peer)

# [ac2-open-claw-reference@1.0.0-canary.19](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.18...ac2-open-claw-reference@1.0.0-canary.19) (2026-07-16)


### Bug Fixes

* **ac2:** bound signaling connect wait so pair re-link cannot hang ([250ab82](https://github.com/algorandfoundation/ac2/commit/250ab827a070e5650600ba7af8d9f3c9adbb4b0c))

# [ac2-open-claw-reference@1.0.0-canary.18](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.17...ac2-open-claw-reference@1.0.0-canary.18) (2026-07-15)


### Features

* **openclaw:** expose Algorand wallet address ([7ac802d](https://github.com/algorandfoundation/ac2/commit/7ac802d3cd771ad66a170c09dfb0a519c2f34e3f))

# [ac2-open-claw-reference@1.0.0-canary.17](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.16...ac2-open-claw-reference@1.0.0-canary.17) (2026-07-07)


### Bug Fixes

* **openclaw:** notify transport close on forced disconnect ([765fd30](https://github.com/algorandfoundation/ac2/commit/765fd30de2109c75e74ccffdb80844271546467f))

# [ac2-open-claw-reference@1.0.0-canary.16](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.15...ac2-open-claw-reference@1.0.0-canary.16) (2026-07-07)


### Bug Fixes

* **openclaw:** unwind data channels on heartbeat close ([8cfdb46](https://github.com/algorandfoundation/ac2/commit/8cfdb46d7d7fa80be48cf15e22898f132816f43d))

# [ac2-open-claw-reference@1.0.0-canary.15](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.14...ac2-open-claw-reference@1.0.0-canary.15) (2026-07-07)


### Bug Fixes

* **ac2-open-claw-reference:** document x402 weather demo ([9cbf388](https://github.com/algorandfoundation/ac2/commit/9cbf388d2576e128e19dfe3b8fc9797d1acff7eb))

# [ac2-open-claw-reference@1.0.0-canary.14](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.13...ac2-open-claw-reference@1.0.0-canary.14) (2026-07-07)


### Bug Fixes

* address wrtc review feedback ([d4a57c1](https://github.com/algorandfoundation/ac2/commit/d4a57c1b096b67ddd5bc3316bd4bf865683e96fb))

# [ac2-open-claw-reference@1.0.0-canary.13](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.12...ac2-open-claw-reference@1.0.0-canary.13) (2026-07-07)


### Bug Fixes

* address wrtc review feedback ([d4a57c1](https://github.com/algorandfoundation/ac2/commit/d4a57c1b096b67ddd5bc3316bd4bf865683e96fb))


### Features

* **ac2-open-claw-reference:** use @roamhq/wrtc for WebRTC transport ([124f4b2](https://github.com/algorandfoundation/ac2/commit/124f4b2cf0f4016320c5593f5fff55cbf8903ac9))

# [ac2-open-claw-reference@1.0.0-canary.12](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.11...ac2-open-claw-reference@1.0.0-canary.12) (2026-07-07)


### Bug Fixes

* **openclaw:** avoid relaying signed payloads by default ([7674cd4](https://github.com/algorandfoundation/ac2/commit/7674cd48a1e85375a8633b18050eb6da93b3a71b))

# [ac2-open-claw-reference@1.0.0-canary.11](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.10...ac2-open-claw-reference@1.0.0-canary.11) (2026-07-07)


### Bug Fixes

* **ac2-open-claw-reference:** bundle libnice node-datachannel artifacts ([6eb5ad8](https://github.com/algorandfoundation/ac2/commit/6eb5ad8ef3494ceb2463d53a71b88f06773b2b16))
* **ac2-open-claw-reference:** keep signature model-visible ([4fcc8bf](https://github.com/algorandfoundation/ac2/commit/4fcc8bf56b07726c227bfbfbe3086fac51c2a6d4))


### Reverts

* **ac2-open-claw-reference:** keep signature in tool details ([4fb3062](https://github.com/algorandfoundation/ac2/commit/4fb3062d1a0abc4b620d00c6ec5b2db1533847d9))
* **ac2-open-claw-reference:** remove libnice rebuild path ([027cded](https://github.com/algorandfoundation/ac2/commit/027cdedf195b694b01150807a6619070d3aaae0a))
* Revert "Merge pull request [#18](https://github.com/algorandfoundation/ac2/issues/18) from algorandfoundation/fix/ac2-bundle-node-datachannel-libnice" ([16c21d6](https://github.com/algorandfoundation/ac2/commit/16c21d64f5301e794a50e266298f0b67788a445b))

# [ac2-open-claw-reference@1.0.0-canary.10](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.9...ac2-open-claw-reference@1.0.0-canary.10) (2026-07-06)


### Bug Fixes

* **ac2-open-claw-reference:** report missing native pairing dependency ([5c82adc](https://github.com/algorandfoundation/ac2/commit/5c82adc1468f2238a7f0788c39735228038a8fb6))

# [ac2-open-claw-reference@1.0.0-canary.9](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.8...ac2-open-claw-reference@1.0.0-canary.9) (2026-07-06)


### Bug Fixes

* **ac2-open-claw-reference:** defer node-datachannel polyfill import ([93dc622](https://github.com/algorandfoundation/ac2/commit/93dc622f6c84ad3127e4e68ef300e03266933d73))

# [ac2-open-claw-reference@1.0.0-canary.8](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.7...ac2-open-claw-reference@1.0.0-canary.8) (2026-07-06)


### Bug Fixes

* **ac2-open-claw-reference:** lazy load native provider from package root ([ba6a1c0](https://github.com/algorandfoundation/ac2/commit/ba6a1c062a76cbe9473737a34a78952956c456e8))

# [ac2-open-claw-reference@1.0.0-canary.7](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.6...ac2-open-claw-reference@1.0.0-canary.7) (2026-07-06)


### Bug Fixes

* **ac2-open-claw-reference:** avoid native import during command registration ([58e73a4](https://github.com/algorandfoundation/ac2/commit/58e73a4645bb7dc8b33934fc7a5fe5611dbd1190))

# [ac2-open-claw-reference@1.0.0-canary.6](https://github.com/algorandfoundation/ac2/compare/ac2-open-claw-reference@1.0.0-canary.5...ac2-open-claw-reference@1.0.0-canary.6) (2026-07-06)


### Bug Fixes

* **ac2-open-claw-reference:** document sign tool signature output ([96c7ab9](https://github.com/algorandfoundation/ac2/commit/96c7ab9e9d8e4b43d47ec00452d2600a9cbfc44d))

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
