#!/bin/sh
# Bind multiple host directories to an LXC container
#
# This script binds multiple volumes to an LXC container by:
# 1. Parsing volumes (key=value format, one per line)
# 2. Creating host directories under <base_path>/<hostname>/<key>
# 3. Creating bind mounts from host to container paths
# 4. Setting proper ownership and permissions
#
# Requires:
#   - vm_id: LXC container ID (from context)
#   - hostname: Container hostname (from context)
#   - volumes: Volume mappings in key=value format, one per line (required)
#   - base_path: Base path for host directories (optional)
#   - host_mountpoint: Host mountpoint base (optional)
#   - username: Username for ownership (optional)
#   - uid: User ID (optional)
#   - gid: Group ID (optional)
#
# Script is idempotent and can be run multiple times safely.
#
# Output: JSON to stdout (errors to stderr)

VMID="{{ vm_id}}"
HOSTNAME="{{ hostname}}"
HOST_MOUNTPOINT="{{ host_mountpoint}}"
BASE_PATH="{{ base_path}}"
VOLUMES="{{ volumes}}"
USERNAME="{{ username}}"
UID_VALUE="{{ uid}}"
GID_VALUE="{{ gid}}"
MAPPED_UID="{{ mapped_uid}}"
MAPPED_GID="{{ mapped_gid}}"

# Check that required parameters are not empty
if [ -z "$VMID" ] || [ -z "$HOSTNAME" ]; then
  echo "Error: Required parameters (vm_id, hostname) must be set and not empty!" >&2
  exit 1
fi

if [ -z "$VOLUMES" ]; then
  echo "Error: Required parameter 'volumes' must be set and not empty!" >&2
  exit 1
fi

# Set default base_path if not provided
if [ -z "$BASE_PATH" ] || [ "$BASE_PATH" = "" ]; then
  BASE_PATH="volumes"
fi

# Use mapped UID/GID if provided, otherwise fall back to uid/gid parameters
if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "" ]; then
  UID_VALUE="$MAPPED_UID"
fi
if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "" ]; then
  GID_VALUE="$MAPPED_GID"
fi

# Construct the full host path: <host_mountpoint>/<base_path>/<hostname>
# If host_mountpoint is not set, use /mnt/<base_path>/<hostname>
if [ -n "$HOST_MOUNTPOINT" ] && [ "$HOST_MOUNTPOINT" != "" ]; then
  HOST_PATH="$HOST_MOUNTPOINT/$BASE_PATH/$HOSTNAME"
else
  HOST_PATH="/mnt/$BASE_PATH/$HOSTNAME"
fi

# Create base path if it doesn't exist
if [ ! -d "$(dirname "$HOST_PATH")" ]; then
  mkdir -p "$(dirname "$HOST_PATH")" >&2
fi

# Create hostname-specific directory if it doesn't exist
if [ ! -d "$HOST_PATH" ]; then
  mkdir -p "$HOST_PATH" >&2
fi

# Helper function: Is container running?
container_running() {
  pct status "$VMID" 2>/dev/null | grep -q 'status: running'
}

# Helper function: Find next free mpX
find_next_mp() {
  USED=$(pct config "$VMID" | grep '^mp' | cut -d: -f1 | sed 's/mp//')
  for i in $(seq 0 9); do
    if ! echo "$USED" | grep -qw "$i"; then
      echo "mp$i"
      return 0
    fi
  done
  echo ""
}

# Check if container needs to be stopped
WAS_RUNNING=0
if container_running; then
  WAS_RUNNING=1
fi

# Track if we need to stop the container
NEEDS_STOP=0

# Process volumes: split by newlines and process each line
# Use a temporary file to avoid subshell issues
TMPFILE=$(mktemp)
echo "$VOLUMES" > "$TMPFILE"

VOLUME_COUNT=0
while IFS= read -r line <&3; do
  # Skip empty lines
  [ -z "$line" ] && continue
  
  # Parse format: key=value or key=value,permissions
  VOLUME_KEY=$(echo "$line" | cut -d'=' -f1)
  VOLUME_REST=$(echo "$line" | cut -d'=' -f2-)
  
  # Check if permissions are specified (comma-separated)
  if echo "$VOLUME_REST" | grep -q ','; then
    VOLUME_VALUE=$(echo "$VOLUME_REST" | cut -d',' -f1)
    VOLUME_PERMS=$(echo "$VOLUME_REST" | cut -d',' -f2)
  else
    VOLUME_VALUE="$VOLUME_REST"
    VOLUME_PERMS="0755"  # Default permissions
  fi
  
  # Skip if key or value is empty
  [ -z "$VOLUME_KEY" ] && continue
  [ -z "$VOLUME_VALUE" ] && continue
  
  # Construct paths: <base_path>/<hostname>/<volume-key>
  SOURCE_PATH="$HOST_PATH/$VOLUME_KEY"
  CONTAINER_PATH="/$VOLUME_VALUE"
  
  # Create source directory if it doesn't exist
  if [ ! -d "$SOURCE_PATH" ]; then
    mkdir -p "$SOURCE_PATH" >&2
  fi
  
  # Set permissions on the source directory if uid/gid are provided
  # For unprivileged containers with 1:1 UID mapping (via setup-lxc-uid-mapping.py),
  # the container UID maps directly to the host UID (no offset calculation needed).
  # UID_VALUE should already contain the correct host UID from mapped_uid parameter.
  if [ -n "$UID_VALUE" ] && [ -n "$GID_VALUE" ] && [ "$UID_VALUE" != "" ] && [ "$GID_VALUE" != "" ]; then
    # Set ownership recursively with the provided UID/GID
    # For 1:1 mapping: Container UID N → Host UID N (direct mapping)
    if chown -R "$UID_VALUE:$GID_VALUE" "$SOURCE_PATH" 2>/dev/null; then
      echo "Set ownership of $SOURCE_PATH (recursively) to $UID_VALUE:$GID_VALUE" >&2
    else
      echo "Warning: Failed to set ownership of $SOURCE_PATH to $UID_VALUE:$GID_VALUE" >&2
    fi
    # Set permissions recursively with configured value
    if chmod -R "$VOLUME_PERMS" "$SOURCE_PATH" 2>/dev/null; then
      echo "Set permissions of $SOURCE_PATH (recursively) to $VOLUME_PERMS" >&2
    else
      echo "Warning: Failed to set permissions of $SOURCE_PATH to $VOLUME_PERMS" >&2
    fi
  fi
  
  # Check if mount already exists
  if pct config "$VMID" | grep -a -q "mp[0-9]*: $SOURCE_PATH,mp=$CONTAINER_PATH"; then
    echo "Mount $SOURCE_PATH -> $CONTAINER_PATH already exists, skipping." >&2
    continue
  fi
  
  # Stop container if needed (only once, before first mount)
  if [ "$NEEDS_STOP" -eq 0 ] && container_running; then
    pct stop "$VMID" >&2
    NEEDS_STOP=1
  fi
  
  # Find next free mountpoint
  MP=$(find_next_mp)
  if [ -z "$MP" ]; then
    echo "Error: No free mountpoint available (mp0-mp9 all in use)" >&2
    rm -f "$TMPFILE"
    exit 1
  fi
  
  # Set up bind mount
  MOUNT_OPTIONS="$SOURCE_PATH,mp=$CONTAINER_PATH"
  if ! pct set "$VMID" -$MP "$MOUNT_OPTIONS" >&2; then
    echo "Error: Failed to set mount point $MP in container $VMID" >&2
    rm -f "$TMPFILE"
    exit 1
  fi
  
  echo "Bound $SOURCE_PATH to $CONTAINER_PATH in container $VMID" >&2
  VOLUME_COUNT=$((VOLUME_COUNT + 1))
done 3< "$TMPFILE"
rm -f "$TMPFILE"

# Restart container if it was running before
if [ "$WAS_RUNNING" -eq 1 ]; then
  # Container was running and we may have stopped it, restart it
  if ! pct start "$VMID" >&2; then
    echo "Error: Failed to restart container $VMID" >&2
    exit 1
  fi
fi

# Note: Permissions are set on the host with mapped UID/GID (UID + 100000, GID + 100000)
# This is because we use standard Proxmox mapping where Container UID N → Host UID (100000 + N)
# No need to set permissions inside the container as they are already correct on the host

echo "Successfully processed volumes for container $VMID" >&2
exit 0

