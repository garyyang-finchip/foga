#!/usr/bin/env bash
# Install the statically linked (musl, "alpine") build of the pinned Foundry release into a directory of its
# own, for Linux machines whose glibc is older than the one the regular Foundry binaries are built against
# (the glibc builds need GLIBC >= 2.35: Ubuntu 22.04 or newer; Amazon Linux 2 and 2023, CentOS 7, Debian 11
# fail with "version `GLIBC_2.35' not found"). The static build runs on any Linux.
#
# usage: scripts/install-foundry.sh [target-dir] [version]   (defaults: ~/.foga/foundry, v1.7.1 = the CI pin)
# then:  export FOGA_FOUNDRY_DIR=<target-dir>      # `foga demo` starts anvil from there
#        export PATH=<target-dir>:$PATH            # or put anvil/forge/cast/chisel first on PATH
set -euo pipefail
DIR="${1:-$HOME/.foga/foundry}"
VERSION="${2:-v1.7.1}"
case "$(uname -s)" in
  Linux) ;;
  *) echo "this script is for Linux; on macOS use foundryup (https://getfoundry.sh)"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
ASSET="foundry_${VERSION}_alpine_${ARCH}.tar.gz"
BASE="https://github.com/foundry-rs/foundry/releases/download/${VERSION}"
mkdir -p "$DIR"
if [ -x "$DIR/anvil" ] && "$DIR/anvil" --version >/dev/null 2>&1; then
  echo "anvil already present in $DIR: $("$DIR/anvil" --version | head -1)"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading $ASSET"
  curl -sSL -o "$tmp/$ASSET" "$BASE/$ASSET"
  curl -sSL -o "$tmp/$ASSET.sha256" "$BASE/${ASSET%.tar.gz}.sha256"
  expected="$(awk '{print $1}' "$tmp/$ASSET.sha256")"
  actual="$(sha256sum "$tmp/$ASSET" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    echo "checksum mismatch for $ASSET: expected $expected, got $actual"
    exit 1
  fi
  tar -xzf "$tmp/$ASSET" -C "$DIR"
  chmod +x "$DIR"/anvil "$DIR"/forge "$DIR"/cast "$DIR"/chisel 2>/dev/null || true
fi
"$DIR/anvil" --version | head -1
"$DIR/forge" --version | head -1
echo
echo "export FOGA_FOUNDRY_DIR=$DIR"
echo "export PATH=$DIR:\$PATH"
