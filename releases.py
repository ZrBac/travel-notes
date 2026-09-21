"""Small code snapshots; rollback never overwrites the database or uploads."""
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = Path('/var/backups/travel-notes-releases')


def code_files(base=None):
    base = BASE if base is None else base
    paths = list(base.glob('*.py')) + [base/n for n in ('requirements.txt','schema.sql','README.md')]
    for directory in ('static','ops-config','tests'):
        paths.extend((base/directory).rglob('*'))
    return sorted(p for p in paths if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checkpoint(label=None):
    label = label or 'checkpoint'
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,50}',label): raise ValueError('Use a short ASCII checkpoint label.')
    ROOT.mkdir(mode=0o700,exist_ok=True)
    name = datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'-'+label
    path = ROOT/(name+'.tar.gz');temporary=path.with_suffix('.partial')
    manifest = {'format':1,'created':time.time(),'files':{str(p.relative_to(BASE)):sha(p) for p in code_files(BASE)}}
    try:
        with tarfile.open(temporary,'w:gz') as archive:
            for relative in manifest['files']: archive.add(BASE/relative,arcname='app/'+relative,recursive=False)
            import io
            data=json.dumps(manifest).encode();info=tarfile.TarInfo('release.json');info.size=len(data);info.mode=0o600
            archive.addfile(info,io.BytesIO(data))
        temporary.chmod(0o600);temporary.replace(path)
    finally: temporary.unlink(missing_ok=True)
    for old in sorted(ROOT.glob('*.tar.gz'),reverse=True)[5:]: old.unlink()
    print('Code checkpoint: '+name)
    return path


def unpack_release(path, destination):
    with tarfile.open(path) as archive:
        manifest = json.load(archive.extractfile('release.json'))
        expected = {'release.json'} | {'app/'+name for name in manifest['files']}
        members = archive.getmembers()
        if len(members) != len(expected) or any(not m.isfile() or m.name not in expected for m in members):
            raise ValueError('Invalid release archive.')
        for name in manifest['files']:
            parts = Path(name).parts
            if Path(name).is_absolute() or '..' in parts or not parts: raise ValueError('Invalid release path.')
        archive.extractall(destination,filter='data')
    for name, expected_hash in manifest['files'].items():
        if sha(destination/'app'/name) != expected_hash: raise ValueError('Release checksum mismatch: '+name)
    return manifest


def replace_code(source, manifest, base=None):
    base = BASE if base is None else base
    # Only tracked application files are replaced. Runtime data and the venv are untouched.
    for current in code_files(base):
        if str(current.relative_to(base)) not in manifest['files']: current.unlink()
    for name in manifest['files']:
        target=base/name;target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_suffix(target.suffix+'.next')
        shutil.copyfile(source/name,temporary);temporary.chmod(0o644);temporary.replace(target)
    for cache in (base/'__pycache__',):
        if cache.exists(): shutil.rmtree(cache)


def rollback(name):
    if not name or not re.fullmatch(r'[a-zA-Z0-9_-]+',name): raise ValueError('Specify a release name from versions.')
    path=ROOT/(name+'.tar.gz')
    if not path.is_file(): raise ValueError('Release not found.')
    with tempfile.TemporaryDirectory(prefix='travel-code-') as temp:
        stage=Path(temp);manifest=unpack_release(path,stage)
        for name in ('requirements.txt','schema.sql'):
            if manifest['files'].get(name) != sha(BASE/name):
                raise ValueError('Dependency or schema changes require a reviewed migration; automatic rollback refused.')
        subprocess.run(['systemctl','start','travel-notes-backup.service'],check=True,timeout=900)
        rescue=checkpoint('before-rollback')
        # The requested archive has already been extracted before checkpoint retention runs.
        subprocess.run([str(BASE/'.venv/bin/python'),str(BASE/'ops.py'),'pause','15'],check=True)
        try:
            subprocess.run(['systemctl','stop','travel-notes'],check=True,timeout=90)
            replace_code(stage/'app',manifest)
            subprocess.run(['systemctl','start','travel-notes'],check=True,timeout=90)
            import ops
            for _ in range(15):
                if ops.probe('http://127.0.0.1/api/health')==200 and ops.probe('http://127.0.0.1/',html=True)==200:
                    print('Rollback complete; database and uploads preserved.');break
                time.sleep(1)
            else: raise RuntimeError('Health check failed after rollback.')
        except Exception:
            subprocess.run(['systemctl','stop','travel-notes'],check=True,timeout=90)
            restore=stage/'rescue';restore.mkdir();old=unpack_release(rescue,restore)
            replace_code(restore/'app',old)
            subprocess.run(['systemctl','start','travel-notes'],check=True,timeout=90)
            raise
        finally:
            subprocess.run([str(BASE/'.venv/bin/python'),str(BASE/'ops.py'),'resume'],check=True)


def main(command,value=None):
    ROOT.mkdir(mode=0o700,exist_ok=True)
    with (ROOT/'lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if command=='checkpoint': checkpoint(value)
        elif command=='versions':
            for path in sorted(ROOT.glob('*.tar.gz'),reverse=True): print(path.name.removesuffix('.tar.gz'))
        else: rollback(value)
