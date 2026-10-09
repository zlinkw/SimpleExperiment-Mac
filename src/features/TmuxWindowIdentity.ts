export interface TmuxWindowIdentity {
  target: string;
  session: string;
  windowId: string;
  windowName: string;
  paneIds: string[];
}

function windows(list: any): any[] {
  if (list?.ok === false || list?.available === false || !Array.isArray(list?.sessions))
    throw new Error(`无法核实 tmux 列表：${String(list?.error || "缺少 sessions")}`);
  return list.sessions.flatMap((session: any) => (session.windows || []).map((win: any) => ({
    ...win, session: String(session.name || ""),
    target: String(win.target || `${session.name}:${win.index}`),
  })));
}

function identity(win: any): TmuxWindowIdentity {
  const windowId = String(win.windowId || "");
  const paneIds = (win.panes || []).map((pane: any) => String(pane.id || "")).filter((id: string) => /^%\d+$/.test(id)).sort();
  if (!/^@\d+$/.test(windowId))
    throw new Error("tmux 窗口缺少稳定身份，请刷新列表或更新 Worker Agent。");
  return { target: win.target, session: win.session, windowId, windowName: String(win.name || ""), paneIds };
}

export function resolveTmuxWindowIdentity(list: any, target: string, expected?: any): TmuxWindowIdentity {
  const all = windows(list);
  const windowId = String(expected?.windowId || "");
  const paneIds: string[] = expected?.paneIds || (expected?.panes || []).map((pane: any) => String(pane.id || "")).filter(Boolean);
  const stable = windowId || paneIds.length;
  const win = all.find((win: any) => stable
    ? (windowId ? win.windowId === windowId : paneIds.every(id => win.panes?.some((pane: any) => pane.id === id)))
    : win.target === target);
  if (!win || win.session !== target.split(":")[0]) throw new Error("tmux 窗口身份已变化或不存在，请刷新后重试。");
  const current = identity(win);
  const expectedName = expected?.windowName ?? expected?.name;
  if (expectedName !== undefined && current.windowName !== expectedName
    || paneIds.length && JSON.stringify([...paneIds].sort()) !== JSON.stringify(current.paneIds))
    throw new Error("tmux 窗口身份已变化，未关闭新占用窗口。");
  return current;
}

export function tmuxWindowIdentityPresent(list: any, expected: TmuxWindowIdentity): boolean {
  return windows(list).some(win => expected.windowId && win.windowId === expected.windowId
    || expected.paneIds.some(id => win.panes?.some((pane: any) => pane.id === id)));
}
