import * as fs from "fs";
import * as path from "path";

/**
 * 配置指南来源解析（0.5.400 发行包文档排除配套）。
 * 发行包不再随包 docs/；指南入口：本地安装存在文档时保持原预览/文本打开行为，
 * 否则回退到仓库在线文档链接（vscode.env.openExternal），不得内嵌整份指南规避排除。
 */
export const SETUP_GUIDE_FILE_NAME = "simple-experiment-setup.md";
export const SETUP_GUIDE_ONLINE_FALLBACK_URL =
  "https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md";

export type SetupGuideSource =
  | { kind: "file"; path: string }
  | { kind: "online"; url: string };

export function setupGuideOnlineUrl(repositoryUrl?: string): string {
  const match = /^(?:https:\/\/github\.com[/:]|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(repositoryUrl || "").trim());
  if (!match) return SETUP_GUIDE_ONLINE_FALLBACK_URL;
  return `https://github.com/${match[1]}/blob/master/docs/${SETUP_GUIDE_FILE_NAME}`;
}

/** Short handoff task only; complete guides remain in the source repository. No network or project reads. */
export function experimentIntegrationGuideUrl(repositoryUrl?: string): string {
  return setupGuideOnlineUrl(repositoryUrl).replace(SETUP_GUIDE_FILE_NAME, "experiment-integration.md");
}

export function experimentIntegrationAiTask(repositoryUrl?: string): string {
  const guide = experimentIntegrationGuideUrl(repositoryUrl);
  const practice = guide.replace("experiment-integration.md", "multimodal-integration-best-practice.md");
  return [
    "请把当前工作区项目接入 SimpleExperiment / SimpleSFTP。先核实当前项目规范根目录、AGENTS.md、已有训练/评估入口、配置及产物，不把示例命令当作真实接口。",
    `完整接入指南（先完整阅读）：${guide}`,
    `MultiModal 已核对源码的最佳实践：${practice}`,
    "若无法读取链接，请明确请求指南正文，不凭记忆补造字段。按指南区分必需契约、可选增强和项目专用规则。先给出入口/参数/配置/seed/输出/指标映射，再在现有模块内做最小修改。",
    "优先复用真实命令；需要时仅加轻量适配入口、独立 job 结果 CSV、普通文本进度和 TensorBoard 标量。保留真实退出码，缺失/未定义指标不填 0，不把训练进度当作任务完成。",
    "参考 MultiModal 的终端进度、干净日志、逐 job 输出和曲线隔离；不要复制它的数据路径、分类指标、质量协议、服务器或项目专用 wrapper 依赖。不要伪造插件 manifest/commandId，不新增 attempt 目录。",
    "仅配置明确启用的单台或多台 Worker。所有科研运行与服务器传输使用实时插件 API，先读取匹配工作区/实例的 discovery 和 capabilities/OpenAPI；不猜端口、环境或方法。",
    "本次先完成源码接入、静态检查与可审核 PLAN。校验/预演按实时工作流执行，涉及同步写入须核实授权；真实训练、上传、覆盖和删除须另有明确授权，不能静默补 confirm/pathConfirmed。",
    "交付时列出修改文件、可执行入口与输出树、列映射/指标语义、已执行检查、未验证项，以及用户首次小规模调试的操作顺序。不要宣称适配所有未知项目或科学结果已经有效。",
  ].join("\n\n");
}

/** 从 context.extension.packageJSON 提取 repository URL（string 或 {url} 两种写法均兼容）。 */
export function extensionRepositoryUrl(extensionPackageJson: unknown): string | undefined {
  const repository = (extensionPackageJson as { repository?: unknown } | undefined)?.repository;
  if (typeof repository === "string") return repository;
  if (repository && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string") {
    return (repository as { url: string }).url;
  }
  return undefined;
}

export function resolveSetupGuideSource(
  extensionPath: string,
  repositoryUrl?: string,
  existsSync: (target: string) => boolean = fs.existsSync,
): SetupGuideSource {
  const local = path.join(extensionPath, "docs", SETUP_GUIDE_FILE_NAME);
  if (existsSync(local)) return { kind: "file", path: local };
  return { kind: "online", url: setupGuideOnlineUrl(repositoryUrl) };
}
