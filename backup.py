"""Atomic PostgreSQL, media, application and configuration backups, root only."""
import fcntl
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from releases import code_files

BASE=Path(__file__).resolve().parent


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source,'sha256').hexdigest()


def config_files():
    fixed=['/etc/travel-notes.env','/etc/nginx/nginx.conf','/etc/logrotate.d/nginx',
           '/var/lib/pgsql/data/postgresql.conf','/var/lib/pgsql/data/postgresql.auto.conf',
           '/var/lib/pgsql/data/pg_hba.conf','/var/lib/pgsql/data/pg_ident.conf']
    paths=[Path(p) for p in fixed]
    for pattern in ('systemd/system/travel-notes*','systemd/system/travel-agent.service','systemd/system/nginx.service.d/*.conf',
                    'systemd/system/postgresql.service.d/*.conf','systemd/system/logrotate.timer.d/*.conf',
                    'systemd/journald.conf.d/*travel*.conf','tmpfiles.d/travel-notes.conf','nginx/default.d/*.conf','nginx/conf.d/*.conf'):
        for p in Path('/etc').glob(pattern):
            paths.extend(p.rglob('*')) if p.is_dir() else paths.append(p)
    paths.append(Path('/usr/local/sbin/travel-notes-ops'))
    paths.append(Path('/usr/local/sbin/travel-agent-auth'))
    paths.extend(Path('/etc/letsencrypt').rglob('*'))
    for suffix in ('*.py','*.md'):
        paths.extend(Path('/opt/travel-agent').glob(suffix))
    return sorted(set(p for p in paths if p.is_file() and not p.is_symlink()))


def verify_archive(path):
    with tarfile.open(path) as archive:
        manifest=json.load(archive.extractfile('manifest.json'))
        actual=set()
        for member in archive:
            if member.name=='manifest.json': continue
            if not member.isfile() or member.name not in manifest['sha256']:
                raise ValueError('Unexpected backup member: '+member.name)
            actual.add(member.name)
            with archive.extractfile(member) as source:
                if hashlib.file_digest(source,'sha256').hexdigest()!=manifest['sha256'][member.name]:
                    raise ValueError('Backup checksum mismatch: '+member.name)
        if actual!=set(manifest['sha256']): raise ValueError('Backup is missing files.')
        return manifest


def prune_backups(target,keep=7,max_bytes=2*1024**3):
    archives=sorted(target.glob('travel-pg-*.tar.gz'),reverse=True)
    total=sum(p.stat().st_size for p in archives)
    while len(archives)>keep or (total>max_bytes and len(archives)>2):
        oldest=archives.pop();total-=oldest.stat().st_size;oldest.unlink()
    if total>max_bytes: print('Backup size exceeds 2 GiB; newest two copies retained.')


def backup():
    if os.geteuid()!=0: raise PermissionError('Complete backups must run as root.')
    os.umask(0o077)
    data=Path(os.environ.get('TRAVEL_DATA','/var/lib/travel-notes'))
    target=Path(os.environ.get('TRAVEL_BACKUP_DIR','/var/backups/travel-notes'))
    target.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (target/'.backup.lock').open('a') as lock, Path('/run/travel-notes-write.lock').open('rb') as writes:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        deadline=time.monotonic()+60
        while True:
            try:
                fcntl.flock(writes,fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic()>deadline: raise RuntimeError('Timed out waiting for active writes; old backups retained.')
                time.sleep(.2)
        if shutil.disk_usage(target).free<512*1024**2:
            raise RuntimeError('Less than 512 MiB free; backup aborted without deleting older copies.')
        timestamp=datetime.now(timezone.utc).isoformat(timespec='seconds')
        filename=target/('travel-pg-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.tar.gz')
        partial=filename.with_suffix('.partial')
        dsn=os.environ['TRAVEL_DATABASE_URL']
        with tempfile.TemporaryDirectory(prefix='travel-backup-',dir=target) as temp:
            dump=Path(temp)/'database.dump'
            with dump.open('wb') as output:
                subprocess.run(['runuser','-u','travelnotes','--','pg_dump','--dbname',dsn,'--format=custom','--no-owner','--no-acl'],stdout=output,check=True,timeout=600)
            subprocess.run(['pg_restore','--list',str(dump)],stdout=subprocess.DEVNULL,check=True,timeout=60)
            files={'database.dump':dump}
            for p in (data/'uploads').rglob('*'):
                if p.is_symlink(): raise ValueError('Uploads must not contain symbolic links.')
                if p.is_file(): files['uploads/'+str(p.relative_to(data/'uploads'))]=p
            files.update({'app/'+str(p.relative_to(BASE)):p for p in code_files()})
            files.update({'config/'+str(p).lstrip('/'):p for p in config_files()})
            cert_root=Path('/etc/letsencrypt')
            links={}
            for p in (cert_root/'live').rglob('*'):
                if p.is_symlink():
                    p.resolve(strict=True).relative_to(cert_root)
                    links[str(p).lstrip('/')]=os.readlink(p)
            if links:
                link_file=Path(temp)/'letsencrypt-symlinks.json'
                link_file.write_text(json.dumps(links,indent=2))
                files['config/letsencrypt-symlinks.json']=link_file
            manifest={'format':'travel-notes-backup-v3','database':'PostgreSQL','created_at':timestamp,'app_schema':3,
                'sha256':{name:digest(p) for name,p in files.items()},
                'restore':'Create an empty UTF-8 database with createdb --template=template0 --encoding=UTF8 --locale=C --owner=travelnotes NAME; restore database.dump using pg_restore --no-owner --no-acl --exit-on-error. Restore uploads separately with the app stopped. app contains source and requirements; config contains private deployment configuration and secrets. Review before applying configuration. Recreate the Python venv from requirements.'}
            try:
                with tarfile.open(partial,'w:gz') as archive:
                    for name,p in files.items(): archive.add(p,arcname=name,recursive=False)
                    raw=json.dumps(manifest,ensure_ascii=False,indent=2).encode()
                    info=tarfile.TarInfo('manifest.json');info.size=len(raw);info.mode=0o600
                    archive.addfile(info,io.BytesIO(raw))
                verify_archive(partial)
                partial.chmod(0o600);partial.replace(filename)
            finally: partial.unlink(missing_ok=True)
        update="import json;from database import connect;from psycopg.types.json import Jsonb;d=json.load(__import__('sys').stdin);c=connect(d['dsn']);c.execute(\"INSERT INTO settings(key,value) VALUES('last_backup',%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value\",(Jsonb(d['info']),));c.commit();c.close()"
        info={'filename':filename.name,'created_at':timestamp,'bytes':filename.stat().st_size}
        subprocess.run(['runuser','-u','travelnotes','--',str(BASE/'.venv/bin/python'),'-c',update],input=json.dumps({'dsn':dsn,'info':info}),text=True,check=True,cwd=BASE,timeout=30)
        prune_backups(target)
        print('Backup verified and created: '+filename.name)
        return filename


if __name__=='__main__': backup()
