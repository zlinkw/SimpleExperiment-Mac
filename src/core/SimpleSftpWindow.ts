import * as path from "node:path";

export const sameProjectRoot = (a: string, b: string) => {
  if (!a || !b) return false;
  const clean = (value: string) => path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
};

/** Extension exports are local to this Extension Host; the global api.json is only a legacy hint. */
export async function currentWindowSftpDiscovery(registry: any, root: string, legacy: () => Promise<any>) {
  if (!root) throw new Error("SFTP_PROJECT_REQUIRED：当前窗口没有受支持的项目，不能借用其他窗口的连接。");
  const extension = registry?.getExtension?.("simple-local.simple-sftp-mac");
  const api = extension ? (extension.isActive ? extension.exports : await extension.activate()) : undefined;
  const discovery = typeof api?.getLocalApiDiscovery === "function" ? await api.getLocalApiDiscovery() : await legacy();
  if (Number(discovery.pid) !== process.pid)
    throw new Error("SFTP_WINDOW_MISMATCH：SimpleSFTP API 属于另一个 VS Code 窗口；请更新配套插件并重载本项目窗口。");
  if (discovery.workspace !== undefined && !sameProjectRoot(String(discovery.workspace), root))
    throw new Error("SFTP_WORKSPACE_MISMATCH：SimpleSFTP 当前项目与调用项目不一致，未转交请求。");
  return discovery;
}
