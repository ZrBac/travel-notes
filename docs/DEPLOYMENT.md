# 部署说明

该仓库保留单机部署的源码和配置模板。按自己的域名、Linux 发行版、证书位置、用户及目录调整后安装；不要直接覆盖已有服务器配置。

## 网站

建议使用独立 `travelnotes` 系统用户和同名 PostgreSQL 角色，应用目录 `/opt/travel-notes`、数据目录 `/var/lib/travel-notes`。把网站源码安装到应用目录并在其中建立 `.venv`；`agent/` 是另一个独立服务，不需要放进 Web 运行目录。

- 私有环境文件使用 `/etc/travel-notes.env`，由 root 管理，不放入 Git。`TRAVEL_SECRET` 使用随机值，数据库 DSN 指向自己的数据库。
- 显式执行 `schema.sql` 初始化/迁移数据库，再启动 Web 服务。初始化管理员可使用 README 的交互式示例。
- `/run/travel-notes-write.lock` 由 `ops-config/travel-notes-tmpfiles.conf` 创建；API 写入与备份共用这把锁。
- `ops-config/travel-notes.service` 提供 Gunicorn 服务示例，运行账号只写业务数据目录。
- `ops-config/nginx-site.conf` 是反向代理片段，需放在 Nginx server 块中。上传请求上限 51 MiB，保留应用单图 50 MiB 的空间。
- `ops-config/nginx-domain.conf.example` 是 HTTPS 模板。替换域名和证书路径，配置证书后再启用；其他 Nginx 模板中的 include 路径也需对应调整。
- HTTPS 部署设 `TRAVEL_HTTPS=1`。80 端口可用于 HTTP 跳转和 ACME 验证。

`ops-config/bin/travel-notes-ops` 是维护工具入口，可安装到 `/usr/local/sbin`。健康检查定时器、备份 service、日志轮换和证书续期配置都位于 `ops-config/`。备份 service 需另行安排适合本机的 systemd timer 或计划任务。

## 可选助手

把 `agent/` 下的控制器源码和文档安装到 `/opt/travel-agent`。单独建立 `travelagent` 用户以及 `/var/lib/travel-agent/{home,private,work}` 和 `/var/lib/travel-agent-test` 等运行目录。控制器的目录、用户和资源限制集中在 `agent/service.py`，部署前检查。

- 使用 `ops-config/travel-agent.service` 安装独立控制器。
- 网站任务和旅游任务各有一个子进程名额，控制器本身保持单线程。
- 模型进程以受限用户运行，网站变更只写开发副本；正式发布由控制器执行摘要检查、备份与健康检查。
- 为候选测试建立独立 `travelagent_test` 数据库，遵守控制器生成的受限 systemd 环境。
- 模型 CLI、账号授权和运行凭据不随仓库分发。需要自行安装所用 CLI 并在专用账号下完成登录。
- `ops-config/bin/travel-agent-auth` 是现有登录封装示例；请核对本机 CLI 路径和认证方式，再安装到 `/usr/local/sbin`。
- 私有目录和认证目录使用严格权限。不要把运行目录、登录文件或真实任务历史加入仓库。

两类助手涉及的 schema、依赖、运维模块及管理 API 变更需要单独审核；不要为了自动上线而放宽发布文件白名单。

## 更新与恢复

更新前保留数据库/上传文件完整备份及代码检查点。源码 Git 仓库不包含业务数据，不能替代数据备份。

```sh
systemctl start travel-notes-backup.service
travel-notes-ops checkpoint before-update
travel-notes-ops status
```

涉及数据库结构时，在独占写锁下执行经审核的迁移；常规代码回退不回退数据库或上传文件。发生结构或依赖不兼容时，维护工具会拒绝自动回退。
