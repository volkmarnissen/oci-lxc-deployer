#!/bin/sh
set -eu

# Serve the local repository via a simple HTTP server.
# Requires busybox httpd or python.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TARGET_ROOT="$ROOT_DIR/../service-packages"
ARCH=${ARCH:-$(apk --print-arch 2>/dev/null || echo x86_64)}
DOC_ROOT="$TARGET_ROOT/$ARCH"
PORT=${PORT:-8080}

if [ ! -d "$DOC_ROOT" ]; then
  echo "Repo not found: $DOC_ROOT. Run scripts/make-repo.sh first." >&2
  exit 1
fi

echo "Serving $DOC_ROOT on http://0.0.0.0:$PORT"
if command -v httpd >/dev/null 2>&1; then
  httpd -p "$PORT" -h "$DOC_ROOT" -f -v
elif command -v python3 >/dev/null 2>&1; then
  cd "$DOC_ROOT" && python3 -m http.server "$PORT"
else
  echo "No httpd or python3 available to serve repo." >&2
  exit 1
fi
