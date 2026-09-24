#!/usr/bin/env python3
"""One-shot browser checks, shared lock and durable cooldown; no automatic retry."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

MIN_GAP=10*60
BLOCK_GAP=30*60
ERROR_GAP=15*60

def save(path,data):
    temporary=path.with_suffix(path.suffix+'.next')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    temporary.chmod(0o600);temporary.replace(path)

def read_state(folder):
    path=folder/'control.json'
    if not path.exists():return {'next_allowed_at':0,'last_result':'never_run'}
    data=json.loads(path.read_text())
    if not isinstance(data,dict) or type(data.get('next_allowed_at')) not in (int,float) or not 0<=data['next_allowed_at']<10**12:
        raise ValueError('Invalid cooldown state')
    return data

def check(folder,command,now=None,timeout=100):
    folder=Path(folder);folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (folder/'run.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'result':'busy','browser_started':False}
        try:state=read_state(folder)
        except (OSError,ValueError,TypeError):return {'result':'state_error','browser_started':False}
        started=time.time() if now is None else now
        if state['next_allowed_at']>started:
            return {'result':'cooldown','browser_started':False,'next_allowed_at':state['next_allowed_at'],'last_result':state.get('last_result')}
        state={'started_at':started,'next_allowed_at':started+ERROR_GAP,'last_result':'incomplete'}
        save(folder/'control.json',state)
        result_path=folder/'last-run.json';result_path.unlink(missing_ok=True)
        env={**os.environ,'XHS_STATE_DIR':str(folder)}
        try:
            result=subprocess.run(command,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=timeout)
            report=json.loads(result_path.read_text())
            if not isinstance(report,dict) or report.get('result') not in ('login_ready','authenticated','blocked','request_limit','timeout','error','unavailable'):
                raise ValueError('Invalid browser report')
            outcome=report['result']
            if result.returncode and outcome not in ('blocked','request_limit','timeout','error'):outcome='error'
        except subprocess.TimeoutExpired:
            outcome='timeout';report={'result':outcome}
        except (OSError,ValueError,TypeError):
            outcome='error';report={'result':outcome}
        finished=time.time() if now is None else now
        delay=BLOCK_GAP if outcome=='blocked' else ERROR_GAP if outcome in ('request_limit','timeout','error','unavailable') else MIN_GAP
        state={'started_at':started,'finished_at':finished,'next_allowed_at':finished+delay,'last_result':outcome,
               'requests':report.get('requests',0),'request_types':report.get('request_types',{}),'trigger':report.get('trigger')}
        save(folder/'control.json',state)
        return {'result':outcome,'browser_started':True,**state}

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=('check','status'));args=parser.parse_args()
    folder=Path(os.environ.get('XHS_STATE_DIR','/var/lib/travel-xhs'))
    if args.action=='status':
        try:result=read_state(folder);result['cooldown_remaining_seconds']=max(0,round(result['next_allowed_at']-time.time()))
        except (OSError,ValueError,TypeError):result={'result':'state_error'}
    else:result=check(folder,['/usr/bin/node',str(Path(__file__).with_name('check.cjs'))])
    print(json.dumps(result,ensure_ascii=False))
    if result.get('result')=='state_error':raise SystemExit(1)

if __name__=='__main__':main()
