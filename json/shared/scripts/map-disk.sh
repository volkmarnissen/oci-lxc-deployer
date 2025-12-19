#!/bin/sh
#
# map-disk.sh: Maps a block device (by UUID) to a running LXC container as a bind mount.
#
# - Stops the container if running
# - Finds the next free mountpoint (mpX)
# - Mounts the device to the given mountpoint on the host (without fstab, with nofail)
# - Sets permissions (uid/gid)
# - Adds the bind mount to the container config (pct set)
# - Restarts the container if it was running before
#
# All output is sent to stderr. Script is idempotent and can be run multiple times safely.

VMID="{{ vm_id}}"
STORAGE_SELECTION="{{ storage_selection}}"
MOUNTPOINT="{{ mountpoint}}"
UID="{{ uid}}"
GID="{{ gid}}"

# Check that all parameters are not empty
if [ -z "$VMID" ] || [ -z "$STORAGE_SELECTION" ] || [ -z "$MOUNTPOINT" ] || [ -z "$UID" ] || [ -z "$GID" ]; then
  echo "Error: All parameters (vm_id, storage_selection, mountpoint, uid, gid) must be set and not empty!" >&2
  exit 1
fi

# Parse storage selection: uuid:... or zfs:...
if echo "$STORAGE_SELECTION" | grep -q "^uuid:"; then
  UUID=$(echo "$STORAGE_SELECTION" | sed 's/^uuid://')
  STORAGE_TYPE="uuid"
elif echo "$STORAGE_SELECTION" | grep -q "^zfs:"; then
  POOL_NAME=$(echo "$STORAGE_SELECTION" | sed 's/^zfs://')
  STORAGE_TYPE="zfs"
else
  echo "Error: Invalid storage selection format. Must start with 'uuid:' or 'zfs:'" >&2
  exit 1
fi

# For ZFS pools, redirect to zfs pool mapping (this should not happen if UI filters correctly)
if [ "$STORAGE_TYPE" = "zfs" ]; then
  echo "Error: ZFS pools should be mapped using the map-zfs-pool template, not map-disk." >&2
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

# 2. Only stop the container if the mount does not exist yet
WAS_RUNNING=0
if container_running; then
  WAS_RUNNING=1
  pct stop "$VMID" 1>&2
fi


# 3. Find next free mpX
USED=$(pct config "$VMID" | grep '^mp' | cut -d: -f1 | sed 's/mp//')
for i in $(seq 0 9); do
  if ! echo "$USED" | grep -qw "$i"; then
    MP="mp$i"
    break
  fi
done

# 4. Find device name by UUID
DEV=$(blkid -U "$UUID")
if [ -z "$DEV" ]; then
  echo "Device with UUID $UUID not found!" >&2
  exit 1
fi

# 5. Create mountpoint on host
mkdir -p "$MOUNTPOINT"


# 6. Mount disk (without fstab, with nofail) only if not already mounted
if ! mountpoint -q "$MOUNTPOINT" || ! mount | grep -q "on $MOUNTPOINT "; then
  mount -o nofail "$DEV" "$MOUNTPOINT" 1>&2
  if [ $? -ne 0 ]; then
    echo "Mounting $DEV to $MOUNTPOINT failed!" >&2
    exit 1
  fi
fi

# 7. Set permissions
chown "$UID:$GID" "$MOUNTPOINT" 1>&2


# 8. Set up bind-mount in container only if not already present
if ! pct config "$VMID" | grep -q "^$MP:"; then
  pct set "$VMID" -$MP "$MOUNTPOINT,mp=$MOUNTPOINT,uid=$UID,gid=$GID" 1>&2
fi

# 9. Restart container if it was running before
if [ "$WAS_RUNNING" -eq 1 ]; then
  pct start "$VMID" 1>&2
fi
