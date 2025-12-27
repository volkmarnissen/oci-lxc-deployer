#!/bin/sh
# Map serial device to LXC container
# Requires: usb_bus_device in format bus:device
exec >&2

# Check required parameters
if [ -z "{{ usb_bus_device }}" ] || [ "{{ usb_bus_device }}" = "" ]; then
  echo "Error: usb_bus_device parameter is required (format: bus:device)" >&2
  exit 1
fi

# Parse bus:device format
USB_BUS_DEVICE="{{ usb_bus_device }}"
USB_BUS=$(echo "$USB_BUS_DEVICE" | cut -d':' -f1)
USB_DEVICE=$(echo "$USB_BUS_DEVICE" | cut -d':' -f2)

if [ -z "$USB_BUS" ] || [ -z "$USB_DEVICE" ]; then
  echo "Error: usb_bus_device must be in format bus:device (e.g., 1:3)" >&2
  echo "Debug: USB_BUS_DEVICE='$USB_BUS_DEVICE', USB_BUS='$USB_BUS', USB_DEVICE='$USB_DEVICE'" >&2
  exit 1
fi

# Construct USB bus path
BUS_FORMATTED=$(printf "%03d" "$USB_BUS")
DEV_FORMATTED=$(printf "%03d" "$USB_DEVICE")
USB_BUS_PATH="/dev/bus/usb/$BUS_FORMATTED/$DEV_FORMATTED"
USB_BUS_RELATIVE=$(echo "$USB_BUS_PATH" | sed 's|^/||')

if [ ! -e "$USB_BUS_PATH" ]; then
  echo "Error: USB bus path $USB_BUS_PATH does not exist" >&2
  echo "Debug: USB_BUS=$USB_BUS, USB_DEVICE=$USB_DEVICE" >&2
  exit 1
fi
echo "Debug: USB_BUS_PATH=$USB_BUS_PATH exists" >&2

# Find tty device associated with this USB bus/device
# USB devices in sysfs can have format: bus-device or bus-device:interface
SYSFS_BASE="/sys/bus/usb/devices"
SYSFS_PATTERN="$USB_BUS-$USB_DEVICE"
echo "Debug: Parsed USB_BUS=$USB_BUS, USB_DEVICE=$USB_DEVICE, SYSFS_PATTERN=$SYSFS_PATTERN" >&2

ACTUAL_HOST_DEVICE=""
# Search in sysfs for tty devices (check base path and all interface paths)
# First try base path
SYSFS_BASE_PATH="$SYSFS_BASE/$SYSFS_PATTERN"
if [ -d "$SYSFS_BASE_PATH" ]; then
  for TTY_DIR in "$SYSFS_BASE_PATH"/*/tty* "$SYSFS_BASE_PATH"/tty*; do
    [ ! -d "$TTY_DIR" ] && continue
    TTY_NAME=$(basename "$TTY_DIR")
    if [ -e "/dev/$TTY_NAME" ]; then
      ACTUAL_HOST_DEVICE="/dev/$TTY_NAME"
      break
    fi
  done
fi
# Then try all interface paths (e.g., 1-2:1.0, 1-2:1.1, etc.)
# Note: Wildcard must be outside quotes to expand
if [ -z "$ACTUAL_HOST_DEVICE" ]; then
  for SYSFS_PATH in $SYSFS_BASE/$SYSFS_PATTERN:*; do
    [ ! -d "$SYSFS_PATH" ] && continue
    for TTY_DIR in "$SYSFS_PATH"/*/tty* "$SYSFS_PATH"/tty*; do
      [ ! -d "$TTY_DIR" ] && continue
      TTY_NAME=$(basename "$TTY_DIR")
      if [ -e "/dev/$TTY_NAME" ]; then
        ACTUAL_HOST_DEVICE="/dev/$TTY_NAME"
        break 2
      fi
    done
  done
fi

if [ -z "$ACTUAL_HOST_DEVICE" ] || [ ! -e "$ACTUAL_HOST_DEVICE" ]; then
  echo "Error: Could not find tty device for USB bus $USB_BUS device $USB_DEVICE" >&2
  echo "Debug: USB_BUS_PATH=$USB_BUS_PATH" >&2
  echo "Debug: Searching in $SYSFS_BASE/$SYSFS_PATTERN*" >&2
  FOUND_ANY=0
  if [ -d "$SYSFS_BASE/$SYSFS_PATTERN" ]; then
    FOUND_ANY=1
    echo "Debug: Found base directory $SYSFS_BASE/$SYSFS_PATTERN" >&2
    ls -la "$SYSFS_BASE/$SYSFS_PATTERN" >&2 || true
  fi
  for SYSFS_PATH in $SYSFS_BASE/$SYSFS_PATTERN:*; do
    if [ -d "$SYSFS_PATH" ]; then
      FOUND_ANY=1
      echo "Debug: Found interface directory $SYSFS_PATH" >&2
      echo "Debug: Contents:" >&2
      ls -la "$SYSFS_PATH" >&2 || true
      echo "Debug: Searching for tty* in subdirectories:" >&2
      for TTY_DIR in "$SYSFS_PATH"/*/tty* "$SYSFS_PATH"/tty*; do
        [ -d "$TTY_DIR" ] && echo "Debug: Found tty directory: $TTY_DIR" >&2 || true
      done
    fi
  done
  [ $FOUND_ANY -eq 0 ] && echo "Debug: No matching sysfs directories found" >&2
  exit 1
fi

# Get container UID/GID (default 1000)
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
CONTAINER_UID="${UID_VALUE:-1000}"
CONTAINER_GID="${GID_VALUE:-1000}"

CONFIG_FILE="/etc/pve/lxc/{{ vm_id }}.conf"

# Container must be stopped for configuration changes
if pct status {{ vm_id }} 2>&1 | grep -q 'status: running'; then
  echo "Error: Container {{ vm_id }} is running. Please stop it before mapping devices." >&2
  exit 1
fi

# Remove existing entries
sed -i '/^mp0:/d; /^dev0:/d' "$CONFIG_FILE"

# Helper function to add cgroup allow entry
add_cgroup_allow() {
  DEVICE="$1"
  STAT_OUTPUT=$(stat -c "%t %T" "$DEVICE" 2>/dev/null || echo "")
  [ -z "$STAT_OUTPUT" ] && return
  MAJOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $1}')))
  MINOR=$((0x$(echo "$STAT_OUTPUT" | awk '{print $2}')))
  if ! grep -q "^lxc.cgroup2.devices.allow = c $MAJOR:$MINOR" "$CONFIG_FILE" 2>/dev/null; then
    echo "lxc.cgroup2.devices.allow = c $MAJOR:$MINOR rwm" >> "$CONFIG_FILE"
  fi
}

# Add cgroup allow entries and device mappings
add_cgroup_allow "$ACTUAL_HOST_DEVICE"
echo "dev0: $ACTUAL_HOST_DEVICE,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0664" >> "$CONFIG_FILE"

add_cgroup_allow "$USB_BUS_PATH"
sed -i "/lxc.mount.entry.*dev\/bus\/usb/d" "$CONFIG_FILE"
echo "lxc.mount.entry = $USB_BUS_PATH $USB_BUS_RELATIVE none bind,optional,create=file,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0664" >> "$CONFIG_FILE"

# Set permissions on USB bus device
MAPPED_UID=$((CONTAINER_UID + 100000))
MAPPED_GID=$((CONTAINER_GID + 100000))
chown "$MAPPED_UID:$MAPPED_GID" "$USB_BUS_PATH" 2>/dev/null || true
chmod 664 "$USB_BUS_PATH" 2>/dev/null || true

# Create udev rule for automatic permissions on reconnect
if command -v udevadm >/dev/null 2>&1; then
  # Find base sysfs path (without interface suffix) for vendor/product ID lookup
  SYSFS_BASE_PATH=""
  for SYSFS_PATH in "$SYSFS_BASE/$SYSFS_PATTERN" "$SYSFS_BASE/$SYSFS_PATTERN:"*; do
    if [ -d "$SYSFS_PATH" ] && [ -f "$SYSFS_PATH/idVendor" ]; then
      SYSFS_BASE_PATH="$SYSFS_PATH"
      break
    fi
  done
  # Extract vendor/product ID from sysfs path or device
  if [ -n "$SYSFS_BASE_PATH" ]; then
    VENDOR_ID=$(udevadm info --path="$SYSFS_BASE_PATH" --attribute-walk 2>/dev/null | grep -i "ATTRS{idVendor}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' || echo "")
    PRODUCT_ID=$(udevadm info --path="$SYSFS_BASE_PATH" --attribute-walk 2>/dev/null | grep -i "ATTRS{idProduct}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' || echo "")
  fi
  [ -z "$VENDOR_ID" ] && VENDOR_ID=$(udevadm info --name="$ACTUAL_HOST_DEVICE" --attribute-walk 2>/dev/null | grep -i "ATTRS{idVendor}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' || echo "")
  [ -z "$PRODUCT_ID" ] && PRODUCT_ID=$(udevadm info --name="$ACTUAL_HOST_DEVICE" --attribute-walk 2>/dev/null | grep -i "ATTRS{idProduct}" | head -n1 | sed 's/.*=="\([^"]*\)".*/\1/' || echo "")
  
  if [ -n "$VENDOR_ID" ] && [ -n "$PRODUCT_ID" ]; then
    RULE_FILE="/etc/udev/rules.d/99-lxc-serial-{{ vm_id }}-${VENDOR_ID}-${PRODUCT_ID}.rules"
    # Rule for tty device
    echo "SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"$VENDOR_ID\", ATTRS{idProduct}==\"$PRODUCT_ID\", MODE=\"0664\", OWNER=\"$MAPPED_UID\", GROUP=\"$MAPPED_GID\"" > "$RULE_FILE"
    # Rule for USB bus device
    echo "SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"$VENDOR_ID\", ATTRS{idProduct}==\"$PRODUCT_ID\", MODE=\"0664\", OWNER=\"$MAPPED_UID\", GROUP=\"$MAPPED_GID\"" >> "$RULE_FILE"
    udevadm control --reload-rules >&2
    udevadm trigger --subsystem-match=tty --attr-match=idVendor="$VENDOR_ID" --attr-match=idProduct="$PRODUCT_ID" >&2
    udevadm trigger --subsystem-match=usb --attr-match=idVendor="$VENDOR_ID" --attr-match=idProduct="$PRODUCT_ID" >&2
  fi
fi

exit 0

