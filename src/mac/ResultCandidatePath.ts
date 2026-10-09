/** Shared with the rendered webview; keep this function independent of Node APIs. */
export function normalizeMacResultCandidatePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes(":")
    || value.includes(String.fromCharCode(92)) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || value.split("/").some(part => !part || part === "." || part === "..")) return "";
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 4096) return "";
  }
  return value;
}
