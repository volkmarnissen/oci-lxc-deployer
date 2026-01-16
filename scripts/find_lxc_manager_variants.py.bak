#!/usr/bin/env python3
"""Find variants of "LXC Manager" in a repository.

Scans files recursively (skipping common VCS/build dirs), extracts matching
strings like "lxc-manager", "LXCManager", "lxc_manager", "lxcManager",
removes duplicates and prints a sorted list.

Usage: python3 scripts/find_lxc_manager_variants.py [path]
"""
import os
import re
import fnmatch
import argparse


DEFAULT_EXCLUDE_DIRS = {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv'}


def is_binary_file(path):
    try:
        with open(path, 'rb') as f:
            chunk = f.read(1024)
            return b'\0' in chunk
    except Exception:
        return True


def load_gitignore_patterns(root):
    gitignore = os.path.join(root, '.gitignore')
    patterns = []
    if not os.path.exists(gitignore):
        return patterns
    try:
        with open(gitignore, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if line.startswith('!'):
                    # ignore negations for now
                    continue
                # normalize trailing slash patterns
                if line.endswith('/'):
                    line = line.rstrip('/')
                patterns.append(line)
    except Exception:
        return []
    return patterns


def matches_gitignore(relpath, name, gitignore_patterns):
    # relpath: relative path from root to the item (posix style), name: basename
    for pat in gitignore_patterns:
        # direct match or prefix (for directories): 'alpine/cache' should match
        if '/' in pat:
            if relpath == pat or relpath.startswith(pat + '/'):
                return True
            # allow glob patterns like 'alpine/package/*'
            if fnmatch.fnmatch(relpath, pat):
                return True
        else:
            # match by basename or simple pattern
            if fnmatch.fnmatch(name, pat) or fnmatch.fnmatch(relpath, pat):
                return True
    return False


def find_variants(root, excludes, gitignore_patterns=None):
    if gitignore_patterns is None:
        gitignore_patterns = []
    pattern = re.compile(r'(?<!\w)(lxc[\s._\-]?manager|lxcmanager)(?!\w)', re.IGNORECASE)
    variants = {}

    root = os.path.abspath(root)

    for dirpath, dirnames, filenames in os.walk(root):
        # filter out excluded directories in-place so os.walk skips them
        kept = []
        for d in dirnames:
            rel = os.path.normpath(os.path.relpath(os.path.join(dirpath, d), root)).replace('\\', '/')
            if any(fnmatch.fnmatch(d, pat) for pat in excludes):
                continue
            if matches_gitignore(rel, d, gitignore_patterns):
                continue
            kept.append(d)
        dirnames[:] = kept

        # check current directory name for matches
        base = os.path.basename(dirpath)
        rel_base = os.path.normpath(os.path.relpath(dirpath, root)).replace('\\', '/')
        for m in pattern.finditer(base):
            token = m.group(0)
            variants.setdefault(token, set()).add(f'dir:{dirpath}')

        # check immediate subdirectory names for matches
        for d in list(dirnames):
            for m in pattern.finditer(d):
                token = m.group(0)
                variants.setdefault(token, set()).add(f'dir:{os.path.join(dirpath, d)}')

        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            # skip binary files
            if is_binary_file(fpath):
                continue
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                    for lineno, line in enumerate(f, start=1):
                        for m in pattern.finditer(line):
                            token = m.group(0)
                            variants.setdefault(token, set()).add(f'{fpath}:{lineno}')
            except Exception:
                # best effort: skip unreadable files
                continue

    return variants


def main():
    parser = argparse.ArgumentParser(description='Find variants of "LXC Manager" in files')
    parser.add_argument('path', nargs='?', default='.', help='Root path to search')
    parser.add_argument('--exclude', '-e', action='append', default=[], help='Additional directory names to exclude (can be repeated)')
    args = parser.parse_args()

    excludes = set(DEFAULT_EXCLUDE_DIRS) | set(args.exclude)
    gitignore_patterns = load_gitignore_patterns(args.path)

    variants = find_variants(args.path, excludes, gitignore_patterns)

    if not variants:
        print('No variants found.')
        return

    print('Found variants (unique, sorted):')
    for token in sorted(variants, key=lambda s: s.lower()):
        locations = sorted(list(variants[token]))
        print(f"{token}  -- {len(locations)} occurrence(s)")
        # print first example location
        print(f"  example: {locations[0]}")


if __name__ == '__main__':
    main()
