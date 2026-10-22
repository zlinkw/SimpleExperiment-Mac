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
