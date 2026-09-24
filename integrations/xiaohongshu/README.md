# 小红书访问验证（独立工具，尚未接入旅行助手）

此工具只检查官方网页版能否进入正常登录界面，不抓取笔记、不发短信、不执行登录、不修改网站或数据库。平台限制出现时立即退出，不使用代理、指纹伪装、内部接口或验证码处理工具。

## 使用

- `sudo /usr/local/sbin/travel-xhs-check status`：只读取本地状态，不联网。
- `sudo /usr/local/sbin/travel-xhs-check check`：手动请求一次验证；若仍在冷却中，直接返回，不启动浏览器。
- `journalctl -u travel-xhs-check.service -n 10`：查看本地执行结果。

只有这个入口用于后续验证。旧的一次性脚本已经归档。没有定时任务、常驻浏览器或自动重试。

## 状态及保护

固定使用 `/var/lib/travel-xhs/profile` 保存独立浏览器数据。目录归专用用户 `travelxhs` 所有，权限 0700；控制状态和统计文件权限 0600。账号会话若以后通过正常登录获得，也只保存在此目录，不传给模型、不提交 Git。当前尚未取得登录状态。

- 全局文件锁拒绝并发操作；状态损坏时拒绝启动。
- 正常检查之间至少间隔 10 分钟；超时或普通错误冷却 15 分钟；安全限制或 HTTP 429 冷却 30 分钟。
- 启动浏览器前先写冷却记录，异常退出后也不能立即反复启动。
- 这些间隔是本工具的保守操作规则，不是平台公布的解封时间，不能保证恢复访问。
- 请求计数达到 300，或 XHR/fetch 合计达到 40 时立即关闭浏览器。已经并发发出的请求可能使最终计数略超阈值；日志记录实际数量。
- 检查只打开一次首页，最多点击一次登录入口。点击前等待 DOMContentLoaded/complete、脚本请求完整结束及短暂稳定窗口；图片是否全部加载不影响就绪判断。这些是保守的就绪信号，不能保证第三方框架已完成全部初始化。
- 页面出现 300012 / 安全验证 / 安全限制，或文档与接口返回 403，以及任何 429，立即停止。
- 页面加载最多等待 60 秒，点击登录后最多再等待 30 秒，总时限 90 秒；等待真实手机号输入框或已加载二维码，空弹窗不算成功，不再提前在 8 秒结束。外层进程保护为 100 秒，服务最长执行 105 秒；systemd 限制到一个 CPU 核、768 MiB 内存、192 个任务，退出时清理整个进程组。

`control.json` 为冷却记录；`last-run.json` 为最近实际浏览器检查结果；`last-network.json` 记录请求 ID、类型、主机名、公开脚本/样式文件名、响应状态、请求完成/失败与相对时间；`last-run.json` 保存结束前未完成请求、DOM 就绪状态、点击完成情况，以及脚本错误类型与消息摘要哈希。HTTP 收到响应头不等于脚本已完整下载，因此分别记录 response 和 request_finished。探针主动关闭引发的请求取消单独计数。原始错误消息、页面正文、URL 参数、Cookie、请求/响应正文或认证头均不写日志。每次覆盖上次统计，不累计膨胀。正常浏览器页面缓存保留，没有使用会禁用 HTTP 缓存的全局请求拦截。

浏览器资料可能包含敏感内容，不放进网站静态目录，不提供公开下载。断开账号应在浏览器已关闭时清理 `profile`，保留控制文件中的冷却状态。

## 部署

独立安装在 `/opt/travel-xhs`，不随网站助手的普通代码发布替换。依赖 Python 3 标准库、Node.js、现有 `/opt/travel-notes/test-tools/node_modules/playwright`（本次测试为 1.63.0）。使用与 Playwright 匹配的 Chromium headless shell，完整运行目录安装到 `/opt/travel-xhs/browser`，由 root 持有且不可由 `travelxhs` 写入；二进制文件不提交仓库。

创建不可登录的系统用户 `travelxhs`，用户目录 `/var/lib/travel-xhs`；安装随附 `travel-xhs-check.service` 到 `/etc/systemd/system`，安装同名命令脚本到 `/usr/local/sbin`，执行 `systemctl daemon-reload`。服务不需要 enable。首次启用必须把最近已知的限制时间导入 `control.json`，不能用换工具或重建目录重置冷却。

此工具不属于现有网站备份范围。源代码保存在仓库；浏览器登录状态无需随网站备份分发，恢复后重新正常授权。恢复工具时也要保留或保守重建最近的冷却记录。

## 验证

`python3 -m unittest discover -s tests -p 'test*.py'` 验证并发锁、冷却、异常退出与私密文件权限。

`XHS_TEST_BROWSER=/opt/travel-xhs/browser/chrome-headless-shell node tests/browser.cjs` 仅访问本机 HTTP 测试页面，验证会话/缓存复用、手机号控件识别、限制页与请求阈值停止、日志脱敏。生产环境的冷却规则不能为了测试而清零。

慢页面回归：`XHS_TEST_BROWSER=/opt/travel-xhs/browser/chrome-headless-shell node tests/readiness.cjs`。仅使用本机模拟页面，覆盖延迟脚本、超过 8 秒才出现的登录控件、脚本一直未完成、脚本异常及脱敏日志；不会清零生产冷却或访问小红书。
