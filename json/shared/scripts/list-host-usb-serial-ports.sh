#!/bin/sh
# List all USB serial ports on the VE host
# Outputs JSON array of objects with name and value for enumValues
# Format: [{"name":"descriptive name from lsusb","value":"/dev/serial/by-id/..."}, ...]
# The name is built from lsusb output, e.g. "ID 1a86:7523 QinHeng Electronics CH340 serial converter"
# Uses /dev/serial/by-id/ paths which are stable across re-plugging

set -e

# Check if lsusb is available
if ! command -v lsusb >/dev/null 2>&1; then
  echo "Error: lsusb command not found. This script requires lsusb to list USB devices." >&2
  exit 1
fi

# Check if we can access USB devices
if [ ! -d "/dev" ]; then
  echo "Error: Cannot access /dev directory." >&2
  exit 1
fi

# Check if /dev/serial/by-id exists
if [ ! -d "/dev/serial/by-id" ]; then
  echo "Error: /dev/serial/by-id directory not found. USB serial devices may not be available." >&2
  exit 1
fi

# Get USB serial device information
# We'll use /dev/serial/by-id/ which provides stable paths
FIRST=true
printf '['

# Process all devices in /dev/serial/by-id/
for SERIAL_LINK in /dev/serial/by-id/*; do
  # Skip if no devices found (glob expansion)
  if [ ! -e "$SERIAL_LINK" ]; then
    continue
  fi
  
  # Get the actual device path (resolve symlink)
  ACTUAL_DEVICE=$(readlink -f "$SERIAL_LINK" 2>/dev/null || echo "")
  if [ -z "$ACTUAL_DEVICE" ] || [ ! -e "$ACTUAL_DEVICE" ]; then
    continue
  fi
  
  # Get the device name (e.g., ttyUSB0, ttyACM0)
  DEVICE_NAME=$(basename "$ACTUAL_DEVICE")
  
  # Try to find the USB device information via /sys/class/tty/
  VENDOR_ID=""
  PRODUCT_ID=""
  USB_INFO=""
  
  # Navigate from /sys/class/tty/ttyUSB0/device up to find USB device with idVendor/idProduct
  if [ -e "/sys/class/tty/$DEVICE_NAME/device" ]; then
    # Get the real device path (use readlink if available, otherwise use the link directly)
    if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
      DEVICE_LINK=$(readlink -f "/sys/class/tty/$DEVICE_NAME/device" 2>/dev/null || echo "")
    else
      # Fallback: resolve relative symlink manually
      DEVICE_LINK=$(readlink "/sys/class/tty/$DEVICE_NAME/device" 2>/dev/null || echo "")
      if [ -n "$DEVICE_LINK" ] && [ "${DEVICE_LINK#/}" = "$DEVICE_LINK" ]; then
        DEVICE_LINK="/sys/class/tty/$DEVICE_NAME/$DEVICE_LINK"
      fi
    fi
    
    if [ -n "$DEVICE_LINK" ]; then
      # Navigate up the directory tree to find USB device directory with idVendor/idProduct
      CURRENT_DIR="$DEVICE_LINK"
      MAX_LEVELS=10
      LEVEL=0
      
      while [ $LEVEL -lt $MAX_LEVELS ]; do
        if [ -f "$CURRENT_DIR/idVendor" ] && [ -f "$CURRENT_DIR/idProduct" ]; then
          VENDOR_ID=$(cat "$CURRENT_DIR/idVendor" 2>/dev/null | tr -d '\n\r' || echo "")
          PRODUCT_ID=$(cat "$CURRENT_DIR/idProduct" 2>/dev/null | tr -d '\n\r' || echo "")
          break
        fi
        PARENT_DIR=$(dirname "$CURRENT_DIR" 2>/dev/null || echo "")
        if [ "$PARENT_DIR" = "$CURRENT_DIR" ] || [ "$PARENT_DIR" = "/" ] || [ -z "$PARENT_DIR" ]; then
          break
        fi
        CURRENT_DIR="$PARENT_DIR"
        LEVEL=$((LEVEL + 1))
      done
      
      # If we found vendor/product IDs, find the specific USB device that matches this tty device
      USB_BUS=""
      USB_DEVICE=""
      USB_INFO=""
      if [ -n "$VENDOR_ID" ] && [ -n "$PRODUCT_ID" ]; then
        # Find USB device by matching vendor/product ID in /sys/bus/usb/devices/
        # This is more reliable than parsing complex sysfs paths
        for USB_DEVICE_PATH in /sys/bus/usb/devices/*; do
          [ ! -d "$USB_DEVICE_PATH" ] && continue
          # Check if this device matches our vendor/product ID
          DEV_VENDOR=$(cat "$USB_DEVICE_PATH/idVendor" 2>/dev/null | tr -d '\n\r' 2>/dev/null || echo "")
          DEV_PRODUCT=$(cat "$USB_DEVICE_PATH/idProduct" 2>/dev/null | tr -d '\n\r' 2>/dev/null || echo "")
          if [ "$DEV_VENDOR" = "$VENDOR_ID" ] && [ "$DEV_PRODUCT" = "$PRODUCT_ID" ]; then
            # Check if this USB device has our tty device
            DEVICE_BASENAME=$(basename "$USB_DEVICE_PATH")
            # Check base path and all interface paths (e.g., 1-3:1.0, 1-3:1.1)
            # First check base path
            for TTY_DIR in "$USB_DEVICE_PATH"/*/tty* "$USB_DEVICE_PATH"/tty*; do
              [ ! -d "$TTY_DIR" ] && continue
              TTY_FOUND=$(basename "$TTY_DIR")
              if [ "$TTY_FOUND" = "$DEVICE_NAME" ]; then
                  # Found matching device! Extract bus and device from path
                  # Path format: /sys/bus/usb/devices/1-3 or /sys/bus/usb/devices/1-3:1.0 or 1-3.4:1.0
                  # Extract bus (first number before -) and device (second number before : or .)
                  USB_BUS=$(echo "$DEVICE_BASENAME" | sed -n 's/^\([0-9]*\)-.*/\1/p' | sed 's/^0*//' || echo "")
                  USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)[.:].*/\1/p' | sed 's/^0*//' || echo "")
                  # If no : or . found, try without suffix
                  [ -z "$USB_DEVICE" ] && USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)$/\1/p' | sed 's/^0*//' || echo "")
                  break 2
              fi
            done
            # Then check interface paths (wildcard must be outside quotes)
            if [ -z "$USB_BUS" ] || [ -z "$USB_DEVICE" ]; then
              for INTERFACE_PATH in $USB_DEVICE_PATH:*; do
                [ ! -d "$INTERFACE_PATH" ] && continue
                for TTY_DIR in "$INTERFACE_PATH"/*/tty* "$INTERFACE_PATH"/tty*; do
                  [ ! -d "$TTY_DIR" ] && continue
                  TTY_FOUND=$(basename "$TTY_DIR")
                  if [ "$TTY_FOUND" = "$DEVICE_NAME" ]; then
                    # Found matching device! Extract bus and device from path
                    # Path format: /sys/bus/usb/devices/1-3 or /sys/bus/usb/devices/1-3:1.0 or 1-3.4:1.0
                    # Extract bus (first number before -) and device (second number before : or .)
                    USB_BUS=$(echo "$DEVICE_BASENAME" | sed -n 's/^\([0-9]*\)-.*/\1/p' | sed 's/^0*//' || echo "")
                    USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)[.:].*/\1/p' | sed 's/^0*//' || echo "")
                    # If no : or . found, try without suffix
                    [ -z "$USB_DEVICE" ] && USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)$/\1/p' | sed 's/^0*//' || echo "")
                    break 2
                  fi
                done
              done
            fi
          fi
        done
        
        # If we found bus/device, get lsusb info for this specific device
        if [ -n "$USB_BUS" ] && [ -n "$USB_DEVICE" ] && [ "$USB_BUS" != "" ] && [ "$USB_DEVICE" != "" ]; then
          # Validate that USB_BUS and USB_DEVICE are numeric integers (no decimals, no letters)
          if echo "$USB_BUS" | grep -qE '^[0-9]+$' && echo "$USB_DEVICE" | grep -qE '^[0-9]+$'; then
            # Convert to integer (remove any leading zeros that might cause issues)
            USB_BUS=$((USB_BUS + 0))
            USB_DEVICE=$((USB_DEVICE + 0))
            # Format bus and device with leading zeros for lsusb matching
            BUS_FORMATTED=$(printf "%03d" "$USB_BUS" 2>/dev/null || echo "")
            DEV_FORMATTED=$(printf "%03d" "$USB_DEVICE" 2>/dev/null || echo "")
            if [ -n "$BUS_FORMATTED" ] && [ -n "$DEV_FORMATTED" ]; then
              # Find lsusb line for this specific bus/device
              LSUSB_LINE=$(lsusb | grep "^Bus $BUS_FORMATTED Device $DEV_FORMATTED:" || echo "")
              if [ -n "$LSUSB_LINE" ]; then
                USB_INFO=$(echo "$LSUSB_LINE" | sed 's/^Bus [0-9]* Device [0-9]*: ID //' || echo "")
              fi
            else
              # printf failed, reset bus/device
              USB_BUS=""
              USB_DEVICE=""
            fi
          else
            # Invalid bus/device numbers, reset them
            USB_BUS=""
            USB_DEVICE=""
          fi
        fi
        if [ -z "$USB_BUS" ] || [ -z "$USB_DEVICE" ]; then
          # Fallback: use first matching device from lsusb
          USB_INFO=$(lsusb -d "${VENDOR_ID}:${PRODUCT_ID}" 2>/dev/null | sed 's/^Bus [0-9]* Device [0-9]*: ID //' | head -n1 || echo "")
        fi
      fi
    fi
  fi
  
  # Create descriptive name (only lsusb description, no device name)
  if [ -n "$USB_INFO" ] && [ "$USB_INFO" != "" ]; then
    # Use full lsusb description without device name
    NAME_TEXT="$USB_INFO"
  elif [ -n "$VENDOR_ID" ] && [ -n "$PRODUCT_ID" ]; then
    # Fallback: use vendor:product ID
    NAME_TEXT="ID ${VENDOR_ID}:${PRODUCT_ID}"
  else
    # Fallback: use the by-id link name
    NAME_TEXT=$(basename "$SERIAL_LINK")
  fi
  
  # Output JSON object
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    printf ','
  fi
  # Escape quotes in name for JSON
  ESCAPED_NAME=$(echo "$NAME_TEXT" | sed 's/"/\\"/g')
  # Use bus:device format as value, fallback to serial link if bus/device not found
  if [ -n "$USB_BUS" ] && [ -n "$USB_DEVICE" ]; then
    VALUE="${USB_BUS}:${USB_DEVICE}"
  else
    VALUE="$SERIAL_LINK"
  fi
  printf '{"name":"%s","value":"%s"}' "$ESCAPED_NAME" "$VALUE"
done

printf ']'
exit 0

