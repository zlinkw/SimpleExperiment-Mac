export const WORKER_PROBE_RUNTIME = String.raw`#!/usr/bin/env python3
import argparse, json, os, subprocess, time

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)

def run(cmd):
    return subprocess.run(cmd, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)

def collect_gpu():
    res = run("nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits")
    if res.returncode != 0:
        return [], res.stderr or res.stdout
    gpus = []
    for line in res.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 7:
            continue
        gpus.append({
            "index": int(float(parts[0] or 0)),
            "uuid": parts[1],
            "name": parts[2],
            "memoryUsedMb": int(float(parts[3] or 0)),
            "memoryTotalMb": int(float(parts[4] or 0)),
            "utilizationGpu": int(float(parts[5] or 0)),
            "temperatureGpu": int(float(parts[6] or 0)),
            "processes": [],
            "source": "worker_probe",
            "generatedAt": now_iso(),
        })
    return gpus, ""

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    args = parser.parse_args()
    out_dir = os.path.join(args.project_dir, "simple_cluster", "tmp", "worker_probe")
    gpus, err = collect_gpu()
    atomic_write(os.path.join(out_dir, "gpu_snapshot.json"), {"schemaVersion": 1, "generatedAt": now_iso(), "gpu": gpus, "error": err})
    atomic_write(os.path.join(out_dir, "health.json"), {"schemaVersion": 1, "generatedAt": now_iso(), "status": "degraded" if err else "ok", "error": err})
`;
