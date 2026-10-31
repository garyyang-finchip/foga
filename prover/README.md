# foga-prover

The proving side of the two ERC-8419 ZK paths, kept as a sub-package so that the kernel's dependency tree stays
free of the proving libraries. `npm run zk:install` installs them here (`npm --prefix prover ci`).

`run.cjs` is a stdin/stdout bridge with one JSON job per process:

- the credential pattern (`kya-public-v1`) over the upstream prover (`vendor/kya-standard/companions/zk-kya-groth16/prover.js`,
  materialized by `foga vendor sync`, which also holds that circuit's wasm, proving key and verification key; nothing of
  it is copied here): `root`, `commit`, `attest`, `prove`;
- the predicate pattern (`kya-predicate-count-v1`, FOGA's own circuit in `../zk/circuits`) over the material built by
  `build-predicate.mjs` into `../zk/build` (`npm run zk:predicate`; `FOGA_ZK_PREDICATE_DIR` overrides): `record.sign`,
  `predicate.prove` (and `root` again, for the source set).

The bridge separates the roles the protocol separates. Credential: the prover (a cell) computes `Poseidon(secret)` and
hands the commitment to the attestor; the attestor signs the scheme-bound credential without seeing the secret; the
prover alone turns the credential into a proof for the admitting registry's domain and the current epoch. Predicate: a
source signs task-completion records about a subject; the prover shows that at least K of them are Accepted inside a
window, with the records, their signatures and its own secret as private input and the rule's parameters as public
input; the result is verified locally against the committed verification key before it leaves the bridge.

`build-predicate.mjs` compiles the predicate circuit with the WASM build of circom and runs a deterministic
**development** ceremony (public beacon, 2^17 powers of tau, Groth16 setup, phase-2 beacon); it exports the
verification key (`../zk/build/verification_key.json`, committed) and the Solidity verifier
(`../contracts/src/zk/Groth16PredicateVerifier.sol`, committed). Public randomness means a forgeable proving key: fit
for the genesis and tests, to be replaced by a real multi-party ceremony before any other use. See `../docs/zk.md`.
