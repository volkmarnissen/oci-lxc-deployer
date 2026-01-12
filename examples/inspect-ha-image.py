#!/usr/bin/env python3
"""
Inspect any OCI image to extract volumes and environment variables using skopeo.

Usage:
    python3 inspect-ha-image.py <image> [--username USER] [--password PASS]
    python3 inspect-ha-image.py homeassistant/home-assistant
    python3 inspect-ha-image.py mariadb:10.11
    python3 inspect-ha-image.py phpmyadmin:latest
    python3 inspect-ha-image.py ghcr.io/node-red/node-red:latest
    python3 inspect-ha-image.py docker://alpine:latest

Requirements:
    - skopeo must be installed (apt install skopeo)
"""

import json
import sys
import subprocess
import argparse
from typing import Optional, Dict, List

def log(message: str) -> None:
    """Print message to stderr (for logging)."""
    print(message, file=sys.stderr)

def error(message: str, exit_code: int = 1) -> None:
    """Print error to stderr and exit."""
    log(f"Error: {message}")
    sys.exit(exit_code)

def check_skopeo() -> bool:
    """Check if skopeo is available."""
    try:
        result = subprocess.run(['which', 'skopeo'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            # Verify it's actually skopeo
            version_result = subprocess.run(['skopeo', '--version'], capture_output=True, text=True, timeout=5)
            if version_result.returncode == 0:
                return True
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

def check_docker() -> bool:
    """Check if docker is available."""
    try:
        result = subprocess.run(['which', 'docker'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            # Verify docker is accessible and daemon is running
            version_result = subprocess.run(['docker', '--version'], capture_output=True, text=True, timeout=5)
            if version_result.returncode == 0:
                # Try a simple command to check if daemon is accessible
                info_result = subprocess.run(['docker', 'info'], capture_output=True, text=True, timeout=5)
                if info_result.returncode == 0:
                    return True
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

def docker_inspect(image_ref: str) -> Optional[dict]:
    """
    Inspect image using docker inspect to get History (which skopeo doesn't provide).
    
    Args:
        image_ref: Image reference (e.g., mariadb:latest, docker.io/library/mariadb:latest)
    
    Returns:
        Dict with inspect output including History, or None if failed
    """
    # Remove docker:// prefix if present for docker CLI
    docker_image_ref = image_ref.replace('docker://', '')
    # Remove docker.io/library/ prefix (Docker CLI uses shorter names)
    docker_image_ref = docker_image_ref.replace('docker.io/library/', '')
    docker_image_ref = docker_image_ref.replace('docker.io/', '')
    
    cmd = ['docker', 'inspect', docker_image_ref]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
        data = json.loads(result.stdout)
        # docker inspect returns an array, get first element
        if data and isinstance(data, list) and len(data) > 0:
            return data[0]
        return None
    except subprocess.TimeoutExpired:
        log(f"  ⏱ Timeout inspecting image with docker: {docker_image_ref}")
        return None
    except subprocess.CalledProcessError as e:
        # Docker image might not be pulled locally
        log(f"  ⚠ Could not inspect with docker (image may not be local): {docker_image_ref}")
        log(f"    Error: {e.stderr[:200] if e.stderr else str(e)}")
        return None
    except json.JSONDecodeError as e:
        log(f"  ⚠ Failed to parse docker inspect output: {e}")
        return None
    except Exception as e:
        log(f"  ⚠ Unexpected error with docker inspect: {e}")
        return None

def parse_image_ref(image_ref: str) -> str:
    """
    Parse and normalize OCI image reference for skopeo.
    
    Returns docker:// formatted image reference.
    Examples:
      alpine:latest -> docker://alpine:latest
      docker://alpine:latest -> docker://alpine:latest
      docker://user/image:tag -> docker://user/image:tag
      oci://ghcr.io/owner/repo:tag -> docker://ghcr.io/owner/repo:tag
      ghcr.io:owner/repo:tag -> docker://ghcr.io/owner/repo:tag (fixes common typo)
      phpmyadmin:latest -> docker://phpmyadmin:latest
    """
    import re
    
    # Remove protocol prefix if present (oci://, docker://)
    image_ref = re.sub(r'^[^:]+://', '', image_ref)
    
    # Fix common typo: registry:owner/repo -> registry/owner/repo
    # This handles cases like "ghcr.io:homeassistant/homeassistant:latest"
    # Pattern: registry.domain followed by colon before the first slash (but after tag separator)
    # Example: ghcr.io:owner/repo:tag -> ghcr.io/owner/repo:tag
    # We need to replace the first colon that appears before the first slash
    if ':' in image_ref and '/' in image_ref:
        # Find the position of first colon and first slash
        colon_pos = image_ref.find(':')
        slash_pos = image_ref.find('/')
        
        # If colon comes before slash, and the part before colon looks like a registry domain (has dots)
        if colon_pos < slash_pos:
            registry_part = image_ref[:colon_pos]
            # If it looks like a domain (contains dots, e.g., ghcr.io, docker.io)
            if '.' in registry_part:
                # Replace the colon with a slash
                image_ref = image_ref[:colon_pos] + '/' + image_ref[colon_pos + 1:]
    
    # Add docker:// prefix (skopeo accepts docker:// for all registries)
    if not image_ref.startswith('docker://'):
        return f"docker://{image_ref}"
    
    return image_ref

def skopeo_inspect(image_ref: str, username: Optional[str] = None, password: Optional[str] = None, 
                   platform: Optional[str] = None) -> dict:
    """
    Inspect image using skopeo and return JSON output.
    
    Args:
        image_ref: Image reference (e.g., docker://image:tag)
        username: Registry username (optional)
        password: Registry password (optional)
        platform: Target platform (e.g., linux/amd64, linux/arm64). Default: linux/amd64
    """
    cmd = ['skopeo', 'inspect', '--format', '{{json .}}']
    
    # Add platform override if specified (needed for multi-arch images)
    if platform:
        # Parse platform (e.g., linux/amd64 -> arch=amd64, os=linux)
        if '/' in platform:
            os_type, arch = platform.split('/', 1)
            cmd.extend(['--override-os', os_type, '--override-arch', arch])
        else:
            # Assume linux if only arch specified
            cmd.extend(['--override-os', 'linux', '--override-arch', platform])
    else:
        # Default to linux/amd64 (most common for container images)
        cmd.extend(['--override-os', 'linux', '--override-arch', 'amd64'])
    
    # Add authentication if provided
    if username and password:
        cmd.extend(['--creds', f'{username}:{password}'])
    elif username:
        # Password might be empty, use credentials anyway
        cmd.extend(['--creds', f'{username}'])
    
    cmd.append(image_ref)
    
    try:
        log(f"Inspecting {image_ref}...")
        if platform:
            log(f"Target platform: {platform}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        error(f"Timeout inspecting image {image_ref}")
    except subprocess.CalledProcessError as e:
        error(f"Failed to inspect image {image_ref}: {e.stderr}")
    except json.JSONDecodeError as e:
        error(f"Failed to parse inspect output: {e}")

def analyze_volumes(volumes: dict, working_dir: str, entrypoint: list, labels: dict, env_vars: list = None) -> dict:
    """
    Analyze volumes to determine which are required vs proposal.
    
    Safe assumptions (REQUIRED only - everything else is PROPOSAL):
    1. Explicit VOLUME declarations in image (VOLUME in Dockerfile) - definitely required
    2. WorkingDir (if set and not root/temp) - application expects data there
    
    Everything else (derived from env vars, labels, etc.) is only a PROPOSAL.
    
    Args:
        volumes: Dict of explicit volumes from image config (from VOLUME directive)
        working_dir: Working directory from image config
        entrypoint: Entrypoint command (not used currently, for future extension)
        labels: Image labels (checked for explicit volume hints)
        env_vars: List of environment variables (for deriving volume proposals)
    
    Returns dict with 'required' and 'proposal' lists.
    """
    required = []
    proposal = []
    
    # SAFE ASSUMPTION 1: Explicit volumes (VOLUME in Dockerfile) are always required
    explicit_volumes = set(volumes.keys()) if volumes else set()
    for vol_path in explicit_volumes:
        required.append(vol_path)
    
    # SAFE ASSUMPTION 2: WorkingDir is required if set and not root/temp
    # Applications typically write data to their working directory
    if working_dir and working_dir not in ['/', '/tmp', '/root']:
        if working_dir not in explicit_volumes:
            required.append(working_dir)
    
    # Check labels for explicit volume hints (if standardized labels exist)
    # Some images might use labels like:
    # - org.opencontainers.image.volumes.required=/data
    # - docker.volumes.required=/data (Docker-specific)
    # But this is not widely standardized, so we check but treat cautiously
    if labels:
        volume_labels = [k for k in labels.keys() if 'volume' in k.lower()]
        for label_key in volume_labels:
            label_value = labels[label_key]
            if isinstance(label_value, str) and label_value.startswith('/'):
                # Only if label EXPLICITLY says "required", treat as required
                if 'required' in label_key.lower() and 'optional' not in label_key.lower():
                    if label_value not in required:
                        required.append(label_value)
                # All other volume labels are proposals
                elif label_value not in required and label_value not in proposal:
                    proposal.append(label_value)
    
    # Extract volume proposals from environment variables
    # These are NOT required, just suggestions based on common patterns
    env_volume_paths = set()
    if env_vars:
        for env_var in env_vars:
            if '=' in env_var:
                var_name, var_value = env_var.split('=', 1)
                var_value = var_value.strip()
                
                # Check if the value looks like a path (absolute path starting with /)
                if var_value.startswith('/') and len(var_value) > 1:
                    # Skip common system paths that are never volumes
                    system_paths = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt/bin', '/opt/sbin', 
                                   '/var/cache', '/var/tmp']
                    if any(var_value == path or var_value.startswith(path + '/') for path in system_paths):
                        continue
                    
                    # Skip if already in required volumes (explicit or WorkingDir)
                    if var_value in explicit_volumes or var_value == working_dir:
                        continue
                    
                    # Look for environment variables that suggest volumes
                    var_name_upper = var_name.upper()
                    volume_indicators = [
                        '_SAVE_PATH',   # SESSION_SAVE_PATH=/sessions
                        '_DATA_DIR',    # DATA_DIR=/data
                        '_STORAGE',     # STORAGE_PATH=/storage
                        '_VOLUME',      # DATA_VOLUME=/data
                        '_CONFIG_DIR',  # CONFIG_DIR=/config
                    ]
                    
                    # Check if variable name suggests it's a volume path
                    if any(indicator in var_name_upper for indicator in volume_indicators):
                        env_volume_paths.add(var_value)
                    # Also check for specific well-known variables
                    elif var_name_upper in ['SESSION_SAVE_PATH', 'DATA_DIR', 'CONFIG_DIR', 'STORAGE_PATH', 
                                            'DATA_PATH', 'PERSISTENT_DATA', 'APP_DATA']:
                        env_volume_paths.add(var_value)
                    # SSL/cert directories (proposal only)
                    elif '_SSL' in var_name_upper or '_CERT' in var_name_upper:
                        env_volume_paths.add(var_value)
    
    # All volumes from environment variables are PROPOSALS only (not required)
    for vol_path in env_volume_paths:
        # Skip if already in required
        if vol_path in required:
            continue
        
        # Skip common system paths
        if vol_path in ['/', '/tmp', '/root', '/usr', '/bin', '/sbin', '/lib', '/lib64']:
            continue
        
        # Skip if it's under /usr (system paths)
        if vol_path.startswith('/usr/'):
            continue
        
        # All env-derived volumes are proposals
        if vol_path not in proposal:
            proposal.append(vol_path)
    
    # Remove duplicates
    return {
        'required': sorted(set(required)),
        'proposal': sorted(set(proposal))
    }

def extract_volumes_from_history(history: list) -> dict:
    """
    Extract VOLUME declarations from image history.
    
    Docker stores VOLUME directives in history as:
    - Single volume: '/bin/sh -c #(nop)  VOLUME ["/path"]'
    - Multiple volumes: '/bin/sh -c #(nop)  VOLUME ["/path1", "/path2"]'
    
    Note: skopeo inspect does NOT return History, so this function is only useful
    when using docker inspect or when History is available from other sources.
    
    Args:
        history: List of history entries from inspect output
    
    Returns:
        Dict mapping volume paths to empty dict (matching Config.Volumes format)
    """
    volumes = {}
    import re
    
    if not history:
        return volumes
    
    # Pattern to match VOLUME directives in history
    # Matches: VOLUME ["/path"] or VOLUME ["/path1", "/path2", ...]
    volume_pattern = r'VOLUME\s+\[(.*?)\]'
    
    for entry in history:
        if not entry or not isinstance(entry, dict):
            continue
        
        created_by = entry.get('created_by', '')
        if not created_by or 'VOLUME' not in created_by.upper():
            continue
        
        # Extract VOLUME declaration
        match = re.search(volume_pattern, created_by, re.IGNORECASE)
        if match:
            # Parse JSON array of paths
            volume_list_str = match.group(1)
            try:
                # Handle both single and multiple volumes
                # Replace single quotes with double quotes if needed
                volume_list_str = volume_list_str.replace("'", '"')
                # Parse as JSON array
                import json
                volume_paths = json.loads(f'[{volume_list_str}]')
                
                # Add each volume path to the dict
                for path in volume_paths:
                    if isinstance(path, str) and path.startswith('/'):
                        volumes[path] = {}
            except (json.JSONDecodeError, ValueError):
                # Fallback: try to extract paths manually
                # Handle cases like: "/path" or "/path1", "/path2"
                paths = re.findall(r'["\']([^"\']+)["\']', volume_list_str)
                for path in paths:
                    if path.startswith('/'):
                        volumes[path] = {}
    
    return volumes

def extract_image_info(inspect_output: dict) -> dict:
    """
    Extract image information from skopeo inspect output.
    
    Returns dict with:
    - env_vars: List of environment variables
    - labels: Dict of labels
    - volumes: Dict of volumes (from Config.Volumes or History)
    - exposed_ports: Dict of exposed ports
    - working_dir: Working directory
    - entrypoint: Entrypoint command
    - cmd: CMD command
    """
    # skopeo inspect returns different structures depending on the image format
    # Try to extract from different possible locations
    
    # Try Config.Config first (Docker format)
    config_data = inspect_output.get('Config', {})
    if not config_data or not isinstance(config_data, dict):
        # Try root-level config (OCI format)
        config_data = inspect_output.get('config', {}) or {}
    
    # Environment variables
    env_vars = config_data.get('Env', []) or inspect_output.get('Env', []) or []
    
    # Labels - could be in Config.Labels or Labels
    labels = config_data.get('Labels', {}) or inspect_output.get('Labels', {}) or {}
    
    # Volumes - first try Config.Volumes, then fall back to History
    volumes = config_data.get('Volumes', {}) or inspect_output.get('Volumes', {}) or {}
    
    # If Config.Volumes is empty, try to extract from History
    # (Modern Docker/BuildKit stores VOLUME only in History, not in Config)
    # Note: skopeo inspect does NOT return History, so we need docker inspect for that
    if not volumes:
        history = inspect_output.get('History', [])
        if history:
            volumes = extract_volumes_from_history(history)
    
    # Exposed ports
    exposed_ports = config_data.get('ExposedPorts', {}) or inspect_output.get('ExposedPorts', {}) or {}
    
    # Working directory
    working_dir = config_data.get('WorkingDir', '') or inspect_output.get('WorkingDir', '')
    
    # Entrypoint
    entrypoint = config_data.get('Entrypoint', []) or inspect_output.get('Entrypoint', []) or []
    
    # CMD
    cmd = config_data.get('Cmd', []) or inspect_output.get('Cmd', []) or []
    
    return {
        'env_vars': env_vars,
        'labels': labels,
        'volumes': volumes,
        'exposed_ports': exposed_ports,
        'working_dir': working_dir,
        'entrypoint': entrypoint,
        'cmd': cmd
    }

def simplify_inspect_output(inspect_output: dict) -> dict:
    """
    Simplify inspect output by removing or truncating large arrays.
    Returns a simplified version suitable for JSON output.
    """
    simplified = inspect_output.copy()
    
    # Remove or truncate large arrays
    large_arrays = ['Layers', 'LayersData', 'RepoTags']
    for key in large_arrays:
        if key in simplified and isinstance(simplified[key], list):
            # Replace with empty array or just count
            simplified[key] = []
    
    # Keep only essential metadata from inspect output
    essential_keys = [
        'Name', 'Digest', 'Created', 'DockerVersion', 'Architecture', 'Os'
    ]
    
    # Create a simplified version with only essential metadata
    simplified_output = {}
    for key in essential_keys:
        if key in simplified:
            simplified_output[key] = simplified[key]
    
    # Add Labels (full labels are useful)
    if 'Labels' in simplified:
        simplified_output['Labels'] = simplified['Labels']
    
    return simplified_output

def main():
    # Check if skopeo is available
    if not check_skopeo():
        error("skopeo is required but not found. Please install it with: apt install skopeo")
    
    parser = argparse.ArgumentParser(
        description='Inspect OCI image to extract volumes and environment variables using skopeo',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 inspect-ha-image.py homeassistant/home-assistant
  python3 inspect-ha-image.py mariadb:10.11
  python3 inspect-ha-image.py phpmyadmin:latest
  python3 inspect-ha-image.py phpmyadmin:latest --platform linux/amd64
  python3 inspect-ha-image.py ghcr.io/node-red/node-red:latest --platform linux/arm64
  python3 inspect-ha-image.py docker://alpine:latest
  python3 inspect-ha-image.py phpmyadmin:latest --username USER --password PASS --platform linux/amd64
        """
    )
    parser.add_argument('image', help='OCI image reference (e.g., image:tag, registry.io/image:tag, docker://image:tag)')
    parser.add_argument('--username', help='Registry username (optional, for private images)')
    parser.add_argument('--password', help='Registry password/token (optional, for private images)')
    parser.add_argument('--platform', help='Target platform (e.g., linux/amd64, linux/arm64). Default: linux/amd64', 
                       default='linux/amd64')
    parser.add_argument('--full-inspect', action='store_true', 
                       help='Include full inspect output with all arrays (default: simplified)')
    
    args = parser.parse_args()
    
    # Parse and normalize image reference
    image_ref = parse_image_ref(args.image)
    
    # Inspect image with skopeo
    inspect_output = skopeo_inspect(image_ref, args.username, args.password, args.platform)
    
    # If docker is available and Config.Volumes is empty, try docker inspect for History
    # (docker inspect provides History which skopeo doesn't)
    docker_inspect_data = None
    if docker_available:
        config_data = inspect_output.get('Config', {}) or inspect_output.get('config', {}) or {}
        volumes = config_data.get('Volumes', {}) or inspect_output.get('Volumes', {}) or {}
        if not volumes:
            log("  Attempting to extract volumes from docker inspect History...")
            docker_inspect_data = docker_inspect(image_ref)
            if docker_inspect_data:
                # Merge History from docker inspect into skopeo output
                docker_history = docker_inspect_data.get('History', [])
                if docker_history:
                    inspect_output['History'] = docker_history
                    log(f"  ✓ Found {len(docker_history)} history entries from docker inspect")
    
    # Extract image information (will use History if available)
    image_info = extract_image_info(inspect_output)
    
    # Analyze volumes (including volumes derived from environment variables)
    volume_analysis = analyze_volumes(
        image_info['volumes'],
        image_info['working_dir'],
        image_info['entrypoint'],
        image_info['labels'],
        image_info['env_vars']
    )
    
    # Extract relevant labels
    relevant_labels = [
        'io.hass.type',
        'io.hass.version',
        'org.opencontainers.image.title',
        'org.opencontainers.image.description',
        'org.opencontainers.image.documentation',
        'org.opencontainers.image.version',
    ]
    relevant_labels_dict = {}
    for label_key in relevant_labels:
        if label_key in image_info['labels']:
            relevant_labels_dict[label_key] = image_info['labels'][label_key]
    
    # Build structured JSON output
    output = {
        'image': {
            'name': inspect_output.get('Name', ''),
            'digest': inspect_output.get('Digest', ''),
            'architecture': inspect_output.get('Architecture', ''),
            'os': inspect_output.get('Os', ''),
            'created': inspect_output.get('Created', ''),
        },
        'environment_variables': image_info['env_vars'],
        'volumes': {
            'required': volume_analysis['required'],
            'proposal': volume_analysis['proposal']
        },
        'exposed_ports': list(image_info['exposed_ports'].keys()) if image_info['exposed_ports'] else [],
        'working_directory': image_info['working_dir'] if image_info['working_dir'] else None,
        'entrypoint': image_info['entrypoint'] if image_info['entrypoint'] else None,
        'cmd': image_info['cmd'] if image_info['cmd'] else None,
        'labels': relevant_labels_dict,
        'documentation': image_info['labels'].get('org.opencontainers.image.documentation'),
    }
    
    # Add simplified inspect output if requested, otherwise add minimal metadata
    if args.full_inspect:
        # Simplify inspect output (remove large arrays)
        output['inspect_output'] = simplify_inspect_output(inspect_output)
    else:
        # Only essential metadata
        output['inspect_output'] = simplify_inspect_output(inspect_output)
    
    # Output as JSON
    print(json.dumps(output, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log("Interrupted by user")
        sys.exit(130)
    except Exception as e:
        error(f"Unexpected error: {str(e)}")
