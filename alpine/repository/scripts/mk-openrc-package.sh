#!/bin/sh
set -eu

# mk-openrc-package.sh
# Generate a simple abuild package skeleton which installs an OpenRC service.
# Usage:
#   PKGNAME=modbus2mqtt PKGVER=1.0.0 \
#   ./scripts/mk-openrc-package.sh
# Optional:
#   BIN_SRC=</absolute/path/to/binary>  # copied into files/$PKGNAME

PKGNAME=${PKGNAME:-}
PKGVER=${PKGVER:-1.0.0}
BIN_SRC=${BIN_SRC:-}

if [ -z "$PKGNAME" ]; then
  echo "PKGNAME required" >&2
  exit 1
fi

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PKG_DIR="$ROOT_DIR/$PKGNAME"
FILES_DIR="$PKG_DIR/files"

mkdir -p "$FILES_DIR"

# APKBUILD
cat >"$PKG_DIR/APKBUILD" <<EOF
# shellcheck shell=sh
pkgname=$PKGNAME
pkgver=$PKGVER
pkgrel=0
pkgdesc="OpenRC service and binary for $PKGNAME"
url=""
arch="noarch"
license="MIT"
depends="openrc"
makedepends=""
install="post-install"
options="!check !strip"
source="
    files/$PKGNAME.initd
    files/$PKGNAME.confd
    files/$PKGNAME
    files/post-install
    "

prepare() {
  :
}

build() {
  :
}

package() {
  install -d "$pkgdir"/usr/bin
  install -m755 "$startdir"/files/$PKGNAME "$pkgdir"/usr/bin/$PKGNAME

  install -d "$pkgdir"/etc/init.d
  install -m755 "$startdir"/files/$PKGNAME.initd "$pkgdir"/etc/init.d/$PKGNAME

  install -d "$pkgdir"/etc/conf.d
  install -m644 "$startdir"/files/$PKGNAME.confd "$pkgdir"/etc/conf.d/$PKGNAME
}

sha512sums="
SKIP  $PKGNAME.initd
SKIP  $PKGNAME.confd
SKIP  $PKGNAME
SKIP  post-install
"
EOF

# init.d
cat >"$FILES_DIR/$PKGNAME.initd" <<'EOF'
#!/sbin/openrc-run
name="$RC_SVCNAME"
command="/usr/bin/'PKGNAME'"
command_args="${'PKGNAME'_OPTS:-}"
pidfile="/run/'PKGNAME'.pid"
output_log="/var/log/'PKGNAME'.log"
error_log="/var/log/'PKGNAME'.err"

depend() {
  need net
}

start_pre() {
  mkdir -p /run
}
EOF
sed -i "s/'PKGNAME'/$PKGNAME/g" "$FILES_DIR/$PKGNAME.initd"

# conf.d
cat >"$FILES_DIR/$PKGNAME.confd" <<EOF
# Command-line options for $PKGNAME
# Example: port and bind address
${PKGNAME}_OPTS="--port 8080 --host 0.0.0.0"
EOF

# post-install maintainer script
cat >"$FILES_DIR/post-install" <<EOF
#!/bin/sh
set -eu
rc-update add $PKGNAME default || true
rc-service $PKGNAME restart || rc-service $PKGNAME start || true
EOF
chmod +x "$FILES_DIR/post-install"

# Placeholder binary
if [ -n "$BIN_SRC" ] && [ -f "$BIN_SRC" ]; then
  cp "$BIN_SRC" "$FILES_DIR/$PKGNAME"
else
  cat >"$FILES_DIR/$PKGNAME" <<'EOF'
#!/bin/sh
echo "$0 starting (placeholder). Provide real binary via BIN_SRC."
exec sleep 60
EOF
  chmod +x "$FILES_DIR/$PKGNAME"
fi

echo "Created $PKG_DIR"
