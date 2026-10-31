# Doctor

`foga doctor` inspects a world and reports, per contract and per layer, what it could establish. It never collapses the layers into a single success flag.

## Layers

| Layer | Question | How |
|---|---|---|
| 1 chain and code | is there code at the address, on the expected chain? | `eth_chainId`, `eth_getCode` |
| 2 interfaces | which interfaces does the contract declare, and does it declare the ones it was built from? | `supportsInterface` probes for ERC-165 and for every interface of the same repository; expected = the contract's direct base interfaces |
| 3 version match | is the runtime code the locked build? | keccak256 of the on-chain code after stripping the CBOR metadata trailer, zeroing every embedded metadata hash (a contract that creates other contracts embeds their creation code and metadata — TaskToken embeds TaskVault), and zeroing library-address and immutable slots, compared with the bundle's `runtimeIdentity` |
| 4 configuration and permissions | are dependencies wired as the world says, and who holds the authority slots? | view calls listed in `src/doctor/checks.ts` (`WIRING_CHECKS`), compared with world addresses, world parameters or explicit `expectations`; `READOUTS` print owner / admin / counters |
| 5 semantic validation | do the success, rejection, signature, proof and recovery cases hold? | the genesis scenario provides the evidence (`foga genesis run`, docs/genesis.md: T0–T9). `foga doctor --genesis <evidence.json>` attributes every recorded check to the standards it exercises (`src/doctor/semantic.ts`: by the operation the check names, with the step as fallback) and reports per ERC: Pass when every effective check passes, Fail when any fails (the failing checks are listed), Not tested when the evidence has no check for the standard or only skipped ones (a check skipped for want of proving material is never a pass). The evidence must come from the same world (worldId and chain), otherwise the verdicts are Unknown |

## Verdicts

`Pass`, `Fail`, `Unknown` (the doctor could not decide — no bundle key, an undecodable answer, an unpublished interface the contract was built from but does not declare), `NotTested` (not probed), `NotApplicable` (nothing to assert — the contract has no ERC-165, the reference is absent from this world, the arguments are unavailable).

A layer-3 (or layer-2) `Fail` on a contract whose world entry carries `deployedRevision` is labeled *known*: the chain holds an earlier revision than the locked source. That is information about the world, not a defect in either. The official ERC-8004 Identity Registry is not built by FOGA: layer 2 checks its ERC-165 and ERC-721 declarations, layer 3 is Not applicable.

## Probe plans and replay

A doctor run is two steps: a deterministic **probe plan** (every JSON-RPC request the doctor needs, derived from the world file and the bundle alone) and its execution. `--export-probe` writes the plan; `scripts/relay.mjs` (or any JSON-RPC client) executes it and writes results; `--import-results` evaluates them. The report records whether it was produced live or by replay, the RPC used and when the results were collected. This lets a machine without RPC access evaluate evidence collected by one that has it, and lets a report be reproduced later from the same results file.

## Running

```bash
# local world just deployed
npm run foga -- doctor --world deployments/local.json --out deployments/local.doctor.json

# Sepolia, attached from the config, live
FOGA_RPC_URL=$SEPOLIA_RPC_URL npm run foga -- doctor --world worlds/sepolia.json --attach --out deployments/sepolia.doctor.json

# Sepolia through a relay
npm run foga -- doctor --world worlds/sepolia.json --attach --export-probe sepolia.probe.json
node scripts/relay.mjs $SEPOLIA_RPC_URL sepolia.probe.json > sepolia.results.json
npm run foga -- doctor --world worlds/sepolia.json --attach --import-results sepolia.results.json --out deployments/sepolia.doctor.json
```

```bash
# layer 5 from a genesis run (the demo does this by itself after the genesis)
npm run foga -- genesis run --world deployments/local.json --until T9
npm run foga -- doctor --world deployments/local.json --genesis deployments/local.genesis.json --out deployments/local.doctor.json
```

The process exits with code 3 when any check fails, so CI can gate on it. `deployments/local.doctor.example.json` is a complete report from a local world after a T0–T9 genesis: layers 1–4 as before (2 Unknown: ADRFServiceEscrow is built from `IADRFExecutor` and `ISettlementLedger` but declares neither — upstream publishes no ids for them) and layer 5 Pass for the ten standards and ERC-8004.
