#!/usr/bin/env bash
# Rehearse the public-chain path on anvil, as CI does: a fresh anvil, the local world deployed, an attach-mode config
# written from it (scripts/attach-rehearsal.mjs: address book attached, the ERC-8471 stack and two eligibility modules
# left for `foga world deploy`, a second AIDRegistry as the ARD backing registry), the hybrid deploy, the preflight,
# the genesis T0-T9 and the doctor with the evidence. Outputs: deployments/local-attach*.json.
#
#   scripts/rehearse-attach.sh [port] [--zk auto|require|skip]
#
# Uses the anvil in FOGA_FOUNDRY_DIR when set (scripts/install-foundry.sh), otherwise the one on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8546}"; shift || true
RPC="http://127.0.0.1:${PORT}"
ANVIL="${FOGA_FOUNDRY_DIR:+$FOGA_FOUNDRY_DIR/}anvil"
mkdir -p .foga-build

"$ANVIL" --silent --port "$PORT" > .foga-build/anvil-rehearsal.log 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  if curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

npm run foga -- world deploy --world worlds/local.json --rpc "$RPC" --out .foga-build/rehearsal-base.json
node scripts/attach-rehearsal.mjs .foga-build/rehearsal-base.json .foga-build/local-attach.config.json "$RPC"
npm run foga -- world deploy --world .foga-build/local-attach.config.json --rpc "$RPC" --out deployments/local-attach.json
npm run foga -- genesis preflight --world deployments/local-attach.json --rpc "$RPC"
rm -f deployments/local-attach.genesis.sqlite deployments/local-attach.genesis.sqlite-wal deployments/local-attach.genesis.sqlite-shm
npm run foga -- genesis run --world deployments/local-attach.json --rpc "$RPC" --until T9 --store deployments/local-attach.genesis.sqlite --out deployments/local-attach.genesis.json "$@"
npm run foga -- doctor --world deployments/local-attach.json --rpc "$RPC" --genesis deployments/local-attach.genesis.json --out deployments/local-attach.doctor.json
