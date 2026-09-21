"""Root-owned artifact handling; never import code from a candidate."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat

DIRECTORIES = ('static','ops-config','tests','migrations')
ROOT_EXTENSIONS = ('.py','.sql','.txt','.md')
APP_MODULES = {'app.py','performance.py','html_imports.py','handbooks.py'}


def paths(root):
    root = Path(root)
    result = [p for p in root.iterdir() if p.suffix in ROOT_EXTENSIONS and p.name not in ('AGENTS.md','TASK_CONTEXT.md')]
    for name in DIRECTORIES:
        directory=root/name
        if directory.is_symlink(): raise ValueError('候选目录包含符号链接：'+name)
        if directory.exists():
            for current, dirs, files in os.walk(directory, followlinks=False):
                dirs[:]=[d for d in dirs if d not in ('__pycache__','.pytest_cache')]
                for d in dirs:
                    if (Path(current)/d).is_symlink(): raise ValueError('候选目录包含符号链接')
                result.extend(Path(current)/f for f in files if not f.endswith('.pyc'))
    if len(result)>3000: raise ValueError('候选文件数量超出限制')
    size=0
    for path in sorted(result):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise ValueError('候选版本只能包含普通文件：'+str(path.relative_to(root)))
        if info.st_size>16*1024**2: raise ValueError('候选文件超过 16 MB')
        size+=info.st_size
        if size>100*1024**2: raise ValueError('候选代码超过 100 MB')
        yield path


def manifest(root):
    root=Path(root)
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths(root)}


def fingerprint(files):
    return hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def copy_code(source, target):
    source=Path(source);target=Path(target);target.mkdir(parents=True,exist_ok=True)
    for path in paths(source):
        dest=target/path.relative_to(source);dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(path,dest);dest.chmod(0o644)


def allowed(name, old, new):
    # Operations code executes as root and requires a separate human-reviewed rollout.
    if name in APP_MODULES: return name in old and name in new
    if name=='README.md': return name in new
    return name.startswith(('static/','tests/')) and not any(part.startswith('.') for part in Path(name).parts)


def compare(old_root, new_root):
    old=manifest(old_root);new=manifest(new_root)
    changes=[];pieces=[];used=0
    for name in sorted(set(old)|set(new)):
        if old.get(name)==new.get(name): continue
        entry={'path':name,'action':'新增' if name not in old else '删除' if name not in new else '修改','automatic':allowed(name,old,new)}
        changes.append(entry)
        try:
            before=(Path(old_root)/name).read_text() if name in old else ''
            after=(Path(new_root)/name).read_text() if name in new else ''
            delta=''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='原版/'+name,tofile='候选/'+name))
        except UnicodeError:
            delta=f'二进制文件：{name}\n'
        remaining=120000-used
        if remaining>0:
            pieces.append(delta[:remaining]);used+=len(pieces[-1])
    return {'files':changes,'diff':'\n'.join(pieces),'diff_truncated':used>=120000,'artifact':fingerprint(new),
            'baseline':fingerprint(old),'manual_files':[f['path'] for f in changes if not f['automatic']]}


def replace(source, live):
    """Only called on root-owned, sealed and hash-verified code after approval."""
    source=Path(source);live=Path(live)
    incoming=manifest(source)
    for path in paths(live):
        if str(path.relative_to(live)) not in incoming: path.unlink()
    for name in incoming:
        dest=live/name;dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.is_symlink() or any(p.is_symlink() for p in dest.parents if p!=live.parent): raise ValueError('正式代码路径包含符号链接')
        temporary=dest.with_name(dest.name+'.agent-next')
        if temporary.is_symlink(): temporary.unlink()
        shutil.copyfile(source/name,temporary);temporary.chmod(0o644);temporary.replace(dest)
    shutil.rmtree(live/'__pycache__',ignore_errors=True)
