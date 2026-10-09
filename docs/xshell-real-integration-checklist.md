# Xshell 真实对接验收清单

## 前置条件

- 已安装 Xshell。
- Hub 已配置可用 `.xsh` 隧道会话。
- Hub 上已进入项目目录。
- Hub Agent 已启动：

```bash
python simple_cluster/runtime/cluster_agent.py serve --host 127.0.0.1 --port 18765 --mode realtime
```

## 步骤

1. 在插件面板点击“配置”。
   预期结果：可以选择或自动识别 `Xshell.exe`。
   失败时检查：路径是否指向 `Xshell.exe`，不是快捷方式或其他 exe。

2. 选择本机已保存的 SSH 服务器，或填写服务器 IP/域名、登录用户名、SSH 端口号。
   预期结果：配置保存成功，面板显示服务器 IP/域名、登录用户名、SSH 端口号。
   失败时检查：如果有固定 Xshell 会话名或服务器简称，可填写“Xshell 登录别名”；不清楚就留空，直接填写 IP/域名、用户名、端口号。

3. 设置本地转发端口，例如 `18765`。
   预期结果：端口未被占用。
   失败时检查：是否已有旧隧道占用端口；插件会推荐可用端口。

4. 设置远端 Agent 端口，例如 `18765`。
   预期结果：与 Hub Agent 启动端口一致。
   失败时检查：Hub Agent 是否实际监听 `127.0.0.1:18765`。

5. 点击“启动 Xshell”。
   预期结果：插件展示命令预览，确认后打开 Xshell 已保存会话或本地隧道会话。
   失败时检查：Xshell 路径、`.xsh` 会话、命令引号、私钥路径、Xshell 登录别名。

6. 点击“检测隧道”。
   预期结果：本地端口打开，`/api/health` 可访问。
   失败时检查：Xshell 本地隧道是否已连接；Hub Agent 是否启动；token 是否匹配。

7. 点击“真实对接检测”。
   预期结果：`/api/health`、`/api/capabilities`、`/api/files/capabilities` 均通过。
   失败时检查：Agent API 版本、文件 API 是否启用、端口是否转发到正确进程。

8. 断开 Xshell 隧道，再次点击“检测隧道”。
   预期结果：UI 显示本地端口关闭或 Agent 不可达，不回退 SSH。
   失败时检查：若 UI 清空旧状态，需要修复 lastKnownGood。

9. 重新启动 Xshell 隧道。
   预期结果：10 秒内恢复健康状态或实时流。
   失败时检查：sinceSeq 重连、SSE fallback、snapshot fallback。
