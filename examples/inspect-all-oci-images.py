#!/usr/bin/env python3
"""
Script to extract all oci_image values from proxmox-community-scripts-analyse.md
and call inspect-ha-image.py for each image, collecting the results in a JSON array.

Usage:
    python3 inspect-all-oci-images.py [--output OUTPUT_FILE] [--platform PLATFORM] [--skip-errors]
    python3 inspect-all-oci-images.py --output oci-images-inspect.json --platform linux/amd64
"""

import json
import re
import subprocess
import sys
import argparse
from pathlib import Path
from typing import List, Dict, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import urllib.request
import urllib.parse

def log(message: str) -> None:
    """Print message to stderr (for logging)."""
    print(message, file=sys.stderr)

def error(message: str, exit_code: int = 1) -> None:
    """Print error to stderr and exit."""
    log(f"Error: {message}")
    sys.exit(exit_code)

def load_image_mappings(mappings_file: Optional[Path] = None) -> Dict[str, str]:
    """
    Load OCI image name mappings from JSON file.
    Returns a dict mapping incorrect names to correct names.
    """
    if mappings_file is None:
        mappings_file = Path(__file__).parent / 'oci-image-mappings.json'
    
    if not mappings_file.exists():
        return {}
    
    try:
        with open(mappings_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('mappings', {})
    except Exception as e:
        log(f"Warning: Could not load image mappings from {mappings_file}: {e}")
        return {}

def extract_oci_images_from_markdown(markdown_file: Path, image_mappings: Optional[Dict[str, str]] = None) -> List[str]:
    """
    Extract all oci_image values from the markdown table.
    Returns a list of unique image references.
    """
    oci_images = set()
    
    if not markdown_file.exists():
        error(f"Markdown file not found: {markdown_file}")
    
    log(f"Reading {markdown_file}...")
    with open(markdown_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find the table section (starts with | Anwendung | ... | oci_image |)
    table_start = content.find('| Anwendung |')
    if table_start == -1:
        error("Could not find table start in markdown file")
    
    table_content = content[table_start:]
    
    # Extract all table rows
    # Pattern: | app_name | ... | `oci_image` | or | app_name | ... | oci_image |
    # The oci_image column is the last column before the final |
    table_rows = re.findall(r'^\|(.+)\|$', table_content, re.MULTILINE)
    
    log(f"Found {len(table_rows)} table rows")
    
    row_count = 0
    for row in table_rows:
        row_count += 1
        
        # Skip header row (first row with "Anwendung")
        if row_count == 1:
            continue
        
        # Split by | - keep all columns (including empty ones)
        # The split includes leading/trailing empty strings, so we need to filter
        parts = row.split('|')
        # Remove leading/trailing empty strings from split
        while parts and not parts[0].strip():
            parts.pop(0)
        while parts and not parts[-1].strip():
            parts.pop()
        
        # Skip if we don't have enough parts
        if len(parts) < 6:  # Need at least 6 columns (Anwendung, Debian, Alpine, Kategorie, Migrations-Gruppe, oci_image)
            continue
        
        # Get all columns, preserving empty ones
        columns = [p.strip() for p in parts]
        
        # Skip separator rows (all columns contain only dashes)
        if all(c.strip('-').strip() == '' for c in columns if c):
            continue
        
        # Get the last column (oci_image)
        oci_image = columns[-1] if columns else ''
        
        # Skip if it's the header text "oci_image"
        if oci_image.lower() == 'oci_image':
            continue
        
        # Remove backticks if present
        oci_image = oci_image.strip('`').strip()
        
        # Skip empty values, "-", and placeholder values
        if not oci_image or oci_image == '-' or oci_image == '`-`' or oci_image == '':
            continue
        
        # Skip if it contains only dashes (separator rows sometimes get parsed)
        if oci_image.strip('-').strip() == '':
            continue
        
        # Skip if it looks invalid (contains only special chars, too short, etc.)
        if len(oci_image) < 2:
            continue
        
        # Skip if it's mostly dashes (likely a separator row)
        if oci_image.count('-') > len(oci_image) * 0.7:
            continue
        
        # Validate: should contain at least one letter or digit (not just special chars)
        if not re.search(r'[a-zA-Z0-9]', oci_image):
            continue
        
        # Apply mapping if available
        if image_mappings and oci_image in image_mappings:
            mapped_image = image_mappings[oci_image]
            log(f"  Mapping {oci_image} -> {mapped_image}")
            oci_images.add(mapped_image)
        else:
            oci_images.add(oci_image)
    
    log(f"Extracted {len(oci_images)} unique OCI images")
    return sorted(list(oci_images))

def check_repo_exists(namespace: str, image_name: str) -> bool:
    """
    Check if a Docker Hub repository exists directly.
    Returns True if the repository exists, False otherwise.
    """
    try:
        url = f"https://hub.docker.com/v2/repositories/{namespace}/{image_name}/"
        request = urllib.request.Request(url)
        request.add_header('Accept', 'application/json')
        
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data.get('name') == image_name
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        # For other HTTP errors, return False (rate limit, etc.)
        return False
    except Exception:
        return False

def check_image_has_latest_tag(repo_name: str) -> bool:
    """
    Check if a Docker Hub repository has a 'latest' tag.
    Returns True if latest tag exists, False otherwise.
    """
    try:
        namespace, image = repo_name.split('/', 1) if '/' in repo_name else ('library', repo_name)
        url = f"https://hub.docker.com/v2/repositories/{namespace}/{image}/tags/latest"
        request = urllib.request.Request(url)
        request.add_header('Accept', 'application/json')
        
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data.get('name') == 'latest'
    except urllib.error.HTTPError:
        return False  # 404 means no latest tag
    except Exception:
        return False  # Assume no latest tag on error

def search_dockerhub_image(image_name: str, max_results: int = 10) -> Optional[str]:
    """
    Search Docker Hub for an image by name using multiple strategies.
    Returns the best matching image reference with namespace, or None if not found.
    
    Prefers images with 'latest' tag and higher star counts.
    """
    try:
        # Strategy 1: Use v2 API which provides better metadata (star_count, pull_count)
        query = urllib.parse.quote(image_name)
        url_v2 = f"https://hub.docker.com/v2/search/repositories?q={query}&page_size={max_results}"
        request_v2 = urllib.request.Request(url_v2)
        request_v2.add_header('Accept', 'application/json')
        
        with urllib.request.urlopen(request_v2, timeout=10) as response_v2:
            data_v2 = json.loads(response_v2.read().decode())
            results = data_v2.get('results', [])
            
            if results:
                # Filter for exact matches (repo name ends with image_name)
                exact_matches = []
                for result in results:
                    repo_name = result.get('repo_name', '')
                    if repo_name and repo_name.endswith(f'/{image_name}'):
                        parts = repo_name.split('/')
                        if len(parts) == 2 and parts[1] == image_name:
                            exact_matches.append(result)
                
                # Prefer exact matches with latest tag and high star count
                if exact_matches:
                    # Sort by star_count descending (most popular first)
                    sorted_matches = sorted(exact_matches, key=lambda x: x.get('star_count', 0), reverse=True)
                    
                    # Check first few for latest tag (limit to 3 to avoid too many API calls)
                    # Prioritize images with latest tag
                    images_with_latest = []
                    images_without_latest = []
                    
                    for match in sorted_matches[:5]:  # Check top 5
                        repo_name = match.get('repo_name')
                        if repo_name:
                            if check_image_has_latest_tag(repo_name):
                                images_with_latest.append((repo_name, match))
                            else:
                                images_without_latest.append((repo_name, match))
                    
                    # Return first image with latest tag, or most popular without latest tag
                    if images_with_latest:
                        return images_with_latest[0][0]
                    elif images_without_latest:
                        log(f"    ⚠ Found {images_without_latest[0][0]} but it has no 'latest' tag")
                        return images_without_latest[0][0]  # Return anyway, inspection will fail with better error
                    
                    # Fallback to first exact match
                    return sorted_matches[0].get('repo_name')
                
                # If no exact matches, return most popular result
                if results:
                    sorted_results = sorted(results, key=lambda x: x.get('star_count', 0), reverse=True)
                    return sorted_results[0].get('repo_name')
        
        # Fallback: Try search.data endpoint
        url_search = f"https://hub.docker.com/search.data?q={query}"
        request_search = urllib.request.Request(url_search)
        request_search.add_header('Accept', 'application/json')
        request_search.add_header('User-Agent', 'Mozilla/5.0')
        
        with urllib.request.urlopen(request_search, timeout=10) as response:
            raw_data = response.read().decode()
            repo_matches = re.findall(r'"id","([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)"', raw_data)
            
            if repo_matches:
                # Filter for exact matches
                exact_matches = [r for r in repo_matches if r.endswith(f'/{image_name}') or r == image_name]
                if exact_matches:
                    return exact_matches[0]
                return repo_matches[0] if repo_matches else None
    
    except Exception as e:
        log(f"    ⚠ Docker Hub search failed for {image_name}: {e}")
    
    return None

def inspect_oci_image(image_ref: str, platform: str = 'linux/amd64', script_path: Path = None, 
                      auto_search: bool = True) -> Optional[Dict]:
    """
    Call inspect-ha-image.py for a single OCI image.
    Returns the parsed JSON output or None if failed.
    """
    if script_path is None:
        script_path = Path(__file__).parent / 'inspect-ha-image.py'
    
    if not script_path.exists():
        error(f"inspect-ha-image.py not found at {script_path}")
    
    try:
        # Call inspect-ha-image.py with stderr redirected (logs go to stderr)
        cmd = ['python3', str(script_path), image_ref, '--platform', platform]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout per image
            check=True
        )
        
        # Parse JSON output from stdout
        json_output = json.loads(result.stdout)
        
        # Add the original image reference to the output
        json_output['_original_image_ref'] = image_ref
        
        return json_output
    
    except subprocess.TimeoutExpired:
        log(f"  ⏱ Timeout inspecting {image_ref}")
        return {
            '_original_image_ref': image_ref,
            '_error': 'timeout',
            '_error_message': 'Inspection timed out after 5 minutes'
        }
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr[:500] if e.stderr else str(e)
        
        # Check for rate limiting errors
        is_rate_limited = (
            'toomanyrequests' in error_msg.lower() or
            'rate limit' in error_msg.lower() or
            'unauthenticated pull rate limit' in error_msg.lower()
        )
        
        if is_rate_limited:
            log(f"  ⚠ Rate limited for {image_ref} - Docker Hub rate limit reached")
            return {
                '_original_image_ref': image_ref,
                '_error': 'rate_limit',
                '_error_message': 'Docker Hub rate limit reached. Consider using authentication or reducing --max-workers.',
                '_retry_after': True  # Indicate this could be retried
            }
        
        # Check if this is a "not found" or "access denied" error that might benefit from searching
        # Only search if image doesn't already have a namespace (no '/' in the name)
        # Also check for "manifest unknown" which might indicate a missing namespace
        is_namespace_missing = '/' not in image_ref
        is_not_found_error = (
            'requested access to the resource is denied' in error_msg or 
            'manifest not found' in error_msg or
            'manifest unknown' in error_msg or
            'reading manifest' in error_msg
        )
        should_search = auto_search and is_namespace_missing and is_not_found_error
        
        if should_search:
            log(f"  🔍 Image {image_ref} not found, searching Docker Hub...")
            found_image = search_dockerhub_image(image_ref)
            
            if found_image and found_image != image_ref:
                log(f"  ✓ Found image on Docker Hub: {found_image}, retrying inspection...")
                # Recursively try with the found image name (but disable auto_search to avoid infinite loops)
                result = inspect_oci_image(found_image, platform, script_path, auto_search=False)
                if result and '_error' not in result:
                    # Mark that we used an alternative image
                    result['_original_image_ref'] = image_ref
                    result['_found_image_ref'] = found_image
                    log(f"  ✓ Successfully inspected {found_image} (original: {image_ref})")
                    return result
                else:
                    # The found image also failed - check if it's a manifest/tag issue
                    if result and '_error_message' in result:
                        error_msg_lower = result['_error_message'].lower()
                        if 'manifest unknown' in error_msg_lower or 'manifest not found' in error_msg_lower:
                            log(f"  ⚠ Found image {found_image} but it has no 'latest' tag or no manifest for platform {platform}")
                            # Return error with helpful message about the found image
                            return {
                                '_original_image_ref': image_ref,
                                '_found_image_ref': found_image,
                                '_error': 'no_latest_tag',
                                '_error_message': f"Image {found_image} exists on Docker Hub but has no 'latest' tag or no manifest for platform {platform}. Original search: {image_ref}"
                            }
                    log(f"  ✗ Found image {found_image} but inspection still failed: {result.get('_error_message', 'Unknown error') if result else 'No result'}")
        
        # Provide helpful hints
        hint = ''
        if 'requested access to the resource is denied' in error_msg or 'manifest not found' in error_msg:
            if not should_search:
                hint = ' (Hint: Image might not exist or might need a namespace prefix, e.g., username/image)'
        elif 'invalid reference format' in error_msg:
            hint = ' (Hint: Image reference format might be incorrect)'
        
        log(f"  ✗ Failed to inspect {image_ref}: {error_msg[:100]}{hint}")
        return {
            '_original_image_ref': image_ref,
            '_error': 'inspection_failed',
            '_error_message': error_msg + hint
        }
    except json.JSONDecodeError as e:
        log(f"  ✗ Failed to parse JSON for {image_ref}: {e}")
        return {
            '_original_image_ref': image_ref,
            '_error': 'json_parse_failed',
            '_error_message': str(e)
        }
    except Exception as e:
        log(f"  ✗ Unexpected error inspecting {image_ref}: {e}")
        return {
            '_original_image_ref': image_ref,
            '_error': 'unexpected_error',
            '_error_message': str(e)
        }

def load_existing_results(output_file: Path) -> Dict[str, Dict]:
    """
    Load existing results from output file.
    Returns a dict mapping image_ref -> result for quick lookup.
    """
    if not output_file.exists():
        return {}
    
    try:
        with open(output_file, 'r', encoding='utf-8') as f:
            existing_results = json.load(f)
        
        # Build lookup dict by _original_image_ref
        lookup = {}
        for result in existing_results:
            original_ref = result.get('_original_image_ref')
            if not original_ref:
                # Fallback: try to extract from image.name
                original_ref = result.get('image', {}).get('name', '')
            
            if original_ref:
                # Normalize for lookup (remove docker://, docker.io/, etc.)
                normalized_ref = original_ref.replace('docker://', '').replace('docker.io/', '')
                if normalized_ref.startswith('library/'):
                    normalized_ref = normalized_ref.replace('library/', '', 1)
                lookup[normalized_ref] = result
                # Also store with original ref as key
                lookup[original_ref] = result
        
        return lookup
    except Exception as e:
        log(f"Warning: Could not load existing results from {output_file}: {e}")
        return {}

def save_results_incremental(new_results: List[Dict], output_file: Path) -> None:
    """
    Save results incrementally, merging with existing file.
    This allows resuming from checkpoints and avoids re-inspecting successful images.
    """
    # Load existing results
    existing_lookup = load_existing_results(output_file)
    
    # Merge: new results overwrite existing ones
    for result in new_results:
        original_ref = result.get('_original_image_ref') or result.get('image', {}).get('name', '')
        if original_ref:
            # Normalize ref for lookup
            normalized_ref = original_ref.replace('docker://', '').replace('docker.io/', '')
            if normalized_ref.startswith('library/'):
                normalized_ref = normalized_ref.replace('library/', '', 1)
            existing_lookup[normalized_ref] = result
            # Also store with original ref as key
            existing_lookup[original_ref] = result
    
    # Convert back to list and save
    merged_results = list(existing_lookup.values())
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(merged_results, f, indent=2, ensure_ascii=False)

def filter_images_to_inspect(all_images: List[str], existing_results: Dict[str, Dict], 
                            retry_failed: bool = False) -> tuple:
    """
    Filter images that need to be inspected based on existing results.
    
    Args:
        all_images: All images to inspect
        existing_results: Dict of existing results (image_ref -> result)
        retry_failed: If True, retry failed images. If False, skip all previously processed images (successful and failed).
    
    Returns:
        Tuple of (images_to_inspect, successful_skipped, failed_skipped, failed_retrying)
        - successful_skipped: Count of successfully inspected images being skipped
        - failed_skipped: Count of failed images being skipped (only if retry_failed=False)
        - failed_retrying: Count of failed images being retried (only if retry_failed=True)
    """
    images_to_inspect = []
    successful_skipped = 0
    failed_skipped = 0
    failed_retrying = 0
    
    for image_ref in all_images:
        # Normalize for lookup
        normalized_ref = image_ref.replace('docker://', '').replace('docker.io/', '')
        if normalized_ref.startswith('library/'):
            normalized_ref = normalized_ref.replace('library/', '', 1)
        
        existing = existing_results.get(normalized_ref) or existing_results.get(image_ref)
        
        if existing:
            # Check if this result has an error
            has_error = '_error' in existing
            
            if has_error:
                # Previously failed - only retry if --retry-failed is set
                if retry_failed:
                    images_to_inspect.append(image_ref)
                    failed_retrying += 1
                else:
                    # Skip failed images by default
                    failed_skipped += 1
            else:
                # Already successfully inspected - always skip
                successful_skipped += 1
        else:
            # Not yet inspected - needs inspection
            images_to_inspect.append(image_ref)
    
    return images_to_inspect, successful_skipped, failed_skipped, failed_retrying

def inspect_all_images(oci_images: List[str], platform: str = 'linux/amd64', 
                       max_workers: int = 1, skip_errors: bool = False, 
                       delay_between_requests: float = 216.0, 
                       checkpoint_file: Optional[Path] = None,
                       existing_results: Optional[Dict[str, Dict]] = None) -> List[Dict]:
    """
    Inspect all OCI images, optionally in parallel.
    Returns a list of inspection results.
    
    Args:
        oci_images: List of image references to inspect
        platform: Target platform (e.g., linux/amd64)
        max_workers: Maximum parallel workers (default: 1 to stay within Docker Hub rate limits)
        skip_errors: Skip failed images instead of including error entries
        delay_between_requests: Delay in seconds between inspect requests (default: 216s = Docker Hub limit)
        checkpoint_file: Path to file for incremental checkpoint saves (optional)
        existing_results: Existing results dict to merge with when saving checkpoints
    
    Note:
        Docker Hub rate limit: 100 requests per 6 hours = ~216 seconds per request.
        Only inspect/config requests are delayed, search requests are NOT delayed.
    """
    results = []
    total = len(oci_images)
    rate_limit_encountered = False
    rate_limit_count = 0
    
    log(f"\nInspecting {total} OCI images (platform: {platform}, max_workers: {max_workers})...")
    log(f"  ⚠ Docker Hub rate limit: 100 requests per 6 hours = ~216 seconds per request")
    log(f"  💡 Current delay: {delay_between_requests}s between inspect requests")
    log(f"  ℹ️  Note: Search requests are NOT delayed, only inspect/config requests are delayed")
    
    # Calculate estimated time
    estimated_seconds = total * delay_between_requests
    estimated_hours = estimated_seconds / 3600
    if estimated_hours > 1:
        log(f"  ⏱ Estimated time: ~{estimated_hours:.1f} hours ({estimated_seconds/60:.0f} minutes) at {delay_between_requests}s per request")
    else:
        log(f"  ⏱ Estimated time: ~{estimated_seconds/60:.0f} minutes at {delay_between_requests}s per request")
    
    if delay_between_requests < 200:
        log(f"  ⚠ Warning: Delay ({delay_between_requests}s) is below recommended 216s for Docker Hub limits")
        log(f"  💡 This may cause rate limiting. Consider using --delay-between-requests 216")
    if max_workers > 1:
        effective_rate = max_workers / delay_between_requests * 3600  # requests per hour
        log(f"  ⚠ Warning: Parallelism (--max-workers {max_workers}) multiplies rate limit consumption")
        log(f"  ⚠ Effective rate: ~{effective_rate:.0f} requests/hour (limit: ~16.7 req/h = 100/6h)")
        if effective_rate > 17:
            log(f"  ⚠ This will exceed Docker Hub rate limits! Consider using --max-workers 1")
    
    start_time = time.time()
    
    # Use ThreadPoolExecutor for parallel inspection
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all tasks (with auto_search enabled by default)
        future_to_image = {
            executor.submit(inspect_oci_image, image_ref, platform, None, True): image_ref
            for image_ref in oci_images
        }
        
        # Process completed tasks
        completed = 0
        last_request_time = time.time()
        last_checkpoint_save = time.time()
        checkpoint_interval = 30  # Save checkpoint every 30 seconds
        
        for future in as_completed(future_to_image):
            image_ref = future_to_image[future]
            completed += 1
            
            # Add delay between requests to reduce rate limiting risk
            if delay_between_requests > 0:
                time_since_last = time.time() - last_request_time
                if time_since_last < delay_between_requests:
                    time.sleep(delay_between_requests - time_since_last)
                last_request_time = time.time()
            
            try:
                result = future.result()
                if result:
                    results.append(result)
                    
                    # Save checkpoint periodically to avoid losing progress
                    if checkpoint_file and (time.time() - last_checkpoint_save) >= checkpoint_interval:
                        log(f"  💾 Saving checkpoint ({completed}/{total} completed)...")
                        # Merge with existing results if provided
                        if existing_results:
                            # Create a combined list for saving
                            all_results_for_checkpoint = list(existing_results.values()) + results
                            save_results_incremental(all_results_for_checkpoint, checkpoint_file)
                        else:
                            save_results_incremental(results, checkpoint_file)
                        last_checkpoint_save = time.time()
                    
                    # Track rate limiting
                    if result.get('_error') == 'rate_limit':
                        rate_limit_encountered = True
                        rate_limit_count += 1
                        if rate_limit_count >= 3:
                            log(f"\n  ⚠ Rate limit encountered {rate_limit_count} times!")
                            log(f"  💡 Consider: 1) Reducing --max-workers (current: {max_workers})")
                            log(f"                2) Adding delays with --delay-between-requests")
                            log(f"                3) Using Docker Hub authentication")
                            log(f"                4) Processing in smaller batches")
                    
                    # Show progress
                    elapsed = time.time() - start_time
                    avg_time = elapsed / completed if completed > 0 else 0
                    remaining = total - completed
                    eta = avg_time * remaining if avg_time > 0 else 0
                    
                    status = "✓" if '_error' not in result else "✗"
                    if result.get('_error') == 'rate_limit':
                        status = "⏸"
                    log(f"  [{completed}/{total}] {status} {image_ref} (ETA: {int(eta)}s)")
                else:
                    if not skip_errors:
                        log(f"  ✗ No result for {image_ref}")
                    elif skip_errors:
                        log(f"  ⊘ Skipping {image_ref} (error, but --skip-errors enabled)")
            except Exception as e:
                log(f"  ✗ Exception processing {image_ref}: {e}")
                if not skip_errors:
                    results.append({
                        '_original_image_ref': image_ref,
                        '_error': 'exception',
                        '_error_message': str(e)
                    })
        
        # Save final checkpoint
        if checkpoint_file and results:
            log(f"  💾 Saving final checkpoint...")
            # Merge with existing results if provided
            if existing_results:
                all_results_for_checkpoint = list(existing_results.values()) + results
                save_results_incremental(all_results_for_checkpoint, checkpoint_file)
            else:
                save_results_incremental(results, checkpoint_file)
    
    elapsed = time.time() - start_time
    
    # Summary with rate limit warnings
    log(f"\n✓ Completed inspection of {len(results)} images in {int(elapsed)}s")
    if rate_limit_encountered:
        successful = len([r for r in results if '_error' not in r])
        log(f"\n  ⚠ Rate limiting encountered: {rate_limit_count} images affected")
        log(f"  ✓ Successfully inspected: {successful}")
        log(f"  ✗ Failed due to rate limit: {rate_limit_count}")
        log(f"  💡 Tip: Re-run with --max-workers 1 and higher --delay-between-requests to process remaining images")
    
    return results

def main():
    parser = argparse.ArgumentParser(
        description='Extract OCI images from markdown and inspect them all',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 inspect-all-oci-images.py
  python3 inspect-all-oci-images.py --output oci-images.json --platform linux/amd64
  python3 inspect-all-oci-images.py --output oci-images.json --platform linux/arm64
  python3 inspect-all-oci-images.py --skip-errors
  # Default: --max-workers 1 --delay-between-requests 216 (Docker Hub: 100 req/6h)
  python3 inspect-all-oci-images.py --max-workers 1 --delay-between-requests 240  # Safer with buffer
  python3 inspect-all-oci-images.py --retry-failed  # Retry previously failed images
  python3 inspect-all-oci-images.py --no-resume     # Start fresh, ignore existing results
  python3 inspect-all-oci-images.py --retry-failed  # Retry previously failed images
  python3 inspect-all-oci-images.py --no-resume     # Start fresh, ignore existing results
        """
    )
    parser.add_argument(
        '--markdown-file',
        type=Path,
        default=Path(__file__).parent.parent / 'docs' / 'proxmox-community-scripts-analyse.md',
        help='Path to the markdown file containing the OCI image table (default: docs/proxmox-community-scripts-analyse.md)'
    )
    parser.add_argument(
        '--output',
        type=Path,
        default=Path('oci-images-inspect.json'),
        help='Output JSON file (default: oci-images-inspect.json). Existing results are loaded and merged.'
    )
    parser.add_argument(
        '--platform',
        default='linux/amd64',
        help='Target platform for inspection (default: linux/amd64)'
    )
    parser.add_argument(
        '--max-workers',
        type=int,
        default=1,
        help='Maximum number of parallel inspections (default: 1, Docker Hub limit: 100 requests/6h). Use 1 to stay within rate limits.'
    )
    parser.add_argument(
        '--delay-between-requests',
        type=float,
        default=216.0,
        help='Delay in seconds between inspect requests (default: 216 = ~3.6min, Docker Hub: 100 req/6h = 216s/req). Note: Search requests are NOT delayed, only inspect/config requests.'
    )
    parser.add_argument(
        '--skip-errors',
        action='store_true',
        help='Skip images that fail inspection instead of including error entries'
    )
    parser.add_argument(
        '--retry-failed',
        action='store_true',
        help='Retry previously failed images from existing results file'
    )
    parser.add_argument(
        '--no-resume',
        action='store_true',
        help='Ignore existing results file and inspect all images from scratch'
    )
    parser.add_argument(
        '--inspect-script',
        type=Path,
        default=None,
        help='Path to inspect-ha-image.py script (default: examples/inspect-ha-image.py)'
    )
    
    args = parser.parse_args()
    
    # Check if inspect-ha-image.py exists
    if args.inspect_script is None:
        args.inspect_script = Path(__file__).parent / 'inspect-ha-image.py'
    
    if not args.inspect_script.exists():
        error(f"inspect-ha-image.py not found at {args.inspect_script}")
    
    # Load existing results if resuming
    existing_results = {}
    if not args.no_resume and args.output.exists():
        log(f"Loading existing results from {args.output}...")
        existing_results = load_existing_results(args.output)
        log(f"  Found {len(existing_results)} existing inspection results")
    
    # Load image mappings (for correcting image names)
    image_mappings = load_image_mappings()
    if image_mappings:
        log(f"Loaded {len(image_mappings)} image name mappings")
    
    # Extract OCI images from markdown (apply mappings automatically)
    oci_images = extract_oci_images_from_markdown(args.markdown_file, image_mappings)
    
    if not oci_images:
        error("No OCI images found in markdown file")
    
    log(f"Found {len(oci_images)} unique OCI images to inspect")
    
    # Filter images that still need inspection
    images_to_inspect, successful_skipped, failed_skipped, failed_retrying = filter_images_to_inspect(
        oci_images, 
        existing_results,
        retry_failed=args.retry_failed
    )
    
    if successful_skipped > 0:
        log(f"  ⊘ Skipping {successful_skipped} successfully inspected images")
    if failed_skipped > 0:
        log(f"  ⊘ Skipping {failed_skipped} previously failed images (use --retry-failed to retry)")
    if failed_retrying > 0:
        log(f"  🔄 Retrying {failed_retrying} previously failed images")
    
    if not images_to_inspect:
        log(f"\n✓ All images already processed!")
        if successful_skipped > 0:
            log(f"  - Successfully inspected: {successful_skipped}")
        if failed_skipped > 0:
            log(f"  - Previously failed (skipped): {failed_skipped}")
        if failed_retrying > 0:
            log(f"  - Retrying failed images: {failed_retrying}")
        if failed_skipped > 0:
            log(f"  💡 Use --retry-failed to retry failed images")
        log(f"  💡 Use --no-resume to start fresh")
        # Still print summary from existing results
        if existing_results:
            all_results = list(existing_results.values())
            successful = len([r for r in all_results if '_error' not in r])
            failed = len([r for r in all_results if '_error' in r])
            rate_limited = len([r for r in all_results if r.get('_error') == 'rate_limit'])
            log(f"\nSummary from existing results:")
            log(f"  Total images: {len(all_results)}")
            log(f"  Successful: {successful}")
            log(f"  Failed: {failed}")
            if rate_limited > 0:
                log(f"    - Rate limited: {rate_limited}")
        return
    
    log(f"  → Inspecting {len(images_to_inspect)} remaining images")
    
    # Inspect remaining images (with checkpoint file for incremental saves)
    results = inspect_all_images(
        images_to_inspect,
        platform=args.platform,
        max_workers=args.max_workers,
        skip_errors=args.skip_errors,
        delay_between_requests=args.delay_between_requests,
        checkpoint_file=args.output,  # Use output file as checkpoint
        existing_results=existing_results if not args.no_resume else None  # Pass existing results for merge
    )
    
    # Save results incrementally (merge with existing)
    # Note: Checkpoint was already saved during inspection, but we merge here to ensure consistency
    log(f"\nSaving final results to {args.output}...")
    if args.no_resume:
        # Start fresh - overwrite existing file
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
    else:
        # Merge with existing results (includes checkpoint saves)
        save_results_incremental(results, args.output)
    
    # Load final results for summary
    final_results_dict = load_existing_results(args.output)
    all_results = list(final_results_dict.values())
    
    # Print summary
    successful = len([r for r in all_results if '_error' not in r])
    failed = len([r for r in all_results if '_error' in r])
    rate_limited = len([r for r in all_results if r.get('_error') == 'rate_limit'])
    
    log(f"\n✓ Summary:")
    log(f"  Total images: {len(oci_images)}")
    log(f"  Successfully inspected: {successful}")
    log(f"  Failed: {failed}")
    if rate_limited > 0:
        log(f"    - Rate limited: {rate_limited}")
    log(f"  Results written to: {args.output}")
    if failed > 0 and not args.retry_failed:
        log(f"\n  💡 Tip: Re-run with --retry-failed to retry failed images")

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log("\nInterrupted by user")
        sys.exit(130)
    except Exception as e:
        error(f"Unexpected error: {str(e)}")

