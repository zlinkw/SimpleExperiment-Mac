import { normalizePosixRelativePath } from "./PosixPath";

type Row = Record<string, any>;
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const planKeys = ["planFile", "plan_file", "plan", "selectedPlanId", "selected_plan_id"];
const revisionKeys = ["planRevision", "plan_revision"];
const links = ["payload", "latestEvent", "contractReport"];

function alias(row: Row, keys: string[], path: boolean): string {
  const owners = [row];
  if (row.options != null) {
    if (!object(row.options)) throw new Error("Invalid receipt options");
    owners.push(row.options);
  }
  const values: string[] = [];
  for (const owner of owners) for (const key of keys) {
    const value = owner[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value === "-" || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid receipt identity");
    values.push(path ? normalizePosixRelativePath(value, "回执 Plan") : value);
  }
  if (new Set(values).size > 1) throw new Error("Conflicting receipt aliases");
  return values[0] || "";
}

/** Structural children may inherit an explicitly owned ancestor. A child Plan
 * never authorizes anonymous ancestor artifacts, timestamps or sibling rows.
 * Contradictory receipt identities are rejected rather than repaired.
 */
export function scopeMacResultOperation(row: unknown, selectedPlan: unknown): { payloads: Row[]; contractCheck: boolean } {
  const empty = { payloads: [], contractCheck: false };
  try {
    const plan = normalizePosixRelativePath(selectedPlan, "当前 Plan");
    if (!object(row)) return empty;
    const payloads: Row[] = [], revisions = new Set<string>(), active = new Set<Row>();
    let nodes = 0, contractCheck = false;
    function visit(item: Row, inherited: boolean, contract: boolean, depth: number): boolean {
      if (++nodes > 64 || depth > 8 || active.has(item)) throw new Error("Invalid receipt tree");
      active.add(item);
      const identity = alias(item, planKeys, true);
      if (identity && identity !== plan) throw new Error("Foreign receipt Plan");
      const owned = Boolean(identity || inherited);
      const check = contract || [item.type, item.action].some(value => typeof value === "string" && value.toLowerCase() === "check-output-contract");
      if (owned) {
        const revision = alias(item, revisionKeys, false);
        if (revision) revisions.add(revision);
        for (const entry of Array.isArray(item.unparseable) ? item.unparseable : []) {
          if (!object(entry)) continue;
          const entryPlan = alias(entry, planKeys, true);
          if (entryPlan && entryPlan !== plan) throw new Error("Foreign result entry Plan");
          const entryRevision = alias(entry, revisionKeys, false);
          if (entryRevision) revisions.add(entryRevision);
        }
        // Remove unscoped wrappers: consumers only see this owner's scalar data.
        const copy: Row = { ...item, planFile: plan };
        for (const key of [...links, "options"]) delete copy[key];
        if (revision) copy.planRevision = revision;
        payloads.push(copy);
        contractCheck ||= check;
      }
      let descendantOwned = owned;
      for (const key of links) {
        const child = item[key];
        if (child == null) continue;
        if (!object(child)) throw new Error("Invalid receipt wrapper");
        descendantOwned = visit(child, owned, check || key === "contractReport", depth + 1) || descendantOwned;
      }
      if (descendantOwned) contractCheck ||= check;
      active.delete(item);
      return descendantOwned;
    }
    visit(row, false, false, 0);
    if (revisions.size > 1) return empty;
    return { payloads, contractCheck };
  } catch { return empty; }
}
