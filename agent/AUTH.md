# 网站管家账号登录

本实现使用独立的 ChatGPT/Codex 账号登录。部署时需自行建立专用系统用户 `travelagent` 并完成授权，后台入口为 `/admin#agent`。

## 服务器管理员命令

```sh
travel-agent-auth login
travel-agent-auth status
travel-agent-auth logout
```

`login` 发起设备码授权。仅在 OpenAI 官方页面登录并输入该命令刚生成的设备码。设备码有时限，过期后重新执行命令。不需要把密码、验证码或认证文件发送给开发者。

若官方页面提示设备码登录未启用，在 ChatGPT 的安全设置中启用后重试；组织账号可能由工作空间管理员控制。若设备码方式不可用，可在本地电脑开启 SSH 转发并执行浏览器登录：

```sh
ssh -L 1455:localhost:1455 root@203.0.113.10
travel-agent-auth browser-login
```

在本地浏览器打开命令输出的授权链接，保持 SSH 连接，登录后的 localhost 回调会转发到服务器。无需开放公网 1455 端口。

## 隔离与后续接入

- 凭据目录：`/var/lib/travel-agent/home/.codex`，仅专用系统用户及 root 可访问，目录权限 0700。
- 登录命令使用清空后的环境，不继承 root 的 API 密钥、配置或会话；强制使用 ChatGPT 登录。
- 账号登录状态使用 `travel-agent-auth status` 检查，不输出认证文件。
- 后续任务执行同样必须明确使用专用用户及该认证目录，并强制账号认证，不能自动改用 API 付费。
- 模型调用使用所授权账号的可用权益与用量限制；达到限额时应保留任务并显示原因。
- 定时基础巡检继续由普通脚本负责，不持续调用模型。

参考：[OpenAI 官方身份验证说明](https://learn.chatgpt.com/docs/auth)。
