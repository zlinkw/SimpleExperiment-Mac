export interface PanelProgressDomPatch {
  text?: Record<string, unknown>;
  title?: Record<string, unknown>;
  classes?: Array<{ selector: string; add?: string[]; remove?: string[] }>;
  meters?: Array<{ selector: string; value: number; max?: number }>;
  visibility?: Array<{ selector: string; hidden: boolean }>;
}

export function patchPanelProgressDom(root: any, patch: PanelProgressDomPatch): number {
  if (!root || typeof root.querySelector !== "function") return 0;
  let changed = 0;
  for (const [selector, rawValue] of Object.entries(patch.text || {})) {
    const node = root.querySelector(selector);
    if (!node) continue;
    const value = String(rawValue ?? "");
    if (String(node.textContent ?? "") !== value) { node.textContent = value; changed += 1; }
  }
  for (const [selector, rawValue] of Object.entries(patch.title || {})) {
    const node = root.querySelector(selector);
    if (!node) continue;
    const value = String(rawValue ?? "");
    if (typeof node.getAttribute === "function" && node.getAttribute("title") !== value) {
      node.setAttribute("title", value);
      changed += 1;
    }
  }
  for (const item of patch.classes || []) {
    const node = root.querySelector(item.selector);
    if (!node || !node.classList) continue;
    for (const name of item.remove || []) if (node.classList.contains(name)) { node.classList.remove(name); changed += 1; }
    for (const name of item.add || []) if (!node.classList.contains(name)) { node.classList.add(name); changed += 1; }
  }
  for (const item of patch.meters || []) {
    const node = root.querySelector(item.selector);
    if (!node) continue;
    const max = Number.isFinite(item.max) && Number(item.max) > 0 ? Number(item.max) : 100;
    const value = Math.max(0, Math.min(max, Number(item.value) || 0));
    if (Number(node.value) !== value) { node.value = value; changed += 1; }
    if (Number(node.max) !== max) { node.max = max; changed += 1; }
    if (typeof node.setAttribute === "function" && node.getAttribute("aria-valuenow") !== String(value)) {
      node.setAttribute("aria-valuenow", String(value));
      changed += 1;
    }
    if (node.style && node.style.width !== value + "%") { node.style.width = value + "%"; changed += 1; }
  }
  for (const item of patch.visibility || []) {
    const node = root.querySelector(item.selector);
    if (!node || Boolean(node.hidden) === Boolean(item.hidden)) continue;
    node.hidden = Boolean(item.hidden);
    changed += 1;
  }
  return changed;
}
