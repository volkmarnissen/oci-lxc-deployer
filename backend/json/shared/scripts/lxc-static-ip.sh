#!/bin/sh

# Edit LXC network settings for a container
# Parameters:
#   {{ use_static_ip }} (boolean)
#   {{ static_ip }} (string)
#   {{ static_ip6 }} (string)
#   {{ static_gw }} (string)
#   {{ static_gw6 }} (string)
#   {{ vm_id }} (string)
#   {{ hostname }} (string)
#   {{ bridge }} (string)
ipv4_ok=true

 # Initialize IP variables (already computed or provided)
static_ip="{{ static_ip }}"
static_ip6="{{ static_ip6 }}"

if [ "{{ use_static_ip }}" != "true" ]; then
  echo "Static IP configuration not requested, skipping." >&2
  exit 0
fi

if [ -z "{{ vm_id }}" ]; then
  echo "No VMID provided!" >&2
  exit 2
fi

if [ -z "{{ hostname }}" ]; then
  echo "No hostname provided!" >&2
  exit 2
fi


ipv6_ok=true

if [ -n "$static_ip" ]; then
  ipv4_ok=true
else
  # If gateway is provided without IP, that's invalid
  if [ -n "{{ static_gw }}" ]; then
    echo "IPv4 gateway provided without IPv4 address!" >&2
    exit 2
  fi
  ipv4_ok=false
fi

if [ -n "$static_ip6" ]; then
  ipv6_ok=true
else
  # If gateway is provided without IP, that's invalid
  if [ -n "{{ static_gw6 }}" ]; then
    echo "IPv6 gateway provided without IPv6 address!" >&2
    exit 2
  fi
  ipv6_ok=false
fi

if [ "$ipv4_ok" = false ] && [ "$ipv6_ok" = false ]; then
  echo "No static IP (IPv4 or IPv6) provided!" >&2
  exit 2
fi

NET_OPTS="name=eth0,bridge={{ bridge }}"
if [ "$ipv4_ok" = true ]; then
  NET_OPTS="$NET_OPTS,ip=$static_ip"
  if [ -n "{{ static_gw }}" ]; then
    NET_OPTS="$NET_OPTS,gw={{ static_gw }}"
  fi
fi
if [ "$ipv6_ok" = true ]; then
  NET_OPTS="$NET_OPTS,ip6=$static_ip6"
  if [ -n "{{ static_gw6 }}" ]; then
    NET_OPTS="$NET_OPTS,gw6={{ static_gw6 }}"
  fi
fi
pct set {{ vm_id }} --net0 "$NET_OPTS" >&2
RC=$?
if [ $RC -ne 0 ]; then
  echo "Failed to set network configuration!" >&2
  exit $RC
fi

echo "Network configuration updated for VM {{ vm_id }}." >&2
exit 0
