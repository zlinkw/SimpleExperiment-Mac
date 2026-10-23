// 清理审核的物理节点/目标枚举与四根机器状态守卫绑定（2026-10-23 行数门禁返修：
// 从 PlanCleanupHost 逐行原样提取的独立职责模块；错误文案、fail-closed 语义与顺序保持原样，
// 公开行为仍由 PlanCleanupHost 类方法委托，本模块不引入新策略）。

/** 仅收集 enabled（enabled !== false，即未显式禁用）的 workerTunnels（原 PlanCleanupHost.collect 内联块；
 * 2026-10-23 父审查纠正：原注释声称"含 disabled Worker"与筛选逻辑相反，按实际行为改写，筛选逻辑未动）。 */
export function collectNodeTargets(host: any): any[] {
  const targets: any[] = [];
  // Only enabled tunnels (enabled !== false) are collected; explicitly disabled Workers are filtered out.
  for (const worker of (host.setupConfig.workerTunnels || []).filter((row: any) => row.enabled !== false)) {
    try { targets.push(host.workerCodeSyncTarget(worker)); }
    catch { targets.push({ id: worker.id, error: "当前服务器身份或项目安全根未核实" }); }
  }
  return targets;
}

export function nodesForTargets(root: string, targets: any[]): any[] {
  return [{ id: "local", kind: "local", root }, ...targets.map((target: any) => ({ id: target.id, kind: "remote",
    host: target.host, user: target.user, port: target.port, root: target.remotePath || "", ...(target.error ? { error: target.error } : {}) }))];
}

/** Bind protection to each node, including ancestors of its state roots.
 * Unknown mappings protect that node; another Worker's paths stay independent. */
export function bindMachineStateByNode(host: any, nodes: any[], targets: any[], scope: any): void {
  const machineStateByNode: Record<string, { prefixes: string[]; unknown: boolean }> = {};
  for (const node of nodes) {
    try {
      const target = targets.find(target => target.id === node.id);
      const guard = node.kind === "local" ? host.localMachineStateGuard?.(node.root)
        : host.targetRootGuard?.(target);
      if (!guard) throw new Error("MACHINE_STATE_MAPPING_UNRESOLVED");
      machineStateByNode[String(node.id)] = guard;
      if (guard.unknown) scope.blockers.push({ code: "MACHINE_STATE_MAPPING_UNRESOLVED", nodeId: String(node.id),
        detail: "该节点的状态根配置无法规范化（相对/越界路径），本轮清理已整体禁用该节点；请修正配置后重试。" });
    } catch {
      machineStateByNode[String(node.id)] = { prefixes: [], unknown: true };
      scope.blockers.push({ code: "MACHINE_STATE_MAPPING_UNRESOLVED", nodeId: String(node.id), detail: "机器状态映射不可用，请重新核对节点配置。" });
    }
  }
  scope.machineStateByNode = machineStateByNode;
}

export function machineStateForNode(host: any, node: any): { prefixes: string[]; unknown: boolean } {
  try {
    if (node.kind === "local") return host.localMachineStateGuard?.(node.root) || { prefixes: [], unknown: true };
    const worker = (host.setupConfig?.workerTunnels || []).find((row: any) => row.id === node.id);
    const target = worker && host.workerCodeSyncTarget(worker);
    return host.targetRootGuard?.(target) || { prefixes: [], unknown: true };
  } catch { return { prefixes: [], unknown: true }; }
}

export function managedNodes(host: any, root: string, currentNode: (id: string) => any): any[] {
  const nodes: any[] = [{ id: "local", kind: "local", root }];
  for (const worker of host.setupConfig.workerTunnels || []) {
    if (worker.enabled === false) continue;
    try { nodes.push({ ...currentNode(worker.id) }); }
    catch { nodes.push({ id: worker.id, kind: "remote", root: "", error: "当前服务器身份或安全根未核实" }); }
  }
  return nodes;
}
