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

## 旅游助手发布攻略

完成的单地攻略可预览后公开发布；包含 2～4 个候选地的图文攻略，可按目的地拆成独立攻略，一次发布或存为多篇草稿。后台保留各篇编辑入口，重复提交不会重复创建，也不会覆盖后续编辑。

拆分要求每个候选地都有完整逐日路线，景点和美食标明所属目的地，住宿、预算与天气等按目的地分章节。较早生成且混排的攻略会提示先继续整理，不会直接拆分丢失内容。所有发布接口需要管理员登录和 CSRF 校验，并使用事务及写入保护。

## 可视化正文编辑（2026-09-21）


攻略与旅行足迹共用 `static/travel-editor.js`，默认采用 [Jodit 4.15.7](https://github.com/xdan/jodit) 可视化模式，支持标题、加粗、斜体、列表、链接、表格、撤销重做、素材插图、图片上传与专注写作。源码入口继续接受 Markdown 或 HTML。

- 固定版本的 JS、CSS 和 MIT 许可证位于 `static/vendor/jodit-4.15.7/`；发行包已核对 npm registry SHA-512。只在后台编辑页加载，无运行时 CDN、额外常驻服务或数据库迁移。
- 数据仍存于原有 `body` 字段。打开后没有修改正文时，保存保留原始文本；可视化修改后保存为 HTML。原有 Markdown 可以继续阅读、编辑，图文攻略的卡片 class、路线、表格、图片署名与资料链接经过保存前后对比验证。
- 后端仍使用既有 HTML 清理白名单。表格的 `colspan`、`rowspan` 仅允许 1～100 的整数，继续过滤脚本、事件属性及任意样式；工具栏只提供可保留的正文格式。
- 正文图片仍使用现有带登录校验和 CSRF 的上传接口，单图 50 MB。上传中禁止离开或保存，失败保留文字。HTML 导入预览中的临时图片地址在保存正文时恢复为正式素材地址，原版手册附件仍独立保存。
- 未保存提醒、revision 冲突保护和源码回退继续有效。组件在切换文章、离开编辑页或退出登录时销毁；关闭模式持久化，编辑器存储使用内存，不持久化正文至 localStorage、sessionStorage 或 IndexedDB。

验证：86 项应用测试通过；隔离数据库和独立测试账号下，浏览器覆盖四篇实际图文攻略往返编辑、只改标题、Markdown/HTML 模式切换、表格插入与修改、素材和 JPEG 上传、HTML 导入与临时图片、游记和新建攻略、320/390 像素手机布局以及离站请求和浏览器持久化检查。生产账号凭据未用于浏览器测试。

自定义弹窗支持点击外侧遮罩关闭，并保留关闭按钮和 Esc；拖动、滑动和删除确认继续按取消规则处理。可运行 `node tests/dialog-dismiss-browser.cjs` 检查，需另行准备 Playwright 与 Chromium。


## 足迹模板与旅行助手复核规范

后台新建或编辑旅行足迹，在「旅途手记」选择一日随记、多日游记或美食记录。可先预览，再追加到现有正文；多日模板依据起止日期生成每天章节。插入后需补全真实经历并保存，相册、关联攻略和可见范围不变；模板不虚构照片、消费或到访经历。

旅行助手每次生成和追问均加载 `TRAVEL_PLAYBOOK.md`：检查日期星期、周一闭馆、住宿房晚、人数与预算口径、城市景点辨识、美食体验、季节和返程替代方案。规则以本次用户条件为准，不固定沿用历史人数或目的地。现代多候选模板要求每地独立的景点、美食和每日路线；明确日期星期错误会退回修正。发布时核对标准预算表的人均、团队及分项合计，对无法可靠解析的价格文字不猜测。

配图优先使用 `photo_catalog.json` 中已核对的公共资料来源，每次仍校验许可与来源。不同候选地交替分配图片额度，缺图在任务详情列明；找不到匹配图片保留文字，不以其他地点或菜品代替。正文资料链接可点击，图片保留简洁说明及作者、许可和来源。该规范与模板不自动改写已发布内容。
