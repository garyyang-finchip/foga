# Delta 0.1.0 -> 0.1.1 (2026-10-30)

Changed files (replace in place):
- package.json, package-lock.json — version 0.1.1; repository and homepage point at github.com/garyyang-finchip/foga
- src/util/bytecode.ts — the runtime identity now also zeroes every metadata hash embedded inside the code (a contract that creates other contracts embeds their creation code and metadata; TaskToken embeds TaskVault), so builds of identical code from different paths compare equal
- src/doctor/doctor.ts, src/doctor/probe.ts — layer-2 mismatches on contracts with a recorded deployedRevision are labeled known; the official ERC-8004 Identity Registry gets an ERC-165/ERC-721 probe on layer 2 and Not applicable on layer 3
- test/bytecode.test.ts — one more unit test (nested metadata masking)
- artifacts/bundle.json, artifacts/bundle.sha256 — rebuilt; the bundle hash is unchanged (0x9f01de54...9109), only the runtimeIdentity values moved to the new rule
- docs/version-lock.md — the Sepolia revision table is now confirmed by the 2026-10-30 run (block 12023355)
- docs/doctor.md — identity rule and the official-registry handling
- worlds/sepolia.json — notes on the revision-3 escrow interface id and on seam 3
- deployments/local.example.json, deployments/local.doctor.example.json, deployments/sepolia.probe.example.json — regenerated

Added files: none. Deleted files: none.

After uploading, re-run on the EC2 box (same command as before, after `git pull`):
  FOGA_RPC_URL=$SEPOLIA_RPC_URL npm run foga -- doctor --world worlds/sepolia.json --attach --out deployments/sepolia.doctor.json
Expected: 8414/TaskToken layer 3 turns to Pass; the remaining Fails are the known revision-3 units of ERC-8471 and the ARD fixture AIDRegistry.
