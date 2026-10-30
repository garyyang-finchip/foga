# Build: from ten repositories to one bundle

`foga build` turns the ten locked reference implementations (plus FOGA's local contracts) into `artifacts/bundle.json`, a single machine-independent file that every other command reads. Nothing else in FOGA needs the Solidity sources.

## Inputs

- `vendor/LOCK.json` — repository URL and commit per ERC.
- `vendor/<repo>/` — materialized by `foga vendor sync` (a one-commit fetch of exactly the locked commit; the directory is replaced if it is at any other commit).
- `build/profiles.json` — how each repository is compiled:
  - `native`: `forge build --ast --no-cache --skip test --skip script --out <foga out dir>` runs inside the vendored repository with its own `foundry.toml`, so optimizer, runs, via-IR, EVM version, metadata and remappings are exactly upstream's.
  - `staged` (kya-standard, aid-standard, whose upstream toolchain is solc-js): the contract tree is copied into `.foga-build/stage/<repo>/` with a generated `foundry.toml` that mirrors the upstream compile script (`solc 0.8.28`, optimizer on, 200 runs, EVM `cancun`, `bytecode_hash = ipfs`). Source names inside the staged project equal the upstream script's source names.
  - `local`: `contracts/` (FOGA's own stand-ins), built with `contracts/foundry.toml`.
- `build/known-interface-ids.json` — the ids 8338 and 8414 publish in their READMEs (those two repositories have no vectors file).

## Compiler binaries

Foundry downloads solc from the Solidity binary mirror on demand. On a machine that cannot reach the mirror, run `scripts/install-solc.sh` (which fetches the three static Linux binaries from the Solidity GitHub releases) and export `FOGA_SOLC_DIR`; `foga build` then passes `--use <dir>/solc-<version>` to forge. The compiler commits used for the committed bundle are `0.8.24+commit.e11b9ed9`, `0.8.28+commit.7893614a` and `0.8.30+commit.73712a01` — the same commits recorded in the upstream Sepolia deployments.

## What goes into the bundle

For every compilation target under a profile's `contractsRoot` (tests, scripts, `lib/` and vendored test fixtures are excluded):

| Field | Source |
|---|---|
| `abi`, `methodIdentifiers`, `bytecode`, `deployedBytecode` | forge artifact |
| `linkReferences`, `deployedLinkReferences`, `immutableReferences` | forge artifact; used for linking at deploy time and for masking at verification time |
| `kind` (contract / library / interface), `abstract`, `baseContracts` | AST |
| `interfaceId` | XOR of the selectors of the interface's own functions (AST `functionSelector`), the same rule as `type(I).interfaceId` |
| `compiler`, `settings` (optimizer, runs, viaIR, evmVersion, bytecodeHash, remappings), `sourceKeccak` | artifact metadata |
| `runtimeIdentity` | keccak256 of the runtime code after stripping the CBOR metadata trailer and zeroing link and immutable slots |
| `role` | heuristic from path and kind (registry, kernel, adapter, module, library, verifier, bridge, example, companion, mock, interface, local-stub) |

`interfaceIds` records, per repository, the computed id, the upstream-published id when there is one, and whether they match. `extras` carries small upstream vectors the world needs (ARD kind ids, SAI term ids, AUF identifiers).

## The bundle hash

`hash` is the sha256 of a canonical JSON (sorted keys, no whitespace) of every contract's `abi`, `bytecode`, `deployedBytecode`, link and immutable references, `compiler`, `settings`, `sourceKeccak` and `upstreamPath`, plus the locked commits. It excludes timestamps and machine paths. `foga build --verify` rebuilds everything into `.foga-build/bundle.verify.json` and compares hashes; CI runs this on every push, so the committed bundle is always reproducible from the lock.

## Determinism notes

- forge writes repository-relative source paths into the metadata, so builds are independent of the checkout location.
- The same solc commit produces the same bytecode; a different forge version does not change bytecode but may change the artifact JSON layout, which the extractor tolerates.
- `--no-cache` is passed so stale caches in a vendored tree cannot leak into the bundle.
