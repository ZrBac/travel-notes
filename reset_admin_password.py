"""Interactive root-only recovery for the PostgreSQL-backed administrator."""
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
from werkzeug.security import generate_password_hash


def main():
    if os.geteuid()!=0 or not sys.stdin.isatty():
        print('请以 root 在交互式终端运行；不要通过参数或管道传入密码。',file=sys.stderr);return 1
    password=getpass.getpass('新密码（8～256 个字符）：')
    confirm=getpass.getpass('再次输入新密码：')
    if password!=confirm or not 8<=len(password)<=256:
        print('两次密码不一致或长度不合要求，未修改。',file=sys.stderr);return 1
    env={line.split('=',1)[0]:line.split('=',1)[1] for line in Path('/etc/travel-notes.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line}
    script="""import json,sys
from database import connect
p=json.load(sys.stdin)
with connect(p['dsn']) as c:
 row=c.execute('SELECT id,username FROM admins ORDER BY id LIMIT 1 FOR UPDATE').fetchone()
 if not row: raise RuntimeError('No administrator exists')
 c.execute('UPDATE admins SET password_hash=%s,session_version=session_version+1 WHERE id=%s',(p['hash'],row['id']))
 c.execute('INSERT INTO audit_log(actor,action,target) VALUES(%s,%s,%s)',('server-root','account.password_reset',row['username']))
"""
    subprocess.run(['runuser','-u','travelnotes','--',str(Path(__file__).parent/'.venv/bin/python'),'-c',script],input=json.dumps({'dsn':env['TRAVEL_DATABASE_URL'],'hash':generate_password_hash(password)}),text=True,check=True,cwd=Path(__file__).parent)
    print('密码已更新，所有旧登录已失效。无需重启服务。');return 0

if __name__=='__main__':
    try: sys.exit(main())
    except (KeyboardInterrupt,EOFError): print('\n操作已取消。',file=sys.stderr);sys.exit(1)
