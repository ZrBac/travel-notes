# 行笺 · Travel Notes

旅行攻略和旅行足迹存档网站，使用 Flask、PostgreSQL 和原生 JavaScript/CSS。公开前台与管理员后台分开，没有访客注册、评论或点赞。

这是从运行版本整理的脱敏源码。真实站点地址、环境密钥、账号凭据、数据库内容、上传照片、导入的攻略和助手任务历史不在仓库中。配置中的 `travel.example.com` 和 `203.0.113.10` 都是示例。

## 功能

- **旅行攻略**：Markdown 编辑、内置智能图文模板、目的地和标签浏览、分类、公开/私密/草稿、批量操作与回收站。
- **旅行足迹**：日期、地点、游记、实际花费、多图相册、照片说明与排序，关联攻略及行程日。
- **HTML 导入**：在「攻略管理 → 导入 HTML」上传 HTML 或 ZIP，预览后存档，同时保留可编辑正文及静态原版附件。
- **图片素材**：单张最多 50 MiB、每篇足迹最多 30 张，支持 JPEG（包括手机 MPO 主图）、PNG、WebP；自动生成 WebP 和缩略图。
- **后台管理**：工作台、分组导航、分类标签、素材管理、站点设置、账号/密码修改、操作记录及数据导出。
- **两类助手**：旅游助手生成带照片、路线与表格的攻略；网站管家在开发副本修改代码、检查并发布。两个助手各有一个执行名额。
- **任务记录**：可删除已结束的记录；有后续引用时先删除后续记录；删除不撤销已发布代码，也不删除已存档攻略和图片。
- **运维**：systemd 服务、健康巡检、PostgreSQL 和上传文件备份、代码检查点及回退。

普通前台始终使用访客视角，仅显示公开内容。管理员从后台打开明确标注的预览页面，可查看私密与草稿；预览链接本身不会赋予权限。图片和 HTML 附件在服务端检查可见性。

## 目录

```text
app.py / *_api.py      网站与后台接口
schema.sql             PostgreSQL 表结构（版本 3）
static/                前台、后台、模板与默认主题图片
html_imports.py         HTML / ZIP 解析和静态化
agent/                 独立助手控制器、攻略校验与照片处理
ops-config/            脱敏后的 systemd、Nginx 和运维配置模板
backup.py / ops.py      备份与定时巡检
releases.py             代码检查点与回退
migrate_sqlite.py       旧 SQLite 数据库的一次性迁移工具
tests/                 网站接口、权限、导入、备份与并发测试
agent/tests/           控制器、发布边界与图文攻略测试
```

网站可以单独运行；助手是可选组件。业务内容需要在部署后通过后台录入、导入或生成，不会从本仓库自动恢复。

## 本地运行

需要 Python 3.11+ 和 PostgreSQL。下面假设当前本机 PostgreSQL 角色可创建和访问开发数据库；也可以自行创建数据库并修改连接配置。

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
createdb travelnotes_dev
cp .env.example .env
```

编辑 `.env`，设置数据库连接，并为 `TRAVEL_SECRET` 生成独立的随机值。加载环境、准备数据目录与写锁：

```sh
set -a
. ./.env
set +a
mkdir -p "$TRAVEL_DATA"
touch "$TRAVEL_WRITE_LOCK"
.venv/bin/python -c 'from database import initialize; initialize()'
```

首次创建管理员（在交互式终端中运行，密码不会显示；默认账号为 `admin`，可通过 `TRAVEL_ADMIN_USER` 环境变量指定）：

```sh
.venv/bin/python - <<'PY'
import getpass
import os
import re
from werkzeug.security import generate_password_hash
from database import connect
username = os.environ.get('TRAVEL_ADMIN_USER', 'admin').strip()
if not re.fullmatch(r'[A-Za-z0-9_]{3,32}', username):
    raise SystemExit('账号格式不正确')
password = getpass.getpass('密码（8～256 个字符）：')
if not 8 <= len(password) <= 256:
    raise SystemExit('密码长度不正确')
if password != getpass.getpass('再次输入密码：'):
    raise SystemExit('两次密码不一致')
with connect() as conn:
    conn.execute('LOCK TABLE admins IN EXCLUSIVE MODE')
    if conn.execute('SELECT count(*) AS n FROM admins').fetchone()['n']:
        raise SystemExit('已存在管理员，请使用后台账号管理')
    conn.execute('INSERT INTO admins(username,password_hash) VALUES(%s,%s)',
                 (username, generate_password_hash(password)))
print('管理员已创建')
PY
.venv/bin/gunicorn --bind 127.0.0.1:8000 --workers 2 --threads 2 app:app
```

前台为 `http://127.0.0.1:8000/`，后台为 `/admin`，健康接口为 `/api/health`。生产部署参见 [部署说明](docs/DEPLOYMENT.md)。

## 验证

网站测试需要独立 PostgreSQL 测试库，会清空该测试库中的表。测试代码拒绝使用正式库名；不要把测试连接指向业务数据。

```sh
export TRAVEL_TEST_DATABASE_URL='dbname=travelnotes_test user=travelnotes host=/var/run/postgresql'
.venv/bin/python -m unittest discover -s tests -p 'test*.py' -q
.venv/bin/python -m unittest discover -s agent/tests -p 'test*.py' -q
```

上面的测试角色、数据库需预先创建；本机 peer 认证时以 `travelnotes` 系统用户运行网站测试。控制器测试导入部署模块，需存在 `travelnotes` 系统用户；执行进程和发布操作在测试中使用临时目录或 mock，不会启动真实模型。

脱敏范围和凭据管理见 [源码脱敏说明](docs/SOURCE_EXPORT.md)。
