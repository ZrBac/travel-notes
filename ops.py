"""Small, timer-driven maintenance; no resident monitoring process."""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE = Path('/var/lib/travel-notes-ops')
DATA = Path('/var/lib/travel-notes')
BACKUPS = Path('/var/backups/travel-notes')
SERVICES = ('postgresql', 'travel-notes', 'nginx')
COOLDOWN = 1800


def read_state():
    try:
        return json.loads((STATE/'status.json').read_text())
    except (OSError, ValueError):
        return {}


def write_state(value):
    path = STATE/'status.next'
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    path.chmod(0o600)
    path.replace(STATE/'status.json')


def probe(url, html=False):
    try:
        # Local checks must not use an environment-configured HTTP proxy.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=8) as response:
            body=response.read(65536 if html else 1024)
            good = b'<main id="app"' in body if html else json.loads(body).get('ok') is True
            return 200 if good else 502
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, ValueError):
        return 0


def choose_recovery(previous, direct, frontend, services, timestamp):
    """Do not restart PostgreSQL, intentionally stopped units, or during maintenance."""
    state = dict(previous)
    state.update(checked_at=timestamp, direct=direct, frontend=frontend, services=services)
    healthy = direct == frontend == 200
    state['failures'] = 0 if healthy else previous.get('failures', 0)+1
    if timestamp < previous.get('maintenance_until', 0):
        state['failures'] = 0
        return state, None
    if healthy or state['failures'] < 3 or timestamp-previous.get('last_recovery', 0) < COOLDOWN:
        return state, None
    if services.get('postgresql') != 'active' or direct == 503:
        return state, None
    target = 'nginx' if direct == 200 else 'travel-notes'
    if services.get(target) not in ('active', 'failed'):
        return state, None
    return state, target


def warnings(timestamp):
    result = []
    disk = shutil.disk_usage(DATA)
    if disk.used/disk.total >= .8:
        result.append('磁盘使用超过 80%，请检查日志、备份和上传文件。')
    archives = list(BACKUPS.glob('travel-pg-*.tar.gz'))
    if not archives or timestamp-max(p.stat().st_mtime for p in archives) > 36*3600:
        result.append('超过 36 小时没有成功备份。')
    backup_result = subprocess.run(['systemctl','show','travel-notes-backup','-p','Result','--value'], capture_output=True, text=True, timeout=5).stdout.strip()
    if backup_result and backup_result != 'success':
        result.append('最近一次备份任务失败，请查看 travel-notes-backup 日志。')
    return result


def check(repair=True):
    previous = read_state()
    timestamp = time.time()
    services = {name:subprocess.run(['systemctl','show',name,'-p','ActiveState','--value'],capture_output=True,text=True,timeout=5).stdout.strip() for name in SERVICES}
    direct = probe('http://127.0.0.1:8000/api/health')
    frontend = probe('http://127.0.0.1/api/health')
    if direct == 200: direct=probe('http://127.0.0.1:8000/',html=True)
    if frontend == 200: frontend=probe('http://127.0.0.1/',html=True)
    state, target = choose_recovery(previous, direct, frontend, services, timestamp)
    state['warnings'] = warnings(timestamp)
    if target and repair:
        state.update(last_recovery=timestamp, last_recovery_service=target)
        # Persist cooldown before any side effect, including failed restart attempts.
        write_state(state)
        if target == 'nginx' and subprocess.run(['nginx','-t'],capture_output=True,timeout=10).returncode:
            state['warnings'].append('Nginx 配置检查失败，已跳过自动重启。')
        else:
            result = subprocess.run(['systemctl','--no-block','restart',target],capture_output=True,timeout=10)
            state['recovery_queued'] = result.returncode == 0
            print(f'Health recovery: {target}; queued={result.returncode == 0}', flush=True)
    if state['warnings'] != previous.get('warnings', []):
        print('Maintenance warnings: '+json.dumps(state['warnings'],ensure_ascii=False),flush=True)
    if direct != 200 or frontend != 200:
        print(f'Health check: direct={direct}, nginx={frontend}, consecutive={state["failures"]}',flush=True)
    write_state(state)
    return state


def clean_data(data, timestamp):
    removed = 0
    root = data/'html-imports'
    if root.exists():
        for path in root.iterdir():
            if path.is_symlink() or not path.is_dir() or not re.fullmatch(r'[a-f0-9]{32}',path.name):
                continue
            try:
                created = float(json.loads((path/'manifest.json').read_text())['created'])
            except (OSError, ValueError, KeyError, TypeError):
                created = path.stat().st_mtime
            if timestamp-created > 86400:
                shutil.rmtree(path); removed += 1
    cache = data/'image-cache'
    files = sorted((p for p in cache.glob('*.webp') if p.is_file() and not p.is_symlink()),key=lambda p:p.stat().st_mtime) if cache.exists() else []
    total = sum(p.stat().st_size for p in files)
    for path in files:
        size = path.stat().st_size
        if timestamp-path.stat().st_mtime > 30*86400 or total > 256*1024*1024:
            path.unlink(); total -= size; removed += 1
    return removed


def cleanup():
    count = clean_data(DATA,time.time())
    for path in BACKUPS.glob('travel-pg-*.tar.partial'):
        if not path.is_symlink() and path.is_file() and time.time()-path.stat().st_mtime > 2*86400:
            path.unlink(); count += 1
    for path in BACKUPS.glob('travel-backup-*'):
        if not path.is_symlink() and path.is_dir() and time.time()-path.stat().st_mtime > 2*86400:
            shutil.rmtree(path); count += 1
    print(f'Maintenance cleanup: {count} expired previews/cache/partial files removed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check','status','cleanup','pause','resume','checkpoint','versions','rollback'])
    parser.add_argument('value',nargs='?')
    parser.add_argument('--no-repair',action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root.')
    STATE.mkdir(mode=0o700,exist_ok=True)
    if args.command in ('checkpoint','versions','rollback'):
        import releases
        return releases.main(args.command,args.value)
    with (STATE/'lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if args.command == 'check':
            result = check(not args.no_repair)
            if args.no_repair: print(json.dumps(result,ensure_ascii=False,indent=2))
        elif args.command == 'status':
            print(json.dumps(read_state(),ensure_ascii=False,indent=2))
        elif args.command == 'cleanup': cleanup()
        else:
            state = read_state()
            minutes = int(args.value or 30) if args.command == 'pause' else 0
            if not 0 <= minutes <= 1440: parser.error('Pause must be 0–1440 minutes.')
            state.update(maintenance_until=time.time()+minutes*60,failures=0)
            write_state(state)
            print(f'Automatic health recovery paused for {minutes} minutes.' if minutes else 'Automatic health recovery resumed.')


if __name__ == '__main__':
    main()
