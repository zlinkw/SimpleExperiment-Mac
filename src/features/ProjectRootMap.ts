import * as path from "node:path";
import { createHash } from "node:crypto";

/**
 * Four-root map per stable project identity: program root (deployed runtime
 * install), machine state root (agent/collector state; never a scientific
 * artifact), code root (the synced project) and the declared artifact roots
 * (work_dirs/results style directories the plan declares). This module is a
 * compatible READ-ONLY view over the existing contract fields (projectDir /
 * installDir / stateDir as already carried by lifecycle contracts) plus the
 * declared output directories; it never moves, copies or deletes history and
 * never re-decides sync/cleanup semantics. The exclusion predicate here is the
 * single source of truth for "this relative path is machine state": the sync
 * scope gate and the cleanup classifier both consult it, so new machine state
 * (for example the shared GPU collector frames written under
 * <stateRoot>/workers/<namespace>/gpu_frame.json) can never be selected as a
 * scientific sync or cleanup candidate even when an older deployment nests the
 * state dir inside the project directory.
 */
export type ProjectRootMap = {
  identity: string;
  programRoot: string;
  stateRoot: string;
  stateRoots: string[];
  codeRoot: string;
  artifactRoots: string[];
  // "unknown" whenever an EXPLICITLY supplied root was invalid (relative,
  // escaping past its root, or otherwise uncanonicalizable). Consumers that
  // write to or delete from a mapped state location must fail closed on
  // "unknown" instead of silently treating the endpoint as safe.
  mapping: "resolved" | "unknown";
  unknownFields: string[];
};

export type ProjectRootMapInput = {
  projectId?: string;
  projectDir?: string;
  installDir?: string;
  stateDir?: string;
  machineStateDirs?: string[];
  artifactDirs?: string[];
};

const POSIX_SEPARATOR = /[\\/]+/;

/** Canonical absolute remote path per the contract's accepted shapes (POSIX
 * absolute or a Windows drive root with either separator). Every segment is
 * normalized — separators unified, repeats collapsed, "." dropped and ".."
 * folded against the segment stack — and a mapping that would climb above the
 * filesystem/drive root, or that is relative or empty, is REJECTED instead of
 * being mapped to a surprising or empty prefix. Real physical-link checks stay
 * in the existing validation layer; this function only fixes spelling, never
 * resolves symlinks. */
export function canonicalRemotePath(value: string): { ok: true; path: string } | { ok: false; reason: "empty" | "relative" | "escaping" } {
  const raw = String(value || "");
  if (/[\x00-\x1f]/.test(raw) || /^[\\/]{2}/.test(raw)) return { ok: false, reason: "relative" };
  const text = (raw.startsWith("/") ? raw : raw.trim()).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!text) return { ok: false, reason: "empty" };
  let rootPrefix = "";
  let body = text;
  if (text.startsWith("/")) rootPrefix = "/";
  else if (/^[A-Za-z]:(\/|$)/.test(text)) { rootPrefix = text[0].toLowerCase() + ":/"; body = text.slice(2); }
  else return { ok: false, reason: "relative" };
  const stack: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return { ok: false, reason: "escaping" };
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const result = rootPrefix + stack.join("/");
  return { ok: true, path: rootPrefix === "/" ? result : result.toLowerCase() };
}

function normalizeRemotePath(value: string): string {
  const canonical = canonicalRemotePath(value);
  return canonical.ok ? canonical.path : "";
}

/** Stable project identity: an explicit id wins; otherwise the normalized root
 * path hashes identically across separator and drive-letter case drift. */
export function projectIdentityKey(input: ProjectRootMapInput): string {
  const explicit = String(input.projectId || "").trim();
  if (explicit) return explicit;
  const root = normalizeRemotePath(String(input.projectDir || ""));
  return createHash("sha256").update(root).digest("hex");
}

/** Compatible read over the existing contract shapes; nothing is invented:
 * stateRoot defaults to <installDir>/state exactly like default_agent_state_dir
 * on the Agent, and artifact roots stay relative to the code root. */
export function resolveProjectRootMap(input: ProjectRootMapInput): ProjectRootMap {
  const unknownFields: string[] = [];
  const read = (field: string, raw: string, required: boolean): string => {
    const text = String(raw || "");
    if (!text) {
      // An absent optional root stays neutral; a missing REQUIRED code root
      // leaves the whole mapping unknown (nothing can be relative to it).
      if (required) unknownFields.push(field);
      return "";
    }
    const canonical = canonicalRemotePath(text);
    if (!canonical.ok) { unknownFields.push(field); return ""; }
    return canonical.path;
  };
  const codeRoot = read("codeRoot", String(input.projectDir || ""), true);
  const programRoot = read("programRoot", String(input.installDir || ""), false);
  const explicitState = String(input.stateDir || "");
  const stateRoot = explicitState
    ? read("stateRoot", explicitState, false)
    : (programRoot ? (programRoot === "/" ? "/state" : programRoot + "/state") : "");
  const artifactRoots = [...new Set((input.artifactDirs || []).reduce<string[]>((acc, item) => {
    const text = String(item || "");
    if (!text) return acc;
    const canonical = canonicalRemotePath(text);
    if (!canonical.ok) { unknownFields.push("artifactRoots"); return acc; }
    acc.push(canonical.path);
    return acc;
  }, []))];
  const stateRoots = [...new Set([stateRoot, ...(input.machineStateDirs || []).map(value => read("machineStateDirs", value, true))].filter(Boolean))];
  return { identity: projectIdentityKey(input), programRoot, stateRoot, stateRoots, codeRoot, artifactRoots,
    mapping: unknownFields.length ? "unknown" : "resolved", unknownFields };
}

/** True only when both spellings canonicalize to the SAME absolute root. An
 * uncanonicalizable side NEVER matches: this equality binds endpoint identity
 * (a probe's projectRoot against the code root), so "invalid == invalid" must
 * not read as "same root" and fail an identity check open. */
export function remoteRootsEqual(left: string, right: string): boolean {
  const a = canonicalRemotePath(left);
  const b = canonicalRemotePath(right);
  return a.ok && b.ok && a.path === b.path;
}

/** True when an absolute path lives under the mapped machine state root. */
export function isMachineStateAbsolute(roots: ProjectRootMap, target: string): boolean {
  const canonical = canonicalRemotePath(target);
  if (!canonical.ok) return false; // invalid absolute targets are not "inside"; callers must not guess
  const text = canonical.path;
  return (roots.stateRoots || [roots.stateRoot]).some(stateRoot => stateRoot && sameRootSpace(text, stateRoot)
    && (text === stateRoot || text.startsWith(stateRoot.endsWith("/") ? stateRoot : stateRoot + "/")));
}

function posixRelative(fromRoot: string, target: string): string | null {
  // Returns the code-root-relative form of an absolute state root, or null when
  // the state root lives OUTSIDE the code root (then no relative enumeration can
  // ever reach it and no relative exclusion is needed), or "" when they are equal
  // (a pathological mapping that covers the whole project; callers must treat
  // that as "everything under the code root is machine state"). Both inputs are
  // already canonical (folded, no "..", unified root spelling), so a plain
  // segment-prefix comparison is exact, and a drive root never compares equal
  // to a POSIX root.
  const base = fromRoot.split("/").filter(Boolean);
  const goal = target.split("/").filter(Boolean);
  const baseIsRoot = !base.length; // code root IS the filesystem/drive root
  if (!goal.length) return baseIsRoot ? "" : null; // state root at "/" under a deeper code root: outside
  let shared = 0;
  while (shared < base.length && shared < goal.length && base[shared] === goal[shared]) shared += 1;
  if (!baseIsRoot) {
    if (shared < base.length) return null; // state not beneath the code root (different branch or ancestor)
    if (goal.length === base.length) return "";
    return goal.slice(base.length).join("/");
  }
  return goal.join("/");
}

/** Same root-space test used for containment: drive-letter roots and POSIX
 * roots are different spaces and never contain one another. */
function sameRootSpace(left: string, right: string): boolean {
  return /^[a-z]:\//i.test(left) === /^[a-z]:\//i.test(right);
}

/**
 * Machine-state relative prefixes derived from the VERIFIED absolute mapping —
 * never from directory-name guessing. A project legitimately containing
 * work_dirs/run/state/projects/x keeps syncing (it is not under the mapped state
 * root), while a custom stateDir nested anywhere inside the code directory is
 * excluded exactly by its mapped prefix. An empty list means the state root is
 * outside the code root and relative enumeration cannot reach it.
 */
/** Full guard view: the derived relative prefixes PLUS whether the mapping is
 * unknown (an explicitly supplied root was invalid). Exclusion consumers may
 * use `prefixes`; any consumer that WRITES to or DELETES at a state-adjacent
 * location must consult `unknown` and fail closed instead of reading an empty
 * prefix list as "nothing is machine state here". */
export function machineStateGuard(map: ProjectRootMap): { prefixes: string[]; unknown: boolean } {
  const unknown = map.mapping === "unknown";
  const prefixes: string[] = [];
  for (const state of map.stateRoots || [map.stateRoot]) {
    if (!state || !map.codeRoot || !sameRootSpace(state, map.codeRoot)) continue;
    // A code root nested in machine state is entirely protected too.
    const ancestor = posixRelative(state, map.codeRoot);
    const rel = ancestor !== null ? "" : posixRelative(map.codeRoot, state);
    if (rel !== null) prefixes.push(rel);
  }
  return { prefixes: [...new Set(prefixes)], unknown };
}

export function machineStateRelativePrefixes(map: ProjectRootMap): string[] {
  return machineStateGuard(map).prefixes;
}

/**
 * True when `relative` lies under one of the mapped machine-state prefixes.
 * With includeAncestors the reverse direction also matches: deleting an ANCESTOR
 * directory of the state root would destroy machine state, so cleanup must treat
 * it as protected too. tmp/result, work_dirs/work_dir and the simple_cluster
 * allowlist keep their existing independent semantics untouched: this predicate
 * only ever sees mapped absolute state roots, not path substrings.
 */
export function isUnderMachineStatePrefixes(relative: string, prefixes: readonly string[],
  includeAncestors = false): boolean {
  // Relative callers include Windows aliases. Conservatively protect case
  // aliases on every endpoint instead of allowing a host-side casing change to
  // bypass a machine-state boundary (POSIX aliases may be over-protected).
  const rel = String(relative || "").replace(/\\/g, "/").split("/").filter(part => part.length > 0 && part !== ".").map(part => part.toLowerCase());
  if (rel.some(part => part === "..")) return includeAncestors; // unresolvable: fail closed for cleanup
  for (const raw of prefixes) {
    const prefix = String(raw || "").replace(/\\/g, "/").split("/").filter(part => part.length > 0 && part !== ".").map(part => part.toLowerCase());
    if (prefix.length === 0) return true; // the whole code root is the mapped state root
    const under = rel.length >= prefix.length && prefix.every((part, index) => rel[index] === part);
    if (under) return true;
    if (includeAncestors && rel.length < prefix.length && rel.every((part, index) => prefix[index] === part)) return true;
  }
  return false;
}
