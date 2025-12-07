#!/bin/sh

# Edit LXC network settings for a container
# Parameters:
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

# Auto-detect static IP usage
if [ -z "$static_ip" ] && [ -z "$static_ip6" ]; then
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

is_valid_ipv4_cidr() {
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*/[0-9]*)
      ip_part=${1%/*}
      prefix=${1#*/}
      # Check prefix range 0-32
      if [ "$prefix" -ge 0 ] 2>/dev/null && [ "$prefix" -le 32 ] 2>/dev/null; then
        # Check each octet 0-255
        IFS='.' read o1 o2 o3 o4 <<EOF
$ip_part
EOF
        for o in "$o1" "$o2" "$o3" "$o4"; do
          case "$o" in
            ''|*[!0-9]) return 1 ;;
          esac
          if [ "$o" -lt 0 ] || [ "$o" -gt 255 ]; then return 1; fi
        done
        return 0
      fi
      return 1 ;;
    *) return 1 ;;
  esac
}

is_valid_ipv6_cidr() {
  case "$1" in
    */*)
      ip_part=${1%/*}
      prefix=${1#*/}
      # prefix 0-128
      if ! [ "$prefix" -ge 0 ] 2>/dev/null || ! [ "$prefix" -le 128 ] 2>/dev/null; then
        return 1
      fi
      # Rough IPv6 check: hex groups separated by ':' (allow :: abbreviation)
      case "$ip_part" in
        *::*) ;; # allow compressed
        *)
          IFS=':' read -r g1 g2 g3 g4 g5 g6 g7 g8 <<EOF
$ip_part
EOF
          ;;
      esac
      # Basic pattern: only hex digits and colons
      case "$ip_part" in
        *[!0-9a-fA-F:]* ) return 1 ;;
      esac
      return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "$static_ip" ]; then
  if ! is_valid_ipv4_cidr "$static_ip"; then
    echo "Invalid IPv4 CIDR: '$static_ip'. Expected format a.b.c.d/prefix (e.g. 192.168.1.10/24)." >&2
    exit 2
  fi
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
  if ! is_valid_ipv6_cidr "$static_ip6"; then
    echo "Invalid IPv6 CIDR: '$static_ip6'. Expected format ip/prefix (e.g. fd00::10/64)." >&2
    exit 2
  fi
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
