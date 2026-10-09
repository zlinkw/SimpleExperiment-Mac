export function parseDistributedResultsFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return value.split("#", 1)[0].trim().toLowerCase() === "true";
}
