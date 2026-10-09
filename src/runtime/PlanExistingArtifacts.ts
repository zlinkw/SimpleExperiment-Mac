/** Same lightweight, read-only artifact check in the scheduler and warm Agent preflight. */
export const PLAN_EXISTING_ARTIFACTS_PYTHON = String.raw`
EXISTING_ARTIFACT_MARKERS = (
    "metrics_summary.csv", "metrics.csv", "results.csv", "summary.csv",
    "best_model.pth", "checkpoint.pth", "latest.pth", "model.pth",
    "train.log", "test.log", "stdout.log", "stderr.log", "console.log",
    "artifact_manifest.json", "checkpoint_manifest.json",
    "config_snapshot.yaml", "env_snapshot.json",
)

def has_existing_artifacts(output_dir):
    base = str(output_dir or "").strip()
    if not base:
        return {"exists": False, "markers": [], "totalFiles": 0}
    try:
        with os.scandir(base) as entries:
            names = [entry.name for entry in entries]
    except (FileNotFoundError, NotADirectoryError):
        return {"exists": False, "markers": [], "totalFiles": 0}
    markers = [name for name in names if name in EXISTING_ARTIFACT_MARKERS]
    try:
        with os.scandir(os.path.join(base, "checkpoints")) as entries:
            for entry in entries:
                if entry.is_file() and os.path.splitext(entry.name)[1] in (".pth", ".ckpt", ".pt"):
                    markers.append("checkpoints/" + entry.name)
                    break
    except (FileNotFoundError, NotADirectoryError):
        pass
    return {"exists": bool(markers), "markers": sorted(set(markers)), "totalFiles": len(names)}
`;
