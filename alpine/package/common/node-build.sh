#!/bin/sh

# Generic helper: rebuild native Node modules for target arch inside abuild env
# Usage: node_rebuild_native <builddir>

node_rebuild_native() {
  builddir="$1"
  [ -n "$builddir" ] || {
    echo "ERROR: node_rebuild_native requires <builddir>" >&2
    return 1
  }
  cd "$builddir" || return 1

  # Remove prebuilt binaries first to force rebuild from source
  find node_modules -type d -name "prebuilds" -prune -print -exec rm -rf '{}' + || true

  echo "Installing build tools..."
  build_log=$(mktemp)
  if ! npm install --save-dev node-gyp node-gyp-build >"$build_log" 2>&1; then
    echo "WARNING: Failed to install build tools" >&2
    cat "$build_log" >&2
  fi
  rm -f "$build_log"

  # Rebuild all native modules from source for target architecture
  find node_modules -name "binding.gyp" -type f | while read -r gyp_file; do
    module_dir=$(dirname "$gyp_file")
    module_name=$(basename "$module_dir")
    echo "Rebuilding native module: $module_name"
    cd "$module_dir" || continue
    log_file=$(mktemp)
    if ! node-gyp rebuild >"$log_file" 2>&1; then
      echo "WARNING: Failed to rebuild $module_name" >&2
      cat "$log_file" >&2
    fi
    rm -f "$log_file"
    cd "$builddir" || return 1
  done

  echo "Cleaning up build tools..."
  npm uninstall node-gyp node-gyp-build >/dev/null 2>&1 || true
}

export -f node_rebuild_native 2>/dev/null || true
