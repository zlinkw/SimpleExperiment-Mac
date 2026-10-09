# bash -lc 远程执行踩坑记录（Agent / Scheduler 运行时）

本插件在远端服务器通过 `tmux new-session -d ... bash -lc "<script>"` 启动 Agent、Scheduler 与
Worker 任务。下列坑都是在这一路径上反复踩过的，记录在此防止再犯。所有运行时 Python 都从
`src/clusterAgentRuntime.ts` / `src/clusterSchedulerRuntime.ts` 的 `String.raw` 模板生成，最终落盘为
`dist/runtime/cluster_agent.py` 与 `dist/runtime/cluster_scheduler.py`。

> 通用红线：**凡是拼进 `bash -lc "..."` 的脚本，都要假设它运行在一个非交互、非登录友好的
> 子 shell 里，且 tmux 会话继承的是 tmux SERVER 的环境，不是发起命令的客户端环境。**

> 交叉红线（Webview 外层模板剥离坑 P0）：`src/ui/PanelHtml.ts` 的 ``return `...<script>...` `` 外层模板同样会吞噬内层正则/字符串的 `\`（如 `\s` `\d` `\.` `\/` `\n`），**严禁** 裸写 `/\s+/` `"\n"`，必须双写为 `/\\s+/` `"\\n"` 或用 `String.fromCharCode(10)` 规避；门禁为 `npm run build` 的 `node -c` 双校验 + `vm.Script` 二次校验。详见 `docs/troubleshooting.md#外层模板剥离坑-P0` 与 `AGENTS.md#红线约束`。

---

## 1. 非交互 `bash -lc` 里 `conda activate` 直接失败 → 会话自毁

**现象**：tmux 会话一创建就消失，`tmux ls` 看不到，`work_dirs` 为空，调度器却以为任务在跑
（表现为 UI 上"全部 blocked / 0 在跑"）。

**根因**：`bash -lc` 是非交互 shell，`conda` 仅仅是 shell 函数（由 `conda.sh` 定义），默认没加载，
所以裸写 `conda activate zlk` 会报 `CommandNotFoundError` 并以 `exit 127` 结束脚本；脚本里通常紧跟
`tmux kill-session`，于是会话立刻自毁。

**正确写法**（先 source conda 初始化脚本，再 activate；按三个位置兜底定位 `conda.sh`，且**禁止嵌套双引号**）：

```bash
__conda_root="$(conda info --base 2>/dev/null)"
__conda_sh=""
if [ -n "$CONDA_PREFIX" ] && [ -f "$CONDA_PREFIX/etc/profile.d/conda.sh" ]; then
  __conda_sh="$CONDA_PREFIX/etc/profile.d/conda.sh"
elif [ -n "$__conda_root" ] && [ -f "$__conda_root/etc/profile.d/conda.sh" ]; then
  __conda_sh="$__conda_root/etc/profile.d/conda.sh"
elif [ -n "$CONDA_EXE" ]; then
  __conda_sh="$(dirname $CONDA_EXE)/../etc/profile.d/conda.sh"
fi
if [ -n "$__conda_sh" ] && [ -f "$__conda_sh" ]; then . "$__conda_sh"; fi
conda activate "<env>"
```

**不要用 `conda run -n <env> ...` 替代**：`conda run` 在非交互 shell 能跑，但它不会把子进程 stdout 转发到
`>> log` 重定向，导致日志抓不到输出（见第 3 条）。要"模拟真人输入、稳定、换服务器也能跑"，就走上面的
`source conda.sh && conda activate` 方案。

相关代码：`simple_conda_activation_script()`（两个运行时文件都有）。

---

## 2. 嵌套双引号会提前闭合外层 `bash -lc "..."` 引号

**现象**：日志文件始终不生成，或脚本后半段被忽略。

**根因**：把脚本写成 `bash -lc "... source "$(dirname "$CONDA_EXE")/../etc/profile.d/conda.sh" ..."`，
内层 `"$CONDA_EXE"` 的双引号会把外层 `"` 提前闭合，后面的 `>> log 2>&1` 被吞掉，变成只重定向了无关内容。

**规则**：拼进 `bash -lc "..."` 的脚本里**不要出现嵌套双引号**。需要命令替换时写成
`$(dirname $CONDA_EXE)`（内部不引），或用单级 `"$VAR"`（内部不再含 `"`）。判断标准：整段脚本在
外层双引号内时，任何内层 `"` 都必须是不成对出现的。

---

## 3. `>> log 2>&1` 放在 `bash -lc "script"` 末尾只重定向最后一条命令

**现象**：脚本跑了，但日志是空的，真实输出只在 tmux pane（屏幕）上一闪而过。

**根因**：`bash -lc "a; b; echo x; exit $rc >> log 2>&1"` 中，重定向只作用于**最后一条** `exit` 命令，
前面的 `python ...` 输出根本没进日志。

**正确写法**：在脚本**最前面**用 `exec` 把整个 shell 的输出同时镜像到日志与屏幕（用户要求"屏幕和日志都同步显示"）：

```bash
exec > >(tee -a "$LOG") 2>&1
```

或至少用花括号组包住整段：`{ ...; } >> "$LOG" 2>&1`。不要依赖末尾追加式重定向。

相关代码：`start_simple_tmux_command()` 中 `tmux_args` 的拼接。

---

## 4. tmux 会话继承 tmux SERVER 环境，不是客户端环境

**现象**：脚本里检查 `$SIMPLE_EXPERIMENT_CONDA_ENV` 为空，导致第 1 条的激活被跳过（直接走 base 环境）。

**根因**：`subprocess.Popen(tmux_args, env={"VAR": ...})` 只影响 tmux **客户端**进程；但 tmux 会话的实际
shell 继承的是**早已存在的 tmux SERVER** 的环境。所以靠客户端 env 把变量传进会话是无效的。

**规则**：需要让 tmux 会话里的 shell 看到的变量，**写进脚本内部**用 `export` 固化，而不是指望外层 env 传入。
例如 `simple_conda_activation_script(env)` 现在会从 Python 的 `env` dict 解析出 env 名并生成
`export SIMPLE_EXPERIMENT_CONDA_ENV='<name>';`，使脚本自包含。

**衍生坑（嵌套 `bash -lc` 重置 PATH）**：如果外层脚本已经 `conda activate`，又把真正命令包成
`bash -lc "python train.py"`（再起一个 login shell），内层 login shell 会重新 source `/etc/profile`，
把外层刚改好的 PATH 重置回 base，于是 `python` 又变回系统/base 解释器。

**规则**：激活与真正执行命令必须在**同一个 shell** 里完成。`start_simple_tmux_command` 外层脚本负责
激活，传入的 `args` 应是原始 `python ...`（不要是又一层 `bash -lc`）；仅当需要独立子 shell 时才用
`simple_conda_wrapped_args()` 生成的单条 `bash -lc "激活 && exec 命令"`（同样是单 shell，不是嵌套）。

---

## 5. 重定向到管道后 Python 块缓冲，屏幕不实时

**现象**：用了第 3 条的 `exec > >(tee ...)` 后，pane 里要等进程结束才一次性刷出。

**根因**：stdout 变成管道后，CPython 对 stdout 走块缓冲，`print` 不即时落盘。

**规则**：脚本开头 `export PYTHONUNBUFFERED=1;`（或在 `python` 调用处加 `-u`）。已在
`start_simple_tmux_command` 的脚本前缀里固化。

---

## 6. 生成的运行时必须兼容远端 Python 3.8

**现象**：本地 `npm run build` 生成的 `dist/runtime/*.py` 在服务器（Python 3.8.10）上 `import` 直接
`SyntaxError` / `AttributeError`，导致 Agent 起不来、只能临时 patch 已部署的旧文件。

**根因**：本机开发用 Python 3.12，模板里混入了 3.9+ 语法。已踩到的具体写法：

- **f-string 表达式里带反斜杠**（PEP 701 才允许，3.12 才放开）：`f"..{sha256_text(ref + '\n' + text)}.."`
  → 改为先把 `ref + "\n" + text` 算进临时变量。
- **`str.removeprefix` / `str.removesuffix`**（3.9）：→ 用 `re.sub(r"^\./", "", s)` 等替代。
- **集合 / 字典合并运算符 `|`**（3.9）：`A | B` → `A.union(B)`；`dict | {...}` → `dict.union({...})`
  或 `{**A, **B}`。
- **注解里用内建泛型**（`list[str]`、`dict[str, Any]`、`X | None`）：在 `cluster_agent.py` 顶部加
  `from __future__ import annotations`（scheduler 已有），让注解惰性求值，避免模块加载时即报错。
- **运行时位置的内建泛型**（`isinstance(x, list[int])`、`cast(list[int], x)`）：3.8 仍会报错，必须避免。

**规则**：改动运行时 Python 模板后，必须执行
`python3.8 -m py_compile dist/runtime/cluster_agent.py dist/runtime/cluster_scheduler.py`
（以及实际 `import` 冒烟）后再打包 vsix。CI / `verify:package-runtime` 不查远端 Python 版本，靠人工守门。

---

## 7. 一键自检清单（改完运行时模板后）

1. `npm run build` 重新生成 `dist/runtime/*.py`。
2. 把两个文件拷到服务器，`python3.8 -m py_compile` 通过。
3. `python3.8` 实际 `import` 两个模块（记得先 `sys.modules[name]=m` 再 `exec_module`，否则 dataclass
   的 `ClassVar` 解析会误报 `AttributeError`）。
4. 确认 `simple_conda_activation_script` 输出里是 `source conda.sh` + `conda activate`，且无嵌套双引号。
5. 确认 tmux 启动参数用的是 `exec > >(tee -a log) 2>&1` 而非末尾 `>> log`。
6. 用一个最小命令（`python -c "import sys; print(sys.executable)"`）真起一个 tmux 会话，确认
   `sys.executable` 指向目标 conda 环境、日志与屏幕都有输出。
