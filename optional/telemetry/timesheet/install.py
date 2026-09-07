"""Install only manifest-listed skill files and agent profiles. Python 3.11+, stdlib."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

def inside(base: Path, relative: str) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or '..' in rel.parts:
        raise ValueError('Unsafe manifest path: ' + relative)
    result = (base / rel).resolve()
    if not result.is_relative_to(base.resolve()):
        raise ValueError('Path escapes install root: ' + relative)
    return result

def install(package: Path, target: Path, *, user=False, apply=False, force=False):
    package, target = package.resolve(), target.resolve()
    manifest = json.loads((package / 'install-manifest.json').read_text(encoding='utf-8'))
    name = manifest['skill_name']
    if not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
        raise ValueError('Invalid skill name')
    skill_prefix = ('skills/' if user else '.agents/skills/') + name
    pairs = [(entry, skill_prefix + '/' + entry) for entry in manifest['skill_files']]
    for asset in manifest['project_assets']:
        dest = asset['destination']
        if not dest.startswith('.codex/agents/') or not dest.endswith('.toml'):
            raise ValueError('Only agent profiles are installable project assets')
        pairs.append((asset['source'], dest.removeprefix('.codex/') if user else dest))
    operations = []
    destinations = set()
    for src, dst in pairs:
        source, destination = inside(package, src), inside(target, dst)
        if destination in destinations:
            raise ValueError('Duplicate destination')
        destinations.add(destination)
        if not source.is_file():
            raise ValueError('Missing package file: ' + src)
        action = 'create'
        if destination.exists():
            if not destination.is_file():
                raise ValueError('Destination is not a file: ' + str(destination))
            action = 'unchanged' if source.read_bytes() == destination.read_bytes() else 'replace'
        operations.append((source, destination, action))
    conflicts = [str(d) for _, d, action in operations if action == 'replace']
    if conflicts and apply and not force:
        raise ValueError('Existing files differ; review dry-run and use --force to back up and update: ' + ', '.join(conflicts))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    if apply:
        for source, destination, action in operations:
            if action == 'unchanged':
                continue
            if action == 'replace':
                backup = destination.parent / '.backups' / stamp / destination.name
                inside(target, str(backup.relative_to(target)))
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(destination, backup)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    return {'skill': name, 'scope': 'user' if user else 'project', 'applied': apply,
            'target': str(target), 'operations': [{'destination': str(d), 'action': a} for _, d, a in operations],
            'hooks_changed': False, 'project_instructions_changed': False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument('--project', type=Path)
    scope.add_argument('--user', action='store_true')
    parser.add_argument('--home', type=Path, help='Codex home override; only with --user')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    if args.home and not args.user:
        parser.error('--home requires --user')
    target = args.project if not args.user else args.home or Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    try:
        result = install(Path(__file__).resolve().parent, target, user=args.user, apply=args.apply, force=args.force)
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(1, str(exc) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
if __name__ == '__main__':
    main()
