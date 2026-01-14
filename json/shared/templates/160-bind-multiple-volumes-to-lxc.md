# Bind Multiple Volumes to LXC

Template documentation for binding multiple host directories to an LXC container.

## Volumes

Volume mappings in ```key=value``` format, one per line. 
Each line creates a bind mount from `<host_mountpoint>/<base_path>/<hostname>/<key>` to `/<value>` in the container.

**Format:** `key=path` or `key=path,permissions`

**Default permissions:** 0755

**Optional:** Add permissions after comma (e.g., 0700, 0755, 0644)

**Examples:**
```
volume1=/var/lib/myapp/data,0700
volume2=/var/lib/myapp/logs,0755
volume3=/var/lib/myapp/config
```

The first example creates a bind mount with 0700 permissions, the second with 0755, and the third uses the default 0755.

### How it works

1. Volume directories are created at `<host_mountpoint>/<base_path>/<hostname>/<key>` on the Proxmox host
2. Each directory is bind-mounted to `/<value>` inside the container
3. Ownership is set using the mapped UID/GID for unprivileged containers
4. Permissions can be customized per volume

## ID of the LXC Container

ID of the LXC container the volumes will be bound to. Typically the numeric VMID used by Proxmox.

## Hostname

Hostname of the LXC container. Used when building per-container directories under the host mountpoint: `<host_mountpoint>/<base_path>/<hostname>/<volume-key>`.

## Host Mountpoint

Mountpoint on the Proxmox host as created by “Mount Disk on Host (120)” or “Mount ZFS Pool on Host (121)”.

- When set, volume directories are created at `<host_mountpoint>/<base_path>/<hostname>/<volume-key>`.
- When empty, `/mnt/<base_path>/<hostname>/<volume-key>` is used instead.

## Base Path

Base subdirectory name under the host mountpoint. Defaults to `volumes`.

- Effective location: `<host_mountpoint>/<base_path>/<hostname>/<volume-key>`
- Without `host_mountpoint`: `/mnt/<base_path>/<hostname>/<volume-key>`

## Username

Optional username used for ownership on the created directories. If provided, it is used by `chown` instead of numeric UID/GID. Should match the user created on the VE host (e.g., 300-create-user-on-host.json).

## UID

Numeric user ID used for setting directory ownership/permissions. Default: `0` (root). Applied consistently on VE host and inside the LXC container.

## GID

Numeric group ID used for setting directory ownership/permissions. Default: `0` (root). Applied consistently on VE host and inside the LXC container.

## Mapped UID (Host)

Optional host-side UID to use for unprivileged containers with 1:1 UID mapping. If not set, the value from `uid` is used. Typically provided by `setup-lxc-uid-mapping.py (102)`.

## Mapped GID (Host)

Optional host-side GID to use for unprivileged containers with 1:1 GID mapping. If not set, the value from `gid` is used. Typically provided by `setup-lxc-uid-mapping.py (102)`.
