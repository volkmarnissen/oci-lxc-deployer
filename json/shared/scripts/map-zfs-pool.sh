#!/bin/sh
#
# map-zfs-pool.sh: Maps a ZFS pool to a running LXC container as a bind mount.
#
# - Stops the container if running
# - Finds the next free mountpoint (mpX)
# - Gets the ZFS pool mountpoint (pool is already mounted in Proxmox)
# - Creates a subdirectory under the pool mountpoint for the container
# - Sets permissions (uid/gid)
# - Adds the bind mount to the container config (pct set)
# - Restarts the container if it was running before
#
# All output is sent to stderr. Script is idempotent and can be run multiple times safely.

VMID="{{ vm_id}}"
STORAGE_SELECTION="{{ storage_selection}}"
MOUNTPOINT="{{ mountpoint}}"
UID_VALUE="{{ uid}}"
GID_VALUE="{{ gid}}"

# Check that required parameters are not empty
if [ -z "$VMID" ] || [ -z "$STORAGE_SELECTION" ] || [ -z "$MOUNTPOINT" ]; then
  echo "Error: Required parameters (vm_id, storage_selection, mountpoint) must be set and not empty!" >&2
  exit 1
fi

# Parse storage selection: must be zfs:...
# If not zfs:, this template is not responsible - skip silently
if ! echo "$STORAGE_SELECTION" | grep -q "^zfs:"; then
  echo "Note: This is not a ZFS pool selection (expected 'zfs:...'), skipping map-zfs-pool." >&2
  exit 0
fi

POOL_NAME=$(echo "$STORAGE_SELECTION" | sed 's/^zfs://')

# Check if zpool command is available
if ! command -v zpool >/dev/null 2>&1; then
  echo "Error: zpool command not found. ZFS tools are required." >&2
  exit 1
fi

# Check if zfs command is available
if ! command -v zfs >/dev/null 2>&1; then
  echo "Error: zfs command not found. ZFS tools are required." >&2
  exit 1
fi

# Helper function: Is container running?
container_running() {
  pct status "$VMID" 2>/dev/null | grep -q 'status: running'
}

# 1. Check if the desired mount (host and container path) is already present in the container config
if pct config "$VMID" | grep -q "mp[0-9]*: $MOUNTPOINT,mp=$MOUNTPOINT"; then
  echo "Mount $MOUNTPOINT is already mapped in container $VMID, skipping." >&2
  exit 0
fi

# 2. Verify that the ZFS pool exists
if ! zpool list "$POOL_NAME" >/dev/null 2>&1; then
  echo "Error: ZFS pool '$POOL_NAME' not found!" >&2
  exit 1
fi

# 3. Only stop the container if the mount does not exist yet
WAS_RUNNING=0
if container_running; then
  WAS_RUNNING=1
  pct stop "$VMID" 1>&2
fi

# 4. Find next free mpX
USED=$(pct config "$VMID" | grep '^mp' | cut -d: -f1 | sed 's/mp//')
for i in $(seq 0 9); do
  if ! echo "$USED" | grep -qw "$i"; then
    MP="mp$i"
    break
  fi
done

# 5. Get current mountpoint of the ZFS pool
POOL_MOUNTPOINT=$(zfs get -H -o value mountpoint "$POOL_NAME" 2>/dev/null || echo "")

# 6. Verify pool is mounted (should always be in Proxmox)
if [ "$POOL_MOUNTPOINT" = "none" ] || [ "$POOL_MOUNTPOINT" = "-" ]; then
  echo "Error: ZFS pool '$POOL_NAME' is not mounted. In Proxmox, pools should always be mounted." >&2
  exit 1
fi

# 7. Verify the pool mountpoint exists
if [ ! -d "$POOL_MOUNTPOINT" ]; then
  echo "Error: ZFS pool mountpoint '$POOL_MOUNTPOINT' does not exist!" >&2
  exit 1
fi

# 8. Create subdirectory under pool mountpoint for this container
# The mountpoint parameter specifies where it should be mounted in the container
# We create a directory under the pool mountpoint on the host
# Use the last component of the mountpoint path as directory name
# e.g., /mnt/backup -> backup, /mnt/zfs -> zfs
SUBDIR_NAME=$(echo "$MOUNTPOINT" | sed 's|^/||' | awk -F'/' '{print $NF}')
if [ -z "$SUBDIR_NAME" ] || [ "$SUBDIR_NAME" = "" ]; then
  # Fallback: use container ID if mountpoint is just "/"
  SUBDIR_NAME="container-${VMID}"
fi
CONTAINER_DIR="$POOL_MOUNTPOINT/$SUBDIR_NAME"

echo "Creating directory $CONTAINER_DIR under ZFS pool mountpoint..." >&2
mkdir -p "$CONTAINER_DIR" >&2

# 9. Set permissions on the container directory if uid/gid are provided
if [ -n "$UID_VALUE" ] && [ -n "$GID_VALUE" ] && [ "$UID_VALUE" != "" ] && [ "$GID_VALUE" != "" ]; then
  chown "$UID_VALUE:$GID_VALUE" "$CONTAINER_DIR" >&2
fi

# 10. Set up bind-mount in container only if not already present
# Bind mount the container directory to the mountpoint inside the container
# Note: uid/gid options are not supported by pct set for mount points
# Permissions are set via chown on the host directory (step 9)
if ! pct config "$VMID" | grep -q "^$MP:"; then
  MOUNT_OPTIONS="$CONTAINER_DIR,mp=$MOUNTPOINT"
  if ! pct set "$VMID" -$MP "$MOUNT_OPTIONS" >&2; then
    echo "Error: Failed to set mount point $MP in container $VMID" >&2
    exit 1
  fi
fi

# 11. Restart container if it was running before
if [ "$WAS_RUNNING" -eq 1 ]; then
  if ! pct start "$VMID" >&2; then
    echo "Error: Failed to restart container $VMID" >&2
    exit 1
  fi
fi

echo "ZFS pool $POOL_NAME successfully mapped to container $VMID: $CONTAINER_DIR -> $MOUNTPOINT" >&2
exit 0

