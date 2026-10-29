#!/usr/bin/env python3
"""Build from an explicit, credential-free context; never send the whole repo."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tag', default='grounds-self-dev:0.2.41')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='grounds-dev-image-') as directory:
    context = Path(directory)
    for name in ['typescript/package.json', 'typescript/package-lock.json',
                 'typescript/binding.gyp', 'tui/package.json', 'tui/package-lock.json',
                 'scripts/dev-environment/Dockerfile', 'scripts/dev-environment/grounds-dev',
                 'scripts/dev-environment/dependency-fingerprint.mjs']:
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, target)
    for name in ['typescript/native', 'typescript/vendor']:
        shutil.copytree(root / name, context / name)
    subprocess.run(['docker', 'build', '--progress=plain', '--label',
                    'grounds.purpose=self-development', '--build-arg', f'GROUNDS_DEV_UID={os.getuid()}',
                    '--build-arg', f'GROUNDS_DEV_GID={os.getgid()}', '-t', args.tag, '-f',
                    str(context / 'scripts/dev-environment/Dockerfile'), str(context)], check=True)
    subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.tag], check=True)
