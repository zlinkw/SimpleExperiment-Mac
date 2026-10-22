/** Logical source repository differs from the shared Mac Release asset repository. */
export function assetRepository(source: string): string {
  return source === "zlinkw/SimpleSFTP-Mac" ? "zlinkw/SimpleExperiment-Mac" : source;
}
