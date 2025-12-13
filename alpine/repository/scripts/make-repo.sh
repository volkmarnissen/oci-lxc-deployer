#!/bin/sh
set -eu

# Assemble APKs into a local repository under alpine/service-packages/<arch>
# and generate APKINDEX (optionally sign if abuild keys exist).

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TARGET_ROOT="$ROOT_DIR/../service-packages"
ARCH=${ARCH:-$(apk --print-arch 2>/dev/null || echo x86_64)}
SRC_DIR=${SRC_DIR:-"$HOME/packages/$ARCH"}
DEST_DIR="$TARGET_ROOT/$ARCH"

mkdir -p "$DEST_DIR"

# Copy APKs
find "$SRC_DIR" -maxdepth 1 -type f -name "*.apk" -exec cp -f {} "$DEST_DIR" \;

# Build index
apk index -o "$DEST_DIR/APKINDEX.tar.gz" "$DEST_DIR"/*.apk

# Sign index if abuild keys available
if command -v abuild-sign >/dev/null 2>&1; then
  abuild-sign "$DEST_DIR/APKINDEX.tar.gz" || true
fi

echo "Repo ready: $DEST_DIR"
echo "Add to /etc/apk/repositories: file://$DEST_DIR"
