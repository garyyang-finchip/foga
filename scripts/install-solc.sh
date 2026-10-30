#!/usr/bin/env bash
# Download the static solc binaries the ten reference implementations are built with, from the
# Solidity GitHub releases, into a directory that `foga build` can use through FOGA_SOLC_DIR.
# Useful on machines that cannot reach binaries.soliditylang.org (Foundry's default mirror).
#
# usage: scripts/install-solc.sh [target-dir]   (default: ~/.foga/solc)
set -euo pipefail
DIR="${1:-$HOME/.foga/solc}"
mkdir -p "$DIR"
for v in 0.8.24 0.8.28 0.8.30; do
  out="$DIR/solc-$v"
  if [ -x "$out" ]; then
    echo "solc-$v already present"
    continue
  fi
  echo "downloading solc $v"
  curl -sSL -o "$out" "https://github.com/ethereum/solidity/releases/download/v$v/solc-static-linux"
  chmod +x "$out"
  "$out" --version | tail -1
done
echo "export FOGA_SOLC_DIR=$DIR"
