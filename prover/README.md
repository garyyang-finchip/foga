# foga-prover

The proving side of the ERC-8419 credential-pattern ZK path (`kya-public-v1`), kept as a sub-package so that the
kernel's dependency tree stays free of the proving libraries. `npm run zk:install` installs them here
(`npm --prefix prover ci`); `run.cjs` is a stdin/stdout bridge over the upstream prover
(`vendor/kya-standard/companions/zk-kya-groth16/prover.js`, materialized by `foga vendor sync`), which also
holds the circuit's wasm, proving key and verification key. Nothing of the upstream prover is copied here.

The bridge separates the roles the protocol separates: the prover (a cell) computes `Poseidon(secret)` and hands
the commitment to the attestor; the attestor signs the scheme-bound credential without seeing the secret; the
prover alone turns the credential into a proof for the admitting registry's domain and the current epoch.
