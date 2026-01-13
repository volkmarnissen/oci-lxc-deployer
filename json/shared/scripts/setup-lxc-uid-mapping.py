#!/usr/bin/env python3
"""
Setup UID/GID mapping for unprivileged LXC containers

This script:
1. Configures /etc/subuid and /etc/subgid with required ranges
2. Updates LXC container config with lxc.idmap entries (if vm_id provided)
3. Supports multiple UIDs/GIDs (comma-separated)

Parameters:
  - uid: User ID(s) for 1:1 mapping (e.g., "1000" or "1000,1001")
  - gid: Group ID(s) for 1:1 mapping (e.g., "1000" or "1000,1001")
  - vm_id: LXC container ID (optional, for updating container config)

Mock paths for testing:
  - MOCK_SUBUID_PATH: Override /etc/subuid path
  - MOCK_SUBGID_PATH: Override /etc/subgid path
  - MOCK_CONFIG_DIR: Override /etc/pve/lxc directory

Output: JSON to stdout (errors to stderr)
"""

import sys
import os
from pathlib import Path

# Standard Proxmox UID/GID range
STANDARD_START = 100000
STANDARD_COUNT = 65536

def parse_ids(id_str):
    """Parse comma-separated IDs into sorted unique list of integers"""
    if not id_str or id_str == "0":
        return []
    return sorted(set(int(x.strip()) for x in id_str.split(",") if x.strip()))

def calculate_ranges(uid_list, gid_list):
    """Calculate subuid/subgid ranges and lxc.idmap entries"""
    all_ids = sorted(set(uid_list + gid_list))
    if not all_ids:
        return [], [], []
    
    max_id = max(all_ids)
    specific_start = STANDARD_START + STANDARD_COUNT + ((max_id // 10) * STANDARD_COUNT)
    rest_start = specific_start + max_id + 1
    rest_count = 65536 - max_id - 1
    
    subuid_entries = [
        f"root:{STANDARD_START}:{STANDARD_COUNT}",
        f"root:{specific_start}:{max_id}",
    ]
    subgid_entries = list(subuid_entries)
    
    for uid in uid_list:
        subuid_entries.append(f"root:{uid}:1")
    for gid in gid_list:
        subgid_entries.append(f"root:{gid}:1")
    
    subuid_entries.append(f"root:{rest_start}:{rest_count}")
    subgid_entries.append(f"root:{rest_start}:{rest_count}")
    
    idmap_entries = []
    if all_ids:
        first_id = min(all_ids)
        if first_id > 0:
            idmap_entries.append(f"lxc.idmap: u 0 {STANDARD_START} {first_id}")
            idmap_entries.append(f"lxc.idmap: g 0 {STANDARD_START} {first_id}")
        
        for uid in sorted(uid_list):
            idmap_entries.append(f"lxc.idmap: u {uid} {uid} 1")
        for gid in sorted(gid_list):
            idmap_entries.append(f"lxc.idmap: g {gid} {gid} 1")
        
        last_id = max(all_ids)
        if last_id < 65535:
            idmap_entries.append(f"lxc.idmap: u {last_id + 1} {rest_start} {rest_count}")
            idmap_entries.append(f"lxc.idmap: g {last_id + 1} {rest_start} {rest_count}")
    
    return subuid_entries, subgid_entries, idmap_entries

def update_file(filepath, entries, description):
    """Add entries to file if they don't exist"""
    Path(filepath).parent.mkdir(parents=True, exist_ok=True)
    
    existing = set()
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            existing = set(line.strip() for line in f if line.strip())
    
    with open(filepath, 'a') as f:
        for entry in entries:
            if entry not in existing:
                f.write(entry + '\n')
                print(f"Added to {filepath}: {entry}", file=sys.stderr)

def update_lxc_config(config_path, idmap_entries):
    """Update LXC container config with idmap entries"""
    config_path.parent.mkdir(parents=True, exist_ok=True)
    
    if not config_path.exists():
        config_path.write_text("")
    
    with open(config_path, 'r') as f:
        lines = f.readlines()
    
    lines = [line for line in lines if not line.strip().startswith('lxc.idmap:')]
    
    for entry in idmap_entries:
        lines.append(entry + '\n')
    
    with open(config_path, 'w') as f:
        f.writelines(lines)

def main():
    uid_str = os.environ.get('uid', '0')
    gid_str = os.environ.get('gid', '0')
    vm_id = os.environ.get('vm_id', '')
    
    subuid_path = os.environ.get('MOCK_SUBUID_PATH', '/etc/subuid')
    subgid_path = os.environ.get('MOCK_SUBGID_PATH', '/etc/subgid')
    config_dir = os.environ.get('MOCK_CONFIG_DIR', '/etc/pve/lxc')
    
    uid_list = parse_ids(uid_str)
    gid_list = parse_ids(gid_str)
    
    if not uid_list and not gid_list:
        return
    
    subuid_entries, subgid_entries, idmap_entries = calculate_ranges(uid_list, gid_list)
    
    update_file(subuid_path, subuid_entries, 'subuid')
    update_file(subgid_path, subgid_entries, 'subgid')
    
    if vm_id and vm_id.isdigit():
        config_path = Path(config_dir) / f"{vm_id}.conf"
        update_lxc_config(config_path, idmap_entries)

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
