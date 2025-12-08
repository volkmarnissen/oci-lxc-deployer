#!/bin/sh
set -e

# package-build.sh
# Container-internal script for building modbus2mqtt APK
# This script runs inside the Alpine container and expects:
# Environment: PACKAGER_PRIVKEY, PKG_VERSION, HOST_UID, HOST_GID, ALPINE_VERSION

echo "=== APK Build Container Script ==="
echo "Alpine version: $ALPINE_VERSION"
echo "Package version: $PKG_VERSION"
echo "Build user: builder ($HOST_UID:$HOST_GID)"

# Setup Alpine repositories
ALPINE_REPO_VER="v${ALPINE_VERSION}"
cat > /etc/apk/repositories <<-REPO
https://mirror.init7.net/alpinelinux/${ALPINE_REPO_VER}/main
https://mirror.init7.net/alpinelinux/${ALPINE_REPO_VER}/community
REPO

write_repos() {
  cat > /etc/apk/repositories <<-REPO
https://mirror.init7.net/alpinelinux/${ALPINE_REPO_VER}/main
https://mirror.init7.net/alpinelinux/${ALPINE_REPO_VER}/community
REPO
}
write_repos
if ! apk update >/dev/null 2>&1; then
  echo "WARN: apk update failed on primary mirror, switching to CDN-only" >&2
  cat > /etc/apk/repositories <<-REPO
https://dl-cdn.alpinelinux.org/alpine/${ALPINE_REPO_VER}/main
https://dl-cdn.alpinelinux.org/alpine/${ALPINE_REPO_VER}/community
REPO
  if ! apk update >/dev/null 2>&1; then
    echo "ERROR: failed to use alpine repositories for ${ALPINE_REPO_VER}" >&2
    echo "Contents of /etc/apk/repositories:" >&2
    sed -n '1,120p' /etc/apk/repositories >&2 || true
    exit 1
  fi
fi

# Install build dependencies
echo "Installing build dependencies..."
APK_ADD_FLAGS="--no-progress --update"
apk $APK_ADD_FLAGS add abuild alpine-sdk nodejs npm git shadow openssl doas >/dev/null 2>&1 || {
  echo "WARN: apk add failed, retrying with default options" >&2
  apk add abuild alpine-sdk nodejs npm git shadow openssl doas >/dev/null 2>&1
}
mkdir -p /etc/doas.d
echo 'permit nopass :dialout as root' > /etc/doas.d/doas.conf || true

# Setup groups and users
if ! getent group dialout >/dev/null 2>&1; then
  addgroup -g "${HOST_GID}" dialout >/dev/null 2>&1 || true
fi
echo "Adding build user and groups..."

adduser -D -u "${HOST_UID}" -G dialout builder || true
addgroup builder abuild || true
mkdir -p /home/builder
chown builder:dialout /home/builder || true
mkdir -p /home/builder/.npm
chown -R builder:dialout /home/builder/.npm || true

# Setup abuild keys
echo "Setting up signing keys..."
mkdir -p /home/builder/.abuild
printf '%s' "$PACKAGER_PRIVKEY" > /home/builder/.abuild/builder-6904805d.rsa

# Generate public key from private key
echo "Generating public key from private key..."
if openssl rsa -in /home/builder/.abuild/builder-6904805d.rsa -pubout -out /home/builder/.abuild/builder-6904805d.rsa.pub 2>/dev/null; then
  echo "✓ Public key generated successfully"
else
  echo "ERROR: Failed to generate public key from private key" >&2
  openssl rsa -in /home/builder/.abuild/builder-6904805d.rsa -pubout -out /home/builder/.abuild/builder-6904805d.rsa.pub 2>&1 || true
  exit 1
fi

chmod 600 /home/builder/.abuild/builder-6904805d.rsa || true
chown -R builder:dialout /home/builder/.abuild || true
cp /home/builder/.abuild/builder-6904805d.rsa.pub /etc/apk/keys || true

# Create abuild configuration
cat > /home/builder/.abuild/abuild.conf <<-EOF
PACKAGER_PRIVKEY="/home/builder/.abuild/builder-6904805d.rsa"
PACKAGER_PUBKEY="/home/builder/.abuild/builder-6904805d.rsa.pub"
EOF
chmod 600 /home/builder/.abuild/abuild.conf || true
chown builder:dialout /home/builder/.abuild/abuild.conf || true
# Ensure desired repo channel directory exists (use channel "lxc-manager")
mkdir -p /work/alpine/lxc-manager
chown -R builder:dialout /work/alpine
# Prepare source
echo "Preparing source code..." >&2
rm -rf /work/src/node_modules || true
# has been set in generate-ap.sh sed -i 's/pkgver=.*/pkgver='"${PKG_VERSION}"'/g' /work/APKBUILD || true

# Build APK as builder user via a temporary script to avoid quoting issues
echo "Building APK version $PKG_VERSION into /work/alpine/lxc-manager/<arch>"
cat >/tmp/build-as-builder.sh <<'BUILDER'
#!/bin/sh
set -e
cd /work
ls
export REPODEST=/work/alpine
export repo=lxc-manager
export ABUILD_VERBOSE=1
export ABUILD_TRACE=1
mkdir -p /var/cache/apk
export APK="apk --no-progress --cache-dir /var/cache/apk"
echo "Building checksum..." >&2
abuild checksum || true
echo "Starting abuild -r..." >&2
abuild -r -P "/work/alpine"
echo "Finished abuild -r" >&2
# Copy public key to repo for convenience
if [ -f "/home/builder/.abuild/builder-6904805d.rsa.pub" ]; then
  cp /home/builder/.abuild/builder-6904805d.rsa.pub "$REPODEST/$repo/packager.rsa.pub"
  echo "✓ Public key copied to $REPODEST/$repo/packager.rsa.pub (architecture-independent)"
else
  echo "WARNING: Public key /home/builder/.abuild/builder-6904805d.rsa.pub not found"
  echo "Available files in /home/builder/.abuild/:"
  ls -la /home/builder/.abuild/ || true
fi
BUILDER
chmod +x /tmp/build-as-builder.sh
chown builder:dialout /tmp/build-as-builder.sh || true
su - builder -s /bin/sh -c '/tmp/build-as-builder.sh'

# Collect built APKs into final /work/repo
mkdir -p /work/repo || true
if [ -d "/home/builder/packages" ]; then
  echo "Collecting APKs from /home/builder/packages to /work/repo..." >&2
  # Copy per-arch repos preserving structure
  find /home/builder/packages -type f -name '*.apk' -exec cp -v {} /work/repo/ \; 2>/dev/null || true
  # Also copy index and signing artifacts if present
  find /home/builder/packages -type f -name 'APKINDEX.tar.gz' -exec cp -v {} /work/repo/ \; 2>/dev/null || true
fi
if [ -f "/home/builder/.abuild/builder-6904805d.rsa.pub" ]; then
  cp /home/builder/.abuild/builder-6904805d.rsa.pub /work/repo/packager.rsa.pub || true
fi

echo "✓ APK build completed successfully"