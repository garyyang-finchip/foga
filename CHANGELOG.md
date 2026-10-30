# Changelog

## 0.2.0-alpha.3 — 2026-10-30

- `scripts/install-foundry.sh`: installs the statically linked (musl) build of the pinned Foundry release for Linux machines whose glibc is older than 2.35 (Amazon Linux 2/2023, CentOS 7, Debian 11), verifying the release checksum. `FOGA_FOUNDRY_DIR` makes `foga demo` start anvil from that directory; the demo recognizes the `GLIBC_x.y not found` failure and points at the script. README and docs/build.md note it.

## 0.2.0-alpha.2 — 2026-10-30

- `foga demo` explains why anvil did not come up instead of timing out: a port already taken (by a JSON-RPC node or by something else), anvil missing from PATH, or anvil exiting at start (its exit code and stderr are shown). The wait ends as soon as anvil exits. The WAL/SHM side files of the operation store are removed with it before a `--genesis` run.
- CI: runner pinned to `ubuntu-24.04` ahead of the `ubuntu-latest` migration; `actions/upload-artifact@v7` (Node 24).
- `contracts/test/FogaCellAccount.t.sol`: `_requirement` is `pure` (compiler warning).

## 0.2.0-alpha.1 — 2026-10-30 (Phase 2a-1)

- `contracts/src/FogaCellAccount.sol` with `interfaces/IASFBindingRegistryLike.sol`: the cell's contract account — ERC-8468 execution gate (`ASFGuardedAccount` semantics), roles (owner, scoped operator, guardian, recovery), owner-level `adoptBinding` as the bootstrap, commitment-class selectors gated on the ERC-8434 state, de-risk allow-list, ERC-1271, ERC-721/1155 receivers, `sweep`. 15 Foundry tests. `contracts/foundry.toml` compiles with via-IR.
- `src/core/` (foga-core): `canonical` (JCS, hashes, data: URIs, CAIP references), `world` (typed handle on a world), `erc8004`, `skills`, `tenders` (with the hashlock profile), `kya`, `aid`, `ard`, `asf`, `units`, and `pack/` (DAG-CBOR and the ERC-8338 package builder, byte-exact against the upstream vectors).
- `src/kernel/` (foga-kernel): `OperationStore` on `node:sqlite`, `TxManager` (exactly-once by key, hash/nonce recovery, re-send rule, fault injection, gas margin), `Cell`, `Kernel`, `RevertDecoder`.
- `src/genesis/`: roles and key derivation, the `foga-probe` skill with its isolated worker, the T0–T3 scenario with checks and evidence, the runner. `scenarios/skills/foga-probe` and `scenarios/skills/finch-extract-verify` are the two skill packages.
- CLI: `foga genesis run`, `foga genesis status`, `foga demo --genesis <step>`; scripts `demo:genesis`, `genesis:local`, `test:contracts`.
- `artifacts/bundle.json` rebuilt: 159 contracts (FogaCellAccount, its interfaces and the via-IR stand-in added); hash `0xab27f383…`.
- CI: Foundry tests, the genesis with an injected crash, the resumed run (asserting one recovered operation and a single submission) and a pure replay (asserting nothing was sent); actions bumped to checkout v5, setup-node v5, upload-artifact v5.
- Docs: `docs/cell-account.md`, `docs/kernel.md`, `docs/genesis.md`; README, compatibility matrix and design memo updated; `deployments/local.genesis.example.json` committed.
- Docker: the image ships `scenarios/`; compose adds the `genesis` service.

## 0.1.1 — 2026-10-30

- Runtime identity (doctor layer 3) also zeroes every metadata hash embedded inside the code, so builds of identical code from different paths compare equal (TaskToken embeds TaskVault's creation code and metadata).
- Layer-2 mismatches on contracts with a recorded `deployedRevision` are labeled known; the official ERC-8004 Identity Registry gets an ERC-165/ERC-721 probe on layer 2 and Not applicable on layer 3.
- `artifacts/bundle.json` rebuilt under the new identity rule; the bundle hash is unchanged.
- `docs/version-lock.md`: the Sepolia revision table is confirmed by the 2026-10-30 runs; `deployments/sepolia.doctor.example.json` committed (second run, block 12023430).
- `package.json`: repository and homepage point at github.com/garyyang-finchip/foga.

## 0.1.0 — 2026-10-30

Phase 1, the world layer: vendor lock and sync for the ten reference implementations, the compiled artifact bundle with cross-checked ERC-165 ids, the one-command world deployment (47 contracts plus ARD kind registration) with a local ERC-8004 stand-in, the doctor (layers 1–4, probe plans and offline replay), the Sepolia address book, CI, Docker files and documentation.
