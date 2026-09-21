"""Single-process controller. All model/generated code runs under other UIDs."""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import subprocess
import time
import urllib.request

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from artifacts import copy_code, manifest, fingerprint, compare, replace
import travel_planner
from guide_visuals import compose
import uuid
import stat

LIVE=Path('/opt/travel-notes')
BASE=Path('/opt/travel-agent')
STATE=Path('/var/lib/travel-agent')
PRIVATE=STATE/'private'
WORK=STATE/'work'
TEST=Path('/var/lib/travel-agent-test')
HOME=STATE/'home'
PYTHON=str(LIVE/'.venv/bin/python')
UPLOADS=Path('/var/lib/travel-notes/uploads')
DB_USER=pwd.getpwnam('travelnotes')
STOP=False


class DatabaseBusy(Exception): pass


def db():
    # This controller is single-threaded: temporarily change only the peer identity.
    os.setegid(DB_USER.pw_gid);os.seteuid(DB_USER.pw_uid)
    try:
        return psycopg.connect('dbname=travelnotes user=travelnotes host=/var/run/postgresql',row_factory=dict_row,connect_timeout=5,
                                options='-c statement_timeout=10000 -c lock_timeout=3000')
    finally:
        os.seteuid(0);os.setegid(0)


def read(sql,args=(),one=False):
    with db() as c:
        cursor=c.execute(sql,args)
        return cursor.fetchone() if one else cursor.fetchall()


def write(sql,args=()):
    with open('/run/travel-notes-write.lock','rb') as guard:
        try: fcntl.flock(guard,fcntl.LOCK_SH|fcntl.LOCK_NB)
        except BlockingIOError: raise DatabaseBusy()
        with db() as c: c.execute(sql,args)


def update(task_id,status=None,result=None,report=None):
    sets=['updated_at=now()'];values=[]
    for key,value in [('status',status),('result',result),('report',Jsonb(report) if report is not None else None)]:
        if value is not None: sets.append(key+'=%s');values.append(value)
    write('UPDATE agent_tasks SET '+','.join(sets)+' WHERE id=%s',(*values,task_id))


def safe_text(text):
    text=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',str(text))
    text=re.sub(r'(?i)(Bearer\s+)[A-Za-z0-9._-]+',r'\1[已隐藏]',text)
    text=re.sub(r'\bsk-[A-Za-z0-9_-]{12,}', '[已隐藏密钥]',text)
    text=re.sub(r'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[已隐藏令牌]',text)
    return text


def command(args,timeout=15):
    result=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=timeout,
                          env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin','LANG':'C.UTF-8'},cwd='/')
    return (result.stdout+'\n'+result.stderr).strip()


def snapshot():
    try: health=json.loads(Path('/var/lib/travel-notes-ops/status.json').read_text())
    except (OSError,ValueError): health={}
    disk=shutil.disk_usage('/')
    versions=[p.name.removesuffix('.tar.gz') for p in sorted(Path('/var/backups/travel-notes-releases').glob('*.tar.gz'),reverse=True)]
    logged='Logged in using ChatGPT' in command(['/usr/local/sbin/travel-agent-auth','status'])
    return {'heartbeat':time.time(),'authenticated':logged,'auth':'ChatGPT 账号','health':health,
            'disk_free':disk.free,'disk_total':disk.total,'versions':versions[:5],'concurrency':2,'lanes':{'website':1,'travel':1},'task_timeout_minutes':20}


def heartbeat():
    data=snapshot()
    write("INSERT INTO settings(key,value) VALUES('agent_service',%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(Jsonb(data),))
    return data


def own_tree(path,user):
    account=pwd.getpwnam(user)
    for current,dirs,files in os.walk(path,followlinks=False):
        os.chown(current,account.pw_uid,account.pw_gid)
        for name in files:
            target=Path(current)/name
            if not target.is_symlink(): os.chown(target,account.pw_uid,account.pw_gid)


def stop_unit(unit):
    subprocess.run(['systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)


def launch(unit,user,cwd,args,log,writable,testing=False,input_path=None,memory=900,cpu=100):
    props=['NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','PrivateTmp=yes','PrivateDevices=yes',
           'ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectControlGroups=yes','RestrictSUIDSGID=yes',
           'CapabilityBoundingSet=','UMask=0077',f'MemoryMax={memory}M','MemorySwapMax=256M',f'CPUQuota={cpu}%',
           'TasksMax=96','RuntimeMaxSec=1200','TimeoutStopSec=10','KillMode=control-group',
           'InaccessiblePaths=/root /var/lib/travel-notes /var/lib/travel-notes-ops /var/backups /etc/travel-notes.env '+str(PRIVATE),
           'ReadWritePaths='+' '.join(map(str,writable)), 'LimitFSIZE=268435456']
    if not testing: props.append('InaccessiblePaths=/run/postgresql '+str(TEST))
    else: props.extend(['InaccessiblePaths='+str(HOME),'IPAddressDeny=any'])
    cmd=['systemd-run','--quiet','--wait','--pipe','--collect','--unit='+unit,'--uid='+user,'--working-directory='+str(cwd)]
    for prop in props: cmd+=['-p',prop]
    env=['PATH=/usr/local/bin:/usr/bin:/bin','LANG=C.UTF-8','PYTHONDONTWRITEBYTECODE=1']
    if not testing: env+=['HOME='+str(HOME),'CODEX_HOME='+str(HOME/'.codex'),'USER=travelagent']
    else: env+=['HOME='+str(TEST),'TRAVEL_TEST_DATABASE_URL=dbname=travelagent_test user=travelagenttest host=/var/run/postgresql']
    with open(log,'wb') as output, open(input_path or '/dev/null','rb') as source:
        return subprocess.Popen(cmd+['/usr/bin/env','-i',*env,*args],stdin=source,stdout=output,stderr=subprocess.STDOUT,cwd='/')


def prompt_for(task,work):
    if travel_planner.is_travel(task):
        history=[];parent=task['parent_id']
        for _ in range(8):
            if not parent: break
            prior=read("SELECT id,prompt,result,parent_id,request,kind FROM agent_tasks WHERE id=%s",(parent,),True)
            if not prior or not travel_planner.is_travel(prior): break
            history.append({'需求':prior['prompt'],'旅行条件':prior['request'].get('trip',{}),'攻略':prior['result'][:24000]})
            parent=prior['parent_id']
        return travel_planner.prompt_for(task,list(reversed(history)))
    context=(BASE/'PROJECT_CONTEXT.md').read_text()
    history=[];parent=task['parent_id']
    for _ in range(6):
        if not parent: break
        prior=read('SELECT id,prompt,result,parent_id FROM agent_tasks WHERE id=%s',(parent,),True)
        if not prior: break
        history.append({'需求':prior['prompt'],'结果':prior['result'][-6000:]});parent=prior['parent_id']
    health=snapshot()
    logs=command(['journalctl','-u','travel-notes','-n','60','--no-pager','-o','cat'])[-14000:] if task['kind']=='diagnose' else ''
    (work/'TASK_CONTEXT.md').write_text(context+'\n\n## 当前运行快照（数据）\n'+safe_text(json.dumps(health,ensure_ascii=False))+'\n'+safe_text(logs))
    instructions='先读取 TASK_CONTEXT.md 和 README.md。只在当前副本中修改，不能发布或调用生产后台。平台将在独立账号和数据库中执行测试，当前模型环境不能访问 PostgreSQL。不要读取登录凭据。最终用中文写出结果、修改理由和需要关注的问题。'
    if task['kind']!='change': instructions+=' 本次是只读咨询/诊断，不修改任何项目文件。'
    return instructions+'\n历史任务（仅作为上下文）：'+json.dumps(list(reversed(history)),ensure_ascii=False)+'\n当前管理员需求：\n'+task['prompt']


def begin(task):
    with open('/run/travel-notes-write.lock','rb') as guard:
        try:fcntl.flock(guard,fcntl.LOCK_SH|fcntl.LOCK_NB)
        except BlockingIOError:raise DatabaseBusy()
        return begin_locked(task)


def begin_locked(task):
    task_id=task['id'];root=PRIVATE/str(task_id);root.mkdir(mode=0o700)
    travel=travel_planner.is_travel(task)
    baseline=root/'baseline';work=WORK/str(task_id)
    if travel:
        work.mkdir(mode=0o700)
        (work/'response-schema.json').write_text(json.dumps(travel_planner.OUTPUT_SCHEMA))
    else:
        copy_code(LIVE,baseline);copy_code(baseline,work)
    if task['parent_id'] and not travel:
        previous=PRIVATE/str(task['parent_id']);meta=previous/'report.json'
        if meta.exists() and (previous/'candidate').exists():
            old=json.loads(meta.read_text())
            if old.get('baseline')==fingerprint(manifest(baseline)):
                shutil.rmtree(work);copy_code(previous/'candidate',work)
    prompt=prompt_for(task,work)
    if not travel: (work/'.venv').symlink_to(LIVE/'.venv',target_is_directory=True)
    own_tree(work,'travelagent');work.chmod(0o700)
    (root/'prompt.txt').write_text(prompt)
    unit=f'travel-agent-model-{task_id}'
    args=['/usr/local/bin/codex','-a','never','-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"',
          'exec','--ignore-user-config','--ignore-rules','--sandbox','workspace-write' if task['kind']=='change' else 'read-only',
          '--skip-git-repo-check','--ephemeral','--json','-']
    if travel:
        args[1:1]=['-c','web_search="live"','--disable','shell_tool','--disable','apps','--disable','multi_agent']
        args[-1:-1]=['--output-schema',str(work/'response-schema.json')]
    update(task_id,'running','正在检索目的地资料并规划行程。' if travel else '正在读取项目并执行任务。')
    proc=launch(unit,'travelagent',work,args,root/'model.log',[work,HOME/'.codex'],input_path=root/'prompt.txt',memory=640 if travel else 900,cpu=70 if travel else 100)
    return {'task':task,'phase':'model','process':proc,'unit':unit,'root':root,'work':work,'started':time.time(),'last_save':0,'result':''}


def model_output(path):
    data=path.read_bytes()[-2*1024**2:].decode(errors='replace');messages=[];progress=[];usage={};completed=False;errors=[];searches=set()
    for line in data.splitlines():
        try: event=json.loads(line)
        except ValueError: continue
        if event.get('type')=='turn.completed': usage=event.get('usage',{});completed=True
        if event.get('type') in ('error','turn.failed'): errors.append(safe_text(str(event.get('message') or event.get('error') or '模型调用失败'))[:1000])
        item=event.get('item',{})
        if item.get('type')=='web_search' and event.get('type')=='item.completed':
            searches.add(item.get('id') or str(len(searches)))
            action=item.get('action',{})
            query=item.get('query') or action.get('query') or action.get('url') or '查询旅行资料'
            progress.append('联网检索：'+safe_text(query)[:250])
        if event.get('type')=='item.completed' and item.get('type')=='agent_message': messages.append(item.get('text',''))
        if item.get('type')=='command_execution' and event.get('type')=='item.completed': progress.append('执行：'+safe_text(item.get('command',''))[:350])
        if item.get('type')=='file_change' and event.get('type')=='item.completed':
            progress.extend('修改：'+str(change.get('path','')) for change in item.get('changes',[]))
    return {'result':safe_text('\n\n'.join(messages))[-24000:],'last_message':safe_text(messages[-1]) if messages else '',
            'progress':progress[-15:],'usage':usage,'completed':completed,'errors':errors[-3:],'web_search_count':len(searches)}


def start_tests(active,report):
    root=active['root'];task_id=active['task']['id'];testwork=TEST/str(task_id)
    copy_code(root/'candidate',testwork)
    baseline_tests=TEST/('baseline-'+str(task_id));shutil.copytree(root/'baseline'/'tests',baseline_tests)
    baseline_tests.chmod(0o755)
    # Bind baseline tests to the candidate without executing any candidate as root.
    for p in baseline_tests.glob('test*.py'):
        content=p.read_text().replace("str(Path(__file__).resolve().parents[1])","os.environ.get('TRAVEL_CANDIDATE_ROOT',str(Path(__file__).resolve().parents[1]))")
        if 'import os' not in content: content='import os\n'+content
        p.write_text(content)
        p.chmod(0o644)
    (testwork/'.venv').symlink_to(LIVE/'.venv',target_is_directory=True)
    own_tree(testwork,'travelagenttest')
    unit=f'travel-agent-tests-{task_id}'
    update(task_id,'testing',report=report)
    process=launch(unit,'travelagenttest',testwork,[PYTHON,str(BASE/'check_candidate.py'),str(testwork),str(baseline_tests)],root/'tests.log',[testwork],testing=True)
    active.update(phase='tests',process=process,unit=unit,testwork=testwork,baseline_tests=baseline_tests,report=report,started=time.time())


def finish_step(active):
    task=active['task'];task_id=task['id'];root=active['root'];process=active['process']
    cancelled=read('SELECT cancel_requested FROM agent_tasks WHERE id=%s',(task_id,),True)['cancel_requested']
    if cancelled or STOP:
        stop_unit(active['unit']);process.wait(timeout=15);update(task_id,'cancelled' if cancelled else 'failed','任务已取消。' if cancelled else '管家服务重启，任务已停止；可重新提交。');return True
    if time.time()-active['started']>1220:
        stop_unit(active['unit']);process.wait(timeout=15);update(task_id,'failed','任务超过 20 分钟限制，已停止。');return True
    if active['phase']=='photos':
        if process.poll() is None: return False
        stop_unit(active['unit'])
        finish_photos(active)
        return True
    if active['phase']=='model':
        data=model_output(root/'model.log')
        travel=travel_planner.is_travel(task)
        if time.time()-active['last_save']>3:
            update(task_id,result=('正在检索资料并整理完整攻略，请稍候。' if travel else data['result'] or '正在执行任务…'),
                   report={'progress':data['progress'],'usage':data['usage'],'web_search_count':data['web_search_count']})
            active['last_save']=time.time()
        if process.poll() is None: return False
        stop_unit(active['unit'])
        if process.returncode or not data['completed']:
            message='\n'.join(data['errors']) or safe_text((root/'model.log').read_text(errors='replace')[-1500:])
            update(task_id,'failed',data['result']+'\n任务未完成：'+message);return True
        if travel:
            try: guide=travel_planner.parse_answer(data['last_message'])
            except ValueError as error:
                update(task_id,'failed',str(error),{'progress':data['progress'],'web_search_count':data['web_search_count']});return True
            if guide.get('highlights'):
                start_photos(active,guide,data);return False
            update(task_id,'done',guide['body'],{'travel_guide':guide,'usage':data['usage'],'progress':data['progress'],'web_search_count':data['web_search_count']})
            return True
        if task['kind']!='change':
            update(task_id,'done',data['result'],{'usage':data['usage'],'progress':data['progress']});return True
        # The transient cgroup has stopped; model processes can no longer mutate the artifact.
        candidate=root/'candidate';copy_code(active['work'],candidate)
        report=compare(root/'baseline',candidate);report.update(usage=data['usage'],progress=data['progress'],publishable=False)
        (root/'report.json').write_text(json.dumps(report,ensure_ascii=False))
        update(task_id,result=data['result'],report=report)
        if not report['files']: update(task_id,'done');return True
        if report['manual_files']:
            report['reason']='涉及数据库、依赖、运维或新增后端模块，需单独审核部署。';update(task_id,'manual',report=report);return True
        start_tests(active,report);return False
    if process.poll() is None: return False
    stop_unit(active['unit'])
    report=active['report'];report['tests']=safe_text((root/'tests.log').read_text(errors='replace'))[-16000:]
    report['tests_passed']=process.returncode==0;report['publishable']=process.returncode==0
    (root/'report.json').write_text(json.dumps(report,ensure_ascii=False))
    update(task_id,'ready' if report['publishable'] else 'failed',report=report)
    return True



def start_photos(active,guide,data):
    root=active['root'];work=active['work'];task_id=active['task']['id']
    spec=work/'photo-guide.json';spec.write_text(json.dumps(guide,ensure_ascii=False));os.chown(spec,pwd.getpwnam('travelagent').pw_uid,pwd.getpwnam('travelagent').pw_gid)
    unit=f'travel-agent-photos-{task_id}'
    update(task_id,result='路线和美食已整理，正在配入景点与菜品照片。',report={'progress':data['progress'],'web_search_count':data['web_search_count']})
    process=launch(unit,'travelagent',work,[PYTHON,str(BASE/'photo_worker.py'),str(spec),str(work/'photos')],root/'photos.log',[work],memory=256,cpu=40)
    active.update(phase='photos',unit=unit,process=process,guide=guide,model_data=data,started=time.time())


def finish_photos(active):
    """Commit cached photos and task reference together under the backup write guard."""
    task_id=active['task']['id'];guide=dict(active['guide']);data=active['model_data'];folder=active['work']/'photos'
    metadata=folder/'photos.json';photos={};created=[]
    if metadata.is_file() and not metadata.is_symlink() and metadata.stat().st_size<100000:
        try:photos=json.loads(metadata.read_text())
        except ValueError:pass
    if not isinstance(photos,dict):photos={}
    with open('/run/travel-notes-write.lock','rb') as guard:
        try:fcntl.flock(guard,fcntl.LOCK_SH|fcntl.LOCK_NB)
        except BlockingIOError:raise DatabaseBusy()
        try:
            with db() as c:
                cached={}
                for key,photo in list(photos.items())[:8]:
                    if not re.fullmatch(r'(highlights|foods)-[0-9]',key) or not isinstance(photo,dict):continue
                    field,index=key.split('-')
                    if int(index)>=len(guide.get(field,[])):continue
                    filename=key+'.webp';path=folder/filename
                    if path.is_symlink() or not path.is_file():continue
                    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
                    with os.fdopen(fd,'rb') as source:
                        info=os.fstat(source.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_size>500000:continue
                        raw=source.read(500001)
                    if raw[:4]!=b'RIFF' or raw[8:12]!=b'WEBP':continue
                    if not all(type(photo.get(k)) is int and 1<=photo[k]<=960 for k in ('width','height')):continue
                    if not all(isinstance(photo.get(k),str) and len(photo[k])<=1000 for k in ('source','title','author','license','license_url')):continue
                    name=uuid.uuid4().hex+'.webp';target=UPLOADS/name
                    with target.open('xb') as output:output.write(raw)
                    created.append(target);os.chown(target,DB_USER.pw_uid,DB_USER.pw_gid);target.chmod(0o600)
                    c.execute('INSERT INTO media(filename,name,bytes,width,height) VALUES(%s,%s,%s,%s,%s)',(name,'攻略配图 · '+guide[field][int(index)]['name'],len(raw),photo['width'],photo['height']))
                    cached[key]={**photo,'url':'/media/'+name};cached[key].pop('file',None)
                guide['body']=compose(guide,cached)
                if len(guide['body'])>100000:raise ValueError('图文攻略过长，请减少目的地或分段规划后重试')
                guide['cover']=next((v['url'] for k,v in cached.items() if k.startswith('highlights-')),'/static/assets/lake.jpg')
                report={'travel_guide':guide,'photos':cached,'photo_count':len(cached),'usage':data['usage'],'progress':data['progress'],'web_search_count':data['web_search_count']}
                c.execute("UPDATE agent_tasks SET status='done',result=%s,report=%s,updated_at=now() WHERE id=%s",(guide['body'],Jsonb(report),task_id))
        except Exception:
            for path in created:path.unlink(missing_ok=True)
            raise

def probe():
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1/api/health',timeout=3) as response: return json.load(response).get('ok') is True
    except Exception: return False


def checked(args,timeout=120):
    result=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=timeout,cwd='/')
    if result.returncode: raise RuntimeError(safe_text(result.stderr or result.stdout)[-1500:])
    return result.stdout


def recover_release():
    journal=PRIVATE/'deployment.json'
    if not journal.exists(): return
    data=json.loads(journal.read_text());rescue=PRIVATE/str(int(data['task_id']))/'rescue'
    checked(['systemctl','stop','travel-notes']);replace(rescue,LIVE);checked(['systemctl','start','travel-notes'])
    journal.unlink();checked(['/usr/local/sbin/travel-notes-ops','resume'])


def deploy(task):
    task_id=task['id'];folder=PRIVATE/str(task_id);folder.mkdir(mode=0o700,exist_ok=True)
    update(task_id,'publishing','正在备份、发布并检查网站。')
    if task['kind']=='publish':
        source=PRIVATE/str(int(task['parent_id']));report=json.loads((source/'report.json').read_text());candidate=source/'candidate'
        if not report.get('publishable') or task['request'].get('artifact')!=report['artifact'] or fingerprint(manifest(candidate))!=report['artifact']:
            raise ValueError('候选版本校验失败，发布已取消')
        if fingerprint(manifest(LIVE))!=report['baseline']: raise ValueError('正式网站已更新，请基于当前版本重新生成候选')
    else:
        version=task['request'].get('version','')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,120}',version): raise ValueError('回退版本无效')
        # Trusted release reader only: the AI cannot change this file via automatic publishing.
        import sys
        sys.path.insert(0,str(LIVE))
        from releases import unpack_release
        sys.path.pop(0)
        target=folder/'rollback';target.mkdir();unpack_release(Path('/var/backups/travel-notes-releases')/(version+'.tar.gz'),target)
        candidate=target/'app'
        for name in ('schema.sql','requirements.txt','agent_api.py','travel_planner_api.py','backup.py','ops.py','releases.py','database.py'):
            if not (candidate/name).exists() or (candidate/name).read_bytes()!=(LIVE/name).read_bytes(): raise ValueError('此版本涉及结构、依赖或运维变化，需单独审核恢复')
        report={'baseline':fingerprint(manifest(LIVE))}
    checked(['systemctl','start','travel-notes-backup.service'],900)
    checked(['/usr/local/sbin/travel-notes-ops','checkpoint','agent-before-'+str(task_id)])
    checked(['/usr/local/sbin/travel-notes-ops','pause','15'])
    try:
        with open('/run/travel-notes-write.lock','rb') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX)
            if fingerprint(manifest(LIVE))!=report['baseline']: raise ValueError('正式代码在发布前发生变化，已停止发布')
            copy_code(LIVE,folder/'rescue')
            journal=PRIVATE/'deployment.json';journal.write_text(json.dumps({'task_id':task_id}))
            try:
                checked(['systemctl','stop','travel-notes']);replace(candidate,LIVE);checked(['systemctl','start','travel-notes'])
                for _ in range(15):
                    if probe(): break
                    time.sleep(1)
                else: raise RuntimeError('新版本健康检查未通过')
                journal.unlink()
            except Exception:
                checked(['systemctl','stop','travel-notes']);replace(folder/'rescue',LIVE);checked(['systemctl','start','travel-notes']);journal.unlink(missing_ok=True)
                raise
    finally: checked(['/usr/local/sbin/travel-notes-ops','resume'])
    checked(['/usr/local/sbin/travel-notes-ops','checkpoint','agent-live-'+str(task_id)])
    if task['kind']=='publish': update(task['parent_id'],'published')
    update(task_id,'done','已发布并通过健康检查。数据库与上传文件保留。' if task['kind']=='publish' else '代码已回退，网站健康检查通过。数据库与上传文件保留。')


def cleanup_task(active):
    work=active.get('work')
    if work and work.exists(): shutil.rmtree(work)
    testwork=active.get('testwork')
    if testwork and testwork.exists(): shutil.rmtree(testwork)
    baseline_tests=active.get('baseline_tests')
    if baseline_tests and baseline_tests.exists(): shutil.rmtree(baseline_tests)


def prune_artifacts():
    folders=sorted((p for p in PRIVATE.iterdir() if p.is_dir() and p.name.isdigit()),key=lambda p:int(p.name),reverse=True)
    for folder in folders[10:]:
        task=read('SELECT status,report FROM agent_tasks WHERE id=%s',(int(folder.name),),True)
        if task and task['status'] in ('queued','running','testing','publishing'): continue
        if task and task['status']=='ready':
            report=task['report'];report.update(publishable=False,reason='候选文件已按保留策略清理，请继续任务重新生成。')
            update(int(folder.name),'manual',report=report)
        shutil.rmtree(folder)


def fail_active(active,error):
    stop_unit(active['unit'])
    update(active['task']['id'],'failed','执行中断：'+safe_text(str(error))[:1500])
    cleanup_task(active)


def scheduler_step(active):
    """One slot per assistant; a failing task cannot cancel the other assistant."""
    for lane in ('website','travel'):
        current=active.get(lane)
        try:
            if current:
                if finish_step(current): cleanup_task(current);del active[lane]
                continue
            if STOP:continue
            scope="request->>'assistant' = 'travel'" if lane=='travel' else "request->>'assistant' IS DISTINCT FROM 'travel'"
            task=read("SELECT * FROM agent_tasks WHERE status='queued' AND "+scope+" ORDER BY id LIMIT 1",one=True)
            if not task:continue
            if task['cancel_requested']:update(task['id'],'cancelled','任务已取消。');continue
            try:
                if task['kind'] in ('publish','rollback'):deploy(task)
                elif shutil.disk_usage(STATE).free<1024**3:update(task['id'],'failed','可用磁盘不足 1 GB，任务已暂停。')
                else:active[lane]=begin(task)
            except DatabaseBusy:raise
            except Exception as error:update(task['id'],'failed',safe_text(str(error))[:2000])
        except DatabaseBusy:pass
        except Exception as error:
            print('Controller '+lane+' error: '+safe_text(str(error))[:1000],flush=True)
            if current:
                try:fail_active(current,error);del active[lane]
                except DatabaseBusy:pass


def main():
    global STOP
    os.umask(0o077)
    def stopping(*_):
        global STOP
        STOP=True
    signal.signal(signal.SIGTERM,stopping);signal.signal(signal.SIGINT,stopping)
    PRIVATE.mkdir(mode=0o700,exist_ok=True)
    with (PRIVATE/'service.lock').open('a') as singleton:
        fcntl.flock(singleton,fcntl.LOCK_EX|fcntl.LOCK_NB)
        recover_release()
        for row in read("SELECT id FROM agent_tasks WHERE status IN ('running','testing','publishing')"):
            for kind in ('model','tests','photos'):stop_unit(f'travel-agent-{kind}-{row["id"]}')
            update(row['id'],'failed','服务重启，未完成任务已停止；可重新提交。')
        active={};last_heartbeat=0;last_cleanup=0
        while not STOP or active:
            try:
                if time.time()-last_heartbeat>20 and not STOP:heartbeat();last_heartbeat=time.time()
                if not active and not STOP and time.time()-last_cleanup>3600:prune_artifacts();last_cleanup=time.time()
            except DatabaseBusy:pass
            except Exception as error:print('Controller maintenance: '+safe_text(str(error))[:1000],flush=True)
            scheduler_step(active)
            time.sleep(1)


if __name__=='__main__': main()
