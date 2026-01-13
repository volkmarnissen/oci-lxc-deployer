<div align="center">

<img alt="LXC Manager Logo" src="docs/assets/lxc-manager-logo.svg" height="120" />

# LXC Manager

Install and manage common LXC applications on Proxmox (e.g., Home Assistant, Node-RED), with support for custom templates and extended application configurations.
</div>

## Quick Install
Run this on your Proxmox host:

```sh
curl -fsSL https://raw.githubusercontent.com/volkmarnissen/lxc-manager/main/install-lxc-manager.sh | sh
```

This installs lxc-manager with DHCP networking. For static IP configuration, see options below.

## Installation Options

### Basic Options
- `--vm-id <id>`: Specific VMID; if omitted, next free VMID is used
- `--disk-size <GB>`: Rootfs size (default: `1`)
- `--memory <MB>`: Memory (default: `512`)
- `--bridge <name>`: Network bridge (default: `vmbr0`)
- `--hostname <name>`: Hostname (default: `lxc-manager`)
- `--config-volume <path>`: Host path for /config volume (default: auto-detected)
- `--secure-volume <path>`: Host path for /secure volume (default: auto-detected)
- `--storage <name>`: Proxmox storage for OCI image (default: `local`)

### Network Options (Static IP)

**IPv4:**
```sh
curl -fsSL https://raw.githubusercontent.com/volkmarnissen/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --static-ip 192.168.4.100/24 --static-gw 192.168.4.1
```
- `--static-ip <ip/prefix>`: IPv4 address in CIDR (e.g., `192.168.4.100/24`)
- `--static-gw <ip>`: IPv4 gateway (e.g., `192.168.4.1`)
- `--static-dns <ip>`: DNS server (optional, e.g., `192.168.4.1`)

**IPv6:**
```sh
curl -fsSL https://raw.githubusercontent.com/volkmarnissen/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- --static-ip6 fd00::50/64 --static-gw6 fd00::1
```
- `--static-ip6 <ip/prefix>`: IPv6 address in CIDR (e.g., `fd00::50/64`)
- `--static-gw6 <ip>`: IPv6 gateway (e.g., `fd00::1`)
- `--static-dns6 <ip>`: IPv6 DNS server (optional)

**Dual Stack (IPv4 + IPv6):**
```sh
curl -fsSL https://raw.githubusercontent.com/volkmarnissen/lxc-manager/main/install-lxc-manager.sh \
  | sh -s -- \
    --static-ip 192.168.4.100/24 --static-gw 192.168.4.1 \
    --static-ip6 fd00::50/64 --static-gw6 fd00::1
```

## Access the Web UI
- Open `http://lxc-manager:3000` from your network (or replace `lxc-manager` with the container's IP/hostname you configured).
- If Proxmox VE is behind a firewall, ensure port `3000/tcp` is reachable from the browser.

## Command Line Usage

For command line usage, task execution, and application development, see [Application Development Guide](docs/application-development.md).

## Documentation
See [docs/INSTALL.md](docs/INSTALL.md) for installation details and [docs/application-development.md](docs/application-development.md) for creating custom applications.


## Templates & Features
- Network helpers (e.g., static IP generation).
- Disk sharing and USB serial mapping templates.
- Parameterized tasks via JSON; validated against schemas in `backend/schemas/`.


## Why LXC Manager?
- Simple Web UI to install common apps (e.g., Home Assistant, Node-RED)
- Reusable JSON templates for repeatable provisioning
- Extend with your own templates and app configurations

