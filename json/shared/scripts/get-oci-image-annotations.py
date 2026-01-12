#!/usr/bin/env python3
"""
Extract OCI image annotations from image config using skopeo.

This script inspects an OCI image and extracts specific annotations
that can be used to pre-fill framework/application metadata.

Parameters (via command line):
  image: OCI image reference (e.g., mariadb:latest, ghcr.io/home-assistant/home-assistant:latest)
  tag: Image tag (optional, default: latest)
  platform: Target platform (optional, default: linux/amd64)

Output (JSON to stdout):
  {
    "url": "https://www.example.com/",
    "documentation": "https://docs.example.com/",
    "source": "https://github.com/owner/repo",
    "vendor": "Vendor Name",
    "description": "Image description"
  }

All logs and errors go to stderr.

Requirements:
  - skopeo must be installed (apt install skopeo)
"""

import json
import sys
import subprocess
import argparse
from typing import Optional, Dict

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
            version_result = subprocess.run(['skopeo', '--version'], capture_output=True, text=True, timeout=5)
            if version_result.returncode == 0:
                return True
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

def parse_image_ref(image: str, tag: str = 'latest') -> str:
    """
    Parse and normalize OCI image reference for skopeo.
    
    Returns docker:// formatted image reference.
    """
    # Remove docker:// prefix if present
    image = image.replace('docker://', '')
    
    # Add tag if not present
    if ':' not in image:
        image = f"{image}:{tag}"
    
    # Add docker:// prefix
    if not image.startswith('docker://'):
        return f"docker://{image}"
    
    return image

def skopeo_inspect(image_ref: str, platform: str = 'linux/amd64') -> Dict:
    """
    Inspect image using skopeo and return JSON output.
    
    Args:
        image_ref: Image reference (e.g., docker://image:tag)
        platform: Target platform (e.g., linux/amd64, linux/arm64)
    """
    cmd = ['skopeo', 'inspect', '--format', '{{json .}}']
    
    # Add platform override if specified
    if platform:
        if '/' in platform:
            os_type, arch = platform.split('/', 1)
            cmd.extend(['--override-os', os_type, '--override-arch', arch])
        else:
            cmd.extend(['--override-os', 'linux', '--override-arch', platform])
    else:
        cmd.extend(['--override-os', 'linux', '--override-arch', 'amd64'])
    
    cmd.append(image_ref)
    
    try:
        log(f"Inspecting {image_ref}...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        error(f"Timeout inspecting image {image_ref}")
    except subprocess.CalledProcessError as e:
        error(f"Failed to inspect image {image_ref}: {e.stderr}")
    except json.JSONDecodeError as e:
        error(f"Failed to parse inspect output: {e}")

def extract_annotations(inspect_output: Dict) -> Dict:
    """
    Extract OCI image annotations from inspect output.
    
    Maps org.opencontainers.image.* labels to simple field names:
    - org.opencontainers.image.url -> url
    - org.opencontainers.image.documentation -> documentation
    - org.opencontainers.image.source -> source
    - org.opencontainers.image.vendor -> vendor
    - org.opencontainers.image.description -> description
    """
    annotations = {}
    
    # Get labels from Config or root level
    config_data = inspect_output.get('Config', {}) or inspect_output.get('config', {}) or {}
    labels = config_data.get('Labels', {}) or inspect_output.get('Labels', {}) or {}
    
    # Extract annotations (remove org.opencontainers.image. prefix)
    if 'org.opencontainers.image.url' in labels:
        annotations['url'] = labels['org.opencontainers.image.url']
    
    if 'org.opencontainers.image.documentation' in labels:
        annotations['documentation'] = labels['org.opencontainers.image.documentation']
    
    if 'org.opencontainers.image.source' in labels:
        annotations['source'] = labels['org.opencontainers.image.source']
    
    if 'org.opencontainers.image.vendor' in labels:
        annotations['vendor'] = labels['org.opencontainers.image.vendor']
    
    if 'org.opencontainers.image.description' in labels:
        annotations['description'] = labels['org.opencontainers.image.description']
    
    return annotations

def main():
    parser = argparse.ArgumentParser(
        description='Extract OCI image annotations using skopeo',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('image', help='OCI image reference (e.g., mariadb:latest, ghcr.io/home-assistant/home-assistant:latest)')
    parser.add_argument('--tag', default='latest', help='Image tag (default: latest)')
    parser.add_argument('--platform', default='linux/amd64', help='Target platform (default: linux/amd64)')
    
    args = parser.parse_args()
    
    # Check if skopeo is available
    if not check_skopeo():
        error("skopeo is required but not found. Please install it with: apt install skopeo")
    
    # Parse image reference
    image_ref = parse_image_ref(args.image, args.tag)
    
    # Inspect image
    inspect_output = skopeo_inspect(image_ref, args.platform)
    
    # Extract annotations
    annotations = extract_annotations(inspect_output)
    
    # Output JSON to stdout
    print(json.dumps(annotations, indent=2))

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log("\nInterrupted by user")
        sys.exit(130)
    except Exception as e:
        error(f"Unexpected error: {str(e)}")

