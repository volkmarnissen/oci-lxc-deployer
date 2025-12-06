#!/usr/bin/env sh
set -e

# Usage:
#   ./generate-ap.sh <pkgname> [path/to/<pkgname>.ini]
# INI example:
#   pkgname=modbus2mqtt
#   pkgver=0.16.57
#   pkgrel=0
#   pkgdesc=Modbus to MQTT bridge
#   url=https://github.com/modbus2mqtt/server
#   license=MIT
#   depends="nodejs npm s6-overlay git openssh-server"
#   makedepends="npm alpine-sdk shadow rsync py3-psutil make build-base linux-headers udev"
#   npmpackage=modbus2mqtt

PKGNAME="$1"
INI_FILE="$2"

if [ -z "$PKGNAME" ]; then
  echo "ERROR: pkgname required" >&2
  exit 1
fi

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
TPL_DIR="$BASE_DIR/apk-template"
OUT_DIR="$BASE_DIR/$PKGNAME"
ROOT_DIR="$BASE_DIR/../.."
ROOT_PACKAGE_JSON="$ROOT_DIR/package.json"
GIT_ORIGIN_URL=""
GIT_OWNER=""
GIT_REPO=""

# Defaults
PKGVER="0.0.1"
PKGREL="0"
PKGDESC="$PKGNAME package"
URL="https://example.com/$PKGNAME"
LICENSE="MIT"
DEPENDS="nodejs npm"
MAKEDEPENDS="npm alpine-sdk"
NPMPACKAGE="$PKGNAME"
POST_INSTALL_EXTRA=""
POST_NPM_SCRIPT=""

# Load INI if provided (robust parsing with spaces)
if [ -z "$INI_FILE" ] || [ ! -f "$INI_FILE" ]; then
  INI_FILE="$BASE_DIR/$PKGNAME.ini"
fi

if [ -n "$INI_FILE" ] && [ -f "$INI_FILE" ]; then
  while IFS='=' read -r key val; do
    # skip empty or comment lines
    [ -z "$key" ] && continue
    case "$key" in \#*) continue;; esac
    # strip optional surrounding double quotes
    sv="$val"
    case "$sv" in '"'*'"') sv="${sv#\"}"; sv="${sv%\"}";; esac
    case "$key" in
      pkgname)      PKGNAME="$sv";;
      pkgver)       PKGVER="$sv";;
      pkgrel)       PKGREL="$sv";;
      pkgdesc)      PKGDESC="$sv";;
      url)          URL="$sv";;
      license)      LICENSE="$sv";;
      depends)      DEPENDS="$sv";;
      makedepends)  MAKEDEPENDS="$sv";;
      npmpackage)   NPMPACKAGE="$sv";;
      app_dirs)     APP_DIRS="$sv";;
      app_dirs_owner) APP_DIRS_OWNER="$sv";;
      post_npm_script) POST_NPM_SCRIPT="$sv";;
    esac
  done < "$INI_FILE"
  # Fallback parsing if defaults remain (handles odd whitespace/BOM)
  case "$PKGVER" in 0.0.1)
    PKGVER="$(grep -E '^pkgver=' "$INI_FILE" | head -n1 | cut -d'=' -f2 | sed 's/^"\?//; s/"\?$//')" || PKGVER="0.0.1"
  esac
  case "$PKGREL" in 0)
    PKGREL="$(grep -E '^pkgrel=' "$INI_FILE" | head -n1 | cut -d'=' -f2 | sed 's/^"\?//; s/"\?$//')" || PKGREL="0"
  esac
  case "$PKGDESC" in "${PKGNAME} package")
    PKGDESC="$(grep -E '^pkgdesc=' "$INI_FILE" | head -n1 | cut -d'=' -f2- | sed 's/^"\?//; s/"\?$//')" || PKGDESC="${PKGNAME} package"
  esac
  case "$URL" in "https://example.com/$PKGNAME")
    URL="$(grep -E '^url=' "$INI_FILE" | head -n1 | cut -d'=' -f2- | sed 's/^"\?//; s/"\?$//')" || URL="https://example.com/$PKGNAME"
  esac
  case "$LICENSE" in MIT)
    LICENSE="$(grep -E '^license=' "$INI_FILE" | head -n1 | cut -d'=' -f2 | sed 's/^"\?//; s/"\?$//')" || LICENSE="MIT"
  esac
  case "$DEPENDS" in "nodejs npm")
    DEPENDS="$(grep -E '^depends=' "$INI_FILE" | head -n1 | cut -d'=' -f2- | sed 's/^"\?//; s/"\?$//')" || DEPENDS="nodejs npm"
  esac
  case "$MAKEDEPENDS" in "npm alpine-sdk")
    MAKEDEPENDS="$(grep -E '^makedepends=' "$INI_FILE" | head -n1 | cut -d'=' -f2- | sed 's/^"\?//; s/"\?$//')" || MAKEDEPENDS="npm alpine-sdk"
  esac
  case "$NPMPACKAGE" in "$PKGNAME")
    NPMPACKAGE="$(grep -E '^npmpackage=' "$INI_FILE" | head -n1 | cut -d'=' -f2 | sed 's/^"\?//; s/"\?$//')" || NPMPACKAGE="$PKGNAME"
  esac
fi
# Render optional post-install extras from INI (app directories)
if [ -n "$APP_DIRS" ]; then
  # default owner if not provided
  [ -n "$APP_DIRS_OWNER" ] || APP_DIRS_OWNER="${PKGNAME}:dialout"
  POST_INSTALL_EXTRA=""
  POST_INSTALL_EXTRA="$POST_INSTALL_EXTRA\n# App-specific directories from INI"
  POST_INSTALL_EXTRA="$POST_INSTALL_EXTRA\nfor d in $APP_DIRS; do mkdir -p \"\$d\"; done"
  POST_INSTALL_EXTRA="$POST_INSTALL_EXTRA\nchown -R $APP_DIRS_OWNER $APP_DIRS 2>/dev/null || true"
  POST_INSTALL_EXTRA="$POST_INSTALL_EXTRA\nchmod -R 755 $APP_DIRS"
fi

# Override pkgver from root package.json (if present)
if [ -f "$ROOT_PACKAGE_JSON" ]; then
  # Extract version value from root package.json robustly (no jq, POSIX tools)
  PKGVER_FROM_ROOT="$(awk -F '"' '/"version"/ { for (i=1; i<=NF; i++) if ($i=="version") { print $(i+2); exit } }' "$ROOT_PACKAGE_JSON" | sed 's/[[:space:]]//g' | sed 's/,\?$//')"
  if [ -n "$PKGVER_FROM_ROOT" ]; then
    PKGVER="$PKGVER_FROM_ROOT"
  fi
fi

# Derive npm scope from git origin if repository is not modbus2mqtt
if command -v git >/dev/null 2>&1; then
  if GIT_ORIGIN_URL=$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null); then
    case "$GIT_ORIGIN_URL" in
      *github.com*)
        # Handle URLs like https://github.com/owner/repo.git or git@github.com:owner/repo.git
        GIT_PATH=$(printf '%s' "$GIT_ORIGIN_URL" | sed -E 's#^git@github.com:##; s#^https?://github.com/##; s#\.git$##')
        GIT_OWNER=$(printf '%s' "$GIT_PATH" | cut -d'/' -f1)
        GIT_REPO=$(printf '%s' "$GIT_PATH" | cut -d'/' -f2)
        ;;
    esac
    if [ -n "$GIT_OWNER" ] && [ -n "$GIT_REPO" ]; then
      case "$GIT_REPO" in
        modbus2mqtt)
          : # keep NPMPACKAGE as-is
          ;;
        *)
          # Prefer scoped npm package name @owner/pkgname
          NPMPACKAGE="@${GIT_OWNER}/${PKGNAME}"
          ;;
      esac
    fi
  fi
fi

echo "Generating APK package skeleton for '$PKGNAME'..."
mkdir -p "$OUT_DIR"

# Copy template files directory
mkdir -p "$OUT_DIR/files"
cp "$TPL_DIR/files"/*.in "$OUT_DIR/files/"

# Render service files ahead of time (avoid sed in APKBUILD)
sed "s/@PKGNAME@/$PKGNAME/g" "$TPL_DIR/files/service.initd.in" > "$OUT_DIR/files/service.initd"
sed "s/@PKGNAME@/$PKGNAME/g" "$TPL_DIR/files/service.confd.in" > "$OUT_DIR/files/service.confd"
chmod +x "$OUT_DIR/files/service.initd"

# Render APKBUILD from template
sed \
  -e "s/@PKGNAME@/$PKGNAME/g" \
  -e "s/@PKGVER@/$PKGVER/g" \
  -e "s/@PKGREL@/$PKGREL/g" \
  -e "s/@PKGDESC@/$(printf '%s' "$PKGDESC" | sed 's/[&/]/\\&/g')/g" \
  -e "s/@URL@/$(printf '%s' "$URL" | sed 's/[&/]/\\&/g')/g" \
  -e "s/@LICENSE@/$LICENSE/g" \
  -e "s/@DEPENDS@/$(printf '%s' "$DEPENDS" | sed 's/[&/]/\\&/g')/g" \
  -e "s/@MAKEDEPENDS@/$(printf '%s' "$MAKEDEPENDS" | sed 's/[&/]/\\&/g')/g" \
  -e "s/@NPMPACKAGE@/$(printf '%s' "$NPMPACKAGE" | sed 's/[&/]/\\&/g')/g" \
  -e "s|@POST_INSTALL_EXTRA@|$(printf '%s' "$POST_INSTALL_EXTRA" | sed 's/[|&]/\\&/g')|g" \
  -e "s|@POST_NPM_SCRIPT@|$(printf '%s' "$POST_NPM_SCRIPT" | sed 's/[|&]/\\&/g')|g" \
  "$TPL_DIR/APKBUILD.in" > "$OUT_DIR/APKBUILD"

  # Render pre-install with @PKGNAME@
  sed "s/@PKGNAME@/$PKGNAME/g" "$TPL_DIR/files/pre-install.in" > "$OUT_DIR/$PKGNAME.pre-install"

  # Render post-install with @PKGNAME@ and inject optional POST_INSTALL_EXTRA as multiline
  {
    while IFS= read -r line; do
      case "$line" in
        *"@POST_INSTALL_EXTRA@"*)
          if [ -n "$POST_INSTALL_EXTRA" ]; then
            printf '%s\n' "$POST_INSTALL_EXTRA"
          fi
          ;;
        *)
          printf '%s\n' "$(printf '%s' "$line" | sed "s/@PKGNAME@/$PKGNAME/g")"
          ;;
      esac
    done < "$TPL_DIR/files/post-install.in"
  } > "$OUT_DIR/$PKGNAME.post-install"

  chmod +x "$OUT_DIR/$PKGNAME.pre-install" "$OUT_DIR/$PKGNAME.post-install"

echo "Done. Package dir: $OUT_DIR"
echo "Next steps:"
echo "  - Edit $OUT_DIR/APKBUILD if needed"
echo "  - Run 'abuild -r' inside $OUT_DIR to build"
