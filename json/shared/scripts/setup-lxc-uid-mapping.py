#!/usr/bin/env python3
"""
Setup UID/GID mapping for unprivileged LXC containers

This script:
1. Configures /etc/subuid and /etc/subgid with required ranges
2. Updates LXC container config with lxc.idmap entries (if vm_id provided)
3. Supports multiple UIDs/GIDs (comma-separated)
4. Outputs mapped host UIDs/GIDs as JSON for use in templates

Parameters:
  - uid: User ID(s) for 1:1 mapping (e.g., "1000" or "1000,1001")
  - gid: Group ID(s) for 1:1 mapping (e.g., "1000" or "1000,1001")
  - vm_id: LXC container ID (optional, for updating container config)

Mock paths for testing:
  - MOCK_SUBUID_PATH: Override /etc/subuid path
  - MOCK_SUBGID_PATH: Override /etc/subgid path
  - MOCK_CONFIG_DIR: Override /etc/pve/lxc directory

Output: JSON to stdout with mapped_uid and mapped_gid (errors to stderr)
    [{"id": "mapped_uid", "value": "101000"}, {"id": "mapped_gid", "value": "101000"}]
"""

import sys
import os
import json
from pathlib import Path
from typing import List, Tuple

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

def parse_idmap_lines(lines: List[str], kind: str) -> List[Tuple[int, int, int]]:
    """Parse lxc.idmap lines into (container_start, host_start, range) for given kind 'u' or 'g'"""
    result: List[Tuple[int, int, int]] = []
    for line in lines:
        s = line.strip()
        if not s.startswith('lxc.idmap'):
            continue
        # Expected formats:
        # 'lxc.idmap = u 0 100000 65536' or 'lxc.idmap: u 0 100000 65536'
        s = s.replace('=', ':')
        parts = [p for p in s.split() if p]
        # parts example: ['lxc.idmap:', 'u', '0', '100000', '65536']
        if len(parts) >= 6 and parts[0].startswith('lxc.idmap'):
            k = parts[1]
            if k != kind:
                continue
            try:
                c_start = int(parts[2])
                h_start = int(parts[3])
                rng = int(parts[4])
                result.append((c_start, h_start, rng))
            except ValueError:
                continue
        elif len(parts) >= 5 and parts[0].startswith('lxc.idmap'):
            # Fallback if tokenization differs
            try:
                k = parts[1]
                if k != kind:
                    continue
                c_start = int(parts[2])
                h_start = int(parts[3])
                rng = int(parts[4])
                result.append((c_start, h_start, rng))
            except Exception:
                continue
    return sorted(result, key=lambda t: t[0])

def compute_host_id_for_container_id(container_id: int, idmap_segments: List[Tuple[int, int, int]], unprivileged: bool) -> int:
    """Given a container UID/GID and idmap segments, compute the host ID. If no segments match,
    assume default Proxmox mapping 100000 offset for unprivileged containers, else 1:1."""
    for c_start, h_start, rng in idmap_segments:
        if c_start <= container_id < c_start + rng:
            return h_start + (container_id - c_start)
    # Fallbacks
    if unprivileged:
        return STANDARD_START + container_id
    return container_id

def main():
    # Get parameters from template variables (will be replaced by sed during script download)
    uid_str = "{{ uid }}"
    gid_str = "{{ gid }}"
    vm_id = "{{ vm_id }}"
    
    # Mock paths for testing (still supported via environment variables)
    subuid_path = os.environ.get('MOCK_SUBUID_PATH', '/etc/subuid')
    subgid_path = os.environ.get('MOCK_SUBGID_PATH', '/etc/subgid')
    config_dir = os.environ.get('MOCK_CONFIG_DIR', '/etc/pve/lxc')
    
    # Normalize parameters (empty/NOT_DEFINED means not set)
    if not uid_str or uid_str == "NOT_DEFINED" or uid_str.strip() == "":
        uid_str = "0"
    if not gid_str or gid_str == "NOT_DEFINED" or gid_str.strip() == "":
        gid_str = "0"
    if not vm_id or vm_id == "NOT_DEFINED" or vm_id.strip() == "":
        vm_id = ""
    
    uid_list = parse_ids(uid_str)
    gid_list = parse_ids(gid_str)
    
    if not uid_list and not gid_list:
        return
    
    subuid_entries, subgid_entries, idmap_entries = calculate_ranges(uid_list, gid_list)
    
    update_file(subuid_path, subuid_entries, 'subuid')
    update_file(subgid_path, subgid_entries, 'subgid')
    
    # Determine mapped host IDs (what we should chown on the host)
    mapped_uid_val = None
    mapped_gid_val = None

    # Default: assume unprivileged unless config says otherwise
    unprivileged = True
    config_lines: List[str] = []
    config_path = None
    if vm_id and vm_id.isdigit():
        config_path = Path(config_dir) / f"{vm_id}.conf"
        # Write idmap entries if provided
        if idmap_entries:
            update_lxc_config(config_path, idmap_entries)
        # Reload config to compute mapping
        try:
            with open(config_path, 'r') as f:
                config_lines = f.readlines()
        except Exception:
            config_lines = []
    # Detect unprivileged flag
    for line in config_lines:
        s = line.strip()
        if s.startswith('unprivileged'):
            # Formats: 'unprivileged: 1' or 'unprivileged: true'
            val = s.split(':', 1)[-1].strip().lower()
            unprivileged = val in ('1', 'true', 'yes')
            break

    # Build idmap segments; if none present, assume default mapping for unprivileged
    u_segments = parse_idmap_lines(config_lines, 'u') if config_lines else []
    g_segments = parse_idmap_lines(config_lines, 'g') if config_lines else []
    if not u_segments and unprivileged:
        u_segments = [(0, STANDARD_START, 65536)]
    if not g_segments and unprivileged:
        g_segments = [(0, STANDARD_START, 65536)]

    # Compute mapped host IDs for the first uid/gid
    if uid_list:
        mapped_uid_val = compute_host_id_for_container_id(uid_list[0], u_segments, unprivileged)
    if gid_list:
        mapped_gid_val = compute_host_id_for_container_id(gid_list[0], g_segments, unprivileged)

    # Output mapped UID/GID as JSON for templates (host IDs to use for chown)
    output = []
    if mapped_uid_val is not None:
        output.append({"id": "mapped_uid", "value": str(mapped_uid_val)})
    if mapped_gid_val is not None:
        output.append({"id": "mapped_gid", "value": str(mapped_gid_val)})
    
    if output:
        print(json.dumps(output))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
