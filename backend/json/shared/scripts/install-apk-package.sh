#!/bin/sh
# Install APK packages inside Alpine LXC (runs inside the container)
# Inputs (templated):
#   {{ packages }}  (space-separated list, e.g. "openssh curl")
# Accept an optional OSTYPE variable (default: alpine)
set -eu
OSTYPE="${ostype:-alpine}"
PACKAGES="{{ packages }}"

if [ -z "$PACKAGES" ]; then
  echo "Missing packages" >&2
  exit 2
fi

case "$OSTYPE" in
  alpine)
    # Ensure apk is available and index up-to-date
    if ! command -v apk >/dev/null 2>&1; then
      echo "Error: apk not found (not an Alpine Linux environment)" >&2
      exit 1
    fi
    apk update || true
    # shellcheck disable=SC2086
    apk add --no-cache $PACKAGES
    ;;
  debian|ubuntu)
    # Ensure apt is available
    if ! command -v apt-get >/dev/null 2>&1; then
      echo "Error: apt-get not found (not a Debian/Ubuntu environment)" >&2
      exit 1
    fi
    # Update package index
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $PACKAGES
    ;;
  *)
    echo "Error: Unsupported ostype: $OSTYPE" >&2
    exit 3
    ;;
esac

# No output requested; exit success
exit 0

