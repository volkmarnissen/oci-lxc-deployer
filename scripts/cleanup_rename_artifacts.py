#!/usr/bin/env python3
"""Cleanup directories left after a failed/partial rename run.

Reads `scripts/replace_lxc_manager_changes.json` by default and for each
directory rename pair attempts to merge contents from the source into the
destination if both exist, then removes the source directory.

Usage:
  python3 scripts/cleanup_rename_artifacts.py --dry-run
  python3 scripts/cleanup_rename_artifacts.py --manifest path/to/manifest.json --yes

Options:
  --dry-run   : show planned operations without performing them
  --manifest  : path to manifest file (default: scripts/replace_lxc_manager_changes.json)
  --yes       : do not ask for interactive confirmation
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def safe_within(root: Path, p: Path) -> bool:
    try:
        p.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def merge_and_remove(src: Path, dst: Path, dry_run: bool):
    actions = []
    if not src.exists():
        return actions
    if not dst.exists():
        actions.append(f"DEST_MISSING: would rename {src} -> {dst}")
        if not dry_run:
            src.rename(dst)
        return actions

    # both exist: move contents from src into dst
    for entry in sorted(src.iterdir()):
        s_entry = entry
        d_entry = dst / entry.name
        if s_entry.is_dir():
            actions.append(f"MERGE_DIR: move {s_entry} -> {d_entry}")
            if not dry_run:
                if d_entry.exists():
                    # merge recursively
                    merge_and_remove(s_entry, d_entry, dry_run=False)
                else:
                    shutil.move(str(s_entry), str(d_entry))
        else:
            actions.append(f"MOVE_FILE: {s_entry} -> {d_entry} {'(overwrite)' if d_entry.exists() else ''}")
            if not dry_run:
                if d_entry.exists():
                    # overwrite
                    try:
                        os.replace(str(s_entry), str(d_entry))
                    except Exception:
                        # fallback: remove dest then move
                        d_entry.unlink()
                        shutil.move(str(s_entry), str(d_entry))
                else:
                    shutil.move(str(s_entry), str(d_entry))

    # remove source dir if empty
    try:
        if not dry_run:
            if any(src.iterdir()):
                # if still has entries, remove recursively
                shutil.rmtree(str(src))
            else:
                src.rmdir()
        actions.append(f"REMOVE_DIR: {src}")
    except Exception as e:
        actions.append(f"REMOVE_FAILED: {src} -> {e}")

    return actions


def main():
    parser = argparse.ArgumentParser(description='Cleanup rename artifacts from replace_lxc_manager run')
    parser.add_argument('--manifest', default='scripts/replace_lxc_manager_changes.json')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--yes', action='store_true')
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        print('Manifest not found:', manifest_path)
        sys.exit(2)

    repo_root = Path('.').resolve()

    with manifest_path.open('r', encoding='utf-8') as f:
        manifest = json.load(f)

    dir_pairs = manifest.get('dir_renames', [])
    planned = []

    for src, dst in dir_pairs:
        src_p = Path(src)
        dst_p = Path(dst)
        # safety: only operate inside repo
        if not safe_within(repo_root, src_p) or not safe_within(repo_root, dst_p):
            planned.append((src, dst, 'SKIP_OUTSIDE_REPO'))
            continue
        if src_p.exists() and dst_p.exists():
            planned.append((str(src_p), str(dst_p), 'BOTH_EXIST'))
        elif src_p.exists() and not dst_p.exists():
            planned.append((str(src_p), str(dst_p), 'SRC_ONLY'))
        else:
            planned.append((str(src_p), str(dst_p), 'SKIP'))

    if not args.yes:
        print('Planned actions:')
        for a in planned:
            print(' -', a[2], ':', a[0], '->', a[1])
        if args.dry_run:
            print('\nDry-run requested; no changes will be made.')
        else:
            ans = input('\nProceed with cleanup? [y/N]: ')
            if ans.lower() != 'y':
                print('Aborted by user')
                return

    summary = []
    for src, dst, status in planned:
        if status == 'BOTH_EXIST' or status == 'SRC_ONLY':
            actions = merge_and_remove(Path(src), Path(dst), dry_run=args.dry_run)
            summary.extend(actions)
        else:
            summary.append(f'SKIPPED: {src} -> {dst} ({status})')

    print('\nSummary:')
    for s in summary:
        print(' -', s)


if __name__ == '__main__':
    main()
