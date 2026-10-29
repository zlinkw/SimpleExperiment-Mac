import { type PlanCleanup } from "../features/PlanCleanup";
import { type EmptyParentPreview } from "../features/IsolationEmptyParents";

/** Explicit review only. Existing contents are never added to the empty-directory scope. */
export async function reviewEmptyIsolationParents(host: any, service: PlanCleanup, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  const previews: EmptyParentPreview[] = [], unknown: string[] = [];
  for (const item of (await service.list()).filter(row => row.action === "isolate")) {
    try {
      const operation = await service.status(item.id);
      if (operation.restoredBy || operation.continuedBy) continue;
      previews.push(...await service.prepareEmptyParentCleanup(operation.preview, false));
    } catch (error: any) { unknown.push(String(error?.message || error)); }
  }
  assertCurrent();
  if (!previews.length) {
    host.notifyWarn(unknown.length ? "部分节点或登记状态无法核实，未删除目录：" + unknown.join("；")
      : "未发现已登记产物删除后留下的空目录；未删除任何文件。");
    return;
  }
  const targets = previews.flatMap(row => row.confirmationPaths.map(path => ({ server: row.node.id,
    connection: row.node.kind === "remote" ? row.node.user + "@" + row.node.host + ":" + row.node.port : "本机", path, type: "directory" })));
  for (const phase of [1, 2]) {
    assertCurrent();
    const answer = await host.askRunConfirmation({ phase, title: "永久删除已隔离产物留下的空目录（第 " + phase + " 次确认）",
      groups: [{ value: "delete_empty_parents", label: "永久删除以下空目录；任何目录出现文件即停止", targets }] });
    if (answer !== "delete_empty_parents") return;
    assertCurrent(); await service.confirmEmptyParentCleanup(previews, phase);
  }
  assertCurrent();
  const removed = await service.executeEmptyParentCleanup(previews);
  host.notifyInfo("已主动核实并移除 " + removed + " 个空目录。" + (unknown.length ? "另有部分节点未核实，保留未动：" + unknown.join("；") : ""));
}
