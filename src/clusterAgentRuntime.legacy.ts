import { RESULT_LAYOUT_PYTHON } from "./results/ResultLayout";
import { PLAN_EXISTING_ARTIFACTS_PYTHON } from "./runtime/PlanExistingArtifacts";
export const CLUSTER_AGENT_RUNTIME = String.raw`#!/usr/bin/env python3
from __future__ import annotations
import argparse, base64, calendar, csv, errno, fnmatch, glob, hashlib, http.client, importlib.util, io, ipaddress, json, math, os, pathlib, random, re, shutil, shlex, signal, socket, statistics, stat, struct, subprocess, sys, threading, time, traceback, urllib.request, uuid, zipfile
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

${RESULT_LAYOUT_PYTHON}
${PLAN_EXISTING_ARTIFACTS_PYTHON}

# 版本由 build 动态注入（单源：package.json#version -> PLUGIN_VERSION，src/runtime/RuntimeManifest.ts#CURRENT_RUNTIME_VERSION -> 其他），禁止手改；占位值仅用于类型检查，落盘以 dist/runtime/cluster_agent.py 为准
SCHEMA_VERSION = 1
AGENT_VERSION = "0.4.64"
RUNTIME_VERSION = "0.4.64"
PLUGIN_VERSION = "0.4.64"
API_VERSION = "1"
MAX_EVENTS = 5000
MAX_JOURNAL_BYTES = 32 * 1024 * 1024
MAX_AGENT_STATE_BYTES = 128 * 1024 * 1024
MAX_UPLOAD_RECORDS = 120
MAX_ACTIVE_UPLOADS = 16
MAX_UPLOAD_CANCELLED_INIT_RECORDS = 256
UPLOAD_CANCELLED_INIT_TTL_SECONDS = 600
MAX_AGENT_SSE_BATCH_BYTES = 1024 * 1024
MAX_AGENT_SSE_EVENT_BYTES = 256 * 1024
MAX_AGENT_EVENT_RECORD_BYTES = 192 * 1024
MAX_WORKER_COMMAND_RESULT_RECORDS = 240
MAX_WORKER_ACTION_KEY_RECORDS = 240
MAX_WORKER_COMMAND_CURSOR_RECORDS = 64
MAX_WORKER_COMMAND_RECORD_BYTES = 128 * 1024
WORKER_COMMAND_CURSOR_TTL_SECONDS = 60 * 60
MAX_EVENT_CURSOR_RECORDS = 64
EVENT_CURSOR_TTL_SECONDS = 60 * 60
MAX_OPERATION_JOURNAL_CACHE_RECORDS = 8
OPERATION_JOURNAL_CACHE_TTL_SECONDS = 10 * 60
MAX_RUNTIME_JSON_CACHE_RECORDS = 16
RUNTIME_JSON_CACHE_TTL_SECONDS = 10 * 60
MAX_RUNTIME_FILE_INDEX_RECORDS = 8
RUNTIME_FILE_INDEX_TTL_SECONDS = 10 * 60
MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS = 32
SCHEDULER_DEPENDENCY_CACHE_TTL_SECONDS = 10 * 60
def _env_int(key: str, default: int) -> int:
    try:
        raw = os.environ.get(key)
        if raw is None or str(raw).strip() == "":
            return default
        return int(str(raw).strip())
    except Exception:
        return default

# T3: GPU 采集协议参数化（环境变量 SIMPLE_GPU_HISTORY_BUCKET/RETENTION 或启动参数），保持 60/72 默认回退，移除 300 硬编码
GPU_HISTORY_BUCKET_SECONDS = _env_int("SIMPLE_GPU_HISTORY_BUCKET_SECONDS", 0) or _env_int("SIMPLE_GPU_HISTORY_BUCKET", 60) or 60
_raw_ret_hours = _env_int("SIMPLE_GPU_HISTORY_RETENTION_HOURS", 0)
_raw_ret_seconds = _env_int("SIMPLE_GPU_HISTORY_RETENTION_SECONDS", 0)
_raw_ret_generic = _env_int("SIMPLE_GPU_HISTORY_RETENTION", 0)
if _raw_ret_seconds:
    GPU_HISTORY_RETENTION_SECONDS = _raw_ret_seconds
elif _raw_ret_hours:
    GPU_HISTORY_RETENTION_SECONDS = _raw_ret_hours * 3600
elif _raw_ret_generic:
    GPU_HISTORY_RETENTION_SECONDS = _raw_ret_generic if _raw_ret_generic > 1000 else _raw_ret_generic * 3600
else:
    GPU_HISTORY_RETENTION_SECONDS = 72 * 3600
# 启动参数覆盖（--gpu-history-bucket / --gpu-history-retention-*）
for _arg, _val in zip(sys.argv, sys.argv[1:] + [""]):
    if _arg in ("--gpu-history-bucket", "--gpu-history-bucket-seconds") and str(_val).strip().isdigit():
        try:
            GPU_HISTORY_BUCKET_SECONDS = max(1, int(str(_val).strip()))
        except Exception:
            pass
    if _arg in ("--gpu-history-retention", "--gpu-history-retention-hours") and str(_val).strip().isdigit():
        try:
            GPU_HISTORY_RETENTION_SECONDS = max(3600, int(str(_val).strip()) * 3600)
        except Exception:
            pass
    if _arg == "--gpu-history-retention-seconds" and str(_val).strip().isdigit():
        try:
            GPU_HISTORY_RETENTION_SECONDS = max(3600, int(str(_val).strip()))
        except Exception:
            pass
GPU_HISTORY_MAX_POINTS_PER_SERIES = _env_int("SIMPLE_GPU_HISTORY_MAX_POINTS", 72 * 60) or 72 * 60
GPU_HISTORY_MAX_SERIES = _env_int("SIMPLE_GPU_HISTORY_MAX_SERIES", 128) or 128
GPU_HISTORY_MAX_TOTAL_POINTS = _env_int("SIMPLE_GPU_HISTORY_MAX_TOTAL_POINTS", 40000) or 40000
GPU_IDLE_UTIL_THRESHOLD = int(os.environ.get("SIMPLE_GPU_IDLE_UTIL_THRESHOLD") or 5)
GPU_IDLE_MEM_THRESHOLD_MB = int(os.environ.get("SIMPLE_GPU_IDLE_MEM_THRESHOLD") or 200)

def reload_worker_runtime_config(env=None):
    """P7热加载：重读每服务器阈值/TTL环境变量，返回新配置并更新全局默认"""
    global GPU_IDLE_UTIL_THRESHOLD, GPU_IDLE_MEM_THRESHOLD_MB
    source = os.environ if env is None else env
    try:
        GPU_IDLE_UTIL_THRESHOLD = int(source.get("SIMPLE_GPU_IDLE_UTIL_THRESHOLD") or GPU_IDLE_UTIL_THRESHOLD)
    except Exception:
        pass
    try:
        GPU_IDLE_MEM_THRESHOLD_MB = int(source.get("SIMPLE_GPU_IDLE_MEM_THRESHOLD") or GPU_IDLE_MEM_THRESHOLD_MB)
    except Exception:
        pass
    return {"gpuIdleUtilThreshold": GPU_IDLE_UTIL_THRESHOLD, "gpuIdleMemThresholdMb": GPU_IDLE_MEM_THRESHOLD_MB}

# 已旁路5秒窗口：瞬时双阈值，无历史平均，不再维护滑动窗口
def _记录显卡利用率(gpu_id, util, now=None):
    """旁路：瞬时判空不再写入历史，保留兼容空函数"""
    return

def _计算5秒平均利用率(gpu_id):
    """旁路：瞬时判空不再计算平均，返回None兼容旧调用"""
    return None

def _record_gpu_util(gpu_id, util, now=None):
    return

def _calc_gpu_5s_avg(gpu_id):
    return None

# tail 三层预算（统一）：L1 实时日志 LIVE 256KB/120行（面板 live tail）、L2 审计日志 AUDIT 1MB 自适应（auditTail）、L3 调度有效尾 16KB/150→50行（_read_effective_tail），需保持分层截断一致，避免日志透传丢失
LIVE_LOG_TAIL_MAX_BYTES = 256 * 1024
AUDIT_TAIL_MAX_BYTES = 1024 * 1024
ATOMIC_REPLACE_ATTEMPTS = 6
ATOMIC_WRITE_SLOT_COUNT = 64
ATOMIC_WRITE_LOCKS = [threading.Lock() for _ in range(ATOMIC_WRITE_SLOT_COUNT)]
TRANSFER_STALL_SECONDS = 120
STATE_RETENTION_SECONDS = 24 * 60 * 60
TMP_RETENTION_SECONDS = 24 * 60 * 60
LAST_STATE_PRUNE = 0.0
AGENT_STATE_PRUNE_LOCK = threading.Lock()
AGENT_STATE_PRUNE_DIAGNOSTICS = {"status": "unknown", "scannedFiles": 0, "totalBytes": 0, "candidateCount": 0, "candidateBytes": 0, "sample": []}
MAX_AGENT_STATE_SCAN_ENTRIES = 10000
UPLOADS = {}
UPLOADS_LOCK = threading.Lock()
UPLOAD_INIT_REQUESTS = {}
UPLOAD_CANCELLED_INIT = {}
AGENT_STATE_DIR = ""
AUTO_COMPLETION_RUNNING = set()
ACTION_NAMES = [
    "run-plan",
    "stop-scheduler-operation",
    "stop-experiment",
    "retry-experiment",
    "reproduce-plan",
    "validate-plan",
    "dry-run-plan",
    "archive-artifacts",
    "archive-plan-copy",
    "exclude-results",
    "sync-artifacts",
    "complete-three-way",
    "delete-artifacts",
    "reconcile-deletions",
    "parse-results",
    "refresh-results",
    "self-check",
    "rescan-results",
    "run-quality-gate",
    "run-statistics",
    "export-paper-table",
    "check-claim-evidence",
    "deploy-runtime",
    "restart-agent",
    "create-debug-bundle",
    "create-offline-bundle",
    "cancel-operation",
    "check-output-contract",
    "parse-case-level",
    "run-leakage-check",
    "run-subgroup-analysis",
    "export-case-analysis",
    "plan-checkpoint-retention",
    "inspect-dataset",
    "export-plotting-contract",
    "infer-config-from-run",
    "recover-plan-from-run",
    "diagnose-result-anomaly",
    "compare-with-best-config",
    "start-worker-task",
    "register-code-sync-proof",
    "rebuild-distributed-results",
    "retry-worker-task",
    "stop-worker-task",
    "delete-worker-artifacts",
    "archive-worker-artifacts",
    "finalize-worker-operation",
    "install-rich",
]
WORKER_RESULT_ACTIONS = {
    "refresh-results", "rescan-results", "parse-results", "run-quality-gate", "run-statistics",
    "export-paper-table", "check-claim-evidence", "check-output-contract", "parse-case-level",
    "run-leakage-check", "run-subgroup-analysis", "export-case-analysis", "plan-checkpoint-retention",
    "inspect-dataset", "export-plotting-contract", "infer-config-from-run", "recover-plan-from-run",
    "diagnose-result-anomaly", "compare-with-best-config", "archive-artifacts", "archive-plan-copy", "exclude-results",
    "sync-artifacts", "complete-three-way",
}
WORKER_TENSORBOARD_ACTIONS = {"start-tensorboard", "stop-tensorboard", "get-tensorboard-status"}
WORKER_ENV_ACTIONS = {"install-rich"}
ACTION_PATHS = [
    "/api/actions/run-plan",
    "/api/actions/stop-scheduler-operation",
    "/api/actions/stop-experiment",
    "/api/actions/retry-experiment",
    "/api/actions/reproduce-plan",
    "/api/actions/validate-plan",
    "/api/actions/dry-run-plan",
    "/api/actions/archive-artifacts",
    "/api/actions/archive-plan-copy",
    "/api/actions/exclude-results",
    "/api/actions/sync-artifacts",
    "/api/actions/complete-three-way",
    "/api/actions/delete-artifacts",
    "/api/actions/reconcile-deletions",
    "/api/actions/parse-results",
    "/api/actions/save-result-policy",
    "/api/actions/refresh-results",
    "/api/actions/self-check",
    "/api/actions/rescan-results",
    "/api/actions/run-quality-gate",
    "/api/actions/run-statistics",
    "/api/actions/export-paper-table",
    "/api/actions/check-claim-evidence",
    "/api/actions/deploy-runtime",
    "/api/actions/restart-agent",
    "/api/actions/create-debug-bundle",
    "/api/actions/create-offline-bundle",
    "/api/actions/cancel-operation",
    "/api/actions/check-output-contract",
    "/api/actions/parse-case-level",
    "/api/actions/run-leakage-check",
    "/api/actions/run-subgroup-analysis",
    "/api/actions/export-case-analysis",
    "/api/actions/plan-checkpoint-retention",
    "/api/actions/inspect-dataset",
    "/api/actions/export-plotting-contract",
    "/api/actions/infer-config-from-run",
    "/api/actions/recover-plan-from-run",
    "/api/actions/diagnose-result-anomaly",
    "/api/actions/compare-with-best-config",
    "/api/actions/start-worker-task",
    "/api/actions/register-code-sync-proof",
    "/api/actions/rebuild-distributed-results",
    "/api/actions/retry-worker-task",
    "/api/actions/stop-worker-task",
    "/api/actions/delete-worker-artifacts",
    "/api/actions/archive-worker-artifacts",
    "/api/actions/finalize-worker-operation",
    "/api/actions/start-tensorboard",
    "/api/actions/stop-tensorboard",
    "/api/actions/get-tensorboard-status",
    "/api/actions/install-rich",
    "/api/actions/clear-cache",
    "/api/actions/clearCache",
    "/api/actions/preview-cache-cleanup",
    "/api/actions/delete-cache-candidates",
]
ACTION_ROUTES = set(ACTION_PATHS)
WORKER_COMMAND_QUEUE = {}
WORKER_COMMAND_RESULTS = {}
WORKER_COMMAND_CURSOR_CACHE = {}
WORKER_COMMAND_CURSOR_LOCK = threading.Lock()
EVENT_CURSOR_CACHE = {}
EVENT_CURSOR_LOCK = threading.Lock()
EVENT_APPEND_LOCK = threading.RLock()
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
CODE_SYNC_PROOF_LOCK = threading.RLock()
DURABLE_PLAN_QUEUE_PROCESSOR_LOCK = threading.Lock()
DURABLE_PLAN_QUEUE_PROCESSORS = {}
DISTRIBUTED_GPU_RESERVATIONS = {}
OPERATION_JOURNAL_CACHE = {}
OPERATION_JOURNAL_CACHE_LOCK = threading.Lock()
RUNTIME_JSON_CACHE = {}
RUNTIME_JSON_CACHE_LOCK = threading.Lock()
RUNTIME_FILE_INDEX_CACHE = {}
RUNTIME_FILE_INDEX_CACHE_LOCK = threading.Lock()
WORKER_ACTION_LOCK = threading.Lock()
WORKER_ACTION_INFLIGHT = {}
WORKER_ACTION_LAST_AT = {}
TENSORBOARD_PROXY_PORTS = {}
SCHEDULER_DEPENDENCY_CACHE = {}
SCHEDULER_DEPENDENCY_IN_FLIGHT = {}
SCHEDULER_DEPENDENCY_CACHE_LOCK = threading.Lock()
PLAN_STRUCTURAL_VALIDATION_CACHE = {}
PLAN_STRUCTURAL_VALIDATION_CACHE_LOCK = threading.RLock()

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def parse_iso_epoch(value):
    if not value:
        return None
    text = str(value).replace(".000Z", "Z")
    try:
        # Stamps come from now_iso()/time.gmtime(), so they must be read back as UTC;
        # time.mktime() would offset every age by the host timezone.
        return float(calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ")))
    except Exception:
        return None

def runtime_record_time(value):
    item = value if isinstance(value, dict) else {}
    for key in ("finishedAt", "finished_at", "updatedAt", "updated_at", "generatedAt", "generated_at", "startedAt", "started_at", "createdAt", "created_at"):
        parsed = parse_iso_epoch(item.get(key))
        if parsed:
            return parsed
    try:
        return float(item.get("seq") or item.get("queueSeq") or item.get("transferredBytes") or 0)
    except Exception:
        return 0.0

def runtime_terminal_status(value):
    status = str((value or {}).get("status") or (value or {}).get("state") or "").strip().lower()
    return status in ("completed", "failed", "cancelled", "canceled", "stalled", "unsupported", "error", "done")

def prune_scheduler_dependency_cache(now_epoch=None, active_key=None):
    now_value = float(now_epoch if now_epoch is not None else time.time())
    for key, value in list(SCHEDULER_DEPENDENCY_CACHE.items()):
        try:
            checked_at = float((value or {}).get("_checkedAtEpoch") or 0)
        except Exception:
            checked_at = 0.0
        if key != active_key and (checked_at <= 0 or now_value - checked_at > SCHEDULER_DEPENDENCY_CACHE_TTL_SECONDS):
            SCHEDULER_DEPENDENCY_CACHE.pop(key, None)
    if len(SCHEDULER_DEPENDENCY_CACHE) <= MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS:
        return
    ranked = sorted(SCHEDULER_DEPENDENCY_CACHE.items(), key=lambda item: float((item[1] or {}).get("_checkedAtEpoch") or 0), reverse=True)
    keep = {key for key, _ in ranked[:MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS]}
    if active_key in SCHEDULER_DEPENDENCY_CACHE:
        keep.add(active_key)
        if len(keep) > MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS:
            oldest = next((key for key, _ in reversed(ranked) if key != active_key and key in keep), None)
            if oldest is not None:
                keep.remove(oldest)
    for key in list(SCHEDULER_DEPENDENCY_CACHE.keys()):
        if key not in keep:
            SCHEDULER_DEPENDENCY_CACHE.pop(key, None)

def prune_worker_command_cursor_cache(now_epoch=None, active_path=None):
    now_value = float(now_epoch if now_epoch is not None else time.time())
    for path, value in list(WORKER_COMMAND_CURSOR_CACHE.items()):
        try:
            last_used = float((value or {}).get("lastUsedAt") or 0)
        except Exception:
            last_used = 0.0
        if path != active_path and (last_used <= 0 or now_value - last_used > WORKER_COMMAND_CURSOR_TTL_SECONDS):
            WORKER_COMMAND_CURSOR_CACHE.pop(path, None)
    if len(WORKER_COMMAND_CURSOR_CACHE) <= MAX_WORKER_COMMAND_CURSOR_RECORDS:
        return
    ranked = sorted(WORKER_COMMAND_CURSOR_CACHE.items(), key=lambda item: float((item[1] or {}).get("lastUsedAt") or 0), reverse=True)
    keep = {path for path, _ in ranked[:MAX_WORKER_COMMAND_CURSOR_RECORDS]}
    if active_path in WORKER_COMMAND_CURSOR_CACHE:
        keep.add(active_path)
        if len(keep) > MAX_WORKER_COMMAND_CURSOR_RECORDS:
            oldest = next((path for path, _ in reversed(ranked) if path != active_path and path in keep), None)
            if oldest is not None:
                keep.remove(oldest)
    for path in list(WORKER_COMMAND_CURSOR_CACHE.keys()):
        if path not in keep:
            WORKER_COMMAND_CURSOR_CACHE.pop(path, None)

def prune_event_cursor_cache(now_epoch=None, active_path=None):
    now_value = float(now_epoch if now_epoch is not None else time.time())
    for path, value in list(EVENT_CURSOR_CACHE.items()):
        try:
            last_used = float((value or {}).get("lastUsedAt") or 0)
        except Exception:
            last_used = 0.0
        if path != active_path and (last_used <= 0 or now_value - last_used > EVENT_CURSOR_TTL_SECONDS):
            EVENT_CURSOR_CACHE.pop(path, None)
    if len(EVENT_CURSOR_CACHE) <= MAX_EVENT_CURSOR_RECORDS:
        return
    ranked = sorted(EVENT_CURSOR_CACHE.items(), key=lambda item: float((item[1] or {}).get("lastUsedAt") or 0), reverse=True)
    keep = {path for path, _ in ranked[:MAX_EVENT_CURSOR_RECORDS]}
    if active_path in EVENT_CURSOR_CACHE:
        keep.add(active_path)
        if len(keep) > MAX_EVENT_CURSOR_RECORDS:
            oldest = next((path for path, _ in reversed(ranked) if path != active_path and path in keep), None)
            if oldest is not None:
                keep.remove(oldest)
    for path in list(EVENT_CURSOR_CACHE.keys()):
        if path not in keep:
            EVENT_CURSOR_CACHE.pop(path, None)

def prune_operation_journal_cache(now_epoch=None, active_path=None):
    now_value = float(now_epoch if now_epoch is not None else time.time())
    for path, value in list(OPERATION_JOURNAL_CACHE.items()):
        try:
            last_used = float((value or {}).get("lastUsedAt") or 0)
        except Exception:
            last_used = 0.0
        if path != active_path and (last_used <= 0 or now_value - last_used > OPERATION_JOURNAL_CACHE_TTL_SECONDS):
            OPERATION_JOURNAL_CACHE.pop(path, None)
    if len(OPERATION_JOURNAL_CACHE) <= MAX_OPERATION_JOURNAL_CACHE_RECORDS:
        return
    ranked = sorted(OPERATION_JOURNAL_CACHE.items(), key=lambda item: float((item[1] or {}).get("lastUsedAt") or 0), reverse=True)
    keep = {path for path, _ in ranked[:MAX_OPERATION_JOURNAL_CACHE_RECORDS]}
    if active_path in OPERATION_JOURNAL_CACHE:
        keep.add(active_path)
        if len(keep) > MAX_OPERATION_JOURNAL_CACHE_RECORDS:
            oldest = next((path for path, _ in reversed(ranked) if path != active_path and path in keep), None)
            if oldest is not None:
                keep.remove(oldest)
    for path in list(OPERATION_JOURNAL_CACHE.keys()):
        if path not in keep:
            OPERATION_JOURNAL_CACHE.pop(path, None)

def prune_runtime_memory_state():
    if len(UPLOADS) > MAX_UPLOAD_RECORDS:
        running = {key: value for key, value in UPLOADS.items() if not runtime_terminal_status(value)}
        terminal = [(key, value) for key, value in UPLOADS.items() if key not in running]
        keep_terminal = max(0, MAX_UPLOAD_RECORDS - len(running))
        keep = set(running.keys())
        keep.update(key for key, _ in sorted(terminal, key=lambda item: runtime_record_time(item[1]), reverse=True)[:keep_terminal])
        for key in list(UPLOADS.keys()):
            if key not in keep:
                UPLOADS.pop(key, None)
    if len(WORKER_COMMAND_RESULTS) > MAX_WORKER_COMMAND_RESULT_RECORDS:
        keep = set(key for key, _ in sorted(WORKER_COMMAND_RESULTS.items(), key=lambda item: runtime_record_time(item[1]), reverse=True)[:MAX_WORKER_COMMAND_RESULT_RECORDS])
        for key in list(WORKER_COMMAND_RESULTS.keys()):
            if key not in keep:
                WORKER_COMMAND_RESULTS.pop(key, None)
    if len(WORKER_ACTION_LAST_AT) > MAX_WORKER_ACTION_KEY_RECORDS:
        active = {key for key, value in WORKER_ACTION_INFLIGHT.items() if int(value or 0) > 0}
        inactive = [(key, value) for key, value in WORKER_ACTION_LAST_AT.items() if key not in active]
        keep_inactive = max(0, MAX_WORKER_ACTION_KEY_RECORDS - len(active))
        keep = set(active)
        keep.update(key for key, _ in sorted(inactive, key=lambda item: int(item[1] or 0), reverse=True)[:keep_inactive])
        for key in list(WORKER_ACTION_LAST_AT.keys()):
            if key not in keep:
                WORKER_ACTION_LAST_AT.pop(key, None)
        for key in list(WORKER_ACTION_INFLIGHT.keys()):
            if key not in keep and int(WORKER_ACTION_INFLIGHT.get(key) or 0) <= 0:
                WORKER_ACTION_INFLIGHT.pop(key, None)
    with SCHEDULER_DEPENDENCY_CACHE_LOCK:
        prune_scheduler_dependency_cache()
    with WORKER_COMMAND_CURSOR_LOCK:
        prune_worker_command_cursor_cache()
    with EVENT_CURSOR_LOCK:
        prune_event_cursor_cache()
    with OPERATION_JOURNAL_CACHE_LOCK:
        prune_operation_journal_cache()

def agent_install_dir(root):
    configured = os.environ.get("SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR", "").strip()
    if configured:
        return os.path.abspath(configured)
    try:
        script = os.path.abspath(__file__)
        runtime_dir = os.path.dirname(script)
        cluster_dir = os.path.dirname(runtime_dir)
        install_dir = os.path.dirname(cluster_dir)
        if os.path.basename(runtime_dir) == "runtime" and os.path.basename(cluster_dir) == "simple_cluster":
            return install_dir
    except Exception:
        pass
    return os.path.join(os.path.abspath(root), "simple_agent")

def fs_sha256(root, file_path):
    if not file_path:
        return {"ok": False, "error": "missing path"}
    ap = os.path.abspath(file_path)
    allowed = [
        os.path.abspath(agent_install_dir(root)),
        os.path.abspath(root),
        os.path.abspath(agent_dir(root)),
    ]
    if not any(ap == a or ap.startswith(a + os.sep) for a in allowed):
        return {"ok": False, "error": "path not allowed", "path": ap}
    if not os.path.isfile(ap):
        return {"ok": False, "error": "not a file", "path": ap}
    h = hashlib.sha256()
    with open(ap, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return {"ok": True, "path": ap, "sha256": h.hexdigest()}

def code_sync_inspect(root, relative_paths):
    root_abs = os.path.realpath(root)
    paths = []
    for value in relative_paths:
        rel = str(value or "").replace("\\", "/").strip()
        if not rel or rel.startswith("/") or rel.startswith("../") or "/../" in rel or rel == "..":
            return {"ok": False, "error": "unsafe relative path"}
        target = os.path.realpath(os.path.join(root_abs, rel))
        if os.path.commonpath([root_abs, target]) != root_abs:
            return {"ok": False, "error": "path outside project"}
        paths.append(rel)
    if not paths or len(paths) > 40:
        return {"ok": False, "error": "expected 1-40 paths"}
    result = subprocess.run(["git", "-C", root_abs, "status", "--porcelain=v1", "--untracked-files=all", "--", *paths], capture_output=True, text=True, timeout=15, check=False)
    git_available = result.returncode == 0
    tracked_result = subprocess.run(["git", "-C", root_abs, "ls-files", "--cached", "--", *paths], capture_output=True, text=True, timeout=15, check=False) if git_available else None
    tracked = set(tracked_result.stdout.splitlines()) if tracked_result and tracked_result.returncode == 0 else set()
    changed = {}
    for line in result.stdout.splitlines() if git_available else []:
        if len(line) >= 4:
            changed[line[3:].strip('"')] = line[:2]
    files = []
    for rel in paths:
        target = os.path.join(root_abs, rel)
        digest = fs_sha256(root_abs, target) if os.path.isfile(target) else {"ok": False}
        exists = os.path.isfile(target)
        status = changed.get(rel, "") or ("??" if git_available and exists and rel not in tracked else "")
        files.append({"path": rel, "status": status, "exists": exists, "sha256": digest.get("sha256", "")})
    return {"ok": True, "gitAvailable": git_available, "files": files}

def project_state_namespace(root):
    root_abs = os.path.abspath(root)
    base = os.path.basename(root_abs.rstrip(os.sep)) or "project"
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in base)[:64] or "project"
    digest = hashlib.sha256(root_abs.encode("utf-8")).hexdigest()[:16]
    return f"{safe}.{digest}"

def default_agent_state_dir(root):
    return os.path.join(agent_install_dir(root), "state", "projects", project_state_namespace(root))

def resolve_agent_state_dir(root, configured=""):
    root_abs = os.path.abspath(root)
    namespace = project_state_namespace(root_abs)
    text = str(configured or "").strip()
    if not text:
        return default_agent_state_dir(root_abs)
    base = os.path.abspath(os.path.expanduser(text))
    # Shared state dir is unsafe: multiple projects would clobber file/event state.
    # Always place project runtime cache under <configured>/projects/<namespace>.
    marker = os.path.normcase(os.path.join("state", "projects"))
    base_norm = os.path.normcase(base)
    if base_norm.endswith(os.path.normcase(os.path.join("projects", namespace))) or base_norm.endswith(os.path.normcase(namespace)):
        return base
    if marker in base_norm:
        parent = base
        # if configured already points into .../state/projects, keep namespace child
        if os.path.basename(base_norm.rstrip(os.sep)) == "projects":
            return os.path.join(base, namespace)
        return os.path.join(os.path.dirname(base), namespace) if os.path.basename(os.path.dirname(base_norm.rstrip(os.sep))) == "projects" else os.path.join(base, namespace)
    return os.path.join(base, "projects", namespace)

def agent_dir(root):
    configured = AGENT_STATE_DIR or os.environ.get("SIMPLE_EXPERIMENT_AGENT_STATE_DIR", "")
    return resolve_agent_state_dir(root, configured)

def path_for(root, name):
    return os.path.join(agent_dir(root), name)

def state_child_path(root, folder, name):
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(name or ""))[:120]
    digest = hashlib.sha256(str(name or "").encode("utf-8")).hexdigest()[:12]
    base = safe or "item"
    target_dir = os.path.join(agent_dir(root), folder)
    os.makedirs(target_dir, exist_ok=True)
    return os.path.join(target_dir, f"{base}.{digest}")

def safe_record_name(value):
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(value or ""))[:120]
    digest = hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:12]
    return f"{safe or 'item'}.{digest}.json"

def transfer_status_path(root, transfer_id):
    return safe_project_path(root, "simple_cluster/file_transfers/" + safe_record_name(transfer_id))

def public_transfer_record(item):
    source = item if isinstance(item, dict) else {}
    out = {"schemaVersion": SCHEMA_VERSION}
    for key in ("transferId", "clientTransferId", "status", "direction", "remotePath", "transferredBytes", "totalBytes", "size", "expectedSize", "receivedBytes", "sha256", "overwrite", "message", "error", "startedAt", "updatedAt", "finishedAt"):
        if key in source and source.get(key) is not None:
            out[key] = source.get(key)
    if str(out.get("status") or "").lower() == "running":
        snapshot = source.get("targetSnapshot") if isinstance(source.get("targetSnapshot"), dict) else None
        if snapshot:
            out["targetSnapshot"] = {
                "exists": bool(snapshot.get("exists")),
                **({"size": int(snapshot.get("size") or 0)} if snapshot.get("size") is not None else {}),
                **({"sha256": str(snapshot.get("sha256") or "")} if snapshot.get("sha256") else {}),
            }
    if "transferId" not in out:
        out["transferId"] = str(source.get("id") or "")
    if "status" not in out:
        out["status"] = "unknown"
    if "transferredBytes" not in out:
        out["transferredBytes"] = 0
    out["updatedAt"] = source.get("updatedAt") or now_iso()
    # transferredBytes is defaulted to 0 above, so an upload that only reports receivedBytes needs
    # the alias to win over that placeholder rather than sit behind it.
    total = transfer_int(out.get("totalBytes"), 0) or transfer_int(out.get("expectedSize"), 0) or transfer_int(out.get("size"), 0)
    done = transfer_int(out.get("transferredBytes"), 0) or transfer_int(out.get("receivedBytes"), 0)
    if total > 0:
        out["percent"] = round(min(100.0, max(0.0, done * 100.0 / total)), 1)
    # A writer that dies leaves its last updatedAt behind, so "running" alone cannot tell a live
    # transfer from an abandoned one; surface the stall instead of letting it poll forever.
    if str(out.get("status") or "").lower() == "running":
        age = iso_age_seconds(out.get("updatedAt"))
        if age is not None and age > TRANSFER_STALL_SECONDS:
            out["stalled"] = True
            out["stalledForSeconds"] = int(age)
    return out

def transfer_int(value, fallback=0):
    try:
        if value is None or value == "":
            return fallback
        return int(float(value))
    except Exception:
        return fallback

def write_transfer_status(root, item):
    if isinstance(item, dict):
        item["updatedAt"] = now_iso()
    public = public_transfer_record(item)
    transfer_id = str(public.get("transferId") or "").strip()
    if not transfer_id:
        return public
    atomic_write(transfer_status_path(root, transfer_id), public)
    return public

def read_transfer_status(root, transfer_id):
    transfer_id = str(transfer_id or "").strip()
    if not transfer_id:
        return {"schemaVersion": SCHEMA_VERSION, "transferId": "", "status": "unknown", "transferredBytes": 0}
    with UPLOADS_LOCK:
        cached = UPLOADS.get(transfer_id)
        snapshot = dict(cached) if isinstance(cached, dict) else None
        if snapshot and isinstance(snapshot.get("targetSnapshot"), dict):
            snapshot["targetSnapshot"] = dict(snapshot["targetSnapshot"])
    if snapshot is not None:
        return public_transfer_record(snapshot)
    record = read_json(transfer_status_path(root, transfer_id), None)
    if isinstance(record, dict):
        return public_transfer_record(record)
    return {"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "status": "unknown", "transferredBytes": 0}

def active_upload_count_unlocked(exclude_transfer_id=""):
    return sum(1 for transfer_id, row in UPLOADS.items()
               if transfer_id != exclude_transfer_id
               and isinstance(row, dict)
               and str(row.get("status") or "").lower() in ("running", "cancelling"))

def upload_item_from_status(root, transfer_id):
    transfer_id = str(transfer_id or "").strip()
    if not transfer_id:
        return None
    with UPLOADS_LOCK:
        if transfer_id in UPLOADS:
            return UPLOADS.get(transfer_id)
    public = read_transfer_status(root, transfer_id)
    remote_path = str(public.get("remotePath") or "").strip()
    if not remote_path:
        return None
    tmp = state_child_path(root, "uploads", f"{transfer_id}-{remote_path}")
    if not os.path.exists(tmp) and str(public.get("status") or "").lower() != "running":
        return None
    item = {
        "schemaVersion": SCHEMA_VERSION,
        "transferId": transfer_id,
        "clientTransferId": public.get("clientTransferId") or "",
        "status": public.get("status") or "running",
        "remotePath": remote_path,
        "transferredBytes": int(public.get("transferredBytes") or 0),
        "totalBytes": int(public.get("totalBytes") or public.get("expectedSize") or 0),
        "tmp": tmp,
        "sha256": str(public.get("sha256") or ""),
        "overwrite": str(public.get("overwrite") or "if_same_size"),
        "targetSnapshot": public.get("targetSnapshot") if isinstance(public.get("targetSnapshot"), dict) else None,
        "startedAt": public.get("startedAt") or now_iso(),
    }
    with UPLOADS_LOCK:
        current = UPLOADS.get(transfer_id)
        if isinstance(current, dict):
            return current
        UPLOADS[transfer_id] = item
    return item

def upload_init_key(transfer_id, client_transfer_id):
    return str(transfer_id or "") + "\0" + str(client_transfer_id or "")

def prune_upload_init_cancellations_locked(now=None):
    current = time.time() if now is None else float(now)
    for key, expires in list(UPLOAD_CANCELLED_INIT.items()):
        if float(expires or 0) <= current:
            UPLOAD_CANCELLED_INIT.pop(key, None)

def begin_upload_init_request(transfer_id, client_transfer_id):
    key = upload_init_key(transfer_id, client_transfer_id)
    with UPLOADS_LOCK:
        prune_upload_init_cancellations_locked()
        if key in UPLOAD_CANCELLED_INIT:
            return "cancelled"
        if int(UPLOAD_INIT_REQUESTS.get(key) or 0) > 0:
            return "pending"
        UPLOAD_INIT_REQUESTS[key] = 1
        return "started"

def upload_init_cancelled_locked(transfer_id, client_transfer_id):
    prune_upload_init_cancellations_locked()
    return upload_init_key(transfer_id, client_transfer_id) in UPLOAD_CANCELLED_INIT

def finish_upload_init_request(root, transfer_id, client_transfer_id):
    key = upload_init_key(transfer_id, client_transfer_id)
    with UPLOADS_LOCK:
        remaining = max(0, int(UPLOAD_INIT_REQUESTS.get(key) or 0) - 1)
        if remaining:
            UPLOAD_INIT_REQUESTS[key] = remaining
        else:
            UPLOAD_INIT_REQUESTS.pop(key, None)
        item = UPLOADS.get(str(transfer_id or ""))
        if (not remaining and isinstance(item, dict)
                and str(item.get("clientTransferId") or "") == str(client_transfer_id or "")
                and item.get("_cancelRequested")
                and str(item.get("status") or "").lower() in ("running", "cancelling")
                and int(item.get("_activeRequests") or 0) <= 0):
            item["_cancelRequested"] = True
            item["status"] = "cancelled"
            item["error"] = "upload cancelled by client"
            item["finishedAt"] = now_iso()
            write_transfer_status(root, item)

def request_upload_init_cancellation(transfer_id, client_transfer_id):
    key = upload_init_key(transfer_id, client_transfer_id)
    with UPLOADS_LOCK:
        now = time.time()
        prune_upload_init_cancellations_locked(now)
        if key not in UPLOAD_CANCELLED_INIT:
            if len(UPLOAD_CANCELLED_INIT) >= MAX_UPLOAD_CANCELLED_INIT_RECORDS:
                return False, int(UPLOAD_INIT_REQUESTS.get(key) or 0), "upload cancellation registry is full"
            UPLOAD_CANCELLED_INIT[key] = now + UPLOAD_CANCELLED_INIT_TTL_SECONDS
        return True, int(UPLOAD_INIT_REQUESTS.get(key) or 0), ""

def begin_upload_request(root, transfer_id, requested_owner):
    item = upload_item_from_status(root, transfer_id)
    if not item:
        return None, {"error": "unknown transfer", "transferId": transfer_id, "status": "unknown"}
    with UPLOADS_LOCK:
        current = UPLOADS.get(transfer_id)
        if not isinstance(current, dict):
            return None, {"error": "unknown transfer", "transferId": transfer_id, "status": "unknown"}
        expected_owner = str(current.get("clientTransferId") or "")
        if expected_owner and requested_owner != expected_owner:
            return None, {"error": "upload slot ownership changed", "transferId": transfer_id, "status": str(current.get("status") or "unknown")}
        if str(current.get("status") or "").lower() != "running":
            return None, {"error": "upload is not accepting data", "transferId": transfer_id, "status": str(current.get("status") or "unknown")}
        current["_activeRequests"] = max(0, int(current.get("_activeRequests") or 0)) + 1
        return current, None

def finish_upload_request(root, item):
    if not isinstance(item, dict):
        return
    with UPLOADS_LOCK:
        item["_activeRequests"] = max(0, int(item.get("_activeRequests") or 0) - 1)
        if (item["_activeRequests"] == 0
                and item.get("_cancelRequested")
                and str(item.get("status") or "").lower() == "cancelling"
                and int(UPLOAD_INIT_REQUESTS.get(upload_init_key(item.get("transferId"), item.get("clientTransferId"))) or 0) <= 0):
            item["status"] = "cancelled"
            item["error"] = "upload cancelled by client"
            item["finishedAt"] = now_iso()
            write_transfer_status(root, item)

def move_file_replace(src, dst):
    # Never delete the last complete target as a fallback. If Windows keeps the
    # destination open beyond the bounded retry window, preserve both the old
    # target and staged upload and report failure for an explicit retry.
    replace_with_retry(src, dst)
    invalidate_runtime_json_cache(dst)

# POSIX rename is atomic, but Windows raises a sharing violation when two writers replace the
# same destination at once; a short bounded retry keeps concurrent state writes from failing.
def replace_with_retry(src, dst, attempts=ATOMIC_REPLACE_ATTEMPTS):
    last_error = None
    for index in range(max(1, int(attempts or 1))):
        try:
            os.replace(src, dst)
            return
        except OSError as exc:
            last_error = exc
            time.sleep(0.005 * (index + 1))
    raise last_error

def atomic_write_file(path, writer):
    """Write through one reusable sibling slot, serialized with bounded striped locks."""
    path = os.fspath(path)
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    normalized = os.path.normcase(os.path.abspath(path))
    stripe = int.from_bytes(hashlib.sha256(normalized.encode("utf-8", errors="surrogatepass")).digest()[:4], "big") % ATOMIC_WRITE_SLOT_COUNT
    temporary = path + ".writing"
    with ATOMIC_WRITE_LOCKS[stripe]:
        try:
            previous = os.lstat(temporary)
            if not stat.S_ISREG(previous.st_mode):
                raise OSError("atomic write staging slot is not a regular file: " + temporary)
        except FileNotFoundError:
            pass
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o600)
        try:
            opened = os.fstat(descriptor)
            current = os.lstat(temporary)
            if (not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(current.st_mode)
                    or getattr(opened, "st_nlink", 1) > 1 or getattr(current, "st_nlink", 1) > 1
                    or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
                raise OSError("atomic write staging slot identity changed: " + temporary)
            try:
                os.fchmod(descriptor, 0o600)
            except OSError:
                pass
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
                descriptor = -1
                writer(stream)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        replace_with_retry(temporary, path)
        try:
            directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass

def atomic_write(path, payload, compact=False):
    def write(stream):
        # Indented output is worth it for hand-inspected state, but not for bulk time series
        # that are rewritten every sampling cycle.
        if compact:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    atomic_write_file(path, write)
    invalidate_runtime_json_cache(path)

def file_size(path):
    try:
        return os.path.getsize(path)
    except Exception:
        return 0

def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback

def prune_runtime_json_cache(now_value=None, active_key=""):
    current = time.time() if now_value is None else float(now_value)
    for key, value in list(RUNTIME_JSON_CACHE.items()):
        if key == active_key:
            continue
        if current - float((value or {}).get("lastUsedAt") or 0) > RUNTIME_JSON_CACHE_TTL_SECONDS:
            RUNTIME_JSON_CACHE.pop(key, None)
    if len(RUNTIME_JSON_CACHE) <= MAX_RUNTIME_JSON_CACHE_RECORDS:
        return
    ranked = sorted(RUNTIME_JSON_CACHE.items(), key=lambda item: float((item[1] or {}).get("lastUsedAt") or 0), reverse=True)
    keep = {key for key, _ in ranked[:MAX_RUNTIME_JSON_CACHE_RECORDS]}
    if active_key:
        keep.add(active_key)
    for key in list(RUNTIME_JSON_CACHE.keys()):
        if key not in keep:
            RUNTIME_JSON_CACHE.pop(key, None)

def read_runtime_json_cached(path, fallback):
    key = os.path.abspath(path)
    try:
        stat = os.stat(key)
    except OSError:
        with RUNTIME_JSON_CACHE_LOCK:
            RUNTIME_JSON_CACHE.pop(key, None)
        return fallback
    signature = (int(stat.st_dev), int(stat.st_ino), int(stat.st_size), int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1000000000))))
    now_value = time.time()
    with RUNTIME_JSON_CACHE_LOCK:
        prune_runtime_json_cache(now_value, key)
        cached = RUNTIME_JSON_CACHE.get(key)
        if cached and cached.get("signature") == signature:
            cached["lastUsedAt"] = now_value
            return cached.get("value")
    sentinel = object()
    value = read_json(key, sentinel)
    if value is sentinel:
        with RUNTIME_JSON_CACHE_LOCK:
            RUNTIME_JSON_CACHE.pop(key, None)
        return fallback
    with RUNTIME_JSON_CACHE_LOCK:
        RUNTIME_JSON_CACHE[key] = {"signature": signature, "value": value, "lastUsedAt": now_value}
        prune_runtime_json_cache(now_value, key)
    return value

def invalidate_runtime_json_cache(path):
    try:
        key = os.path.abspath(path)
    except Exception:
        return
    with RUNTIME_JSON_CACHE_LOCK:
        RUNTIME_JSON_CACHE.pop(key, None)

def prune_runtime_file_index_cache(now_value=None, active_key=""):
    current = time.time() if now_value is None else float(now_value)
    for key, value in list(RUNTIME_FILE_INDEX_CACHE.items()):
        if key == active_key:
            continue
        if current - float((value or {}).get("lastUsedAt") or 0) > RUNTIME_FILE_INDEX_TTL_SECONDS:
            RUNTIME_FILE_INDEX_CACHE.pop(key, None)
    if len(RUNTIME_FILE_INDEX_CACHE) <= MAX_RUNTIME_FILE_INDEX_RECORDS:
        return
    ranked = sorted(RUNTIME_FILE_INDEX_CACHE.items(), key=lambda item: float((item[1] or {}).get("lastUsedAt") or 0), reverse=True)
    keep = {key for key, _ in ranked[:MAX_RUNTIME_FILE_INDEX_RECORDS]}
    if active_key:
        keep.add(active_key)
    for key in list(RUNTIME_FILE_INDEX_CACHE.keys()):
        if key not in keep:
            RUNTIME_FILE_INDEX_CACHE.pop(key, None)

def runtime_directory_signature(path):
    try:
        stat = os.stat(path)
        return (int(stat.st_dev), int(stat.st_ino), int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1000000000))))
    except OSError:
        return None

def scheduler_state_paths(root):
    base = os.path.abspath(os.path.join(root, "simple_cluster", "tmp", "cluster_scheduler"))
    key = base + "|*_state.json"
    signature = runtime_directory_signature(base)
    if signature is None:
        with RUNTIME_FILE_INDEX_CACHE_LOCK:
            RUNTIME_FILE_INDEX_CACHE.pop(key, None)
        return []
    now_value = time.time()
    with RUNTIME_FILE_INDEX_CACHE_LOCK:
        prune_runtime_file_index_cache(now_value, key)
        cached = RUNTIME_FILE_INDEX_CACHE.get(key)
        if cached and cached.get("signature") == signature:
            cached["lastUsedAt"] = now_value
            return list(cached.get("paths") or [])
    paths = sorted(glob.glob(os.path.join(base, "*_state.json")))
    refreshed_signature = runtime_directory_signature(base)
    with RUNTIME_FILE_INDEX_CACHE_LOCK:
        RUNTIME_FILE_INDEX_CACHE[key] = {"signature": refreshed_signature, "paths": paths, "lastUsedAt": now_value}
        prune_runtime_file_index_cache(now_value, key)
    return list(paths)

def safe_project_path(root, value):
    # tmp/ 为主，simple_cluster/tmp 仅过渡兼容，下版本移除（强绑定 src/syncState.ts:MANAGED_ARTIFACT_PREFIXES 13前缀；绝对路径经 relpath 归一化，双兼容防 logPath 越界致空日志 P0）
    raw = str(value or "").replace("\\", "/")
    if os.path.isabs(raw) or raw.startswith("/"):
        try:
            rel = os.path.relpath(os.path.abspath(raw), os.path.abspath(root)).replace("\\", "/")
        except Exception:
            rel = raw.lstrip("/")
    else:
        rel = raw.lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise ValueError("unsafe path")
    # 终版5文件契约（2026-09）：4种契约 basename 任意深度放行，第5种大表走 experiments/results 前缀
    root_result_files = ("metrics_summary.csv", "metrics_case.csv", "stdout.log", "stderr.log")
    if parts[-1].lower() in root_result_files:
        pass
    elif parts[0] not in ("simple_cluster", "work_dirs", "experiments", "configs", "archives", "exports", "results", "paper", "outputs", "runs", "logs", "test_results", "lightning_logs", "custom_results", "reports", "artifacts", "evals", "eval", "evaluation", "predictions", "submissions", "tmp"):
        raise ValueError("path outside allowed project roots")
    target = os.path.abspath(os.path.join(root, *parts))
    root_abs = os.path.abspath(root)
    real_target = os.path.realpath(target)
    real_root = os.path.realpath(root_abs)
    if not real_target.startswith(real_root + os.sep) and real_target != real_root:
        raise ValueError("path outside project")
    deny_names = ("id_rsa", "id_ed25519", ".ssh", "known_hosts")
    if any(part in deny_names or part.endswith(".pem") for part in parts):
        raise ValueError("protected file path")
    return target

# 终版5文件契约（2026-09）：ROOT 仅 4 种契约 basename；TOP 仅 output_dir 宿主；PREFIX 仅 experiments/results。
RESULT_ROOT_FILES = {
    "metrics_summary.csv", "metrics_case.csv",
    "stdout.log", "stderr.log",
}

RESULT_TOP_DIRS = {
    "work_dirs", "results", "outputs", "runs", "logs", "test_results", "lightning_logs",
    "custom_results", "reports", "artifacts", "evals", "eval", "evaluation", "predictions", "submissions",
}

RESULT_PREFIX_PAIRS = {
    ("experiments", "results"),
}

RESULT_EXACT_PAIRS = {("experiments", "results.csv")}
MAX_RESULT_CANDIDATE_CACHE_RECORDS = 512
RESULT_CANDIDATE_CACHE = {}
MAX_WORKER_AVAILABILITY_RECORDS = 64
WORKER_AVAILABILITY_EXPIRY_FACTOR = 4

NON_RESULT_METADATA_FILES = {
    "artifact_manifest.json", "checkpoint_manifest.json", "manifest.json",
    "metadata.json", "status.json", "state.json", "progress.json", "job.json",
    "jobs.json", "jobs.csv", "env_snapshot.json", "config_snapshot.json",
    "config_snapshot.yaml", "config_snapshot.yml",
}

def allowed_result_candidate(value):
    rel = str(value or "").strip().strip("'\"").replace("\\", "/").lstrip("/")
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        return False
    if not re.search(r"\.(csv|json|txt|log|out)$", parts[-1], re.I):
        return False
    lowered = [part.lower() for part in parts]
    # 终版判定同步：4种契约 basename 任意深度放行；experiments/results/ 前缀任意 basename 放行
    if lowered[-1] in RESULT_ROOT_FILES:
        return True
    if tuple(lowered) in RESULT_EXACT_PAIRS:
        return True
    if lowered[0] in RESULT_TOP_DIRS:
        return len(lowered) >= 2
    return len(lowered) >= 2 and tuple(lowered[:2]) in RESULT_PREFIX_PAIRS

def parseable_result_candidate(value):
    text = normalize_result_candidate(value)
    if not text or not allowed_result_candidate(text):
        return ""
    lower = text.lower()
    base = os.path.basename(lower)
    if lower in IGNORED_RESULT_FILES or lower.startswith("simple_cluster/results/") or base in NON_RESULT_METADATA_FILES:
        return ""
    if re.search(r"(?:_snapshot|_manifest|_status|_state|_progress)\.json$", base):
        return ""
    return text

def structured_result_candidate(value):
    candidate = parseable_result_candidate(value)
    if not candidate:
        return ""
    if os.path.basename(candidate).lower() in STRUCTURED_RESULT_DIAGNOSTIC_LOGS:
        return ""
    return candidate

DELETE_ALLOWED_TOP_DIRS = ("work_dirs", "exports", "results")
DELETE_ALLOWED_PREFIXES = (
    ("experiments", "runs"),
    ("experiments", "results"),
    ("simple_cluster", "archive"),
    ("simple_cluster", "archive_manifests"),
    ("simple_cluster", "results"),
    ("simple_cluster", "logs"),
    ("simple_cluster", "debug"),
    ("simple_cluster", "tmp"),
    ("paper", "tables"),
)
DELETE_ALLOWED_EXACT_FILES = (("experiments", "results.csv"),)
DELETE_DENY_NAMES = ("id_rsa", "id_ed25519", ".ssh", "known_hosts", ".env", ".env.local", ".env.production")
DELETE_DENY_TOP_DIRS = (".git", ".svn", ".hg", ".vscode", ".idea", "node_modules", "__pycache__", ".venv", "venv", "env")
LEGACY_DELETE_SEARCH_ROOTS = ("work_dirs", "experiments/runs", "simple_cluster/archive", "simple_cluster/results", "results", "exports")
LEGACY_DELETE_MAX_SCAN = 20000
LEGACY_DELETE_MAX_DEPTH = 8

def safe_project_delete_path(root, value):
    raw = str(value or "").replace("\\", "/").strip()
    root_abs = os.path.abspath(root)
    if os.path.isabs(raw) or raw.startswith("/"):
        target_abs = os.path.abspath(raw)
        try:
            rel = os.path.relpath(target_abs, root_abs).replace("\\", "/")
        except Exception:
            rel = ""
    else:
        rel = raw.lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise ValueError("unsafe path")
    lowered = [p.lower() for p in parts]
    if any(part in DELETE_DENY_TOP_DIRS for part in lowered):
        raise ValueError("protected project metadata path")
    if any(part in DELETE_DENY_NAMES or part.endswith(".pem") or part.endswith(".key") for part in lowered):
        raise ValueError("protected credential path")
    allowed_base_parts = managed_delete_base_parts(parts)
    if not allowed_base_parts:
        raise ValueError("task deletion only allows experiment artifact paths")
    target = os.path.abspath(os.path.join(root_abs, *parts))
    real_target = os.path.realpath(target)
    real_root = os.path.realpath(root_abs)
    if not real_target.startswith(real_root + os.sep) and real_target != real_root:
        raise ValueError("path outside project")
    allowed_base = os.path.abspath(os.path.join(root_abs, *allowed_base_parts))
    real_allowed_base = os.path.realpath(allowed_base)
    if real_allowed_base != allowed_base:
        raise ValueError("task deletion path crosses symbolic link")
    if real_target != real_allowed_base and not real_target.startswith(real_allowed_base + os.sep):
        raise ValueError("task deletion path escapes artifact root")
    return target

def managed_delete_target(parts):
    return managed_delete_base_parts(parts) is not None

def managed_delete_base_parts(parts):
    if not parts:
        return None
    lowered = [str(p or "").lower() for p in parts]
    if len(lowered) == 1:
        return None
    if lowered[0] in DELETE_ALLOWED_TOP_DIRS:
        return parts[:1]
    for exact in DELETE_ALLOWED_EXACT_FILES:
        if tuple(lowered) == exact:
            return parts[:len(exact)]
    for prefix in DELETE_ALLOWED_PREFIXES:
        if len(lowered) > len(prefix) and tuple(lowered[:len(prefix)]) == prefix:
            return parts[:len(prefix)]
    return None

def legacy_delete_token(value):
    text = str(value or "").replace("\\", "/").strip().strip("/")
    if not text or "/" in text or text in (".", ".."):
        return ""
    if len(text) > 180:
        return ""
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-:@+=")
    if any(ch not in allowed for ch in text):
        return ""
    if text.lower() in DELETE_DENY_NAMES or text.lower() in DELETE_DENY_TOP_DIRS:
        return ""
    return text

def legacy_delete_candidate_paths(root, value):
    token = legacy_delete_token(value)
    if not token:
        return []
    root_abs = os.path.abspath(root)
    candidates = []
    scanned = 0
    for rel_root in LEGACY_DELETE_SEARCH_ROOTS:
        try:
            base = safe_project_path(root_abs, rel_root)
        except Exception:
            continue
        if not os.path.isdir(base):
            continue
        base_depth = base.rstrip(os.sep).count(os.sep)
        for current, dirs, files in os.walk(base):
            scanned += 1
            if scanned > LEGACY_DELETE_MAX_SCAN:
                break
            depth = current.rstrip(os.sep).count(os.sep) - base_depth
            dirs[:] = [d for d in dirs if d not in DELETE_DENY_TOP_DIRS and d.lower() not in DELETE_DENY_NAMES]
            if depth >= LEGACY_DELETE_MAX_DEPTH:
                dirs[:] = []
            for name in list(dirs) + list(files):
                if name == token:
                    path = os.path.join(current, name)
                    try:
                        candidates.append(safe_project_delete_path(root_abs, os.path.relpath(path, root_abs).replace("\\", "/")))
                    except Exception:
                        pass
            if scanned > LEGACY_DELETE_MAX_SCAN:
                break
    real_candidates = []
    seen = set()
    for path in sorted(candidates, key=lambda item: (len(os.path.realpath(item)), os.path.realpath(item))):
        real = os.path.realpath(path)
        if real in seen:
            continue
        if any(real.startswith(parent + os.sep) for parent in seen):
            continue
        seen.add(real)
        real_candidates.append(path)
    return real_candidates

def file_info(root, path_value):
    target = safe_project_path(root, path_value)
    st = os.stat(target)
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "path": str(path_value).replace("\\", "/"),
        "exists": True,
        "name": os.path.basename(target),
        "type": "directory" if os.path.isdir(target) else "file",
        "size": st.st_size,
        "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
    }
    if os.path.isfile(target):
        result["sha256"] = sha256_file(target)
    return result

def read_seq(root):
    try:
        return int(open(path_for(root, "seq.txt"), "r", encoding="utf-8").read().strip() or "0")
    except Exception:
        return 0

def write_seq(root, seq):
    atomic_write(path_for(root, "seq.txt"), seq)

def compact_terminal_event(event, original_bytes):
    if event.get("type") not in ("operation_completed", "operation_failed", "operation_cancelled"):
        return None
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    body = {}
    for key in ("action", "opId", "status", "message", "planFile", "planRevision", "workerId", "runId", "completedRunId"):
        value = payload.get(key)
        if isinstance(value, str):
            body[key] = value[:2048]
    for key in ("publish", "jobCount", "completedCount", "failedCount", "fileCount", "rowCount"):
        value = payload.get(key)
        if isinstance(value, (bool, int, float)):
            body[key] = value
    paths = payload.get("outputPaths")
    if isinstance(paths, list):
        if len(paths) <= 64 and all(isinstance(value, str) and len(value.encode("utf-8")) <= 1024 for value in paths):
            body["outputPaths"] = paths
        else:
            # An incomplete output list must never be advertised as a publishable completion.
            body.update(status="failed", message="终态输出清单超过回执上限，未确认发布；请检查操作详情")
    body.update(compacted=True, omittedBytes=original_bytes)
    return {**{key: event[key] for key in ("schemaVersion", "seq", "generatedAt", "source", "hubId", "operationId") if key in event},
            "type": "operation_failed" if body.get("status") == "failed" else event["type"], "payload": body}

def append_event(root, event):
    prune_runtime_memory_state()
    os.makedirs(agent_dir(root), exist_ok=True)
    # ThreadingHTTPServer serves concurrent actions, so allocating seq, appending the line and
    # compacting must be one critical section; duplicate seq values silently drop realtime
    # events for any client whose cursor already passed that number. RLock because the
    # completion pipeline below can re-enter append_event on this same thread.
    original_event = event
    with EVENT_APPEND_LOCK:
        seq = read_seq(root) + 1
        event = {"schemaVersion": SCHEMA_VERSION, "seq": seq, "generatedAt": now_iso(), "source": "hub_agent", "hubId": event.get("hubId", "hub"), **event}
        encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        encoded_bytes = len(encoded.encode("utf-8"))
        if encoded_bytes > MAX_AGENT_EVENT_RECORD_BYTES:
            terminal = compact_terminal_event(event, encoded_bytes)
            event = terminal or {"schemaVersion": SCHEMA_VERSION, "seq": seq, "generatedAt": now_iso(), "source": "hub_agent", "hubId": event.get("hubId", "hub"),
                     "type": "diagnostics_updated", "payload": {"code": "journal_gap", "reason": "event_record_exceeds_limit", "omittedType": str(event.get("type") or "event")[:96], "omittedBytes": encoded_bytes}}
            operation_id = str(original_event.get("operationId") or "").strip()[:160] if isinstance(original_event, dict) else ""
            if operation_id:
                event["operationId"] = operation_id
            encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        with open(path_for(root, "events.jsonl"), "a", encoding="utf-8") as f:
            f.write(encoded + "\n")
        write_seq(root, seq)
        compact_journal(root)
    prune_agent_state(root)
    maybe_auto_run_completion_pipeline(root, original_event)
    return event

def worker_command_path(root, worker_id):
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(worker_id or "worker"))[:80] or "worker"
    return path_for(root, f"worker_commands_{safe}.jsonl")

def worker_command_checkpoint_path(root, worker_id):
    return worker_command_path(root, worker_id)[:-6] + ".cursor.json"

def worker_command_queue_identity(path):
    stat = os.stat(path)
    prefix_length = min(512, stat.st_size)
    with open(path, "rb") as handle:
        prefix = handle.read(prefix_length)
    return {"device": stat.st_dev, "inode": stat.st_ino, "size": stat.st_size,
            "prefixLength": prefix_length, "prefixSha256": hashlib.sha256(prefix).hexdigest()}

def load_worker_command_checkpoint(root, worker_id):
    checkpoint = read_json(worker_command_checkpoint_path(root, worker_id), {})
    if not isinstance(checkpoint, dict) or not checkpoint:
        return 0
    try:
        identity = worker_command_queue_identity(worker_command_path(root, worker_id))
        prefix_length = int(checkpoint.get("prefixLength") or 0)
        with open(worker_command_path(root, worker_id), "rb") as handle:
            old_prefix = handle.read(prefix_length)
        if (int(checkpoint.get("device", -1)) != identity["device"]
                or int(checkpoint.get("inode", -1)) != identity["inode"]
                or identity["size"] < int(checkpoint.get("size") or 0)
                or hashlib.sha256(old_prefix).hexdigest() != checkpoint.get("prefixSha256")):
            return 0
        return max(0, int(checkpoint.get("queueSeq") or 0))
    except Exception:
        return 0

def save_worker_command_checkpoint(root, worker_id, sequence):
    identity = worker_command_queue_identity(worker_command_path(root, worker_id))
    atomic_write(worker_command_checkpoint_path(root, worker_id), {
        "schemaVersion": SCHEMA_VERSION, "queueSeq": int(sequence), **identity, "updatedAt": now_iso(),
    })

def initial_worker_command_checkpoint(root, worker_id):
    checkpoint_path = worker_command_checkpoint_path(root, worker_id)
    if os.path.isfile(checkpoint_path):
        return load_worker_command_checkpoint(root, worker_id)
    queue_path = worker_command_path(root, worker_id)
    if not os.path.isfile(queue_path):
        return 0
    # A new Agent must not replay an old Plan's commands when no scheduler owns them.
    try:
        for entry in _read_run_plan_registry(root):
            if not isinstance(entry, dict):
                continue
            if _is_pid_alive(entry.get("pid")) or tmux_session_alive(str(entry.get("tmuxSession") or ""), cwd=root):
                return 0  # Preserve unprocessed commands belonging to the live scheduler.
        with open(queue_path, "rb") as handle:
            sequence = sum(1 for _ in handle)
        if sequence:
            save_worker_command_checkpoint(root, worker_id, sequence)
        return sequence
    except Exception:
        return 0  # An uncertain queue is retried through the existing task-id guard.

def enqueue_worker_command(root, worker_id, command):
    worker_id = str(worker_id or "").strip()
    if not worker_id:
        raise ValueError("缺少 workerId。")
    item = {
        "schemaVersion": SCHEMA_VERSION,
        "commandId": str(command.get("commandId") or f"cmd-{int(time.time() * 1000)}-{os.getpid()}"),
        "workerId": worker_id,
        "createdAt": now_iso(),
        **command,
    }
    command_bytes = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    if command_bytes > MAX_WORKER_COMMAND_RECORD_BYTES:
        raise ValueError(f"Worker 命令超过 {MAX_WORKER_COMMAND_RECORD_BYTES} 字节传输上限")
    os.makedirs(agent_dir(root), exist_ok=True)
    with EVENT_APPEND_LOCK:
        with open(worker_command_path(root, worker_id), "a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
    append_event(root, {"type": "worker_command_enqueued", "workerId": worker_id, "operationId": item["commandId"], "payload": item})
    return item

def read_worker_commands(root, worker_id, since_seq=0, limit=20):
    path = os.path.abspath(worker_command_path(root, worker_id))
    out = []
    if not os.path.isfile(path):
        return out
    requested_since = max(0, int(since_seq or 0))
    requested_limit = max(1, int(limit or 20))
    stat = os.stat(path)
    now_value = time.time()
    with WORKER_COMMAND_CURSOR_LOCK:
        prune_worker_command_cursor_cache(now_value, path)
        cached = dict(WORKER_COMMAND_CURSOR_CACHE.get(path) or {})
    same_file = cached.get("device") == stat.st_dev and cached.get("inode") == stat.st_ino
    cached_offset = int(cached.get("offset") or 0)
    use_cursor = same_file and int(cached.get("seq") or 0) == requested_since and 0 <= cached_offset <= stat.st_size
    current_seq = requested_since if use_cursor else 0
    current_offset = cached_offset if use_cursor else 0
    with open(path, "r", encoding="utf-8") as f:
        if current_offset:
            f.seek(current_offset)
        while True:
            line = f.readline()
            if not line:
                break
            current_seq += 1
            current_offset = f.tell()
            if current_seq <= requested_since:
                continue
            try:
                item = json.loads(line)
                item["queueSeq"] = current_seq
                out.append(item)
            except Exception:
                continue
            if len(out) >= requested_limit:
                break
    with WORKER_COMMAND_CURSOR_LOCK:
        WORKER_COMMAND_CURSOR_CACHE[path] = {
            "seq": current_seq,
            "offset": current_offset,
            "device": stat.st_dev,
            "inode": stat.st_ino,
            "lastUsedAt": now_value,
        }
        prune_worker_command_cursor_cache(now_value, path)
    return out

def record_worker_command_results(root, worker_id, payload):
    rows = payload.get("commandResults") if isinstance(payload.get("commandResults"), list) else []
    accepted = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        command_id = str(row.get("commandId") or row.get("operationId") or "").strip()
        if not command_id:
            continue
        WORKER_COMMAND_RESULTS[command_id] = row
        prune_runtime_memory_state()
        append_event(root, {
            "type": str(row.get("eventType") or "worker_command_result"),
            "workerId": worker_id,
            "operationId": command_id,
            "payload": row,
        })
        accepted += 1
    return accepted

def compact_journal_meta_path(root):
    return path_for(root, "events.compact.json")

def mark_journal_compacted(root, journal, kept_count=0):
    try:
        atomic_write(compact_journal_meta_path(root), {
            "lastSeq": read_seq(root),
            "lastCompactEpoch": time.time(),
            "journalBytes": os.path.getsize(journal) if os.path.isfile(journal) else 0,
            "keptCount": int(kept_count or 0),
        })
    except Exception:
        pass

def should_compact_journal(root, journal):
    try:
        size = os.path.getsize(journal)
    except Exception:
        return False
    if MAX_JOURNAL_BYTES > 0 and size >= int(MAX_JOURNAL_BYTES * 0.85):
        return True
    seq = read_seq(root)
    meta = read_json(compact_journal_meta_path(root), {})
    try:
        last_seq = int(meta.get("lastSeq") or 0)
    except Exception:
        last_seq = 0
    compact_interval = max(100, min(MAX_EVENTS, 1000))
    if seq and seq - last_seq >= compact_interval:
        return True
    try:
        last_epoch = float(meta.get("lastCompactEpoch") or 0)
    except Exception:
        last_epoch = 0.0
    retention_check_seconds = min(max(STATE_RETENTION_SECONDS, 300), 3600) if STATE_RETENTION_SECONDS > 0 else 3600
    return time.time() - last_epoch >= retention_check_seconds

def compact_journal(root):
    journal = path_for(root, "events.jsonl")
    try:
        if not should_compact_journal(root, journal):
            return
        with open(journal, "r", encoding="utf-8") as f:
            lines = f.readlines()
        if not lines:
            mark_journal_compacted(root, journal, 0)
            return
        cutoff = time.time() - max(0, STATE_RETENTION_SECONDS)
        kept_reversed = []
        total = 0
        for line in reversed(lines):
            encoded = len(line.encode("utf-8", errors="ignore"))
            if len(kept_reversed) >= MAX_EVENTS:
                break
            if MAX_JOURNAL_BYTES > 0 and total + encoded > MAX_JOURNAL_BYTES:
                break
            if STATE_RETENTION_SECONDS > 0:
                try:
                    generated = parse_iso_epoch(json.loads(line).get("generatedAt"))
                    if generated and generated < cutoff:
                        continue
                except Exception:
                    pass
            kept_reversed.append(line)
            total += encoded
        kept = list(reversed(kept_reversed))
        if kept == lines:
            mark_journal_compacted(root, journal, len(kept))
            return
        atomic_write_file(journal, lambda stream: stream.writelines(kept))
        mark_journal_compacted(root, journal, len(kept))
    except Exception:
        pass

def prune_agent_state(root, force=False):
    global LAST_STATE_PRUNE, AGENT_STATE_PRUNE_DIAGNOSTICS
    now = time.time()
    with AGENT_STATE_PRUNE_LOCK:
        if not force and now - LAST_STATE_PRUNE < 60:
            return
        LAST_STATE_PRUNE = now
        prune_runtime_memory_state()
        state_root = os.path.abspath(agent_dir(root))
        state_root_real = os.path.realpath(state_root)
        protected = {
            "agent.pid", "agent.lock", "agent.started_at", "agent.version", "agent.config.json",
            "agent.session.json", "seq.txt", "stop", "distributed_plan_queue.json",
            "worker_recall_tombstones.json", "worker_start_claims.json",
        }
        try:
            os.makedirs(state_root, exist_ok=True)
            cutoff = now - max(0, STATE_RETENTION_SECONDS)
            tmp_cutoff = now - max(0, TMP_RETENTION_SECONDS)
            entries = []
            unsafe_entries = 0
            truncated = False
            scanned_entries = 0
            scanned_directories = 0
            directories = [state_root]
            while directories:
                current = directories.pop()
                scanned_directories += 1
                try:
                    resolved_current = os.path.realpath(current)
                    if os.path.commonpath([state_root_real, resolved_current]) != state_root_real:
                        unsafe_entries += 1
                        continue
                    current_stat = os.lstat(current)
                    if stat.S_ISLNK(current_stat.st_mode) or not stat.S_ISDIR(current_stat.st_mode):
                        unsafe_entries += 1
                        continue
                except (OSError, ValueError):
                    unsafe_entries += 1
                    continue
                try:
                    with os.scandir(current) as iterator:
                        for entry in iterator:
                            scanned_entries += 1
                            if scanned_entries > MAX_AGENT_STATE_SCAN_ENTRIES:
                                truncated = True
                                break
                            try:
                                if entry.is_symlink():
                                    unsafe_entries += 1
                                    continue
                                if entry.is_dir(follow_symlinks=False):
                                    directories.append(entry.path)
                                    continue
                                if not entry.is_file(follow_symlinks=False):
                                    unsafe_entries += 1
                                    continue
                                st = entry.stat(follow_symlinks=False)
                            except OSError:
                                unsafe_entries += 1
                                continue
                            full = entry.path
                            rel = os.path.relpath(full, state_root).replace("\\", "/")
                            size = int(st.st_size or 0)
                            mtime = float(st.st_mtime or now)
                            base = entry.name
                            protected_entry = base in protected or (base.startswith("worker_commands_") and base.endswith(".cursor.json"))
                            reasons = []
                            if not protected_entry:
                                is_tmp = ".tmp." in base or base.endswith(".writing") or ".upload." in base or rel.startswith("uploads/")
                                if (is_tmp and mtime < tmp_cutoff) or (STATE_RETENTION_SECONDS > 0 and mtime < cutoff):
                                    reasons.append("retention")
                            entries.append({"path": rel, "size": size, "mtime": mtime, "protected": protected_entry, "reasons": reasons})
                        if truncated:
                            break
                except OSError:
                    unsafe_entries += 1
            scanned_directories = min(scanned_directories, MAX_AGENT_STATE_SCAN_ENTRIES)
            total = sum(item["size"] for item in entries)
            candidate_keys = {item["path"] for item in entries if item["reasons"]}
            if MAX_AGENT_STATE_BYTES > 0 and total > MAX_AGENT_STATE_BYTES:
                target = int(MAX_AGENT_STATE_BYTES * 0.85)
                projected = total - sum(item["size"] for item in entries if item["path"] in candidate_keys)
                for item in sorted(entries, key=lambda row: row["mtime"]):
                    if projected <= target:
                        break
                    if item["protected"] or item["path"] in candidate_keys:
                        continue
                    item["reasons"].append("state_size")
                    candidate_keys.add(item["path"])
                    projected -= item["size"]
            candidates = [item for item in entries if item["path"] in candidate_keys]
            candidate_bytes = sum(item["size"] for item in candidates)
            AGENT_STATE_PRUNE_DIAGNOSTICS = {
                "status": "scan_truncated" if truncated else "confirmation_required" if candidates else "within_budget",
                "scannedEntries": scanned_entries, "scannedDirectories": scanned_directories,
                "scannedFiles": len(entries), "unsafeEntries": unsafe_entries,
                "totalBytes": total, "maxBytes": int(MAX_AGENT_STATE_BYTES or 0),
                "totalBytesComplete": not truncated,
                "candidateCount": len(candidates), "candidateBytes": candidate_bytes,
                "sample": [{"path": item["path"][:256], "size": item["size"],
                    "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(item["mtime"])),
                    "reasons": item["reasons"]} for item in sorted(candidates, key=lambda row: row["mtime"])[:8]],
                "updatedAt": now_iso(),
                "automaticDeletion": False,
            }
        except Exception as exc:
            AGENT_STATE_PRUNE_DIAGNOSTICS = {"status": "unavailable", "scannedEntries": 0, "scannedDirectories": 0, "scannedFiles": 0, "totalBytes": 0,
                "totalBytesComplete": False,
                "candidateCount": 0, "candidateBytes": 0, "sample": [], "error": str(exc)[:240],
                "updatedAt": now_iso(), "automaticDeletion": False}

def pid_is_alive(pid, kill_probe=os.kill):
    try:
        pid_value = int(pid)
        if pid_value <= 0:
            return False
        kill_probe(pid_value, 0)
        return True
    except (ValueError, TypeError):
        return False
    except OSError as exc:
        # Only ESRCH proves the process is gone. On Windows and under restricted
        # permissions, probing a live PID may raise another error; keep the
        # resource guarded until absence is certain.
        return exc.errno != errno.ESRCH
    except Exception:
        return True

def is_pid_running(pid):
    return pid_is_alive(pid)

def acquire_pid(root, run_id=""):
    os.makedirs(agent_dir(root), exist_ok=True)
    pid_path = path_for(root, "agent.pid")
    old = read_json(pid_path, {})
    if old.get("pid") and is_pid_running(old.get("pid")):
        return False
    identity = str(run_id or uuid.uuid4().hex)
    atomic_write(pid_path, {"pid": os.getpid(), "runId": identity, "startedAt": now_iso(), "agentVersion": AGENT_VERSION})
    atomic_write(path_for(root, "agent.lock"), {"pid": os.getpid(), "runId": identity, "lockedAt": now_iso(), "agentVersion": AGENT_VERSION})
    atomic_write(path_for(root, "agent.started_at"), {"startedAt": now_iso()})
    atomic_write(path_for(root, "agent.version"), {"agentVersion": AGENT_VERSION})
    return True

def agent_stop_requested(stop_path, pid, run_id):
    marker = read_json(stop_path, {})
    if not isinstance(marker, dict):
        return False
    try:
        marker_pid = int(marker.get("pid") or 0)
    except (TypeError, ValueError):
        return False
    return marker_pid == int(pid or 0) and str(marker.get("runId") or "") == str(run_id or "")

def request_agent_stop(root):
    pid_info = read_json(path_for(root, "agent.pid"), {})
    config = read_json(path_for(root, "agent.config.json"), {})
    try:
        pid = int(pid_info.get("pid") or 0)
    except (TypeError, ValueError):
        pid = 0
    run_id = str(pid_info.get("runId") or "").strip()
    if pid <= 0 or not run_id or str(config.get("runId") or "") != run_id or int(config.get("pid") or 0) != pid:
        raise RuntimeError("当前 Agent 运行身份尚未就绪，未发送停止请求")
    if not is_pid_running(pid):
        raise RuntimeError("当前 Agent 已不在运行，未发送停止请求")
    atomic_write(path_for(root, "stop"), {"pid": pid, "runId": run_id, "requestedAt": now_iso()})
    return {"pid": pid, "runId": run_id}

def inspect_agent(root):
    health = read_runtime_json_cached(path_for(root, "health_snapshot.json"), {})
    pid_info = read_runtime_json_cached(path_for(root, "agent.pid"), {})
    version_info = read_runtime_json_cached(path_for(root, "agent.version"), {})
    started_info = read_runtime_json_cached(path_for(root, "agent.started_at"), {})
    pid = pid_info.get("pid")
    running = bool(pid and is_pid_running(pid))
    return {
        **health,
        "agentVersion": version_info.get("agentVersion") or pid_info.get("agentVersion") or AGENT_VERSION,
        "pid": pid,
        "startedAt": pid_info.get("startedAt") or started_info.get("startedAt"),
        "running": running,
        "lockStale": bool(pid and not running),
    }

def collect_scheduler(root):
    states = []
    for p in scheduler_state_paths(root):
        source = read_runtime_json_cached(p, None)
        if isinstance(source, dict):
            data = dict(source)
            data.setdefault("file", p)
            data["source"] = "hub_agent"
            data["generatedAt"] = now_iso()
            states.append(data)
    return states

TRACE_PLAN_PATH_FIELDS = ("artifactPath", "artifact_path", "hub_job_dir", "worker_job_dir", "native_job_dir", "output_dir", "outputDir", "resultPath", "result_path", "results_csv", "result_csv")
TRACE_PLAN_SCHEDULER_BUCKETS = ("running_experiments", "testing_experiments", "queued_experiments", "pending_experiments", "completed_experiments", "failed_experiments", "stopped_experiments")

def trace_path_variants(value):
    normalized = re.sub(r"^\./", "", re.sub(r"/+", "/", str(value or "").strip().replace("\\", "/"))).rstrip("/")
    if not normalized:
        return set()
    variants = {normalized}
    for marker in ("/work_dirs/", "/experiments/", "/results/", "/simple_cluster/"):
        index = ("/" + normalized).find(marker)
        if index >= 0:
            variants.add(("/" + normalized)[index + 1:])
    if os.path.splitext(normalized.rsplit("/", 1)[-1])[1]:
        parent = normalized.rsplit("/", 1)[0] if "/" in normalized else ""
        variants.update(trace_path_variants(parent))
    return {item for item in variants if item}

def add_trace_plan_provenance(index, value, plan, revision=""):
    plan_text = str(plan or "").strip().replace("\\", "/")
    if not plan_text:
        return
    provenance = (plan_text, str(revision or "").strip())
    for key in trace_path_variants(value):
        previous = index.get(key)
        if previous is None and key in index:
            continue
        if previous and previous != provenance:
            index[key] = None
        else:
            index[key] = provenance

def trace_plan_provenance_index(root, scheduler=None):
    index = {}
    for state in scheduler if isinstance(scheduler, list) else collect_scheduler(root):
        if not isinstance(state, dict):
            continue
        parent_plan = str(state.get("planFile") or state.get("plan_file") or state.get("plan") or "").strip()
        parent_revision = str(state.get("planRevision") or state.get("plan_revision") or "").strip()
        rows = []
        for bucket in TRACE_PLAN_SCHEDULER_BUCKETS:
            rows.extend(item for item in (state.get(bucket) or []) if isinstance(item, dict))
        for row in rows:
            plan = row.get("planFile") or row.get("plan_file") or row.get("plan") or parent_plan
            revision = row.get("planRevision") or row.get("plan_revision") or parent_revision
            for field in TRACE_PLAN_PATH_FIELDS:
                add_trace_plan_provenance(index, row.get(field), plan, revision)
    archive_pattern = os.path.join(root, "simple_cluster", "archive_state", "by_plan", "*.json")
    for archive_path in glob.glob(archive_pattern):
        state = read_json(archive_path, {})
        if not isinstance(state, dict):
            continue
        plan = state.get("planFile") or state.get("plan_file") or ""
        revision = state.get("planRevision") or state.get("plan_revision") or ""
        entries = state.get("entries") if isinstance(state.get("entries"), dict) else {}
        for key, entry in entries.items():
            item = entry if isinstance(entry, dict) else {}
            item_plan = item.get("planFile") or item.get("plan_file") or plan
            item_revision = item.get("planRevision") or item.get("plan_revision") or revision
            add_trace_plan_provenance(index, key, item_plan, item_revision)
            add_trace_plan_provenance(index, item.get("path"), item_plan, item_revision)
    return index

def enrich_trace_plan_provenance(root, rows, scheduler=None):
    provenance_index = trace_plan_provenance_index(root, scheduler)
    out = []
    for raw in rows if isinstance(rows, list) else []:
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        existing_plan = str(row.get("planFile") or row.get("plan_file") or row.get("plan") or "").strip().replace("\\", "/")
        existing_revision = str(row.get("planRevision") or row.get("plan_revision") or "").strip()
        matches = set()
        for field in TRACE_PLAN_PATH_FIELDS:
            for key in trace_path_variants(row.get(field)):
                provenance = provenance_index.get(key)
                if provenance and (not existing_plan or provenance[0] == existing_plan):
                    matches.add(provenance)
        if existing_plan:
            row["planFile"] = existing_plan
            revisions = {revision for plan, revision in matches if plan == existing_plan and revision}
            if not existing_revision and len(revisions) == 1:
                existing_revision = next(iter(revisions))
        elif len(matches) == 1:
            existing_plan, existing_revision = next(iter(matches))
            row["planFile"] = existing_plan
        if existing_revision:
            row["planRevision"] = existing_revision
        out.append(row)
    return out

def enrich_trace_review_state(root, rows):
    entry_cache = {}
    out = []
    for raw in rows if isinstance(rows, list) else []:
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        plan = str(row.get("planFile") or row.get("plan_file") or row.get("plan") or "").strip()
        revision = str(row.get("planRevision") or row.get("plan_revision") or "").strip()
        cache_key = (plan, revision)
        if cache_key not in entry_cache:
            entry_cache[cache_key] = read_archive_entries(root, plan or None, revision)
        entries = entry_cache[cache_key]
        row_keys = result_evidence_keys(row)
        if any(artifact_key_is_archived(entries, key) for key in row_keys):
            row["reviewState"] = "archived"
            row["reviewReason"] = "已归档并纳入有效结果"
        elif any(artifact_key_is_excluded(entries, key) for key in row_keys):
            row["reviewState"] = "excluded"
            row["reviewReason"] = "已排除但保留在完整预览中"
        out.append(row)
    return out

def collect_traces(root, scheduler=None):
    data = read_json(os.path.join(root, "simple_cluster", "experiment_index.json"), [])
    if not isinstance(data, list):
        return []
    data = enrich_trace_plan_provenance(root, data, scheduler)
    data = enrich_trace_review_state(root, data)
    for row in data:
        if isinstance(row, dict):
            row.setdefault("source", "hub_agent")
            row.setdefault("generatedAt", now_iso())
    return data

# L1 实时日志尾：256KB/120行预算（面板 live tail），与 L2/L3 分层一致，截断后按行读取避免日志透传截断
def read_live_log_tail(path, max_lines=120, max_bytes=LIVE_LOG_TAIL_MAX_BYTES):
    line_limit = max(1, int(max_lines or 120))
    byte_limit = max(1024, int(max_bytes or LIVE_LOG_TAIL_MAX_BYTES))
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        offset = f.tell()
        start = max(0, offset - byte_limit)
        f.seek(start)
        data = f.read(byte_limit)
    if start:
        boundary = data.find(b"\n")
        if boundary >= 0:
            data = data[boundary + 1:]
    text = data.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines(keepends=True)
    return "".join(lines[-line_limit:]), offset

def collect_live_output(states, max_lines=120, root=None):
    # P0: 优先读 live_output/{gid}.json 或 _tmux_capture_tail(fixed_gpu_window) 的 pane buffer，文件 read_live_log_tail 仅降级
    events = []
    for state in states:
        for key in ("running_experiments", "testing_experiments"):
            for row in state.get(key) or []:
                log = str(row.get("log_path") or row.get("hub_console_log") or row.get("schedulerLog") or "")
                run_key = scheduler_row_run_key(row)
                live_key = run_key or "|".join(str(row.get(x) or "") for x in ("source", "plan", "experiment", "worker_id", "session", "log_path"))
                text = ""
                offset = 0
                used_pane = False
                # 提取 gid 用于 live_output / capture-pane 优先路径
                gid = str(row.get("gpu_id") or row.get("gpuId") or row.get("gpu") or "").strip()
                if not gid:
                    # 兼容从 session 或 log_path 推断，或尝试从 row 的其他字段
                    for _k in ("gpuId", "gpu_id", "gpu", "targetGpuId", "target_gpu_id"):
                        _v = str(row.get(_k) or "").strip()
                        if _v:
                            gid = _v
                            break
                # window 维度聚合：优先 live_output/{tmuxTarget}.json（真实 pane 直链，支撑 UI window 切换自动对应任务日志）
                _tmux_target = str(row.get("tmuxTarget") or row.get("tmuxSession") or row.get("window") or "").strip()
                if not _tmux_target and gid:
                    try:
                        _prefix2 = _resolve_tmux_prefix(None, None, None)
                        _tmux_target = fixed_gpu_window_name(_prefix2, gid)
                    except Exception:
                        _tmux_target = ""
                if _tmux_target:
                    try:
                        _root2 = str(root or "").strip() or os.getcwd()
                        _safe_target = re.sub(r"[^A-Za-z0-9_.-]+", "-", _tmux_target).strip("-") or _tmux_target
                        live_path_target = os.path.join(agent_dir(_root2), "live_output", f"{_safe_target}.json")
                        if os.path.isfile(live_path_target):
                            data2 = read_json(live_path_target, {})
                            if isinstance(data2, dict):
                                tail_val2 = data2.get("tail")
                                if isinstance(tail_val2, list) and tail_val2:
                                    text = "\n".join(str(x) for x in tail_val2[-int(max_lines or 120):]) + "\n"
                                    offset = len(tail_val2)
                                    used_pane = True
                                elif isinstance(tail_val2, str) and tail_val2.strip():
                                    lines2 = tail_val2.splitlines()
                                    text = "\n".join(lines2[-int(max_lines or 120):]) + "\n"
                                    offset = len(lines2)
                                    used_pane = True
                    except Exception:
                        pass
                    if not used_pane:
                        try:
                            cap2 = _tmux_capture_tail(_tmux_target, None, int(max_lines or 120))
                            if cap2 and str(cap2).strip():
                                text = cap2
                                offset = len(str(cap2).splitlines())
                                used_pane = True
                        except Exception:
                            pass
                # 1) 兼容旧路径 live_output/{gid}.json
                if not used_pane and gid:
                    try:
                        _root = str(root or "").strip() or os.getcwd()
                        live_path = os.path.join(agent_dir(_root), "live_output", f"{gid}.json")
                        if os.path.isfile(live_path):
                            data = read_json(live_path, {})
                            if isinstance(data, dict):
                                tail_val = data.get("tail")
                                if isinstance(tail_val, list) and tail_val:
                                    text = "\n".join(str(x) for x in tail_val[-int(max_lines or 120):]) + "\n"
                                    offset = len(tail_val)
                                    used_pane = True
                                elif isinstance(tail_val, str) and tail_val.strip():
                                    lines = tail_val.splitlines()
                                    text = "\n".join(lines[-int(max_lines or 120):]) + "\n"
                                    offset = len(lines)
                                    used_pane = True
                    except Exception:
                        pass
                # 2) 其次 _tmux_capture_tail(fixed_gpu_window) 兼容 gid 窗口
                if not used_pane and gid:
                    try:
                        prefix = _resolve_tmux_prefix(None, None, None)
                        win = fixed_gpu_window_name(prefix, gid)
                        if win != _tmux_target:
                            cap = _tmux_capture_tail(win, None, int(max_lines or 120))
                            if cap and str(cap).strip():
                                text = cap
                                offset = len(str(cap).splitlines())
                                used_pane = True
                    except Exception:
                        pass
                # 3) 降级：文件 read_live_log_tail
                if not used_pane:
                    if not log or not os.path.isfile(log):
                        continue
                    try:
                        text, offset = read_live_log_tail(log, max_lines)
                    except Exception:
                        continue
                events.append({"key": live_key, "runKey": run_key or live_key, "text": text, "path": log, "offset": offset})
    return events

def scheduler_row_run_key(row):
    for key in ("runKey", "run_key", "id", "experimentId", "experiment_id", "global_job_id", "session", "log_path"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return ""

def collect_worker_gpu(worker):
    snapshot = worker.get("localSnapshotPath") or worker.get("gpuSnapshotPath")
    if not snapshot:
        return [], "worker snapshot path not configured"
    data = read_json(snapshot, {})
    if isinstance(data, dict) and isinstance(data.get("gpu"), list):
        return data.get("gpu"), ""
    if isinstance(data, list):
        return data, ""
    return [], "worker snapshot unavailable"

SYSTEM_GPU_PROCESSES = {"xorg", "x", "gnome-shell", "kwin", "kwin_x11"}

def collect_local_gpu():
    gpu_cmd = ["nvidia-smi", "--query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"]
    proc_cmd = ["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"]
    try:
        gpu_r = subprocess.run(gpu_cmd, text=True, capture_output=True, check=False, timeout=8)
    except FileNotFoundError:
        return [], "nvidia-smi not found"
    except Exception as exc:
        return [], str(exc)
    if gpu_r.returncode != 0:
        return [], (gpu_r.stderr or gpu_r.stdout or "nvidia-smi query failed").strip()
    gpus, uuid_map, pids = [], {}, []
    for row in csv.reader(io.StringIO(gpu_r.stdout or "")):
        if len(row) < 7:
            continue
        idx, uuid, name, used, total, util, temp = [str(x).strip() for x in row[:7]]
        try:
            item = {
                "index": int(float(idx or 0)),
                "gpu_index": int(float(idx or 0)),
                "id": uuid,
                "uuid": uuid,
                "name": name,
                "gpu_name": name,
                "memoryUsedMb": int(float(used or 0)),
                "memory_used_mb": int(float(used or 0)),
                "memoryTotalMb": int(float(total or 0)),
                "memory_total_mb": int(float(total or 0)),
                "utilizationPercent": int(float(util or 0)),
                "utilization": int(float(util or 0)),
                "gpu_util": int(float(util or 0)),
                "temperature": int(float(temp or 0)) if temp else None,
                "temperatureGpu": int(float(temp or 0)) if temp else None,
                "processes": [],
                "updatedAt": now_iso(),
                "source": "worker_telemetry",
            }
        except Exception:
            continue
        # 瞬时双阈值：保留瞬时 util/mem 写入，不再写入5秒平均
        gpus.append(item)
        uuid_map[uuid] = item
    try:
        proc_r = subprocess.run(proc_cmd, text=True, capture_output=True, check=False, timeout=8)
    except Exception:
        proc_r = None
    if proc_r and proc_r.returncode == 0:
        for row in csv.reader(io.StringIO(proc_r.stdout or "")):
            if len(row) < 4:
                continue
            uuid, pid, pname, mem = [str(x).strip() for x in row[:4]]
            base = os.path.basename(pname or "").lower()
            if not base or base in SYSTEM_GPU_PROCESSES:
                continue
            gpu = uuid_map.get(uuid)
            if gpu is None:
                continue
            proc = {
                "pid": pid,
                "processName": os.path.basename(pname),
                "process_name": os.path.basename(pname),
                "usedMemoryMb": int(float(mem or 0)),
                "used_memory_mb": int(float(mem or 0)),
                "user": "",
                "command": "",
                "pluginManaged": False,
            }
            gpu["processes"].append(proc)
            if pid:
                pids.append(pid)
    if pids:
        try:
            ps = subprocess.run(["ps", "-o", "pid=,user=,args=", "-p", ",".join(pids)], text=True, capture_output=True, check=False, timeout=5)
            details = {}
            for line in (ps.stdout or "").splitlines():
                parts = line.split(None, 2)
                if len(parts) >= 2:
                    details[parts[0]] = {"user": parts[1], "command": parts[2] if len(parts) > 2 else ""}
            for gpu in gpus:
                for proc in gpu["processes"]:
                    detail = details.get(str(proc.get("pid") or ""), {})
                    proc["user"] = detail.get("user", "")
                    proc["command"] = detail.get("command", "")
        except Exception:
            pass
        for gpu in gpus:
            for proc in gpu["processes"]:
                try:
                    with open(f"/proc/{proc['pid']}/environ", "rb") as env_file:
                        proc["pluginManaged"] = b"SIMPLE_EXPERIMENT_MANAGED_JOB=1" in env_file.read().split(b"\0")
                except (OSError, ValueError):
                    pass
    return gpus, ""

def gpu_history_path(root):
    return path_for(root, "gpu_history.json")

def gpu_history_empty():
    return {
        "schemaVersion": 1,
        "bucketSeconds": GPU_HISTORY_BUCKET_SECONDS,
        "retentionHours": max(1, int(GPU_HISTORY_RETENTION_SECONDS // 3600)),
        "maxPointsPerSeries": GPU_HISTORY_MAX_POINTS_PER_SERIES,
        "servers": {},
    }

def gpu_history_epoch(value):
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    text = str(value or "").strip().replace(".000Z", "Z")
    try:
        numeric = float(text)
        if math.isfinite(numeric):
            return numeric
    except Exception:
        pass
    try:
        whole = text[:-1] if text.endswith("Z") else text
        whole = whole.split(".", 1)[0]
        return float(calendar.timegm(time.strptime(whole, "%Y-%m-%dT%H:%M:%S")))
    except Exception:
        return None

def gpu_history_iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(epoch)))

def gpu_history_number(row, *keys):
    for key in keys:
        value = row.get(key)
        try:
            number = float(value)
            if math.isfinite(number):
                return number
        except Exception:
            continue
    return None

def gpu_history_percent(value):
    if value is None:
        return None
    return round(max(0.0, min(100.0, float(value))), 3)

def gpu_history_rows(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("gpus", "gpu", "rows"):
            if isinstance(value.get(key), list):
                return value.get(key)
    return []

def trim_gpu_history_series(servers, active_keys=None):
    active = active_keys if isinstance(active_keys, set) else set()
    ranked = []
    for server_id, gpus in servers.items():
        for gpu_id, points in gpus.items():
            latest = max((int(point.get("bucketEpoch") or 0) for point in points), default=0)
            key = (server_id, gpu_id)
            ranked.append((0 if key in active else 1, -latest, server_id, gpu_id))
    keep = {(server_id, gpu_id) for _, _, server_id, gpu_id in sorted(ranked)[:GPU_HISTORY_MAX_SERIES]}
    for server_id in list(servers.keys()):
        for gpu_id in list(servers[server_id].keys()):
            if (server_id, gpu_id) not in keep:
                servers[server_id].pop(gpu_id, None)
        if not servers[server_id]:
            servers.pop(server_id, None)

def normalize_gpu_history(value):
    out = gpu_history_empty()
    source = value if isinstance(value, dict) else {}
    raw_servers = source.get("servers") if isinstance(source.get("servers"), dict) else {}
    for raw_server_id, raw_gpus in raw_servers.items():
        if not isinstance(raw_gpus, dict):
            continue
        server_id = str(raw_server_id or "").strip()
        if not server_id:
            continue
        normalized_gpus = {}
        for raw_gpu_id, raw_points in raw_gpus.items():
            gpu_id = str(raw_gpu_id or "").strip()
            if not gpu_id or not isinstance(raw_points, list):
                continue
            points_by_bucket = {}
            for raw_point in raw_points:
                if not isinstance(raw_point, dict):
                    continue
                epoch = gpu_history_epoch(raw_point.get("bucketEpoch") if raw_point.get("bucketEpoch") is not None else raw_point.get("timestamp"))
                if epoch is None:
                    continue
                bucket = int(epoch // GPU_HISTORY_BUCKET_SECONDS) * GPU_HISTORY_BUCKET_SECONDS
                point = dict(raw_point)
                point.update({
                    "serverId": server_id,
                    "gpuId": gpu_id,
                    "bucketEpoch": bucket,
                    "timestamp": gpu_history_iso(bucket),
                })
                point.pop("imputed", None)
                point.pop("gapBefore", None)
                points_by_bucket[bucket] = point
            points = [points_by_bucket[key] for key in sorted(points_by_bucket)][-GPU_HISTORY_MAX_POINTS_PER_SERIES:]
            if points:
                normalized_gpus[gpu_id] = points
        if normalized_gpus:
            out["servers"][server_id] = normalized_gpus
    trim_gpu_history_series(out["servers"])
    if source.get("recoveredFromCorruption"):
        out["recoveredFromCorruption"] = True
        out["recoveredAt"] = source.get("recoveredAt") or ""
    out["updatedAt"] = source.get("updatedAt") or ""
    return out

def update_gpu_history(value, gpu_by_server, timestamp=None):
    out = normalize_gpu_history(value)
    epoch = gpu_history_epoch(timestamp)
    if epoch is None:
        epoch = time.time()
    bucket = int(epoch // GPU_HISTORY_BUCKET_SECONDS) * GPU_HISTORY_BUCKET_SECONDS
    cutoff = bucket - GPU_HISTORY_RETENTION_SECONDS + GPU_HISTORY_BUCKET_SECONDS
    servers = out["servers"]
    active_keys = set()
    for server_id in list(servers.keys()):
        for gpu_id in list(servers[server_id].keys()):
            points = [point for point in servers[server_id][gpu_id] if cutoff <= int(point.get("bucketEpoch") or 0) <= bucket]
            if points:
                servers[server_id][gpu_id] = points[-GPU_HISTORY_MAX_POINTS_PER_SERIES:]
            else:
                servers[server_id].pop(gpu_id, None)
        if not servers[server_id]:
            servers.pop(server_id, None)
    for raw_server_id, raw_rows in (gpu_by_server.items() if isinstance(gpu_by_server, dict) else []):
        server_id = str(raw_server_id or "").strip()
        if not server_id:
            continue
        for row in gpu_history_rows(raw_rows):
            if not isinstance(row, dict):
                continue
            gpu_id = str(row.get("index") if row.get("index") is not None else row.get("gpu_index") if row.get("gpu_index") is not None else row.get("gpuId") if row.get("gpuId") is not None else row.get("gpu_id") if row.get("gpu_id") is not None else row.get("id") or row.get("uuid") or "").strip()
            if not gpu_id:
                continue
            active_keys.add((server_id, gpu_id))
            used = gpu_history_number(row, "memoryUsedMb", "memory_used_mb", "memoryUsed", "used")
            total = gpu_history_number(row, "memoryTotalMb", "memory_total_mb", "memoryTotal", "total")
            utilization = gpu_history_percent(gpu_history_number(row, "utilizationPercent", "utilization", "gpu_util", "utilization_gpu"))
            memory_utilization = gpu_history_percent((used / total * 100.0) if used is not None and total and total > 0 else None)
            point = {
                "serverId": server_id,
                "gpuId": gpu_id,
                "bucketEpoch": bucket,
                "timestamp": gpu_history_iso(bucket),
                "gpuUtilPercent": utilization,
                "memoryUsedMb": used,
                "memoryTotalMb": total,
                "memoryUtilPercent": memory_utilization,
            }
            points = servers.setdefault(server_id, {}).setdefault(gpu_id, [])
            points = [existing for existing in points if int(existing.get("bucketEpoch") or 0) != bucket]
            points.append(point)
            servers[server_id][gpu_id] = sorted(points, key=lambda item: int(item.get("bucketEpoch") or 0))[-GPU_HISTORY_MAX_POINTS_PER_SERIES:]
    trim_gpu_history_series(servers, active_keys)
    enforce_gpu_history_total_budget(servers)
    out["updatedAt"] = gpu_history_iso(bucket)
    return out

# Per-series and series-count caps still allow 128 x 4320 points, and the whole file is reread and
# rewritten on every sampling cycle; an aggregate ceiling keeps that cost bounded.
def enforce_gpu_history_total_budget(servers, max_total=None):
    budget = max(1, int(max_total or GPU_HISTORY_MAX_TOTAL_POINTS))
    series = [(server_id, gpu_id) for server_id, gpus in servers.items() for gpu_id in gpus.keys()]
    if not series:
        return 0
    total = sum(len(servers[server_id][gpu_id]) for server_id, gpu_id in series)
    if total <= budget:
        return total
    share = max(1, budget // len(series))
    for server_id, gpu_id in series:
        points = servers[server_id][gpu_id]
        if len(points) > share:
            servers[server_id][gpu_id] = points[-share:]
    return sum(len(servers[server_id][gpu_id]) for server_id, gpu_id in series)

def record_gpu_history(root, gpu_by_server, timestamp=None):
    path = gpu_history_path(root)
    existed = os.path.exists(path)
    raw = read_json(path, None)
    valid = isinstance(raw, dict) and isinstance(raw.get("servers"), dict)
    out = update_gpu_history(raw, gpu_by_server, timestamp)
    if existed and not valid:
        out["recoveredFromCorruption"] = True
        out["recoveredAt"] = now_iso()
    atomic_write(path, out, compact=True)
    return out

def downsample_gpu_history_points(points, max_points):
    rows = list(points or [])
    try:
        requested = int(max_points or GPU_HISTORY_MAX_POINTS_PER_SERIES)
    except Exception:
        requested = GPU_HISTORY_MAX_POINTS_PER_SERIES
    limit = max(1, min(GPU_HISTORY_MAX_POINTS_PER_SERIES, requested))
    if not rows:
        return []
    if len(rows) <= limit:
        indexes = list(range(len(rows)))
    elif limit == 1:
        indexes = [len(rows) - 1]
    else:
        indexes = []
        for index in range(limit):
            sampled = int(round(index * (len(rows) - 1) / (limit - 1)))
            if not indexes or sampled != indexes[-1]:
                indexes.append(sampled)
        real_indexes = [index for index, point in enumerate(rows) if point.get("imputed") is not True]
        if len(real_indexes) <= limit:
            selected = set(real_indexes)
            for index in [0, len(rows) - 1] + indexes:
                if len(selected) >= limit:
                    break
                selected.add(index)
            indexes = sorted(selected)
    out = []
    previous_source_index = None
    for source_index in indexes:
        point = dict(rows[source_index])
        gap_before = False
        if previous_source_index is not None:
            for current_index in range(previous_source_index + 1, source_index + 1):
                previous_epoch = int(rows[current_index - 1].get("bucketEpoch") or 0)
                current_epoch = int(rows[current_index].get("bucketEpoch") or 0)
                if current_epoch - previous_epoch > GPU_HISTORY_BUCKET_SECONDS:
                    gap_before = True
                    break
        point["gapBefore"] = gap_before
        out.append(point)
        previous_source_index = source_index
    return out

def fill_gpu_history_points(points, server_id, gpu_id, start_epoch, end_epoch):
    start_bucket = int(math.ceil(float(start_epoch) / GPU_HISTORY_BUCKET_SECONDS)) * GPU_HISTORY_BUCKET_SECONDS
    end_bucket = int(math.floor(float(end_epoch) / GPU_HISTORY_BUCKET_SECONDS)) * GPU_HISTORY_BUCKET_SECONDS
    if start_bucket > end_bucket:
        return []
    real_by_bucket = {int(point.get("bucketEpoch") or 0): point for point in points or []}
    out = []
    # T4: 去零填充 - 仅返回 real points，不再补 0；调用方已改为直接 downsample real_points
    for bucket in sorted(real_by_bucket.keys()):
        real = real_by_bucket.get(bucket)
        if real is not None and start_bucket <= bucket <= end_bucket:
            point = dict(real)
            point["imputed"] = False
            out.append(point)
    return out

def query_gpu_history(root, server_id="", gpu_id="", start=None, end=None, max_points=GPU_HISTORY_MAX_POINTS_PER_SERIES):
    history = normalize_gpu_history(read_json(gpu_history_path(root), {}))
    start_epoch = gpu_history_epoch(start)
    end_epoch = gpu_history_epoch(end)
    effective_end = end_epoch if end_epoch is not None else time.time()
    effective_end = int(effective_end // GPU_HISTORY_BUCKET_SECONDS) * GPU_HISTORY_BUCKET_SECONDS
    retention_start = effective_end - GPU_HISTORY_RETENTION_SECONDS + GPU_HISTORY_BUCKET_SECONDS
    effective_start = max(start_epoch if start_epoch is not None else retention_start, retention_start)
    series = []
    target_server = str(server_id).strip().lower() if server_id else ""
    target_gpu = str(gpu_id).strip().lower() if gpu_id else ""
    for current_server_id, gpus in history.get("servers", {}).items():
        if target_server and str(current_server_id).strip().lower() != target_server:
            continue
        for current_gpu_id, points in gpus.items():
            if target_gpu and str(current_gpu_id).strip().lower() != target_gpu:
                continue
            selected = [point for point in points if int(point.get("bucketEpoch") or 0) >= effective_start and int(point.get("bucketEpoch") or 0) <= effective_end]
            # T4: 移除 fill_gpu_history_points 补零（imputed True 按0补），改为 downsample 仅 real points；gapBefore 断线由 downsample 标记
            real_points = [dict(p) for p in selected]
            for _real in real_points:
                _real["imputed"] = False
            series.append({
                "serverId": current_server_id,
                "gpuId": current_gpu_id,
                "points": downsample_gpu_history_points(real_points, max_points),
                "rawPointCount": len(real_points),
                "sampledPointCount": len(selected),
            })
    return {
        "schemaVersion": 1,
        "bucketSeconds": GPU_HISTORY_BUCKET_SECONDS,
        "retentionHours": max(1, int(GPU_HISTORY_RETENTION_SECONDS // 3600)),
        "maxPointsPerSeries": GPU_HISTORY_MAX_POINTS_PER_SERIES,
        "maxSeries": GPU_HISTORY_MAX_SERIES,
        "updatedAt": history.get("updatedAt") or "",
        "series": series,
    }

def api_worker_gpu(root):
    cached = read_runtime_json_cached(path_for(root, "gpu_snapshot.json"), {})
    if cached:
        return cached
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "source": "worker_telemetry",
        "gpu": [],
        "gpus": [],
        "status": "pending",
        "message": "Worker GPU telemetry sampler has not produced a snapshot yet.",
    }

def gpu_row_id(row):
    # 修复 index==0 时因 Python falsy 被 or 跳过取到 uuid：显式判 None 且优先 index 数字 0-3 返回 "0"；UUID 仅作后缀忽略，规范化为数字 0..63
    for k in ("index","gpu_index"):
        v = row.get(k)
        if v is not None and str(v).strip()!="":
            norm = _normalize_gpu_id_for_window(v)
            if norm and norm != "0":
                return norm
            try: return str(int(float(str(v).strip())))
            except: 
                nv = _normalize_gpu_id_for_window(str(v).strip())
                if nv:
                    return nv
                return str(v).strip()
    for k in ("gpu_id","gpuId","id"):
        v = row.get(k)
        if v is not None and str(v).strip()!="":
            s = str(v).strip()
            if re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", s, re.I):
                m = re.search(r"(?:gpu)[-_]?(\d+)\b", s, re.I)
                if m:
                    return m.group(1)
                continue
            norm = _normalize_gpu_id_for_window(s)
            if norm and norm != "0":
                return norm
            if re.match(r"^\d+$", s):
                return s
            m2 = re.search(r"(?:gpu)[-_]?(\d+)\b", s, re.I)
            if m2:
                return m2.group(1)
            # 非 UUID 且非数字则跳过，避免返回 UUID
            if not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", s, re.I):
                # 仅当非 UUID 才返回，否则继续找下一个
                if len(s) < 12:
                    return s
    # 兼容历史 gpu_uuid 字段，仅当作纯 UUID 时忽略
    for k in ("uuid","gpu_uuid"):
        v = row.get(k)
        if v is not None and str(v).strip()!="":
            s = str(v).strip()
            if re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", s, re.I):
                m = re.search(r"(?:gpu)[-_]?(\d+)\b", s, re.I)
                if m:
                    return m.group(1)
                continue
            norm = _normalize_gpu_id_for_window(s)
            if norm and norm != "0":
                return norm
            if s.isdigit():
                return s
    return ""

def gpu_row_busy(row, util_threshold=None, mem_threshold=None):
    """利用率<阈值且显存<阈值判空，瞬时；支持每服务器阈值覆盖，缺失时回退进程数"""
    try:
        # 每服务器覆盖优先，否则用全局阈值（默认 5% / 200MB）
        thr_util = float(util_threshold) if util_threshold is not None else float(GPU_IDLE_UTIL_THRESHOLD)
        thr_mem = float(mem_threshold) if mem_threshold is not None else float(GPU_IDLE_MEM_THRESHOLD_MB)
        # 读取利用率：兼容多个字段名（三端镜像：agent/scheduler/plugin统一）
        util = None
        for k in ("utilizationPercent", "utilization", "gpu_util", "utilizationGpu", "utilization_gpu", "gpuUtilPercent", "gpu_util_percent", "gpuUtil", "util"):
            if k in row and row.get(k) is not None:
                try:
                    v = float(row.get(k))
                    if math.isfinite(v):
                        util = v
                        break
                except Exception:
                    continue
        # 读取显存占用 MB：兼容多个字段名（三端镜像）
        mem = None
        for k in ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used", "used", "usedMemoryMb", "used_memory_mb", "memUsedMb", "usedMb", "mem_used_mb"):
            if k in row and row.get(k) is not None:
                try:
                    v = float(row.get(k))
                    if math.isfinite(v):
                        mem = v
                        break
                except Exception:
                    continue
        # 瞬时双阈值：util<thr_util 且 mem<thr_mem 即空闲 else 忙
        if util is not None and mem is not None:
            if float(util) < thr_util and float(mem) < thr_mem:
                return False
            else:
                return True
        # 字段缺失时回退进程数（仅缺失时回退）
        processes = row.get("processes") or row.get("procs") or []
        if isinstance(processes, list) and len(processes) > 0:
            return True
        try:
            return int(row.get("processCount") or row.get("process_count") or 0) > 0
        except Exception:
            return False
    except Exception:
        return False

def availability_from_gpu(worker_id, gpu_payload, source="worker_agent_direct", ttl_seconds=None, capacity_limit=None, **kwargs):
    # 兼容旧 ttl_seconds 位置参数：若第4个位置实为 capacity_limit 数字而 capacity_limit 未传，则兼容
    if capacity_limit is None and ttl_seconds is not None:
        # 旧调用 availability_from_gpu(..., 180, cap) 会把 ttl_seconds 当 capacity_limit 误用；兼容处理
        # 若 ttl_seconds 看起来像 capacity（小整数）且 kwargs 无 capacity，则尝试识别
        # 但新逻辑已去TTL，ttl_seconds 仅作兼容忽略，capacity_limit 以 kwargs 或显式为准
        try:
            # 若 ttl_seconds 是数字且 capacity_limit 为 None 且源 payload 无 TTL 语义，则忽略
            pass
        except Exception:
            pass
    # 处理 kwargs 中可能残留的 ttl / capacity
    if capacity_limit is None and "capacity_limit" in kwargs:
        capacity_limit = kwargs.get("capacity_limit")
    if capacity_limit is None and "capacityLimit" in kwargs:
        capacity_limit = kwargs.get("capacityLimit")
    # 去TTL：忽略所有 ttl 相关参数；支持每服务器阈值覆盖
    # 每服务器空卡阈值：优先 kwargs，其次 gpu_payload 透传，最后全局默认
    thr_util = kwargs.get("gpuIdleUtilThreshold") if kwargs.get("gpuIdleUtilThreshold") is not None else kwargs.get("gpu_idle_util_threshold")
    if thr_util is None:
        thr_util = gpu_payload.get("gpuIdleUtilThreshold") if isinstance(gpu_payload, dict) and gpu_payload.get("gpuIdleUtilThreshold") is not None else gpu_payload.get("gpu_idle_util_threshold") if isinstance(gpu_payload, dict) else None
    thr_mem = kwargs.get("gpuIdleMemThresholdMb") if kwargs.get("gpuIdleMemThresholdMb") is not None else kwargs.get("gpu_idle_mem_threshold")
    if thr_mem is None:
        thr_mem = gpu_payload.get("gpuIdleMemThresholdMb") if isinstance(gpu_payload, dict) and gpu_payload.get("gpuIdleMemThresholdMb") is not None else gpu_payload.get("gpu_idle_mem_threshold") if isinstance(gpu_payload, dict) else None
    rows = gpu_payload.get("gpus") or gpu_payload.get("gpu") or []
    if isinstance(rows, dict):
        rows = next((value for value in rows.values() if isinstance(value, list)), [])
    if not isinstance(rows, list):
        rows = []
    available, busy = [], []
    for row in rows:
        if not isinstance(row, dict):
            continue
        gpu_id = gpu_row_id(row)
        if not gpu_id:
            continue
        if gpu_row_busy(row, util_threshold=thr_util, mem_threshold=thr_mem):
            busy.append(gpu_id)
        else:
            available.append(gpu_id)
    # 中文化 reason 四值：可用 / 目前无空卡 / 暂无显卡数据 / GPU查询失败
    gpu_error = ""
    try:
        gpu_error = str(gpu_payload.get("gpuError") or gpu_payload.get("gpu_error") or gpu_payload.get("error") or "") if isinstance(gpu_payload, dict) else ""
    except Exception:
        gpu_error = ""
    if available:
        reason = "可用"
    elif gpu_error and not busy and not rows:
        reason = "GPU查询失败"
    elif busy:
        reason = "目前无空卡"
    else:
        reason = "暂无显卡数据"
    # capacity=auto 语义：空/0 → auto=total 总数；显式 clamp 1..总数；total=0 则 cap=0
    total_gpus = len(available) + len(busy)
    capacity_source = "auto"
    try:
        cap_raw = capacity_limit
        if cap_raw is None or (isinstance(cap_raw, str) and cap_raw.strip().lower() in ("", "auto")) or float(cap_raw or 0) == 0:
            cap = total_gpus
            capacity_source = "auto"
        else:
            cap = max(1, min(int(float(cap_raw)), total_gpus)) if total_gpus > 0 else 0
            capacity_source = "explicit"
    except Exception:
        cap = total_gpus
        capacity_source = "auto"
    if total_gpus == 0:
        cap = 0
    result = {
        "workerId": str(worker_id or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker"),
        "available": bool(available),
        "availableGpuIds": available,
        "busyGpuIds": busy,
        "reason": reason,
        "source": source,
        "updatedAt": now_iso(),
        "capacityLimit": cap,
        "capacitySource": capacity_source,
        "totalGpus": total_gpus,
        "gpuError": gpu_error,
        "gpuIdleUtilThreshold": int(thr_util) if thr_util is not None else int(GPU_IDLE_UTIL_THRESHOLD),
        "gpuIdleMemThresholdMb": int(thr_mem) if thr_mem is not None else int(GPU_IDLE_MEM_THRESHOLD_MB),
        "gpus": rows,
    }
    # 同时透传 sessionCheck / ttl 供调度器感知每服务器差异
    if kwargs.get("sessionCheckMinSeconds") is not None or kwargs.get("session_check_min_seconds") is not None:
        result["sessionCheckMinSeconds"] = int(kwargs.get("sessionCheckMinSeconds") or kwargs.get("session_check_min_seconds") or 5)
    if kwargs.get("workerStatusTtlSeconds") is not None or kwargs.get("worker_status_ttl_seconds") is not None:
        result["workerStatusTtlSeconds"] = int(kwargs.get("workerStatusTtlSeconds") or kwargs.get("worker_status_ttl_seconds") or 180)
    return result

def api_worker_availability(root):
    gpu_payload = api_worker_gpu(root)
    return {"schemaVersion": SCHEMA_VERSION, "workers": [availability_from_gpu(os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker", gpu_payload)]}

def availability_cache_path(root):
    return path_for(root, "worker_availability.json")

def read_availability_cache(root, cached=False):
    path = availability_cache_path(root)
    data = read_runtime_json_cached(path, {}) if cached else read_json(path, {})
    return data if isinstance(data, dict) else {}

def availability_entry_expired(entry, ttl_default=180):
    # 去TTL：按5秒平均利用率判空，不再按 ttlSeconds 判过期，保留仅作最大记录数裁剪
    if not isinstance(entry, dict):
        return True
    # 不再按 ttl 判断过期，仅保留基本结构校验
    return False

# Entries accumulate per worker id and are broadcast whole on every batch, so retired or
# renamed workers must not linger forever in the cache, the API payload or the journal.
def prune_availability_entries(entries, keep_ids, ttl_default=180):
    # 去TTL：忽略 ttl_default，仅按 keep_ids 与最大记录数裁剪
    kept = {}
    for worker_id, entry in entries.items():
        if worker_id in keep_ids or not availability_entry_expired(entry, ttl_default):
            kept[worker_id] = entry
    if len(kept) <= MAX_WORKER_AVAILABILITY_RECORDS:
        return kept
    ranked = sorted(kept.items(), key=lambda item: (item[0] in keep_ids, parse_iso_epoch((item[1] or {}).get("updatedAt")) or 0.0), reverse=True)
    return dict(ranked[:MAX_WORKER_AVAILABILITY_RECORDS])

def write_availability_batch(root, payload):
    now = now_iso()
    # 去TTL：不再使用 ttlSeconds
    rows = payload.get("workers") if isinstance(payload.get("workers"), list) else []
    current = read_availability_cache(root)
    source_entries = current.get("workers") if isinstance(current.get("workers"), dict) else {}
    entries = dict(source_entries)
    updated_ids = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        worker_id = str(row.get("workerId") or row.get("worker_id") or "").strip()
        if not worker_id:
            continue
        merged = dict(row)
        merged["workerId"] = worker_id
        merged["source"] = str(row.get("source") or payload.get("source") or "local_aggregator")
        merged["updatedAt"] = str(row.get("updatedAt") or payload.get("generatedAt") or now)
        # 去TTL：移除 ttlSeconds 字段，删除前兼容清理；保留 P1 新字段供调度器消费
        merged.pop("ttlSeconds", None)
        for _k in ("gpuError", "totalGpus", "capacitySource", "gpuIdleUtilThreshold", "gpuIdleMemThresholdMb"):
            if _k in row and _k not in merged:
                merged[_k] = row.get(_k)
        entries[worker_id] = merged
        updated_ids.add(worker_id)
    entries = prune_availability_entries(entries, updated_ids)
    out = {"schemaVersion": SCHEMA_VERSION, "generatedAt": now, "workers": entries}
    atomic_write(availability_cache_path(root), out)
    append_event(root, {"type": "worker_availability", "source": str(payload.get("source") or "local_aggregator"), "payload": {"workers": list(entries.values()), "generatedAt": now}})
    return {"schemaVersion": SCHEMA_VERSION, "accepted": True, "updated": len(rows), "generatedAt": now}

def write_worker_uplink_batch(root, payload):
    events = payload.get("events") if isinstance(payload.get("events"), list) else []
    availability = payload.get("availability") if isinstance(payload.get("availability"), dict) else None
    worker_id = str(payload.get("workerId") or "").strip()
    accepted_events = 0
    if availability:
        write_availability_batch(root, {
            "schemaVersion": SCHEMA_VERSION,
            "source": availability.get("source") or "worker_uplink",
            "generatedAt": availability.get("updatedAt") or now_iso(),
            "workers": [availability],
        })
    for event in events:
        if not isinstance(event, dict):
            continue
        append_event(root, {
            "type": str(event.get("type") or "worker_uplink_event"),
            "source": event.get("source") or "worker_telemetry",
            "workerId": event.get("workerId") or worker_id,
            "operationId": event.get("operationId") or "",
            "payload": event.get("payload") if isinstance(event.get("payload"), dict) else event,
        })
        accepted_events += 1
    accepted_events += record_worker_command_results(root, worker_id, payload) if worker_id else 0
    commands_since = int(payload.get("commandsSince") or 0)
    commands = read_worker_commands(root, worker_id, commands_since, payload.get("commandsLimit") or 20) if worker_id else []
    return {"schemaVersion": SCHEMA_VERSION, "accepted": True, "events": accepted_events, "availability": bool(availability), "commands": commands, "generatedAt": now_iso()}

def worker_task_snapshot_key(task):
    key = str(task.get("commandId") or task.get("operationId") or task.get("runKey") or "")
    if key:
        return ("id", key)
    return ("legacy", str(task.get("planFile") or task.get("plan") or ""), str(task.get("pid") or ""), str(task.get("tmuxSession") or ""))

def retain_worker_task_snapshot(tasks, terminal_limit=200):
    """Keep every unfinished job so a later Agent restart can still reconcile it."""
    terminal_positions = [index for index, task in enumerate(tasks)
                          if not isinstance(task, dict) or str(task.get("status") or "").lower()
                          not in ("running", "dispatching", "pending", "queued", "unknown")]
    discard = set(terminal_positions[:max(0, len(terminal_positions) - terminal_limit)])
    return [task for index, task in enumerate(tasks) if index not in discard]

def append_worker_task(root, task):
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        key = worker_task_snapshot_key(task)
        old_index = next((index for index, item in enumerate(tasks) if worker_task_snapshot_key(item or {}) == key), None)
        kept = [item for item in tasks if worker_task_snapshot_key(item or {}) != key]
        if old_index is None:
            kept.append(task)
        else:
            kept.insert(min(old_index, len(kept)), task)
        atomic_write(path_for(root, "worker_task_snapshot.json"), {"schemaVersion": SCHEMA_VERSION, "tasks": retain_worker_task_snapshot(kept), "generatedAt": now_iso()})
    if isinstance(task, dict) and task.get("planJobCount") is not None:
        record_durable_plan_task_terminal(root, task)

def durable_plan_queue_path(root):
    return path_for(root, "distributed_plan_queue.json")

def read_durable_plan_queue(root):
    path = durable_plan_queue_path(root)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {"schemaVersion": 1, "jobs": []}
    if not isinstance(data, dict) or data.get("schemaVersion") != 1 or not isinstance(data.get("jobs"), list):
        raise ValueError("持久 Plan 队列格式损坏；禁止覆盖或自动重发")
    return data

def write_durable_plan_queue(root, data):
    path = durable_plan_queue_path(root)
    atomic_write(path, data)

DURABLE_PLAN_IDENTITY_FIELDS = (
    "projectId", "workflowId", "planFile", "planRevision", "codeFingerprint",
    "experimentIndex", "case", "seed", "attempt", "outputDir", "runKey",
    "commandId", "workerId",
)

def durable_plan_value(command, key):
    value = command.get(key)
    if value in (None, ""):
        options = command.get("options") if isinstance(command.get("options"), dict) else {}
        value = options.get(key)
    aliases = {"planFile": ("plan",), "case": ("experimentCase",), "commandId": ("operationId",)}
    if value in (None, ""):
        options = command.get("options") if isinstance(command.get("options"), dict) else {}
        for alias in aliases.get(key, ()):
            value = command.get(alias) or options.get(alias)
            if value not in (None, ""):
                break
    if key in ("experimentIndex", "seed", "attempt", "planJobCount", "fullPlanJobCount") and value not in (None, ""):
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    return str(value).strip() if value is not None else ""

def durable_plan_identity(command):
    return {key: durable_plan_value(command, key) for key in DURABLE_PLAN_IDENTITY_FIELDS}

def durable_plan_public_task(row):
    public = {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"), "fullPlanJobCount": row.get("fullPlanJobCount"),
              "enqueuedAt": row.get("enqueuedAt"), "status": str(row.get("status") or "unknown").lower(),
              "durableAccepted": True, "acceptedAt": row.get("acceptedAt"), "gpuId": row.get("gpuId") or "",
              "schedulingMode": row.get("schedulingMode") or "local_idle"}
    for key in ("mode", "executionMode", "executionModeSource"):
        if row.get(key) is not None:
            public[key] = row.get(key)
    for key in ("finishedAt", "cancelledAt", "stopReason", "error", "exitCode", "identityConflict", "lastDispatchResult", "trainingRecovery", "originalExecution"):
        if row.get(key) is not None:
            public[key] = row.get(key)
    if (public["status"] == "cancelled" and row.get("stopReason") == "requeue"
            and row.get("neverStarted") is True):
        public.update({"targetCommandId": public["commandId"], "durableReleased": True,
                       "neverStarted": True, "neverStartedEvidence": row.get("neverStartedEvidence")})
    return public

def durable_plan_same_identity(left, right):
    return durable_plan_identity(left) == durable_plan_identity(right)

def durable_code_manifest_digest(manifest):
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError("missing code manifest")
    stable = [[key, manifest[key]] for key in sorted(manifest, key=lambda value: str(value).encode("utf-16-be"))]
    return hashlib.sha256(json.dumps(stable, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

def code_sync_proof_runtime_generation():
    return "|".join((str(AGENT_VERSION), str(RUNTIME_VERSION), str(PLUGIN_VERSION)))

def code_sync_proof_id(project_id, fingerprint, manifest_digest, scope_signature, runtime_generation=None):
    generation = runtime_generation or code_sync_proof_runtime_generation()
    identity = "\n".join((str(project_id), str(fingerprint), str(manifest_digest), str(scope_signature), str(generation)))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()

def code_sync_proof_document(root):
    data = read_json(path_for(root, "code_sync_proofs.json"), {})
    if not isinstance(data, dict) or not isinstance(data.get("proofs"), dict):
        return {"schemaVersion": 1, "proofs": {}}
    return data

def _code_sync_stat_record(root, relative, expected, verify_content=False):
    relative = str(relative or "").replace("\\", "/")
    parts = relative.split("/")
    if (relative.startswith("/") or re.match(r"^[a-zA-Z]:", relative)
            or any(part in ("", ".", "..") for part in parts)):
        raise ValueError("unsafe code manifest path: " + relative)
    full = os.path.abspath(os.path.join(root, *parts))
    real_root = os.path.realpath(root)
    real_full = os.path.realpath(full)
    try:
        if os.path.commonpath([real_root, real_full]) != real_root:
            raise ValueError("code manifest escapes project: " + relative)
    except ValueError:
        raise ValueError("code manifest escapes project: " + relative)
    current = os.path.abspath(root)
    for part in parts:
        current = os.path.join(current, part)
        if os.path.islink(current):
            raise ValueError("mounted code file traverses a symlink: " + relative)
    if not os.path.isfile(full):
        raise ValueError("mounted code file missing or not regular: " + relative)
    if not isinstance(expected, dict):
        raise ValueError("invalid code manifest entry: " + relative)
    try:
        expected_size = int(expected.get("size"))
    except (TypeError, ValueError):
        raise ValueError("invalid code manifest size: " + relative)
    expected_sha = str(expected.get("sha256") or "").lower()
    if expected_size < 0 or not re.fullmatch(r"[a-f0-9]{64}", expected_sha):
        raise ValueError("invalid code manifest entry: " + relative)
    before = os.stat(full, follow_symlinks=False)
    if not os.path.isfile(full) or int(before.st_size) != expected_size:
        raise ValueError("mounted code size mismatch: " + relative)
    if verify_content:
        file_hash = hashlib.sha256()
        with open(full, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                file_hash.update(chunk)
        if file_hash.hexdigest() != expected_sha:
            raise ValueError("mounted code changed: " + relative)
    after = os.stat(full, follow_symlinks=False)
    before_mtime = int(getattr(before, "st_mtime_ns", before.st_mtime * 1_000_000_000))
    after_mtime = int(getattr(after, "st_mtime_ns", after.st_mtime * 1_000_000_000))
    if int(before.st_size) != int(after.st_size) or before_mtime != after_mtime:
        raise ValueError("mounted code changed during proof verification: " + relative)
    return {"path": relative, "size": int(after.st_size), "mtime_ns": after_mtime}

def verify_code_sync_proof_record(root, proof, row, runtime_generation=None):
    if not isinstance(proof, dict):
        raise ValueError("code-sync proof missing")
    expected_project = str(row.get("projectId") or "")
    expected_fingerprint = str(row.get("codeFingerprint") or "")
    expected_digest = str(row.get("manifestDigest") or row.get("codeFingerprint") or "")
    proof_id = str(row.get("codeSyncProofId") or row.get("proofId") or "")
    scope_signature = str(proof.get("scopeSignature") or "")
    expected_generation = runtime_generation or code_sync_proof_runtime_generation()
    runtime_generation = str(proof.get("runtimeGeneration") or "")
    if (not proof_id or str(proof.get("proofId") or "") != proof_id
            or str(proof.get("projectId") or "") != expected_project
            or str(proof.get("codeFingerprint") or "") != expected_fingerprint
            or str(proof.get("manifestDigest") or "") != expected_digest
            or runtime_generation != expected_generation
            or not re.fullmatch(r"[a-f0-9]{64}", scope_signature)
            or proof_id != code_sync_proof_id(expected_project, expected_fingerprint, expected_digest,
                                               scope_signature, runtime_generation)):
        raise ValueError("code-sync proof identity mismatch or stale runtime generation")
    files = proof.get("files") if isinstance(proof.get("files"), list) else []
    if not files or int(proof.get("fileCount") or -1) != len(files):
        raise ValueError("code-sync proof file inventory is invalid")
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("code-sync proof file inventory is invalid")
        relative = str(item.get("path") or "").replace("\\", "/")
        parts = relative.split("/")
        if (relative.startswith("/") or re.match(r"^[a-zA-Z]:", relative)
                or any(part in ("", ".", "..") for part in parts)):
            raise ValueError("unsafe code-sync proof path: " + relative)
        current = os.path.abspath(root)
        for part in parts:
            current = os.path.join(current, part)
            if os.path.islink(current):
                raise ValueError("code-sync proof path traverses a symlink: " + relative)
        full = os.path.abspath(os.path.join(root, *parts))
        real_root = os.path.realpath(root)
        real_full = os.path.realpath(full)
        try:
            if os.path.commonpath([real_root, real_full]) != real_root:
                raise ValueError("code-sync proof path escapes project: " + relative)
        except ValueError:
            raise ValueError("code-sync proof path escapes project: " + relative)
        if not os.path.isfile(full):
            raise ValueError("code-sync proof stale; file missing: " + relative)
        stat = os.stat(full, follow_symlinks=False)
        actual_mtime = int(getattr(stat, "st_mtime_ns", stat.st_mtime * 1_000_000_000))
        if int(stat.st_size) != int(item.get("size", -1)) or actual_mtime != int(item.get("mtime_ns", -1)):
            raise ValueError("code-sync proof stale; stat changed: " + relative)
    return proof

def _store_code_sync_proof(root, proof):
    with CODE_SYNC_PROOF_LOCK:
        data = code_sync_proof_document(root)
        proofs = dict(data.get("proofs") or {})
        proofs[str(proof["proofId"])] = proof
        if len(proofs) > 32:
            keep = sorted(proofs.items(), key=lambda item: str(item[1].get("verifiedAt") or ""), reverse=True)[:32]
            proofs = dict(keep)
        atomic_write(path_for(root, "code_sync_proofs.json"), {"schemaVersion": 1, "proofs": proofs}, compact=True)

def register_code_sync_proof(root, payload, worker_id):
    if not isinstance(payload, dict):
        raise ValueError("invalid code-sync proof request")
    project_id = str(payload.get("projectId") or "").strip()
    fingerprint = str(payload.get("codeFingerprint") or "").strip()
    manifest = payload.get("codeManifest")
    manifest_digest = str(payload.get("manifestDigest") or "").strip()
    scope_signature = str(payload.get("scopeSignature") or "").strip()
    if not project_id or not fingerprint or not manifest_digest or not scope_signature:
        raise ValueError("code-sync proof identity is incomplete")
    if str(payload.get("workerId") or worker_id or "").strip() != str(worker_id or "").strip():
        raise ValueError("code-sync proof Worker owner mismatch")
    actual_digest = durable_code_manifest_digest(manifest)
    if actual_digest != fingerprint or actual_digest != manifest_digest:
        raise ValueError("code-sync proof manifest fingerprint mismatch")
    if not re.fullmatch(r"[a-f0-9]{64}", scope_signature):
        raise ValueError("code-sync proof scope signature is invalid")
    runtime_generation = code_sync_proof_runtime_generation()
    proof_id = code_sync_proof_id(project_id, fingerprint, manifest_digest, scope_signature, runtime_generation)
    identity = {"projectId": project_id, "codeFingerprint": fingerprint, "manifestDigest": manifest_digest,
                "codeSyncProofId": proof_id}
    existing = code_sync_proof_document(root).get("proofs", {}).get(proof_id)
    if isinstance(existing, dict):
        try:
            verify_code_sync_proof_record(root, existing, identity)
            return {"ok": True, "proofId": proof_id, "manifestDigest": manifest_digest,
                    "fileCount": int(existing.get("fileCount") or 0), "scopeSignature": scope_signature,
                    "verifiedAt": existing.get("verifiedAt"), "runtimeGeneration": runtime_generation, "reused": True}
        except Exception:
            pass
    files = []
    for relative, expected in manifest.items():
        files.append(_code_sync_stat_record(root, relative, expected, verify_content=False))
    if not files:
        raise ValueError("code-sync proof file inventory is empty")
    proof = {"schemaVersion": 1, "proofId": proof_id, **identity, "scopeSignature": scope_signature,
             "fileCount": len(files), "files": files, "verifiedAt": now_iso(),
             "runtimeGeneration": runtime_generation}
    _store_code_sync_proof(root, proof)
    signal_durable_plan_queue_processor(root, worker_id)
    return {"ok": True, "proofId": proof_id, "manifestDigest": manifest_digest,
            "fileCount": len(files), "scopeSignature": scope_signature,
            "verifiedAt": proof["verifiedAt"], "runtimeGeneration": runtime_generation, "reused": False}

def _legacy_durable_code_sync_proof(root, row, manifest):
    project_id = str(row.get("projectId") or "")
    fingerprint = str(row.get("codeFingerprint") or "")
    manifest_digest = durable_code_manifest_digest(manifest)
    if not project_id or manifest_digest != fingerprint:
        raise ValueError("legacy code manifest fingerprint mismatch")
    scope_signature = str(row.get("scopeSignature") or hashlib.sha256(
        json.dumps(sorted(manifest), ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest())
    runtime_generation = code_sync_proof_runtime_generation()
    proof_id = code_sync_proof_id(project_id, fingerprint, manifest_digest, scope_signature, runtime_generation)
    identity = {"projectId": project_id, "codeFingerprint": fingerprint, "manifestDigest": manifest_digest,
                "codeSyncProofId": proof_id}
    existing = code_sync_proof_document(root).get("proofs", {}).get(proof_id)
    if isinstance(existing, dict):
        try:
            return verify_code_sync_proof_record(root, existing, identity)
        except Exception:
            pass
    files = []
    for relative, expected in manifest.items():
        files.append(_code_sync_stat_record(root, relative, expected, verify_content=True))
    proof = {"schemaVersion": 1, "proofId": proof_id, **identity, "scopeSignature": scope_signature,
             "fileCount": len(files), "files": files, "verifiedAt": now_iso(),
             "runtimeGeneration": runtime_generation}
    _store_code_sync_proof(root, proof)
    return proof

def renew_code_sync_proof_runtime(root, proof, row):
    # An Agent upgrade changes the verifier generation, not the mounted project.
    # Validate the complete old identity and every stat-bound source file before
    # issuing a new proof. Ordinary verification remains strict about generation.
    if not isinstance(proof, dict) or proof.get("schemaVersion") != 1:
        raise ValueError("code-sync proof missing or unsupported schema")
    previous_generation = str(proof.get("runtimeGeneration") or "")
    if not previous_generation:
        raise ValueError("code-sync proof runtime generation missing")
    with CODE_SYNC_PROOF_LOCK:
        verify_code_sync_proof_record(root, proof, row, runtime_generation=previous_generation)
        generation = code_sync_proof_runtime_generation()
        proof_id = code_sync_proof_id(proof["projectId"], proof["codeFingerprint"],
                                     proof["manifestDigest"], proof["scopeSignature"], generation)
        current_identity = {**row, "codeSyncProofId": proof_id}
        current = code_sync_proof_document(root).get("proofs", {}).get(proof_id)
        if current is not None:
            return verify_code_sync_proof_record(root, current, current_identity)
        renewed = {**proof, "proofId": proof_id, "codeSyncProofId": proof_id,
                   "runtimeGeneration": generation, "verifiedAt": now_iso(),
                   "previousProofId": proof["proofId"], "runtimeRenewedFrom": previous_generation}
        verify_code_sync_proof_record(root, renewed, current_identity)
        _store_code_sync_proof(root, renewed)
        return renewed

def resolve_durable_code_sync_proof(root, row):
    proof_id = str(row.get("codeSyncProofId") or "")
    if proof_id:
        proof = code_sync_proof_document(root).get("proofs", {}).get(proof_id)
        if isinstance(proof, dict) and str(proof.get("runtimeGeneration") or "") != code_sync_proof_runtime_generation():
            return renew_code_sync_proof_runtime(root, proof, row)
        return verify_code_sync_proof_record(root, proof, row)
    manifest = row.get("codeManifest")
    if isinstance(manifest, dict):
        return _legacy_durable_code_sync_proof(root, row, manifest)
    raise ValueError("code-sync proof missing; code is not dispatchable")

def _durable_gpu_busy_reason(root, gpu_id, command_id, gpus=None, util_threshold=None, mem_threshold=None,
                             max_concurrent_gpus=None):
    gpu_id = str(gpu_id or "").strip()
    if not gpu_id:
        return "gpu_busy"
    try:
        util_threshold = float(GPU_IDLE_UTIL_THRESHOLD if util_threshold is None else util_threshold)
        mem_threshold = float(GPU_IDLE_MEM_THRESHOLD_MB if mem_threshold is None else mem_threshold)
        if not math.isfinite(util_threshold) or not math.isfinite(mem_threshold) or util_threshold < 0 or mem_threshold < 0:
            raise ValueError("invalid GPU idle threshold")
    except (TypeError, ValueError):
        raise ValueError("GPU idle thresholds must be finite nonnegative numbers")
    if gpus is None:
        gpus, error = collect_local_gpu()
        if error:
            return "gpu_busy"
    if DISTRIBUTED_GPU_RESERVATIONS.get(gpu_id) not in (None, command_id):
        return "gpu_busy"
    tasks = read_json(path_for(root, "worker_task_snapshot.json"), {})
    task_rows = tasks.get("tasks") if isinstance(tasks, dict) and isinstance(tasks.get("tasks"), list) else []
    if any(isinstance(item, dict) and str(item.get("gpuId") or "") == gpu_id
           and str(item.get("commandId") or "") != command_id
           and str(item.get("status") or "").lower() in ("running", "dispatching", "unknown") for item in task_rows):
        return "gpu_busy"
    queue = read_durable_plan_queue(root)
    occupied_gpu_ids = {str(key) for key, owner in DISTRIBUTED_GPU_RESERVATIONS.items()
                        if str(key) and str(owner) != command_id}
    occupied_gpu_ids.update(str(item.get("gpuId")) for item in task_rows if isinstance(item, dict)
                            and item.get("gpuId") not in (None, "")
                            and str(item.get("status") or "").lower() in ("running", "dispatching", "unknown")
                            and str(item.get("commandId") or "") != command_id)
    occupied_gpu_ids.update(str(item.get("gpuId")) for item in queue.get("jobs", []) if isinstance(item, dict)
                            and item.get("gpuId") not in (None, "")
                            and (str(item.get("status") or "").lower() in ("dispatching", "running", "unknown")
                                 or str(item.get("status") or "").lower() == "queued" and item.get("requireIdleGpu") is True)
                            and str(item.get("commandId") or "") != command_id)
    try:
        cap_text = str(max_concurrent_gpus or "").strip().lower()
        cap = 0 if cap_text in ("", "auto") else int(max_concurrent_gpus)
    except (TypeError, ValueError):
        raise ValueError("maxConcurrentGpus must be a nonnegative integer or auto")
    if cap < 0:
        raise ValueError("maxConcurrentGpus must be a nonnegative integer or auto")
    if cap > 0 and len(occupied_gpu_ids) >= cap:
        return "gpu_busy"
    if any(isinstance(item, dict) and str(item.get("gpuId") or "") == gpu_id
           and str(item.get("commandId") or "") != command_id
           and (str(item.get("status") or "").lower() in ("dispatching", "running", "unknown")
                or str(item.get("status") or "").lower() == "queued" and item.get("requireIdleGpu") is True)
           for item in queue.get("jobs", [])):
        return "gpu_busy"
    gpu = next((item for item in gpus if gpu_row_id(item) == gpu_id), None)
    if gpu is None:
        return "gpu_busy"
    process_list = gpu.get("processes") if "processes" in gpu else gpu.get("procs") if "procs" in gpu else None
    if gpu.get("processes") or gpu.get("procs"):
        return "gpu_busy"
    process_count = gpu.get("processCount") if "processCount" in gpu else gpu.get("process_count")
    trusted_processes = isinstance(process_list, list) or process_count is not None
    util_keys = ("utilizationPercent", "utilization", "gpu_util", "utilizationGpu", "utilization_gpu", "gpuUtilPercent", "gpu_util_percent", "gpuUtil", "util")
    mem_keys = ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used", "used", "usedMemoryMb", "used_memory_mb", "memUsedMb", "usedMb", "mem_used_mb")
    def has_finite_metric(keys):
        for key in keys:
            try:
                value = float(gpu.get(key))
                if gpu.get(key) is not None and math.isfinite(value) and value >= 0:
                    return True
            except (TypeError, ValueError):
                pass
        return False
    has_metrics = has_finite_metric(util_keys) and has_finite_metric(mem_keys)
    if not has_metrics or not trusted_processes:
        return "gpu_busy"
    try:
        if process_count is not None and int(process_count) < 0:
            return "gpu_busy"
        if process_count is not None and int(process_count) > 0:
            return "gpu_busy"
    except (TypeError, ValueError):
        return "gpu_busy"
    if gpu_row_busy(gpu, util_threshold=util_threshold, mem_threshold=mem_threshold):
        return "gpu_busy"
    return ""

def accept_durable_plan_job(root, command, worker_id):
    identity = durable_plan_identity(command)
    missing = [key for key in DURABLE_PLAN_IDENTITY_FIELDS if identity.get(key) in (None, "")]
    count = durable_plan_value(command, "planJobCount")
    if count in (None, ""):
        missing.append("planJobCount")
    if missing:
        raise ValueError("持久 Plan 队列缺少完整身份：" + ",".join(missing))
    if identity["workerId"] != str(worker_id):
        raise ValueError("持久 Plan job 的 Worker owner 不匹配")
    if identity["runKey"] != identity["commandId"]:
        raise ValueError("runKey 必须匹配 commandId")
    if not isinstance(identity["experimentIndex"], int) or identity["experimentIndex"] < 0:
        raise ValueError("experimentIndex 无效")
    if not isinstance(identity["seed"], int):
        raise ValueError("seed 无效")
    if not isinstance(identity["attempt"], int) or identity["attempt"] < 1:
        raise ValueError("attempt 必须为正整数")
    if not isinstance(count, int) or count < 1:
        raise ValueError("planJobCount 必须为正整数；experimentIndex 保留原计划索引")
    full_count = durable_plan_value(command, "fullPlanJobCount")
    if full_count in (None, ""):
        full_count = count
    if not isinstance(full_count, int) or full_count < count:
        raise ValueError("fullPlanJobCount 不能少于本次提交任务数")
    plan_file = str(identity["planFile"]).replace("\\", "/")
    if plan_file.startswith("/") or any(part in ("", ".", "..") for part in plan_file.split("/")):
        raise ValueError("planFile 必须是项目内规范相对路径")
    output_dir = str(identity["outputDir"]).replace("\\", "/")
    if output_dir.startswith("/") or any(part in ("", ".", "..") for part in output_dir.split("/")):
        raise ValueError("outputDir 必须是项目内规范相对路径")
    if "/attempts/" not in output_dir:
        raise ValueError("outputDir 必须位于 attempts 路径下")
    identity["planFile"] = plan_file
    identity["outputDir"] = output_dir
    options = command.get("options") if isinstance(command.get("options"), dict) else {}
    require_idle_gpu = command.get("requireIdleGpu") is True or options.get("requireIdleGpu") is True
    requested_gpu = str(command.get("gpuId") or options.get("gpuId") or "").strip()
    if require_idle_gpu and not requested_gpu:
        raise ValueError("requireIdleGpu admission requires an explicit gpuId")
    enqueued_at = str(command.get("enqueuedAt") or options.get("enqueuedAt") or now_iso())
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_durable_plan_queue(root)
        old = next((row for row in data["jobs"] if isinstance(row, dict) and str(row.get("commandId") or "") == identity["commandId"]), None)
        tombstone = recalled_worker_command(root, identity)
        if tombstone:
            if not _legacy_recall_identity_matches(identity, tombstone):
                raise ValueError("commandId 已被 recall tombstone 绑定到不同的任务身份")
            return {**identity, "planJobCount": count, "gpuId": tombstone.get("gpuId") or "",
                    "status": "cancelled", "durableAccepted": True, "durableReleased": True,
                    "neverStarted": True, "neverStartedEvidence": tombstone.get("neverStartedEvidence")}
        if old:
            if not durable_plan_same_identity(old, identity) or int(old.get("planJobCount") or 0) != count:
                raise ValueError("commandId 已绑定到不同的 Plan job 身份")
            if old.get("executionMode") and command.get("executionMode") != old["executionMode"]:
                raise ValueError("commandId 已绑定到不同的运行模式")
            status = str(old.get("status") or "unknown")
            if status.lower() == "queued":
                try:
                    signal_durable_plan_queue_processor(root, worker_id)
                except Exception:
                    pass
            return {**durable_plan_identity(old), "planJobCount": old.get("planJobCount"), "enqueuedAt": old.get("enqueuedAt"),
                    "gpuId": old.get("gpuId") or "", "status": status, "durableAccepted": True,
                    "message": "Agent 已持久接收该 job"}
        if require_idle_gpu:
            try:
                gpus, gpu_error = collect_local_gpu()
            except Exception:
                gpus, gpu_error = [], "unavailable"
            util_threshold = command.get("gpuIdleUtilThreshold", options.get("gpuIdleUtilThreshold", options.get("gpu_idle_util_threshold")))
            mem_threshold = command.get("gpuIdleMemThresholdMb", options.get("gpuIdleMemThresholdMb", options.get("gpu_idle_mem_threshold")))
            max_concurrent_gpus = command.get("maxConcurrentGpus", options.get("maxConcurrentGpus"))
            reason = gpu_error or _durable_gpu_busy_reason(root, requested_gpu, identity["commandId"], gpus,
                                                          util_threshold=util_threshold, mem_threshold=mem_threshold,
                                                          max_concurrent_gpus=max_concurrent_gpus)
            if reason:
                return {**identity, "planJobCount": count, "gpuId": requested_gpu, "status": "pending",
                        "durableAccepted": False, "admissionRejected": True, "reason": "gpu_busy",
                        "message": "指定 GPU 当前繁忙，任务未持久接收"}
        row = dict(command)
        mode = verified_durable_execution_mode(root, command)
        row.update(identity)
        row.update({"schemaVersion": 1, "planJobCount": count, "fullPlanJobCount": full_count, "enqueuedAt": enqueued_at,
                    "workerId": str(worker_id), "status": "queued", "acceptedAt": now_iso(),
                    "requireIdleGpu": require_idle_gpu, "gpuId": requested_gpu if require_idle_gpu else ""})
        row.update({"mode": mode, "executionMode": mode, "executionModeSource": "matching_plan_revision"})
        row["options"] = {**options, "mode": mode, "executionMode": mode}
        data["schemaVersion"] = 1
        data["jobs"].append(row)
        write_durable_plan_queue(root, data)
        if require_idle_gpu:
            DISTRIBUTED_GPU_RESERVATIONS[requested_gpu] = identity["commandId"]
    try:
        append_event(root, {"type": "distributed_plan_job_accepted", "workerId": worker_id,
                            "operationId": identity["commandId"], "payload": {**identity, "planJobCount": count, "enqueuedAt": enqueued_at}})
    except Exception:
        pass
    try:
        signal_durable_plan_queue_processor(root, worker_id)
    except Exception:
        pass
    return {**identity, "planJobCount": count, "enqueuedAt": enqueued_at,
            "gpuId": requested_gpu if require_idle_gpu else "", "status": "queued",
            "durableAccepted": True, "message": "Agent 已持久接收该 job"}

def cancel_durable_plan_job(root, command):
    target = str(command.get("targetCommandId") or command.get("commandIdTarget") or "").strip()
    if not target:
        return None
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_durable_plan_queue(root)
        row = next((item for item in data["jobs"] if isinstance(item, dict) and str(item.get("commandId") or "") == target), None)
        if not row or str(row.get("status") or "").lower() != "queued":
            return None
        required = tuple(key for key in DURABLE_PLAN_IDENTITY_FIELDS if key != "commandId")
        supplied = {key: durable_plan_value(command, key) for key in required}
        missing = [key for key, value in supplied.items() if value in (None, "")]
        if missing:
            raise ValueError("待启动任务取消缺少完整身份：" + ",".join(missing))
        if any(str(row.get(key) if row.get(key) is not None else "") != str(value) for key, value in supplied.items()):
            raise ValueError("取消请求身份与持久队列 job 不匹配")
        cancelled_at = now_iso()
        row.update({"status": "cancelled", "cancelledAt": cancelled_at,
                    "cancelCommandId": str(command.get("commandId") or command.get("operationId") or "")})
        write_durable_plan_queue(root, data)
        receipt = {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"), "enqueuedAt": row.get("enqueuedAt"),
                   "status": "cancelled", "finishedAt": cancelled_at, "stopReason": "user_cancel", "gpuId": ""}
    append_worker_task(root, {**receipt, "schemaVersion": SCHEMA_VERSION})
    append_event(root, {"type": "distributed_plan_job_cancelled", "workerId": receipt["workerId"],
                        "operationId": target, "payload": receipt})
    return receipt

def requeue_durable_plan_job(root, command):
    target = str(command.get("targetCommandId") or command.get("commandIdTarget") or "").strip()
    if not target:
        return None
    stop_id = str(command.get("commandId") or command.get("operationId") or "").strip()
    if not stop_id or stop_id == target:
        raise ValueError("recall operationId must be present and distinct from targetCommandId")
    requested = dict(command)
    requested["commandId"] = target
    identity = durable_plan_identity(requested)
    count = durable_plan_value(command, "planJobCount")
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_durable_plan_queue(root)
        row = next((item for item in data["jobs"] if isinstance(item, dict) and str(item.get("commandId") or "") == target), None)
        if row:
            missing = [key for key in DURABLE_PLAN_IDENTITY_FIELDS if identity.get(key) in (None, "")]
            if count in (None, ""):
                missing.append("planJobCount")
            if missing:
                raise ValueError("待重新排队任务缺少完整身份：" + ",".join(missing))
            if (not durable_plan_same_identity(row, identity) or int(row.get("planJobCount") or 0) != count
                    or str(row.get("gpuId") or "") != str(command.get("gpuId") or "")):
                raise ValueError("重新排队请求身份与持久队列 job 不匹配")
            status = str(row.get("status") or "unknown").lower()
            if status == "cancelled" and str(row.get("stopReason") or "") == "requeue":
                tombstone = recalled_worker_command(root, {"commandId": target})
                if tombstone:
                    return {**tombstone, "durableAccepted": True, "durableReleased": True}
                receipt = {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                           "gpuId": row.get("gpuId") or "", "targetCommandId": target,
                           "status": "cancelled", "stopReason": "requeue", "durableAccepted": True,
                           "durableReleased": True, "neverStarted": True,
                           "neverStartedEvidence": "durable_queued_row", "stopCommandId": stop_id}
                return write_worker_recall_tombstone(root, receipt)
            if status != "queued":
                return {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                        "gpuId": row.get("gpuId") or "", "status": status,
                        "durableAccepted": True, "durableReleased": False}
            snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
            tasks = snapshot.get("tasks") if isinstance(snapshot, dict) and isinstance(snapshot.get("tasks"), list) else []
            started = next((item for item in tasks if isinstance(item, dict)
                            and str(item.get("commandId") or item.get("operationId") or "") == target), None)
            if started and (not durable_plan_same_identity(row, started)
                            or str(row.get("gpuId") or "") != str(started.get("gpuId") or "")):
                return {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                        "gpuId": row.get("gpuId") or "", "status": "unknown",
                        "durableAccepted": True, "durableReleased": False, "identityConflict": True}
            if started and durable_plan_value(started, "planJobCount") != count:
                return {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                        "gpuId": row.get("gpuId") or "", "status": "unknown",
                        "durableAccepted": True, "durableReleased": False, "identityConflict": True}
            if started and str(started.get("status") or "").lower() != "queued":
                return {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                        "gpuId": row.get("gpuId") or "", "status": str(started.get("status") or "unknown").lower(),
                        "durableAccepted": True, "durableReleased": False}
            if started and _legacy_recall_has_execution_marker(started):
                return {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                        "gpuId": row.get("gpuId") or "", "status": "unknown",
                        "durableAccepted": True, "durableReleased": False, "identityConflict": True}
            at = now_iso()
            receipt = {**durable_plan_identity(row), "planJobCount": row.get("planJobCount"),
                       "enqueuedAt": row.get("enqueuedAt"), "gpuId": row.get("gpuId") or "",
                       "targetCommandId": target, "status": "cancelled", "stopReason": "requeue",
                       "durableAccepted": True, "durableReleased": True,
                       "neverStarted": True, "neverStartedEvidence": "durable_queued_row",
                       "stopCommandId": stop_id, "finishedAt": at}
            write_worker_recall_tombstone(root, receipt)
            row.update({"status": "cancelled", "cancelledAt": at, "finishedAt": at, "stopReason": "requeue",
                        "cancelCommandId": stop_id, "neverStarted": True, "neverStartedEvidence": "durable_queued_row"})
            release_distributed_gpu_reservation(str(row.get("gpuId") or ""), target)
            write_durable_plan_queue(root, data)
            append_worker_task(root, {**receipt, "schemaVersion": SCHEMA_VERSION})
        else:
            claim = worker_start_claim(root, target)
            if claim:
                return {**_legacy_recall_identity(command), "commandId": target,
                        "targetCommandId": target, "status": "unknown", "durableAccepted": False,
                        "durableReleased": False, "legacyReleased": False,
                        "message": "worker start was already claimed; ownership retained"}
            snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
            tasks = snapshot.get("tasks") if isinstance(snapshot, dict) and isinstance(snapshot.get("tasks"), list) else []
            actual = next((item for item in tasks if isinstance(item, dict)
                           and str(item.get("commandId") or item.get("operationId") or "") == target), None)
            existing = recalled_worker_command(root, {"commandId": target})
            if existing:
                if not _legacy_recall_identity_matches(command, existing):
                    raise ValueError("commandId 已绑定到不同的 recall tombstone 身份")
                return {**existing, "durableAccepted": bool(existing.get("durableAccepted")),
                        "durableReleased": True, "legacyReleased": True}
            if actual:
                if not _legacy_recall_identity_matches(command, actual):
                    raise ValueError("重新排队请求身份与当前 Worker task 不匹配或历史身份不完整")
                status = str(actual.get("status") or "unknown").lower()
                if status not in ("queued", "pending"):
                    return {**_legacy_recall_identity(actual), "commandId": target,
                            "targetCommandId": target, "status": status, "durableAccepted": False,
                            "durableReleased": False, "legacyReleased": False}
                if _legacy_recall_has_execution_marker(actual):
                    return {**_legacy_recall_identity(actual), "commandId": target,
                            "targetCommandId": target, "status": "unknown", "durableAccepted": False,
                            "durableReleased": False, "legacyReleased": False,
                            "message": "historical task has execution markers; ownership retained"}
                evidence = "worker_task_queued" if status == "queued" else "worker_task_pending"
                receipt = {**_legacy_recall_identity(actual), "commandId": target,
                           "targetCommandId": target, "status": "cancelled", "stopReason": "requeue",
                           "durableAccepted": False, "durableReleased": True, "legacyReleased": True,
                           "neverStarted": True, "neverStartedEvidence": evidence,
                           "stopCommandId": stop_id, "finishedAt": now_iso(),
                           **({"planId": actual.get("planId")} if actual.get("planId") else {})}
            else:
                # Command-only history is releasable only when it carries an explicit queued state.
                worker_id = str(_legacy_recall_value(command, "workerId") or "").strip()
                command_path = worker_command_path(root, worker_id) if worker_id else ""
                queued_command = None
                queued_sequence = 0
                if command_path and os.path.isfile(command_path):
                    try:
                        with open(command_path, "r", encoding="utf-8") as handle:
                            for sequence, line in enumerate(handle, 1):
                                try:
                                    candidate = json.loads(line)
                                except Exception:
                                    continue
                                if isinstance(candidate, dict) and str(candidate.get("commandId") or candidate.get("operationId") or "") == target:
                                    queued_command = candidate
                                    queued_sequence = sequence
                    except OSError:
                        queued_command = None
                if not queued_command:
                    return {**_legacy_recall_identity(command), "commandId": target,
                            "targetCommandId": target, "status": "unknown", "durableAccepted": False,
                            "durableReleased": False, "legacyReleased": False,
                            "message": "missing historical command evidence; ownership retained"}
                if not _legacy_recall_identity_matches(command, queued_command):
                    raise ValueError("重新排队请求身份与历史 Worker command 不匹配或不完整")
                command_status = str(queued_command.get("status") or "").lower()
                if (command_status not in ("queued", "pending") or _legacy_recall_has_execution_marker(queued_command)
                        or not historical_command_is_unprocessed(root, worker_id, queued_sequence)):
                    return {**_legacy_recall_identity(queued_command), "commandId": target,
                            "targetCommandId": target, "status": command_status or "unknown",
                            "durableAccepted": False, "durableReleased": False, "legacyReleased": False,
                            "message": "historical command lacks never-started evidence; ownership retained"}
                receipt = {**_legacy_recall_identity(queued_command), "commandId": target,
                           "targetCommandId": target, "status": "cancelled", "stopReason": "requeue",
                           "durableAccepted": False, "durableReleased": True, "legacyReleased": True,
                           "neverStarted": True, "neverStartedEvidence": "worker_command_queued",
                           "stopCommandId": stop_id, "finishedAt": now_iso()}
            write_worker_recall_tombstone(root, receipt)
            append_worker_task(root, {**receipt, "schemaVersion": SCHEMA_VERSION})
    receipt["durableReleased"] = True
    receipt.setdefault("stoppedPids", [])
    receipt.setdefault("stoppedTasks", [])
    append_event(root, {"type": "distributed_plan_job_released", "workerId": receipt["workerId"],
                        "operationId": target, "payload": receipt})
    return receipt

LEGACY_WORKER_STOP_IDENTITY_FIELDS = ("workflowId", "planRevision", "planFile", "case", "seed", "attempt", "outputDir", "workerId", "gpuId")

def worker_recall_tombstones_path(root):
    return path_for(root, "worker_recall_tombstones.json")

def read_worker_recall_tombstones(root):
    data = read_json(worker_recall_tombstones_path(root), {})
    rows = data.get("rows") if isinstance(data, dict) and isinstance(data.get("rows"), list) else []
    return [row for row in rows if isinstance(row, dict)]

def worker_start_claims_path(root):
    return path_for(root, "worker_start_claims.json")

def read_worker_start_claims(root):
    data = read_json(worker_start_claims_path(root), {})
    rows = data.get("rows") if isinstance(data, dict) and isinstance(data.get("rows"), list) else []
    return [row for row in rows if isinstance(row, dict)]

def worker_start_claim(root, command_id):
    return next((row for row in read_worker_start_claims(root)
                 if str(row.get("commandId") or "") == str(command_id or "")), None)

def write_worker_start_claim(root, command):
    command_id = str(command.get("commandId") or command.get("operationId") or "").strip()
    if not command_id:
        raise ValueError("worker start claim requires commandId")
    data = read_json(worker_start_claims_path(root), {})
    rows = data.get("rows") if isinstance(data, dict) and isinstance(data.get("rows"), list) else []
    if any(isinstance(row, dict) and str(row.get("commandId") or "") == command_id for row in rows):
        return False
    rows.append({"commandId": command_id, "workerId": str(command.get("workerId") or ""),
                 "action": str(command.get("action") or ""), "status": "claimed",
                 "claimedAt": now_iso()})
    atomic_write(worker_start_claims_path(root), {"schemaVersion": SCHEMA_VERSION, "rows": rows})
    return True

def recalled_worker_command(root, command):
    target = str(command.get("commandId") or command.get("operationId") or "").strip()
    if not target:
        return None
    return next((row for row in read_worker_recall_tombstones(root)
                 if str(row.get("commandId") or "") == target), None)

def write_worker_recall_tombstone(root, receipt):
    path = worker_recall_tombstones_path(root)
    data = read_json(path, {})
    rows = data.get("rows") if isinstance(data, dict) and isinstance(data.get("rows"), list) else []
    target = str(receipt.get("commandId") or "")
    old = next((row for row in rows if isinstance(row, dict) and str(row.get("commandId") or "") == target), None)
    if old:
        if any(str(old.get(key) or "") != str(receipt.get(key) or "")
               for key in LEGACY_WORKER_STOP_IDENTITY_FIELDS):
            raise ValueError("commandId 已被绑定到不同的 recall tombstone 身份")
        return old
    rows.append(dict(receipt))
    atomic_write(path, {"schemaVersion": SCHEMA_VERSION, "rows": rows, "updatedAt": now_iso()})
    return receipt

def _legacy_recall_value(row, field):
    options = row.get("options") if isinstance(row.get("options"), dict) else {}
    aliases = {
        "workflowId": ("workflowId", "workflow_id", "parentId"),
        "planRevision": ("planRevision", "plan_revision"),
        "planFile": ("planFile", "plan_file", "plan"),
        "case": ("case", "caseName", "experimentCase", "experiment_case"),
        "seed": ("seed",), "attempt": ("attempt",),
        "outputDir": ("outputDir", "output_dir"),
        "workerId": ("workerId", "worker_id"), "gpuId": ("gpuId", "gpu_id"),
    }
    for key in aliases.get(field, (field,)):
        value = row.get(key)
        if value in (None, ""):
            value = options.get(key)
        if value not in (None, ""):
            return value
    return ""

def _legacy_recall_identity(row):
    return {field: _legacy_recall_value(row, field) for field in LEGACY_WORKER_STOP_IDENTITY_FIELDS}

def _legacy_recall_identity_matches(expected, actual):
    left, right = _legacy_recall_identity(expected), _legacy_recall_identity(actual)
    if any(value in (None, "") for value in left.values()) or any(value in (None, "") for value in right.values()):
        return False
    for field in LEGACY_WORKER_STOP_IDENTITY_FIELDS:
        if field in ("seed", "attempt"):
            try:
                if int(left[field]) != int(right[field]):
                    return False
            except (TypeError, ValueError):
                return False
        elif str(left[field]).strip() != str(right[field]).strip():
            return False
    return True

def _legacy_recall_has_execution_marker(task):
    for key in ("pid", "processPid"):
        value = task.get(key)
        if value not in (None, "", 0, "0", False):
            return True
    return any(str(task.get(key) or "").strip() for key in (
        "startedAt", "started_at", "tmuxSession", "tmuxPane", "exitCodePath"))

def historical_command_is_unprocessed(root, worker_id, sequence):
    # A stale queued payload in the append-only log is not a live queue receipt.
    # Require a checkpoint bound to this file, in addition to its explicit queued state.
    checkpoint = read_json(worker_command_checkpoint_path(root, worker_id), {})
    try:
        if not isinstance(checkpoint, dict) or checkpoint.get("schemaVersion") != SCHEMA_VERSION:
            return False
        if any(type(checkpoint.get(key)) is not int or checkpoint[key] < 0
               for key in ("queueSeq", "size", "device", "inode", "prefixLength")):
            return False
        identity = worker_command_queue_identity(worker_command_path(root, worker_id))
        saved_size = checkpoint["size"]
        prefix_length = checkpoint["prefixLength"]
        cursor = checkpoint["queueSeq"]
        if (saved_size <= 0 or prefix_length != min(512, saved_size) or sequence <= cursor
                or int(checkpoint["device"]) != identity["device"] or int(checkpoint["inode"]) != identity["inode"]
                or identity["size"] < int(checkpoint["size"])):
            return False
        with open(worker_command_path(root, worker_id), "rb") as handle:
            saved = handle.read(saved_size)
        return (saved.endswith(bytes([10])) and cursor <= saved.count(bytes([10]))
                and hashlib.sha256(saved[:prefix_length]).hexdigest() == checkpoint["prefixSha256"])
    except (OSError, KeyError, TypeError, ValueError):
        return False

def worker_task_matches_stop_identity(command, task):
    target_command = str(command.get("targetCommandId") or command.get("commandIdTarget") or "").strip()
    task_command = str(task.get("commandId") or task.get("operationId") or "").strip()
    if not target_command or task_command != target_command:
        return False
    fields = (*DURABLE_PLAN_IDENTITY_FIELDS, "gpuId", "planJobCount") if task.get("projectId") else LEGACY_WORKER_STOP_IDENTITY_FIELDS
    for field in fields:
        if field == "commandId":
            continue  # targetCommandId identifies the job; commandId identifies this stop.
        expected = command.get(field)
        actual = task.get("plan") if field == "planFile" and task.get("planFile") in (None, "") else task.get(field)
        if field in ("seed", "attempt", "experimentIndex", "planJobCount"):
            try:
                if int(actual) != int(expected):
                    return False
            except (TypeError, ValueError):
                return False
        elif str(actual if actual is not None else "") != str(expected):
            return False
    return True
def durable_plan_task_status(task):
    status = str(task.get("status") or "").lower()
    return {"running": "running", "completed": "completed", "failed": "failed",
            "stopped": "cancelled", "cancelled": "cancelled", "canceled": "cancelled"}.get(status)

def record_durable_plan_task_terminal(root, task):
    status = durable_plan_task_status(task)
    if status not in ("completed", "failed", "cancelled"):
        return False
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_durable_plan_queue(root)
        row = next((item for item in data["jobs"] if isinstance(item, dict)
                    and str(item.get("commandId") or "") == str(task.get("commandId") or "")), None)
        if not row or str(row.get("status") or "").lower() in ("completed", "failed", "cancelled"):
            return False
        if not durable_plan_same_identity(row, task):
            row.update({"status": "unknown", "identityConflict": True,
                        "error": "terminal worker task identity conflicts with durable Plan queue"})
        else:
            row.update({"status": status, "finishedAt": task.get("finishedAt") or now_iso(),
                        "updatedAt": now_iso()})
            if task.get("exitCode") is not None:
                row["exitCode"] = task.get("exitCode")
            if task.get("error"):
                row["error"] = str(task.get("error"))
            if status == "cancelled":
                row["stopReason"] = task.get("stopReason") or "user_cancel"
        write_durable_plan_queue(root, data)
        return True

def sync_durable_plan_task_rows(root):
    snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
    tasks = snapshot.get("tasks") if isinstance(snapshot, dict) and isinstance(snapshot.get("tasks"), list) else []
    task_by_id = {str(item.get("commandId") or ""): item for item in tasks if isinstance(item, dict) and item.get("commandId")}
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_durable_plan_queue(root)
        changed = False
        for row in data["jobs"]:
            if not isinstance(row, dict):
                continue
            old_status = str(row.get("status") or "unknown").lower()
            if old_status in ("completed", "failed", "cancelled"):
                continue
            task = task_by_id.get(str(row.get("commandId") or ""))
            if not task:
                continue
            if not durable_plan_same_identity(row, task):
                row.update({"status": "unknown", "identityConflict": True,
                            "error": "worker task snapshot identity conflicts with durable Plan queue"})
                changed = True
                continue
            mapped = durable_plan_task_status(task)
            if mapped and mapped != old_status:
                row.update({"status": mapped, "updatedAt": now_iso()})
                for key in ("finishedAt", "exitCode", "error", "logPath", "cancelledAt", "stopReason"):
                    if task.get(key) is not None:
                        row[key] = task[key]
                changed = True
        if changed:
            write_durable_plan_queue(root, data)
    return data

def fence_queued_idle_gpu_admission(root, row, reason):
    command_id = str(row.get("commandId") or "")
    changed = False
    with WORKER_TASK_SNAPSHOT_LOCK:
        latest = read_durable_plan_queue(root)
        current = next((item for item in latest["jobs"] if isinstance(item, dict)
                        and str(item.get("commandId") or "") == command_id), None)
        if current and current.get("status") == "queued" and current.get("requireIdleGpu") is True:
            current.update({"status": "unknown", "updatedAt": now_iso(),
                            "error": str(reason or "GPU admission changed before dispatch; operator reconciliation required")})
            write_durable_plan_queue(root, latest)
            changed = True
    if changed:
        append_event(root, {"type": "distributed_plan_job_dispatch_unknown", "workerId": str(row.get("workerId") or ""),
                            "operationId": command_id, "payload": {"message": str(reason or "GPU admission changed before dispatch")}})
    return changed

def drain_durable_plan_queue_once(root, worker_id, gpu_probe=None, execute=None, target_command_id=None):
    worker_id = str(worker_id or "worker").strip() or "worker"
    gpu_probe = gpu_probe or collect_local_gpu
    execute = execute or execute_worker_command
    reconcile_worker_task_exit_codes(root)
    data = sync_durable_plan_task_rows(root)
    dispatched = []
    for row in data["jobs"]:
        if not isinstance(row, dict):
            continue
        if target_command_id and str(row.get("commandId") or "") != str(target_command_id):
            continue
        if str(row.get("status") or "").lower() != "queued" or str(row.get("workerId") or "") != worker_id:
            continue
        try:
            proof = resolve_durable_code_sync_proof(root, row)
            execution_mode = verified_durable_execution_mode(root, row)
        except Exception as exc:
            message = str(exc)
            with WORKER_TASK_SNAPSHOT_LOCK:
                latest = read_durable_plan_queue(root)
                current = next((item for item in latest["jobs"] if item.get("commandId") == row.get("commandId")), None)
                if current and current.get("status") == "queued" and (current.get("codeBlocked") is not True or current.get("error") != message):
                    current.update({"codeBlocked": True, "error": message})
                    write_durable_plan_queue(root, latest)
                    append_event(root, {"type": "distributed_plan_code_wait", "workerId": worker_id,
                                        "operationId": row.get("commandId"), "payload": {"error": message}})
            continue
        # Persist renewal on the same queued command before admission. A busy GPU
        # must not leave an obsolete code error or require another submission.
        with WORKER_TASK_SNAPSHOT_LOCK:
            latest = read_durable_plan_queue(root)
            current = next((item for item in latest["jobs"] if isinstance(item, dict)
                            and item.get("commandId") == row.get("commandId")), None)
            if not current or current.get("status") != "queued" or not durable_plan_same_identity(current, row):
                continue
            changed = False
            # Only unstarted queued commands can be migrated. Running processes and
            # terminal audit records retain their original actual mode and exit status.
            if current.get("executionMode") != execution_mode or current.get("mode") != execution_mode:
                current.update({"legacyRequestedMode": current.get("mode"), "mode": execution_mode,
                                "executionMode": execution_mode, "executionModeSource": "matching_plan_revision"})
                current["options"] = {**(current.get("options") or {}), "mode": execution_mode, "executionMode": execution_mode}
                changed = True
            if isinstance(proof, dict) and proof.get("proofId") and proof["proofId"] != current.get("codeSyncProofId"):
                current.update({"codeSyncProofId": proof["proofId"],
                                "manifestDigest": proof["manifestDigest"],
                                "codeSyncProofRuntimeGeneration": proof["runtimeGeneration"]})
                changed = True
            if current.pop("codeBlocked", False):
                current.pop("error", None)
                changed = True
            if changed:
                write_durable_plan_queue(root, latest)
            row = current
        gpus, error = gpu_probe()
        if error:
            if row.get("requireIdleGpu") is True:
                fence_queued_idle_gpu_admission(root, row, "GPU telemetry unavailable after durable acceptance: " + str(error))
            break
        snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = snapshot.get("tasks") if isinstance(snapshot, dict) and isinstance(snapshot.get("tasks"), list) else []
        latest = read_durable_plan_queue(root)
        occupied = {str(item.get("gpuId")) for item in tasks if isinstance(item, dict)
                    and str(item.get("status") or "").lower() in ("running", "dispatching")}
        occupied.update(str(item.get("gpuId")) for item in latest.get("jobs", []) if isinstance(item, dict)
                        and item.get("gpuId")
                        and (str(item.get("status") or "").lower() in ("dispatching", "running", "unknown")
                             or str(item.get("status") or "").lower() == "queued" and item.get("requireIdleGpu") is True)
                        and str(item.get("commandId") or "") != str(row.get("commandId") or ""))
        command_id = str(row.get("commandId") or "")
        occupied.update(gpu_id for gpu_id, owner in DISTRIBUTED_GPU_RESERVATIONS.items() if owner != command_id)
        row_options = row.get("options") if isinstance(row.get("options"), dict) else {}
        util_threshold = row.get("gpuIdleUtilThreshold", row_options.get("gpuIdleUtilThreshold", row_options.get("gpu_idle_util_threshold")))
        mem_threshold = row.get("gpuIdleMemThresholdMb", row_options.get("gpuIdleMemThresholdMb", row_options.get("gpu_idle_mem_threshold")))
        max_concurrent_gpus = row.get("maxConcurrentGpus", row_options.get("maxConcurrentGpus"))
        pinned_gpu = str(row.get("gpuId") or "") if row.get("requireIdleGpu") is True else ""
        candidates = [gpu for gpu in gpus if not pinned_gpu or gpu_row_id(gpu) == pinned_gpu]
        free = next((gpu_row_id(gpu) for gpu in candidates if gpu_row_id(gpu) not in occupied
                     and not _durable_gpu_busy_reason(root, gpu_row_id(gpu), command_id, gpus,
                                                      util_threshold, mem_threshold, max_concurrent_gpus)), None)
        if free is None:
            if row.get("requireIdleGpu") is True:
                fence_queued_idle_gpu_admission(root, row, "Requested GPU became busy before dispatch; reconciliation required")
            continue
        claimed = False
        with WORKER_TASK_SNAPSHOT_LOCK:
            latest = read_durable_plan_queue(root)
            current = next((item for item in latest["jobs"] if isinstance(item, dict)
                            and item.get("commandId") == row.get("commandId")), None)
            if current and current.get("status") == "queued" and DISTRIBUTED_GPU_RESERVATIONS.get(str(free)) in (None, str(current.get("commandId") or "")):
                if current.pop("codeBlocked", False):
                    current.pop("error", None)
                current.update({"status": "dispatching", "gpuId": str(free), "dispatchingAt": now_iso()})
                DISTRIBUTED_GPU_RESERVATIONS[str(free)] = str(current.get("commandId") or "")
                write_durable_plan_queue(root, latest)
                row = current
                claimed = True
        if not claimed:
            continue
        command = dict(row)
        command.pop("durablePlanQueue", None)
        command.pop("codeManifest", None)
        command.pop("codeSyncProofId", None)
        command.pop("manifestDigest", None)
        command.pop("scopeSignature", None)
        command["gpuId"] = str(free)
        try:
            result = execute(root, command, worker_id)
            result_status = str(result.get("status") or "unknown").lower()
            if result_status in ("running", "completed", "failed", "cancelled", "stopped"):
                new_status = "cancelled" if result_status in ("cancelled", "stopped") else result_status
            else:
                new_status = "unknown"
        except Exception as exc:
            message = str(exc)
            waiting = any(marker in message for marker in (
                "已被待启动任务占用", "已有插件任务运行", "当前非空闲", "GPU 实时检测失败", "GPU 不存在或尚无实时状态"))
            result = {"status": "queued" if waiting else "unknown", "message": message}
            new_status = "unknown" if row.get("requireIdleGpu") is True and waiting else "queued" if waiting else "unknown"
        with WORKER_TASK_SNAPSHOT_LOCK:
            latest = read_durable_plan_queue(root)
            current = next((item for item in latest["jobs"] if isinstance(item, dict)
                            and item.get("commandId") == row.get("commandId")), None)
            if current and current.get("status") == "dispatching":
                current["status"] = new_status
                current["lastDispatchResult"] = result
                current["updatedAt"] = now_iso()
                if new_status == "queued":
                    current["gpuId"] = ""
                    release_distributed_gpu_reservation(free, str(current.get("commandId") or ""))
                elif new_status in ("running", "completed", "failed", "cancelled"):
                    release_distributed_gpu_reservation(free, str(current.get("commandId") or ""))
                write_durable_plan_queue(root, latest)
        if new_status in ("unknown", "failed"):
            append_event(root, {"type": "distributed_plan_job_dispatch_" + new_status,
                                "workerId": worker_id, "operationId": row.get("commandId"),
                                "payload": {"message": result.get("message") or "dispatch outcome is unknown"}})
        dispatched.append({"commandId": row.get("commandId"), "status": new_status, "gpuId": str(free)})
        data = sync_durable_plan_task_rows(root)
    return dispatched

def durable_plan_queue_processor_key(root, worker_id):
    return (os.path.realpath(root), str(worker_id or "worker").strip() or "worker")

def durable_plan_queue_wake_event(root, worker_id):
    key = durable_plan_queue_processor_key(root, worker_id)
    with DURABLE_PLAN_QUEUE_PROCESSOR_LOCK:
        record = DURABLE_PLAN_QUEUE_PROCESSORS.get(key)
        if not isinstance(record, dict):
            record = {"wake": threading.Event(), "thread": None}
            DURABLE_PLAN_QUEUE_PROCESSORS[key] = record
        return record["wake"]

def signal_durable_plan_queue_processor(root, worker_id):
    durable_plan_queue_wake_event(root, worker_id).set()

def start_durable_plan_queue_processor(root, worker_id, poll_seconds=5, stop_event=None):
    worker_id = str(worker_id or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
    key = durable_plan_queue_processor_key(root, worker_id)
    with DURABLE_PLAN_QUEUE_PROCESSOR_LOCK:
        record = DURABLE_PLAN_QUEUE_PROCESSORS.get(key)
        if isinstance(record, dict) and record.get("thread") is not None:
            existing = record.get("thread")
            if not hasattr(existing, "is_alive") or existing.is_alive():
                return existing
    wake = durable_plan_queue_wake_event(root, worker_id)
    try:
        with WORKER_TASK_SNAPSHOT_LOCK:
            data = read_durable_plan_queue(root)
            changed = False
            for row in data["jobs"]:
                if isinstance(row, dict) and str(row.get("status") or "").lower() == "dispatching":
                    row.update({"status": "unknown", "recoveredAt": now_iso(),
                                "error": "Agent restarted during dispatch; automatic replay is fenced."})
                    changed = True
            if changed:
                write_durable_plan_queue(root, data)
    except Exception as exc:
        append_event(root, {"type": "distributed_plan_queue_recovery_error", "workerId": worker_id, "payload": {"error": str(exc)}})
    def loop():
        while stop_event is None or not stop_event.is_set():
            wake.clear()
            if stop_event is not None and stop_event.is_set():
                break
            try:
                drain_durable_plan_queue_once(root, worker_id)
            except Exception as exc:
                append_event(root, {"type": "distributed_plan_queue_error", "workerId": worker_id, "payload": {"error": str(exc)}})
            wake.wait(timeout=max(1.0, float(poll_seconds or 5)))
            if stop_event is not None and stop_event.is_set():
                break
    processor = threading.Thread(target=loop, daemon=True, name="durable-plan-queue-processor")
    with DURABLE_PLAN_QUEUE_PROCESSOR_LOCK:
        record = DURABLE_PLAN_QUEUE_PROCESSORS.get(key) or {"wake": wake, "thread": None}
        existing = record.get("thread")
        if existing is not None and (not hasattr(existing, "is_alive") or existing.is_alive()):
            return existing
        record["thread"] = processor
        DURABLE_PLAN_QUEUE_PROCESSORS[key] = record
        processor.start()
    return processor

def reserve_distributed_gpu(root, gpu_id, command_id, util_threshold=None, mem_threshold=None,
                            require_idle_gpu=False, max_concurrent_gpus=None):
    """Reserve one physical GPU before starting a distributed job; never infer ownership from username."""
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        existing = next((row for row in tasks if isinstance(row, dict) and str(row.get("commandId") or "") == command_id), None)
        if existing:
            return existing
        reservation_owner = DISTRIBUTED_GPU_RESERVATIONS.get(str(gpu_id))
        if reservation_owner and reservation_owner != command_id:
            raise RuntimeError(f"GPU {gpu_id} 已被待启动任务占用")
        if any(isinstance(row, dict) and str(row.get("gpuId") or "") == str(gpu_id)
               and str(row.get("status") or "").lower() in ("running", "dispatching") for row in tasks):
            raise RuntimeError(f"GPU {gpu_id} 已有插件任务运行")
        gpus, error = collect_local_gpu()
        if error:
            raise RuntimeError(f"GPU 实时检测失败：{error}")
        row = next((item for item in gpus if gpu_row_id(item) == str(gpu_id)), None)
        if row is None:
            raise RuntimeError(f"GPU {gpu_id} 不存在或尚无实时状态")
        process_list = row.get("processes") if "processes" in row else row.get("procs") if "procs" in row else None
        if require_idle_gpu or max_concurrent_gpus not in (None, "", 0, "0", "auto"):
            busy = bool(_durable_gpu_busy_reason(root, gpu_id, command_id, gpus, util_threshold,
                                                 mem_threshold, max_concurrent_gpus))
        else:
            busy = bool(row.get("processes")) or gpu_row_busy(
                row, util_threshold=util_threshold, mem_threshold=mem_threshold)
        if busy:
            raise RuntimeError(f"GPU {gpu_id} 当前非空闲，已停止派发")
        DISTRIBUTED_GPU_RESERVATIONS[str(gpu_id)] = command_id
        return None

def release_distributed_gpu_reservation(gpu_id, command_id):
    with WORKER_TASK_SNAPSHOT_LOCK:
        if DISTRIBUTED_GPU_RESERVATIONS.get(str(gpu_id)) == command_id:
            DISTRIBUTED_GPU_RESERVATIONS.pop(str(gpu_id), None)

def simple_runtime_env(base=None):
    env = dict(os.environ if base is None else base)
    if str(env.get("SIMPLE_EXPERIMENT_CONDA_ENV") or "").strip() in {"-", "--"}:
        env["SIMPLE_EXPERIMENT_CONDA_ENV"] = ""
    env.setdefault("SIMPLE_EXPERIMENT_CONDA_ENV", "")
    env.setdefault("SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV", "1" if str(env.get("SIMPLE_EXPERIMENT_CONDA_ENV") or "").strip() else "0")
    return env

def simple_conda_env_python(env_name):
    # Resolve the configured conda env's python to an absolute path. The agent's own PATH
    # often lacks 'conda', but a login shell ('bash -lc') has it initialized (just like an
    # interactive tmux session), so we ask conda to resolve the interpreter for us.
    # 绝对路径支持：如 /path/to/conda_envs/<env_name> 直接取 {path}/bin/python，不再探测 conda run
    if not env_name:
        return None
    cache = getattr(simple_conda_env_python, "_cache", None)
    if cache is None:
        cache = {}
        simple_conda_env_python._cache = cache
    if env_name in cache:
        return cache[env_name]
    if str(env_name).strip().startswith("/"):
        clean = str(env_name).strip().rstrip("/\\")
        if clean.endswith("/bin/python"):
            result = clean
        else:
            result = clean + "/bin/python"
        cache[env_name] = result
        return result
    # 降级兜底保留：仅环境名（如 <env_name>）曾走 conda run 探测，现已要求绝对路径，此分支保留为历史兼容但主流程已在 simple_runtime_python 处直接失败
    result = None
    try:
        proc = subprocess.run(
            ["bash", "-lc", "conda run -n " + shlex.quote(env_name) + " python -c \"import sys; print(sys.executable)\""],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30,
        )
        if proc.returncode == 0:
            lines = [ln.strip() for ln in proc.stdout.strip().splitlines() if ln.strip()]
            if lines:
                result = lines[-1]
    except Exception:
        result = None
    cache[env_name] = result
    return result


def simple_runtime_python(env=None):
    # 固化为绝对路径：仅接受以 / 开头的绝对路径（可选以 /bin/python 结尾），否则直接失败提示“请填写完整环境路径”；跨平台以 "/" 判定
    source = simple_runtime_env(env)
    conda_env = simple_conda_env_name(source)
    if conda_env:
        # 必须为绝对路径：以 / 开头，精确到环境文件夹如 /path/to/conda_envs/<env_name>，可选以 /bin/python 结尾；空值表示不激活 conda
        if not str(conda_env).strip().startswith("/"):
            raise RuntimeError(f"condaEnv 请填写完整环境路径，以 / 开头（精确到环境文件夹，如 /path/to/conda_envs/<env_name>，可选以 /bin/python 结尾），当前值: {conda_env!r}；仅环境名已废弃")
        clean = conda_env.strip().rstrip("/\\")
        if clean.endswith("/bin/python"):
            return clean
        return clean + "/bin/python"
    # No conda env: use the agent's own interpreter for local checks.
    return sys.executable if os.path.isabs(sys.executable) else sys.executable

def simple_conda_env_name(env=None):
    source = os.environ if env is None else env
    value = str(source.get("SIMPLE_EXPERIMENT_CONDA_ENV") or "").strip()
    return "" if value in {"-", "--"} else value


def simple_conda_required(env=None):
    source = os.environ if env is None else env
    return str(source.get("SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV") or "").strip().lower() in {"1", "true", "yes", "on"}


def simple_conda_activation_script(env=None):
    # Portable activation: when env is explicitly given, bind it; otherwise emit the
    # generic runtime script that checks $SIMPLE_EXPERIMENT_CONDA_ENV at execution time.
    # The generic form is required by publicRuntimeEnvironmentDefault's regex.
    raw_env_name = simple_conda_env_name(env) if env is not None else ""
    # Treat empty env with no explicit dict as generic runtime script (HEAD behavior)
    if env is None and not raw_env_name:
        return "; ".join([
            'SIMPLE_EXPERIMENT_CONDA_ENV="$' + '{SIMPLE_EXPERIMENT_CONDA_ENV:-}"',
            '__simple_conda_required(){ echo "Conda env $SIMPLE_EXPERIMENT_CONDA_ENV is required."; return 127; }',
            'if [ -n "$SIMPLE_EXPERIMENT_CONDA_ENV" ]; then :',
            'for __SIMPLE_EXPERIMENT_CONDA_SH in "$HOME/miniconda3/etc/profile.d/conda.sh" "$HOME/anaconda3/etc/profile.d/conda.sh" "$HOME/miniforge3/etc/profile.d/conda.sh" "$HOME/mambaforge/etc/profile.d/conda.sh" "/opt/conda/etc/profile.d/conda.sh" "/opt/anaconda3/etc/profile.d/conda.sh" "/usr/local/anaconda3/etc/profile.d/conda.sh"; do if ! command -v conda >/dev/null 2>&1 && [ -f "$__SIMPLE_EXPERIMENT_CONDA_SH" ]; then . "$__SIMPLE_EXPERIMENT_CONDA_SH"; fi; done',
            'if command -v conda >/dev/null 2>&1; then __SIMPLE_EXPERIMENT_CONDA_SETUP="$(conda shell.posix hook 2>/dev/null)" && eval "$__SIMPLE_EXPERIMENT_CONDA_SETUP" || true; fi',
            '__simple_conda_env_dir="$SIMPLE_EXPERIMENT_CONDA_ENV"; case "$__simple_conda_env_dir" in */bin/python) __simple_conda_env_dir="$(dirname "$(dirname "$__simple_conda_env_dir")")";; */bin) __simple_conda_env_dir="$(dirname "$__simple_conda_env_dir")";; esac',
            'if command -v conda >/dev/null 2>&1; then conda activate "$SIMPLE_EXPERIMENT_CONDA_ENV" >/dev/null 2>&1 || __simple_conda_required; elif [ -x "$__simple_conda_env_dir/bin/python" ]; then export PATH="$__simple_conda_env_dir/bin:$PATH"; elif [ -x "$SIMPLE_EXPERIMENT_CONDA_ENV" ] && [ ! -d "$SIMPLE_EXPERIMENT_CONDA_ENV" ]; then __simple_conda_bin="$(dirname "$SIMPLE_EXPERIMENT_CONDA_ENV")"; export PATH="$__simple_conda_bin:$PATH"; elif [ "$' + '{SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV:-0}" = "1" ]; then __simple_conda_required; fi',
            'fi',
        ])
    if not raw_env_name:
        return "true"
    return (
        'export SIMPLE_EXPERIMENT_CONDA_ENV=' + shlex.quote(str(raw_env_name)) + '; '
        'if [ -n "$SIMPLE_EXPERIMENT_CONDA_ENV" ]; then '
        '__conda_root="$(conda info --base 2>/dev/null)"; '
        '__conda_sh=""; '
        'if [ -n "$CONDA_PREFIX" ] && [ -f "$CONDA_PREFIX/etc/profile.d/conda.sh" ]; then __conda_sh="$CONDA_PREFIX/etc/profile.d/conda.sh"; '
        'elif [ -n "$__conda_root" ] && [ -f "$__conda_root/etc/profile.d/conda.sh" ]; then __conda_sh="$__conda_root/etc/profile.d/conda.sh"; '
        'elif [ -n "$CONDA_EXE" ]; then __conda_sh="$(dirname $CONDA_EXE)/../etc/profile.d/conda.sh"; fi; '
        'if [ -n "$__conda_sh" ] && [ -f "$__conda_sh" ]; then . "$__conda_sh"; fi; '
        '__simple_conda_env_dir="$SIMPLE_EXPERIMENT_CONDA_ENV"; case "$__simple_conda_env_dir" in */bin/python) __simple_conda_env_dir="$(dirname "$(dirname "$__simple_conda_env_dir")")";; */bin) __simple_conda_env_dir="$(dirname "$__simple_conda_env_dir")";; esac; '
        'if [ -x "$__simple_conda_env_dir/bin/python" ]; then export PATH="$__simple_conda_env_dir/bin:$PATH"; elif [ -x "$SIMPLE_EXPERIMENT_CONDA_ENV" ] && [ ! -d "$SIMPLE_EXPERIMENT_CONDA_ENV" ]; then __simple_conda_bin="$(dirname "$SIMPLE_EXPERIMENT_CONDA_ENV")"; export PATH="$__simple_conda_bin:$PATH"; else _c_ok=0; for _i in 1 2 3 4 5; do '
        'if conda activate "$SIMPLE_EXPERIMENT_CONDA_ENV" 2>/dev/null; then _c_ok=1; break; fi; '
        'echo "[simple-agent] conda activate attempt $_i failed for $SIMPLE_EXPERIMENT_CONDA_ENV"; conda env list 2>&1 | head -20; sleep 1; done; '
        'if [ "$_c_ok" != "1" ]; then echo "[simple-agent] conda activate $SIMPLE_EXPERIMENT_CONDA_ENV failed PATH=$PATH CONDA_EXE=$CONDA_EXE"; conda activate "$SIMPLE_EXPERIMENT_CONDA_ENV"; exit 127; fi; fi; fi'
    )

def simple_conda_wrapped_args(args, env):
    source = simple_runtime_env(env)
    if os.name == "nt":
        return args
    conda_env = str(source.get("SIMPLE_EXPERIMENT_CONDA_ENV") or "").strip()
    require = str(source.get("SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV") or "").strip().lower() in ("1", "true", "yes", "on")
    if not (require and conda_env):
        return args
    # 变量化双保险：conda activate 与绝对 python 共存；不在此因 which 失败而跳过 wrapping，activation 脚本自行 source conda.sh
    shell = os.environ.get("SHELL") or ("/bin/bash" if os.path.isfile("/bin/bash") else "/bin/sh")
    # Keep the portable activation pattern expected by runtime tests (empty-arg call)
    # simple_conda_activation_script()} && exec
    return [shell, "-lc", f"{simple_conda_activation_script(env)} && exec {shlex.join([str(item) for item in args])}"]

def _normalize_gpu_id_for_window(value):
    s = str(value or "0").strip()
    if not s or s == "-":
        return "0"
    if re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", s, re.I):
        m = re.search(r"(?:gpu)[-_]?(\d+)\b", s, re.I)
        if m:
            v = m.group(1)
            try:
                if 0 <= int(v) < 64:
                    return v
            except Exception:
                pass
        return "0"
    if re.match(r"^\d+$", s):
        try:
            if 0 <= int(s) < 64:
                return s
        except Exception:
            pass
        return s
    m2 = re.search(r"(?:gpu)[-_]?(\d+)\b", s, re.I)
    if m2:
        return m2.group(1)
    # fallback: pure numeric fragment not inside uuid already handled, else 0
    return "0" if not s.isdigit() else s

def fixed_gpu_window_name(prefix, gpu_id):
    # 前缀按设置自动识别：显式 prefix 优先，否则走 _resolve_tmux_prefix 统一解析
    if prefix and str(prefix).strip():
        base = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(prefix).strip()).strip("-").lower()[:32]
        if not base or not re.match(r"^[a-z0-9]", base):
            base = _resolve_tmux_prefix(None, None, None)
    else:
        base = _resolve_tmux_prefix(None, None, None)
    if not base or not re.match(r"^[a-z0-9]", base):
        base = "simple"
    gid_raw = _normalize_gpu_id_for_window(gpu_id)
    gid = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(gid_raw or "0").strip().lower()).strip("-").lower() or "0"
    return f"{base}-gpu-{gid}"

def simple_tmux_name(value):
    text = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "task")).strip("-").lower()
    prefix = _resolve_tmux_prefix(None, None, None)
    # _resolve 已做归一与合法性校验，此处二次加固与旧逻辑保持一致
    prefix = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(prefix or _resolve_tmux_prefix(None, None, None))).strip("-").lower()[:32]
    if not prefix or not re.match(r"^[a-z0-9]", prefix):
        prefix = "simple"
    return ((prefix + "-" + (text or "task"))[:96])

def worker_tmux_session_name(worker_id, gpu_id, local_worker_id=None):
    # 可测性与归一加固：抽出纯函数，两个归一均与 simple_tmux_name 一致（小写、非法字符→-、去首尾-、截后 lower）；gpu 归一化复用 _normalize_gpu_id_for_window 忽略 UUID
    gpu_id_norm_raw = _normalize_gpu_id_for_window(gpu_id)
    gpu_id_norm = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(gpu_id_norm_raw or "0").strip().lower()).strip("-").lower() or "0"
    gpu_id_norm = re.sub(r"[^a-z0-9_.-]+", "-", gpu_id_norm).strip("-") or "0"
    worker_norm = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(worker_id or "").strip().lower()).strip("-").lower() or "worker"
    worker_norm = re.sub(r"[^a-z0-9_.-]+", "-", worker_norm).strip("-") or "worker"
    try:
        raw_local = str(local_worker_id if local_worker_id is not None else os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "").strip().lower()
        local_norm = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw_local).strip("-").lower() or "worker"
        local_norm = re.sub(r"[^a-z0-9_.-]+", "-", local_norm).strip("-") or "worker"
    except Exception:
        local_norm = "worker"
    is_single = (not str(worker_id or "").strip()) or (worker_norm in ("worker", "default")) or (local_norm and worker_norm == local_norm)
    if is_single:
        return f"gpu-{gpu_id_norm}"
    else:
        return f"gpu-{worker_norm}-{gpu_id_norm}"

def tmux_available():
    return os.name != "nt" and bool(shutil.which("tmux"))

def tmux_session_alive(session, cwd=None, env=None):
    if not session:
        return False
    return subprocess.run(["tmux", "has-session", "-t", session], cwd=cwd or None, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env).returncode == 0

def tmux_task_pane_alive(pane, session, cwd=None, env=None):
    if not str(pane or "").startswith("%"):
        return tmux_session_alive(session, cwd, env)
    try:
        result = subprocess.run(["tmux", "display-message", "-p", "-t", str(pane), "#{pane_id}"], cwd=cwd or None, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=3, env=env)
        return result.returncode == 0 and result.stdout.strip() == str(pane)
    except Exception:
        return False

def tmux_pane_pid(session, cwd=None, env=None):
    try:
        result = subprocess.run(["tmux", "display-message", "-p", "-t", session, "#{pane_pid}"], cwd=cwd or None, text=True, capture_output=True, timeout=3, env=env)
        return int((result.stdout or "").strip() or "0") if result.returncode == 0 else 0
    except Exception:
        return 0

def _tmux_log_size(log_path):
    try:
        if not log_path or not os.path.isfile(log_path):
            return 0
        # Effective log size: ignore bootstrap echoes; pipe-pane marker已为主镜像(固定GPU窗口+capture-pane)，此处仅兼容旧日志过滤
        # so shell bootstrap lines are not mistaken for real scheduler progress.
        try:
            _size = os.path.getsize(log_path)
            _read_len = min(_size, 64 * 1024)
            with open(log_path, "rb") as _f:
                if _size > _read_len:
                    _f.seek(_size - _read_len)
                _data = _f.read(_read_len)
        except Exception:
            return 0
        _text = _data.decode("utf-8", errors="replace")
        _effective = 0
        for _line in _text.splitlines():
            _stripped = _line.strip()
            if not _stripped:
                continue
            if _stripped.startswith("[pipe-pane"):
                continue
            if _stripped.startswith("conda activate"):
                continue
            if _stripped.startswith("cd "):
                # 仅过滤 shell bootstrap 的短 cd 行（长度<80），避免误删正常调度日志中含 cd /path 的行
                if len(_stripped) < 80 and ("/data" in _stripped or '"' in _stripped or "'" in _stripped) and "experiment" not in _stripped.lower():
                    continue
            if _stripped.startswith("export "):
                continue
            if "SIMPLE_TMUX_READY" in _stripped:
                continue
            if "SIMPLE_EXPERIMENT_" in _stripped:
                continue
            if "printf '%s'" in _stripped or 'printf "%s"' in _stripped:
                continue
            if _stripped.startswith("printf") and ("exit_code" in _stripped or "$?" in _stripped):
                continue
            if "cluster_scheduler" in _stripped or "--scheduler-log" in _stripped or "--operation-id" in _stripped or "worker_availability" in _stripped or "--agent-state-dir" in _stripped or "exit_code" in _stripped:
                continue
            if _stripped.startswith("/") or _stripped.startswith("--"):
                if "cluster_scheduler" in _stripped or "--scheduler-log" in _stripped or "--operation-id" in _stripped or "worker_availability" in _stripped or "--agent-state-dir" in _stripped or "exit_code" in _stripped:
                    continue
            _effective += len(_stripped.encode("utf-8")) + 1
        return _effective
    except Exception:
        try:
            return os.path.getsize(log_path) if log_path and os.path.isfile(log_path) else 0
        except Exception:
            return 0

def _tmux_raw_log_size(log_path):
    try:
        return os.path.getsize(log_path) if log_path and os.path.isfile(log_path) else 0
    except Exception:
        return 0

def _is_noise_line(line):
    try:
        _s = line.strip()
        if not _s:
            return True
        if "Traceback" in _s or "Error" in _s or "Exception" in _s:
            return False
        # 保留关键错误行：Killed/OOM/signal/exit code 等强制非噪声（P0-1）
        if re.search(r"Killed|OOM|out of memory|signal|Segfault|CUDA|NCCL|exit code|exit_code|killed|took too long|timeout", _s, re.IGNORECASE):
            return False
        _prompt = re.match(r"^\([^)]+\)\s*[^$#]*[$#]\s*", _s)
        if _prompt:
            _s = _s[_prompt.end():].strip()
            if not _s:
                return True
            if "Traceback" in _s or "Error" in _s or "Exception" in _s:
                return False
        if "conda activate" in _s:
            return True
        if _s.startswith("[pipe-pane"):
            return True
        if _s.startswith("export "):
            return True
        if "SIMPLE_TMUX_READY" in _s:
            return True
        if "SIMPLE_EXPERIMENT_" in _s:
            return True
        if "printf '%s'" in _s or 'printf "%s"' in _s:
            return True
        if _s.startswith("printf") and ("exit_code" in _s or "$?" in _s):
            return True
        # 白名单：含关键调度错误的行不视为噪声，避免调度启动失败被清零（P0-3）
        if "调度器启动失败" in _s or "目前无空卡" in _s or "排队等待中" in _s:
            return False
        # passive_interrupt 重入队为主动重试非致命，必须视为有效进展，禁止判噪声
        if "passive_interrupt_requeue" in _s or "passive_interrupted" in _s:
            return False
        if re.search(r"passive_interrupt", _s, re.I):
            return False
        if "cluster_scheduler" in _s or "--scheduler-log" in _s or "--operation-id" in _s or "worker_availability" in _s or "--agent-state-dir" in _s or "exit_code" in _s:
            return True
        if _s.startswith("/") or _s.startswith("--"):
            if "调度器启动失败" in _s or "目前无空卡" in _s or "排队等待中" in _s:
                return False
            if "cluster_scheduler" in _s or "--scheduler-log" in _s or "--operation-id" in _s or "worker_availability" in _s or "--agent-state-dir" in _s or "exit_code" in _s:
                return True
        if "cd " in _s and "/data" in _s and "experiment" not in _s.lower():
            return True
        if _s == "/":
            return True
        return False
    except Exception:
        return False

# L3 调度有效尾（复用 L1/L2 预算思想）：16KB 截断后取末 150 行→噪声过滤→保留 50 行，确保调度错误/程序首错不被截断，需与 LIVE/AUDIT 预算分层一致
def _read_effective_tail(path, max_bytes=16*1024):
    try:
        if not path or not os.path.isfile(path):
            return "", 0, ""
        _st = os.stat(path)
        with open(path, "rb") as _h:
            _h.seek(max(0, _st.st_size - max_bytes))
            _raw = _h.read()
        _txt = _raw.decode("utf-8", errors="replace")
        _tail_150 = _txt.splitlines()[-150:]
        _joined = "\n".join(_tail_150)
        _t4000 = _joined[-4000:] if _joined else ""
        _filtered = [_l for _l in _t4000.splitlines() if _l.strip() and not _is_noise_line(_l)]
        _eff_tail = ("\n".join(_filtered[-50:]) + ("\n" if _filtered[-50:] else "")) if _filtered else ""
        _cnt = len([_l for _l in _eff_tail.splitlines() if _l.strip()]) if _eff_tail else 0
        _upd = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_st.st_mtime))
        return _eff_tail, _cnt, _upd
    except Exception:
        return "", 0, ""

def _tmux_capture_tail(session, env, max_lines=50):
    try:
        r = subprocess.run(["tmux", "capture-pane", "-p", "-S", f"-{max_lines}", "-t", session], capture_output=True, text=True, timeout=5, env=env)
        lines = (r.stdout or "").splitlines()[-max_lines:]
        return "\n".join(lines)
    except Exception:
        return ""

def _tmux_pane_python_running(session, env):
    # Return True when a python process running cluster_scheduler is a descendant of
    # the pane shell. Used by wait_scheduler to distinguish a genuinely running
    # scheduler from a tmux shell that is alive but never launched the command.
    pane_pid = tmux_pane_pid(session, None, env)
    if not pane_pid:
        return False
    try:
        out = subprocess.run(["ps", "-eo", "pid,ppid,comm,args"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return False
    procs = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 3)
        if len(parts) >= 4:
            try:
                procs.append((int(parts[0]), int(parts[1]), parts[2], parts[3]))
            except ValueError:
                continue
    by_pid = {p[0]: p for p in procs}

    def reachable(pid):
        seen = set()
        while pid and pid != 1 and pid not in seen:
            seen.add(pid)
            if pid == pane_pid:
                return True
            parent = by_pid.get(pid)
            if not parent:
                return False
            pid = parent[1]
        return False

    for pid, ppid, comm, args_line in procs:
        if "python" in comm and "cluster_scheduler" in args_line and reachable(pid):
            return True
    return False

def _is_main_shell_target(session):
    # 围栏：禁止重型调度指令落在主 shell simple1:0.0 / zlk1:0.0（兼容历史前缀，调度应仅在 <prefix>-sch-* / <prefix>-gpu-* / <prefix>-worker-*-agent）
    try:
        s = str(session or "").strip()
        if not s:
            return True
        # 严格匹配主 shell 及其变体：simple1:0.0 / zlk1:0.0 / 0.0 / :0.0
        if s in ("simple1:0.0", "zlk1:0.0") or s.endswith(":0.0") and not ("-sch-" in s or "-gpu-" in s or "-agent" in s):
            # 额外：任何以 simple1/zlk1 开头且无 -sch/-gpu/-agent 的均视为主 shell（兼容历史）
            if s.startswith("simple1") or s.startswith("zlk1"):
                return True
            if s == "0.0" or s.endswith(":0.0"):
                return True
        if s in ("simple1:0.0", "simple1:0", "zlk1:0.0", "zlk1:0", "0.0", "0"):
            return True
    except Exception:
        pass
    return False

def _is_heavy_scheduler_line(line):
    try:
        l = str(line or "")
        # 重型命令特征：cd /data、conda activate、SIMPLE_TMUX_READY、cluster_scheduler、printf exit_code
        if "cluster_scheduler" in l or "SIMPLE_TMUX_READY" in l or "SIMPLE_EXPERIMENT_TMUX" in l or "SIMPLE_EXPERIMENT_EXIT_CODE" in l:
            return True
        if "conda activate" in l and "SIMPLE_EXPERIMENT" in l or "conda activate" in l and "cluster_scheduler" in l:
            return True
        if "conda activate" in l:
            return True
        if l.strip().startswith("cd ") and "/data" in l:
            return True
        if "printf" in l and "exit_code" in l:
            return True
    except Exception:
        pass
    return False

def _is_bootstrap_tmux_line(line):
    try:
        l = str(line or "").strip().lower()
        if not l:
            return False
        # 建窗/控窗指令：允许在主 shell (zlk1:0.0/simple1:0.0) 上执行，不属于重型调度
        if "tmux new-session" in l or "tmux new -s" in l or "tmux new-window" in l or "tmux kill-session" in l or "tmux kill-window" in l or "tmux kill-pane" in l or "tmux split-window" in l:
            return True
        # agent 管理窗模拟键入：tmux send-keys 透传 kill-window/new/split 等控窗指令同样放行
        if "tmux send-keys" in l:
            return True
        if l.startswith("tmux ") and ("new" in l or "kill" in l or "split" in l):
            return True
    except Exception:
        pass
    return False

def _fallback_bootstrap_via_main_shell(session, shell_cmd, cwd, env, log_path):
    # 宽松建窗 fallback：在主 shell (zlk1:0.0) 上人工发送 tmux 建窗指令，不阻断调度
    candidates = ["zlk1:0.0", "simple1:0.0", "0.0"]
    shell_part = " ".join(shlex.quote(s) for s in (shell_cmd or [])) if shell_cmd else ""
    base_cmd = f"tmux new-session -d -s {shlex.quote(str(session))}"
    if shell_part:
        base_cmd = base_cmd + " " + shell_part
    # cd 到正确目录后再建窗，避免 cwd 丢失
    if cwd:
        bootstrap_line = f"cd {shlex.quote(str(cwd))} && {base_cmd}"
    else:
        bootstrap_line = base_cmd
    last_err = ""
    for target in candidates:
        try:
            proc = subprocess.run(["tmux", "send-keys", "-t", target, bootstrap_line, "Enter"], capture_output=True, text=True, timeout=5, env=env)
            if proc.returncode == 0:
                msg = f"[fallback] bootstrap tmux new-session via main shell {target!r} for {session!r}: {bootstrap_line!r}"
                print(msg, file=sys.stderr, flush=True)
                try:
                    if log_path:
                        os.makedirs(os.path.dirname(str(log_path)) or ".", exist_ok=True)
                        with open(str(log_path), "a", encoding="utf-8") as _lf:
                            _lf.write(f"[{now_iso()}] FALLBACK bootstrap via {target}: {bootstrap_line}\n")
                except Exception:
                    pass
                # 新建窗口后等待 5秒让 bashrc 执行完毕（统一 5秒规则，fallback 路径亦如此）
                time.sleep(5)
                # 验证 session 是否已创建
                if tmux_session_alive(session, cwd, env):
                    return True
                # 再等待一次 readiness
                try:
                    if _wait_tmux_ready(session, env, timeout=10.0, poll=0.3, cwd=cwd):
                        return True
                except Exception:
                    pass
                # 即使 readiness 未完全通过，若 session 已存在也视为 fallback 成功（后续 send-keys 会重试）
                if tmux_session_alive(session, cwd, env):
                    return True
            else:
                last_err = f"target={target!r} rc={proc.returncode} stderr={_truncate_text(proc.stderr, 500)!r}"
                print(f"[warn] fallback bootstrap via {target!r} failed for {session!r}: {last_err}", file=sys.stderr, flush=True)
        except Exception as exc:
            last_err = f"target={target!r} exc={exc!r}"
            print(f"[warn] fallback bootstrap exception via {target!r} for {session!r}: {exc!r}", file=sys.stderr, flush=True)
    # 直接 shell 执行兜底（非 tmux 终端，人工发送语义）：直接执行 tmux new-session 建窗
    try:
        proc2 = subprocess.run(base_cmd, shell=True, cwd=cwd or None, capture_output=True, text=True, timeout=10, env=env)
        if proc2.returncode == 0 and tmux_session_alive(session, cwd, env):
            print(f"[fallback] direct shell bootstrap success for {session!r}: {base_cmd!r}", file=sys.stderr, flush=True)
            try:
                if log_path:
                    with open(str(log_path), "a", encoding="utf-8") as _lf2:
                        _lf2.write(f"[{now_iso()}] FALLBACK direct shell bootstrap: {base_cmd} rc=0\n")
            except Exception:
                pass
            return True
        else:
            print(f"[warn] direct shell bootstrap failed for {session!r} rc={getattr(proc2, 'returncode', '?')} stderr={_truncate_text(getattr(proc2, 'stderr', ''), 500)!r}", file=sys.stderr, flush=True)
    except Exception as exc:
        print(f"[warn] direct shell bootstrap exception for {session!r}: {exc!r}", file=sys.stderr, flush=True)
    print(f"[warn] all fallback bootstrap paths failed for {session!r} last_err={last_err!r}", file=sys.stderr, flush=True)
    return False

def _popen_fallback_launch(args, cwd, env, log_path, exit_code_path):
    # Popen 兜底：不依赖 tmux，直接启动调度命令，不阻断调度
    try:
        if log_path:
            os.makedirs(os.path.dirname(str(log_path)) or ".", exist_ok=True)
        log_file = open(str(log_path), "a", encoding="utf-8") if log_path else None
        # 确保 exit_code 目录存在
        if exit_code_path:
            try:
                _d = os.path.dirname(str(exit_code_path))
                if _d:
                    os.makedirs(_d, exist_ok=True)
            except Exception:
                pass
        # 构造带 exit_code 回写的 shell 命令（与 tmux 路径一致）
        cmd_str = shlex.join([str(x) for x in args])
        if exit_code_path:
            cmd_str = cmd_str + "; printf '%s' \"$?\" > " + shlex.quote(str(exit_code_path))
        proc = subprocess.Popen(cmd_str, shell=True, cwd=str(cwd) if cwd else None, env=env, stdout=log_file or subprocess.DEVNULL, stderr=subprocess.STDOUT, preexec_fn=os.setsid if hasattr(os, "setsid") else None)
        pid = int(getattr(proc, "pid", 0) or 0)
        print(f"[fallback] Popen launch success pid={pid} cmd={_truncate_text(cmd_str, 400)!r}", file=sys.stderr, flush=True)
        try:
            if log_path:
                with open(str(log_path), "a", encoding="utf-8") as _lf:
                    _lf.write(f"[{now_iso()}] FALLBACK Popen launch pid={pid} cmd={_truncate_text(cmd_str, 500)}\n")
        except Exception:
            pass
        return pid
    except Exception as exc:
        print(f"[warn] Popen fallback failed: {exc!r}", file=sys.stderr, flush=True)
        try:
            if log_path:
                with open(str(log_path), "a", encoding="utf-8") as _lf:
                    _lf.write(f"[{now_iso()}] FALLBACK Popen failed: {exc!r}\n")
        except Exception:
            pass
        return 0

def _truncate_text(value, limit=2000):
    try:
        s = str(value or "")
        if len(s) > limit:
            return s[:limit] + f"...[truncated {len(s)-limit} chars, total {len(s)}]"
        return s
    except Exception:
        return ""

def _tmux_ls_snapshot(env, timeout=3):
    try:
        r = subprocess.run(["tmux", "ls"], capture_output=True, text=True, timeout=timeout, env=env)
        out = (r.stdout or "")[:1500]
        err = (r.stderr or "")[:500]
        if out or err:
            return (out + ("\n[stderr] " + err if err else "")).strip()[:2000]
        return f"tmux ls rc={r.returncode}"
    except Exception as exc:
        return f"tmux ls unavailable: {exc!r}"

def _build_tmux_error_context(session, returncode=None, stderr="", stdout="", cwd="", attempts=1, env=None, last_capture=""):
    try:
        stderr_t = _truncate_text(stderr, 2000)
        stdout_t = _truncate_text(stdout, 2000)
        cwd_s = str(cwd or "") or "(cwd empty)"
        snapshot = _tmux_ls_snapshot(env)
        env_keys = ""
        try:
            if isinstance(env, dict):
                env_keys = ",".join(sorted(k for k in env.keys() if k.startswith("SIMPLE_") or k in ("CUDA_VISIBLE_DEVICES", "CONDA_DEFAULT_ENV", "WORK_DIR")))[:500]
        except Exception:
            env_keys = ""
        last_cap_t = _truncate_text(last_capture, 2000) if last_capture else ""
        parts = [f"session={session!r}", f"returncode={returncode}", f"cwd={cwd_s!r}", f"attempts={attempts}", f"stderr={stderr_t!r}", f"stdout={stdout_t!r}", f"last_capture={last_cap_t!r}", f"env_keys={env_keys!r}", f"tmux_ls={snapshot!r}"]
        return "; ".join(parts)
    except Exception as exc:
        return f"session={session!r} rc={returncode} build_context_failed={exc!r} last_capture={_truncate_text(last_capture, 2000)!r}"

def _wait_tmux_ready(session, env, timeout=60.0, poll=0.3, cwd=""):
    # 围栏：禁止在主 shell 上执行 readiness 探针（应仅在 tmux 子窗口）
    if _is_main_shell_target(session):
        raise RuntimeError(f"refusing to probe tmux readiness on main shell target {session!r}; must be simple-sch-*/simple-gpu-*/simple-worker-*-agent")
    # cwd 存在性校验：若 cwd 不存在直接抛错带路径（避免 bash -l 在不存在目录起慢或静默失败）
    _cwd_to_check = str(cwd or "")
    if _cwd_to_check:
        try:
            if not os.path.isdir(_cwd_to_check):
                raise RuntimeError(f"tmux _wait_tmux_ready cwd not exists for {session!r}; cwd={_cwd_to_check!r}; refusing to continue scheduling")
        except RuntimeError:
            raise
        except Exception as exc:
            print(f"[warn] tmux _wait_tmux_ready cwd check exception for {session!r} cwd={_cwd_to_check!r}: {exc!r}", file=sys.stderr, flush=True)
    # Confirm the tmux pane shell is ready to accept keystrokes: echo a unique marker
    # and wait until it shows up in capture-pane. Avoids the startup race where the
    # first send-keys is dropped because the login shell has not reached its prompt.
    marker = "SIMPLE_TMUX_READY_%d" % int(time.time())
    # 初始化排障上下文：每次 capture-pane 的 stdout/stderr/last output 均捕获，失败时带入 RuntimeError
    _wait_tmux_ready.last_capture = ""
    _wait_tmux_ready.last_stderr = ""
    _wait_tmux_ready.last_stdout = ""
    _wait_tmux_ready.last_rc = None
    _wait_tmux_ready.consecutive_timeouts = 0
    last_capture = ""
    last_stderr = ""
    last_stdout = ""
    last_rc = None
    consecutive_timeouts = 0
    # send-keys marker 增加重试 2 次（共 3 次尝试），避免单次丢键导致 readiness 误判；失败记录 warning
    _sent = False
    last_send_err = ""
    for _attempt in range(3):
        try:
            _proc = subprocess.run(["tmux", "send-keys", "-t", session, "printf '\\n%s\\n' " + shlex.quote(marker), "Enter"], capture_output=True, text=True, timeout=5, env=env)
            if _proc.returncode == 0:
                _sent = True
                break
            else:
                last_send_err = f"rc={_proc.returncode} stderr={_truncate_text(_proc.stderr, 500)!r} stdout={_truncate_text(_proc.stdout, 500)!r}"
                print(f"[warn] tmux send-keys attempt {_attempt+1}/3 failed for {session!r} marker {marker!r}: {last_send_err}", file=sys.stderr, flush=True)
        except Exception as exc:
            last_send_err = f"exception {exc!r}"
            print(f"[warn] tmux send-keys attempt {_attempt+1}/3 exception for {session!r}: {exc!r}", file=sys.stderr, flush=True)
        time.sleep(0.3 * (_attempt + 1))
    if not _sent:
        _wait_tmux_ready.last_stderr = last_send_err
        _wait_tmux_ready.last_capture = last_capture
        _wait_tmux_ready.last_stdout = last_stdout
        _wait_tmux_ready.last_rc = -1
        print(f"[warn] tmux send-keys failed after 3 attempts for {session!r} marker {marker!r} last_err={last_send_err!r}", file=sys.stderr, flush=True)
        return False
    deadline = time.time() + timeout
    poll_interval = poll
    poll_count = 0
    while time.time() < deadline:
        poll_count += 1
        try:
            r = subprocess.run(["tmux", "capture-pane", "-p", "-S", "-100", "-t", session], capture_output=True, text=True, timeout=3, env=env)
            last_capture = r.stdout or ""
            last_stderr = r.stderr or ""
            last_stdout = r.stdout or ""
            last_rc = r.returncode
            _wait_tmux_ready.last_capture = last_capture
            _wait_tmux_ready.last_stderr = last_stderr
            _wait_tmux_ready.last_stdout = last_stdout
            _wait_tmux_ready.last_rc = last_rc
            _wait_tmux_ready.consecutive_timeouts = consecutive_timeouts
            if marker in (r.stdout or ""):
                if consecutive_timeouts:
                    print(f"[info] tmux _wait_tmux_ready recovered after {consecutive_timeouts} timeouts for {session!r}", file=sys.stderr, flush=True)
                print(f"[info] tmux _wait_tmux_ready success for {session!r} after {poll_count} polls marker {marker!r} last_capture_len={len(last_capture)}", file=sys.stderr, flush=True)
                consecutive_timeouts = 0
                return True
            if poll_count == 1 or poll_count % 10 == 0:
                print(f"[info] tmux _wait_tmux_ready polling {session!r} attempt {poll_count} marker not yet visible last_capture_len={len(last_capture)} last_rc={last_rc}", file=sys.stderr, flush=True)
            consecutive_timeouts = 0
            _wait_tmux_ready.consecutive_timeouts = consecutive_timeouts
            poll_interval = poll
        except subprocess.TimeoutExpired as exc:
            consecutive_timeouts += 1
            last_stderr = f"TimeoutExpired after 3s: {exc!r}"
            _wait_tmux_ready.last_stderr = last_stderr
            _wait_tmux_ready.last_capture = last_capture
            _wait_tmux_ready.consecutive_timeouts = consecutive_timeouts
            print(f"[warn] tmux capture-pane timeout {consecutive_timeouts} for {session!r}: {exc!r} last_capture={_truncate_text(last_capture, 200)!r}", file=sys.stderr, flush=True)
            if consecutive_timeouts >= 5:
                poll_interval = poll * 2
                print(f"[warn] tmux capture-pane consecutive timeout {consecutive_timeouts} for {session!r}, extending poll to {poll_interval}s", file=sys.stderr, flush=True)
            else:
                poll_interval = poll
            time.sleep(poll_interval)
            continue
        except Exception as exc:
            consecutive_timeouts += 1
            last_stderr = f"{exc!r}"
            _wait_tmux_ready.last_stderr = last_stderr
            _wait_tmux_ready.last_capture = last_capture
            _wait_tmux_ready.consecutive_timeouts = consecutive_timeouts
            print(f"[warn] tmux capture-pane exception for {session!r}: {exc!r} last_capture={_truncate_text(last_capture, 200)!r} last_stderr={_truncate_text(last_stderr, 200)!r}", file=sys.stderr, flush=True)
            if consecutive_timeouts >= 5:
                poll_interval = poll * 2
                print(f"[warn] tmux capture-pane consecutive exception {consecutive_timeouts} for {session!r}, extending poll to {poll_interval}s", file=sys.stderr, flush=True)
            else:
                poll_interval = poll
            time.sleep(poll_interval)
            continue
        time.sleep(poll_interval)
    _wait_tmux_ready.last_capture = last_capture
    _wait_tmux_ready.last_stderr = last_stderr
    _wait_tmux_ready.last_stdout = last_stdout
    _wait_tmux_ready.last_rc = last_rc
    _wait_tmux_ready.consecutive_timeouts = consecutive_timeouts
    print(f"[warn] tmux _wait_tmux_ready timeout after {timeout}s for {session!r} marker {marker!r} polls={poll_count} last_capture={_truncate_text(last_capture, 500)!r} last_stderr={_truncate_text(last_stderr, 500)!r} consecutive_timeouts={consecutive_timeouts}", file=sys.stderr, flush=True)
    return False

def _send_tmux_line(session, line, env, retries=3):
    # 围栏：仅重型调度指令禁止落在主 shell；建窗/控窗类 tmux 指令允许在 zlk1:0.0/simple1:0.0 上执行（人工发送语义）
    if _is_main_shell_target(session) and _is_heavy_scheduler_line(line) and not _is_bootstrap_tmux_line(line):
        raise RuntimeError(f"refusing heavy scheduler line on main shell target {session!r}: {str(line)[:120]!r}")
    # 建窗类 tmux 指令在主 shell 上直接放行（用户接受在 zlk1:0.0 上执行建窗/进窗）
    if _is_main_shell_target(session) and _is_bootstrap_tmux_line(line):
        pass
    # Send one line via tmux send-keys, validating the return code and retrying on
    # transient failures. Returns the last return code (0 == success).
    last_rc = 1
    for attempt in range(1, retries + 1):
        try:
            proc = subprocess.run(["tmux", "send-keys", "-t", session, line, "Enter"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, env=env)
            last_rc = proc.returncode
            if last_rc == 0:
                return 0
        except Exception:
            last_rc = -1
        time.sleep(0.3 * attempt)
    return last_rc

def start_simple_tmux_command(session, args, cwd, log_path, env, exit_code_path=None):
    # Simulate a human operator: open a detached tmux session (login shell so conda/profile
    # is available), mirror the pane to a log file (screen + log), then type 'conda activate',
    # 'cd', and finally the command. No nested 'bash -lc' quoting, no process substitution.
    # Never destroy an earlier task's terminal while starting a new one.
    if tmux_session_alive(session, cwd, env):
        raise RuntimeError(f"tmux session already exists: {session}")
    shell = os.environ.get("SHELL") or ("/bin/bash" if os.path.isfile("/bin/bash") else "/bin/sh")
    # 宽松建窗：不再强制 bash -l，让 tmux 使用 default-shell，避免 .bashrc 加载慢/失败导致建窗超时
    shell_cmd = [shell]
    # 显式不追加 "-l"，tmux 将使用 default-shell；若需登录 shell 由用户 tmux.conf 决定
    if log_path:
        parent = os.path.dirname(str(log_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
    # A reusable pending marker makes stale completion state non-authoritative without
    # accumulating one temporary file per launch or deleting prior evidence.
    if exit_code_path:
        write_atomic_text(str(exit_code_path), "pending\n")
    # 围栏：显式拒绝主 shell target 作为 session（仅针对调度类 session 名，建窗指令本身可在主 shell 执行）
    if _is_main_shell_target(session):
        raise RuntimeError(f"refusing to create tmux session on main shell target {session!r}; must be simple-sch-*/simple-gpu-*/simple-worker-*-agent; " + _build_tmux_error_context(session, None, "", "", cwd, 1, env))
    proc = subprocess.run(["tmux", "new-session", "-d", "-s", session] + shell_cmd, cwd=cwd, capture_output=True, text=True, env=env, timeout=20)
    if proc.returncode != 0:
        err = (proc.stderr or "") + (proc.stdout or "")
        # A duplicate may belong to a failed run whose console must be retained.
        low = err.lower()
        ctx = _build_tmux_error_context(session, proc.returncode, proc.stderr, proc.stdout, cwd, 1, env)
        raise RuntimeError(f"tmux new-session failed rc={proc.returncode} stderr={_truncate_text(err, 2000)!r} for {session!r}; cwd={str(cwd)!r}; attempts=1; {ctx}")
    # 新建窗口后等待 5秒让 bashrc 相关脚本执行完毕，再发送 conda 激活等指令（统一 5秒规则）
    time.sleep(5)
    # 日志直显 tmux 窗口：不再 pipe-pane tee，日志直接输出到 pane；log_path 仅用于 info 备份（FileHandler）
    if log_path:
        try:
            os.makedirs(os.path.dirname(str(log_path)) or ".", exist_ok=True)
        except Exception:
            pass
    conda_env = simple_conda_env_name(env)
    lines = []
    if conda_env:
        lines.append("conda activate " + shlex.quote(conda_env))
    if cwd:
        lines.append("cd " + shlex.quote(str(cwd)))
    # tmux does not forward arbitrary env vars into the session shell, so export the
    # session/log dir explicitly. The scheduler (run_job) reads these to publish the
    # experiment output_dir sidecar used by the split-pane log mirror.
    if env.get("SIMPLE_EXPERIMENT_TMUX_SESSION") and env.get("SIMPLE_EXPERIMENT_TMUX_LOG_DIR"):
        lines.append("export SIMPLE_EXPERIMENT_TMUX_SESSION=" + shlex.quote(str(env.get("SIMPLE_EXPERIMENT_TMUX_SESSION"))))
        lines.append("export SIMPLE_EXPERIMENT_TMUX_LOG_DIR=" + shlex.quote(str(env.get("SIMPLE_EXPERIMENT_TMUX_LOG_DIR"))))
    # Forward the exit-code path so the launched --run-job writes it from Python too (belt-and-suspenders
    # completion signal that does not depend on the trailing shell 'printf' surviving tmux send-keys).
    if env.get("SIMPLE_EXPERIMENT_EXIT_CODE_PATH"):
        lines.append("export SIMPLE_EXPERIMENT_EXIT_CODE_PATH=" + shlex.quote(str(env.get("SIMPLE_EXPERIMENT_EXIT_CODE_PATH"))))
    if env.get("SIMPLE_EXPERIMENT_MANAGED_JOB"):
        lines.append("export SIMPLE_EXPERIMENT_MANAGED_JOB=1")
    if env.get("SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS"):
        lines.append("export SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS=1")
    # The command below appends its rc via '; printf "%s" "$?" > exit_code_path'. That redirect
    # fails (and the completion signal is lost forever) if the parent dir does not exist, which
    # would leave the scheduler waiting on a never-written file while the session stays alive.
    # Always create the directory up front so the exit-code file is reliably written.
    if exit_code_path:
        try:
            _ec_dir = os.path.dirname(str(exit_code_path))
            if _ec_dir:
                os.makedirs(_ec_dir, exist_ok=True)
        except Exception:
            pass
    command = shlex.join([str(item) for item in args])
    if exit_code_path:
        command = command + "; printf '%s' \"$?\" > " + shlex.quote(str(exit_code_path))
    lines.append(command)
    # Forward critical env vars directly into the tmux session environment so the
    # launched scheduler sees them even if a later send-keys line is dropped by the
    # startup race. This complements the export lines above (belt-and-suspenders).
    for _key in ("SIMPLE_EXPERIMENT_TMUX_SESSION", "SIMPLE_EXPERIMENT_TMUX_LOG_DIR", "SIMPLE_EXPERIMENT_EXIT_CODE_PATH", "SIMPLE_EXPERIMENT_MANAGED_JOB", "SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS", "SIMPLE_EXPERIMENT_CONDA_ENV", "CUDA_VISIBLE_DEVICES"):
        _val = env.get(_key)
        if _val:
            try:
                subprocess.run(["tmux", "set-environment", "-t", session, _key, str(_val)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, env=env)
            except Exception:
                pass
    # cwd 存在性校验（前置）：若 cwd 不存在直接抛错带路径，避免高负载下 bash -l 慢启与 capture 超时静默
    if cwd:
        try:
            if not os.path.isdir(str(cwd)):
                ctx_cwd = _build_tmux_error_context(session, None, f"cwd not exists: {str(cwd)!r}", "", cwd, 1, env, last_capture="")
                raise RuntimeError(f"tmux _wait_tmux_ready cwd not exists for {session!r}; cwd={str(cwd)!r}; {ctx_cwd}; refusing to continue scheduling")
        except RuntimeError:
            raise
        except Exception as exc:
            print(f"[warn] cwd existence check failed for {session!r} cwd={str(cwd)!r}: {exc!r}", file=sys.stderr, flush=True)
    # Wait until the pane shell is actually ready to accept keystrokes. 宽松建窗：超时不直接阻断调度，降级 fallback
    _wait_ok = False
    _wait_exc_info = None
    try:
        _wait_ok = _wait_tmux_ready(session, env, timeout=60.0, poll=0.3, cwd=cwd)
    except RuntimeError as _wait_exc:
        _wait_exc_info = _wait_exc
        print(f"[warn] tmux _wait_tmux_ready exception for {session!r}: {_wait_exc!r}, attempting fallback via main shell", file=sys.stderr, flush=True)
        _wait_ok = False
    if not _wait_ok:
        _last_cap = getattr(_wait_tmux_ready, "last_capture", "")
        _last_err = getattr(_wait_tmux_ready, "last_stderr", "")
        _last_out = getattr(_wait_tmux_ready, "last_stdout", "")
        _last_rc = getattr(_wait_tmux_ready, "last_rc", None)
        _combined_stderr = _last_err or _truncate_text(_last_cap, 2000)
        _combined_stdout = _last_out or _truncate_text(_last_cap, 2000)
        ctx = _build_tmux_error_context(session, _last_rc, _combined_stderr, _combined_stdout, cwd, 1, env, last_capture=_last_cap)
        print(f"[warn] tmux _wait_tmux_ready timeout/failed for {session!r}; cwd={str(cwd)!r}; last_capture={_truncate_text(_last_cap, 500)!r}; {ctx}; attempting fallback bootstrap via zlk1:0.0", file=sys.stderr, flush=True)
        try:
            if log_path:
                with open(str(log_path), "a", encoding="utf-8") as _lf:
                    _lf.write(f"[{now_iso()}] WARN _wait_tmux_ready failed for {session!r}, fallback via main shell; {ctx}\n")
        except Exception:
            pass
        # 尝试在主 shell (zlk1:0.0) 上人工发送 tmux new-session 建窗，不阻断调度
        _fallback_ok = _fallback_bootstrap_via_main_shell(session, shell_cmd, cwd, env, log_path)
        if _fallback_ok:
            print(f"[info] fallback bootstrap succeeded for {session!r}, retrying _wait_tmux_ready", file=sys.stderr, flush=True)
            try:
                _wait_ok = _wait_tmux_ready(session, env, timeout=15.0, poll=0.3, cwd=cwd)
            except Exception as _re_exc:
                print(f"[warn] retry _wait_tmux_ready after fallback failed for {session!r}: {_re_exc!r}", file=sys.stderr, flush=True)
                _wait_ok = tmux_session_alive(session, cwd, env)
        if not _wait_ok:
            # 若 session 已存在但 readiness 未通过，仍尝试继续 send-keys（后续会重试），仅当 session 完全不存在时直接阻断
            if tmux_session_alive(session, cwd, env):
                print(f"[warn] _wait_tmux_ready still not ok but session alive for {session!r}, proceeding to send-keys with warn", file=sys.stderr, flush=True)
                try:
                    if log_path:
                        with open(str(log_path), "a", encoding="utf-8") as _lf:
                            _lf.write(f"[{now_iso()}] WARN _wait_tmux_ready not ok but session alive, proceeding to send-keys; fallback path used\n")
                except Exception:
                    pass
                _wait_ok = True
            else:
                # Session 仍不存在，直接阻断调度并抛出详细上下文（不再 Popen 兜底）
                print(f"[error] fallback bootstrap failed and session not alive for {session!r}, blocking task dispatch; {ctx}", file=sys.stderr, flush=True)
                try:
                    if log_path:
                        with open(str(log_path), "a", encoding="utf-8") as _lf:
                            _lf.write(f"[{now_iso()}] ERROR _wait_tmux_ready failed for {session!r}; {ctx}; blocking dispatch\n")
                except Exception:
                    pass
                if _wait_exc_info is not None:
                    raise RuntimeError(f"tmux _wait_tmux_ready failed for {session!r}; cwd={str(cwd)!r}; last_capture={_truncate_text(_last_cap, 2000)!r}; {ctx}; fallback via main shell failed; blocking task dispatch: {_wait_exc_info!r}") from _wait_exc_info
                raise RuntimeError(f"tmux _wait_tmux_ready timeout after 60.0s for {session!r}; cwd={str(cwd)!r}; last_capture={_truncate_text(_last_cap, 2000)!r}; {ctx}; fallback via main shell failed; blocking task dispatch")
    # Type each line, validating the send-keys return code. 宽松：失败先尝试 fallback 重建 session 并重发，仍失败则 Popen 兜底
    _send_failed_lines = []
    for line in lines:
        rc = _send_tmux_line(session, line, env)
        if rc != 0:
            print(f"[warn] tmux send-keys failed rc={rc} for {session!r} line={_truncate_text(line, 200)!r}, attempting retry via fallback", file=sys.stderr, flush=True)
            # 若 session 已死，尝试 fallback 重建
            if not tmux_session_alive(session, cwd, env):
                _fallback_ok2 = _fallback_bootstrap_via_main_shell(session, shell_cmd, cwd, env, log_path)
                if _fallback_ok2:
                    time.sleep(0.5)
                    rc = _send_tmux_line(session, line, env)
                    if rc == 0:
                        print(f"[info] retry send-keys after fallback succeeded for {session!r}", file=sys.stderr, flush=True)
                        continue
            _send_failed_lines.append((line, rc))
    if _send_failed_lines:
        print(f"[error] tmux send-keys failed for {len(_send_failed_lines)} lines for {session!r}, blocking task dispatch", file=sys.stderr, flush=True)
        try:
            if log_path:
                with open(str(log_path), "a", encoding="utf-8") as _lf:
                    _lf.write(f"[{now_iso()}] ERROR send-keys failed {len(_send_failed_lines)} lines for {session!r}; blocking dispatch\n")
                    for _fl, _rc in _send_failed_lines:
                        _lf.write(f"  failed line rc={_rc} line={_truncate_text(_fl, 300)!r}\n")
        except Exception:
            pass
        ctx = _build_tmux_error_context(session, _send_failed_lines[0][1], "", f"send-keys failed for line={_truncate_text(_send_failed_lines[0][0], 500)!r}", cwd, 1, env)
        raise RuntimeError(f"tmux send-keys failed rc={_send_failed_lines[0][1]} for {session!r}; line={_truncate_text(_send_failed_lines[0][0], 500)!r}; cwd={str(cwd)!r}; {ctx}; blocking task dispatch")
    # Mirror the experiment's stdout.log/stderr.log into a split pane so the operator can see
    # errors directly inside the tmux window (the scheduler/train output may be redirected to
    # those files by the project). Start at the current end to avoid replaying prior attempts.
    _sidecar_dir = env.get("SIMPLE_EXPERIMENT_TMUX_LOG_DIR") if isinstance(env, dict) else None
    if _sidecar_dir:
        _sidecar_path = os.path.join(str(_sidecar_dir), str(session) + ".output_dir")
        _watch = "bash -c " + shlex.quote(
            "while [ ! -f " + shlex.quote(str(_sidecar_path)) + " ]; do sleep 1; done; OD=$(cat " + shlex.quote(str(_sidecar_path)) + "); exec tail -n 0 -F \"$OD/stdout.log\" \"$OD/stderr.log\""
        )
        try:
            subprocess.run(["tmux", "split-window", "-t", str(session), "-v", "-l", "40%", _watch], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, env=env)
        except Exception:
            pass
    return tmux_pane_pid(session, cwd, env) or 0

def start_job_in_gpu_pane(gpu_window, args, cwd, env, log_path, exit_code_path):
    # Mark the command identity pending before publishing a pane; readers only accept
    # an integer exit code as completion, so a prior command's value cannot leak forward.
    write_atomic_text(str(exit_code_path), "pending\n")
    if not tmux_session_alive(gpu_window, cwd, env):
        shell = os.environ.get("SHELL") or ("/bin/bash" if os.path.isfile("/bin/bash") else "/bin/sh")
        # 宽松建窗：不强制 bash -l，与 start_simple_tmux_command 一致
        shell_cmd = [shell]
        proc_gs = subprocess.run(["tmux", "new-session", "-d", "-s", gpu_window] + shell_cmd, cwd=cwd, capture_output=True, text=True, env=env, timeout=20)
        if proc_gs.returncode != 0:
            err = (proc_gs.stderr or proc_gs.stdout or "")
            # Do not kill a duplicate session: it may contain failed-task logs.
            low_gs = (err or "").lower()
            attempts_gs = 1
            if proc_gs.returncode != 0:
                ctx = _build_tmux_error_context(gpu_window, proc_gs.returncode, proc_gs.stderr, proc_gs.stdout, cwd, attempts_gs, env)
                raise RuntimeError(f"tmux new-session failed for gpu_window {gpu_window!r} rc={proc_gs.returncode} stderr={_truncate_text(err, 2000)!r}; cwd={str(cwd)!r}; attempts={attempts_gs}; {ctx}; blocking task dispatch")
        # new-session 已同步创建 tmux 会话。任务由独立 split-window pane 运行，
        # 无须等待基础 shell 的 bashrc，也不向该 shell 发送训练命令。
    try:
        # 修复 GPU pane 无 conda：若 SIMPLE_EXPERIMENT_CONDA_ENV 是绝对路径且 $CONDA_ENV/bin/python 存在，则直接用该 python 和 PATH 包含 $CONDA_ENV/bin，不走 conda activate（兜底 conda 已清洗 PATH 的情况）
        _conda_env_name = simple_conda_env_name(env) if isinstance(env, dict) else ""
        _args_list = [str(x) for x in args]
        _conda_env_is_abs = bool(str(_conda_env_name or "").strip().startswith("/"))
        _direct_python = ""
        _direct_bin = ""
        _activation = "true"
        if _conda_env_is_abs:
            try:
                _ep = simple_conda_env_python(_conda_env_name)
                if _ep:
                    _direct_python = str(_ep).strip()
                    if _direct_python.endswith("/bin/python"):
                        _direct_bin = _direct_python[:-7]
                    else:
                        _clean_tmp = str(_conda_env_name).strip().rstrip("/\\")
                        if _clean_tmp.endswith("/bin/python"):
                            _direct_bin = __import__("os").path.dirname(_clean_tmp)
                            _direct_python = _clean_tmp
                        elif _clean_tmp.endswith("/bin"):
                            _direct_bin = _clean_tmp
                        else:
                            _direct_bin = _clean_tmp.rstrip("/") + "/bin"
                    if __import__("os").path.isfile(_direct_python) and __import__("os").access(_direct_python, __import__("os").X_OK):
                        if _args_list and _args_list[0] == "python":
                            _args_list[0] = _direct_python
                        _activation = f'export PATH={__import__("shlex").quote(_direct_bin)}:$PATH'
                    else:
                        if _args_list and _args_list[0] == "python" and _direct_python:
                            _args_list[0] = _direct_python
                        _direct_bin_q = __import__("shlex").quote(_direct_bin)
                        _direct_py_q = __import__("shlex").quote(_direct_python)
                        _orig_act = simple_conda_activation_script(env)
                        _activation = f'if [ -x {_direct_py_q} ]; then export PATH={_direct_bin_q}:$PATH; else {_orig_act}; fi'
                else:
                    _activation = simple_conda_activation_script(env)
            except Exception:
                _activation = simple_conda_activation_script(env) if _conda_env_name else "true"
        else:
            _activation = simple_conda_activation_script(env) if isinstance(env, dict) and _conda_env_name else "true"
            if _args_list and _args_list[0] == "python" and _conda_env_name:
                try:
                    _ep = simple_conda_env_python(_conda_env_name)
                    if _ep:
                        _args_list[0] = _ep
                except Exception:
                    pass
        _joined = __import__("shlex").join(_args_list)
        if _activation and _activation != "true":
            _inner = f"{_activation} && {_joined}"
        else:
            _inner = _joined
        # 实时日志 tee：stdout/stderr 同时输出到 TMUX pane（可见）与文件备份（log_path），exit_code 用 pipefail 保留
        _tee_log = __import__("shlex").quote(str(log_path))
        try:
            os.makedirs(os.path.dirname(str(log_path)) or ".", exist_ok=True)
        except Exception:
            pass
        _distributed_export = "export SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS=1; " if env.get("SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS") else ""
        _cmd = f"export SIMPLE_EXPERIMENT_MANAGED_JOB=1; {_distributed_export}set -o pipefail; {{ {_inner}; }} 2>&1 | tee -a {_tee_log}; printf '%s' \"$?\" > {__import__('shlex').quote(str(exit_code_path))}; exec bash"
        # Each task gets a separate window in the GPU session. A failed window
        # remains visible; later plans can launch another window on this GPU.
        window_name = "run-" + str(int(time.time() * 1000))
        split_args = ["tmux", "new-window", "-d", "-t", gpu_window, "-n", window_name, "-c", str(cwd or "."), "-P", "-F", "#{pane_id}", "--", "bash", "-c", _cmd]
        for split_attempt in range(3):
            result = subprocess.run(split_args, capture_output=True, text=True, timeout=10, cwd=cwd, env=env)
            if result.returncode == 0:
                break
            split_error = ((result.stderr or "") + " " + (result.stdout or "")).lower()
            if split_attempt >= 2 or not any(text in split_error for text in ("no such session", "can't find session", "can't find window")):
                break
            time.sleep(0.2)
        if result.returncode != 0:
            ctx_sw = _build_tmux_error_context(gpu_window, result.returncode, result.stderr, result.stdout, cwd, 1, env)
            raise RuntimeError(f"tmux new-window failed for {gpu_window!r} rc={result.returncode} stderr={_truncate_text(result.stderr, 2000)!r} stdout={_truncate_text(result.stdout, 2000)!r}; cwd={str(cwd)!r}; cmd={_truncate_text(_cmd, 800)!r}; {ctx_sw}; blocking task dispatch")
        pane_id = (result.stdout or "").strip().splitlines()[-1].strip() if result.stdout else ""
        if not pane_id or pane_id == gpu_window:
            # pane 进入失败视为调度器级错误：无 pane_id 则无法监控任务，必须阻止派发
            ctx_pane = _build_tmux_error_context(gpu_window, result.returncode, result.stderr, result.stdout, cwd, 1, env)
            raise RuntimeError(f"tmux split-window pane enter failed for {gpu_window!r}: pane_id missing or equals window (pane_id={pane_id!r}); cwd={str(cwd)!r}; stdout={_truncate_text(result.stdout, 1000)!r}; {ctx_pane}; blocking task dispatch")
        return pane_id or gpu_window
    except RuntimeError:
        raise
    except Exception as exc:
        ctx_exc = _build_tmux_error_context(gpu_window, None, str(exc), "", cwd, 1, env)
        raise RuntimeError(f"split-window failed for {gpu_window!r}: {exc!r}; cwd={str(cwd)!r}; {ctx_exc}; blocking task dispatch")

def _resolve_dynamic_gpu_ids(root):
    # 动态解析 worker 配置的 gpu_ids：优先 options/env/availableGpuIds，其次遍历 MANAGED GPU 窗口
    try:
        cuda = str(os.environ.get("CUDA_VISIBLE_DEVICES") or "").strip()
        if cuda:
            ids = [x.strip() for x in cuda.split(",") if x.strip() != ""]
            if ids:
                return ids
    except Exception:
        pass
    try:
        gp = read_json(path_for(root, "gpu_snapshot.json"), {})
        gpus = gp.get("gpus") or gp.get("gpu") or {}
        if isinstance(gpus, list) and gpus:
            ids = [str(g.get("index") if isinstance(g, dict) and g.get("index") is not None else g.get("id") if isinstance(g, dict) else str(g)) for g in gpus if isinstance(g, dict)]
            ids = [x for x in ids if x]
            if ids:
                return ids
        if isinstance(gpus, dict):
            for v in gpus.values():
                if isinstance(v, list) and v:
                    ids = [str(x.get("index") if isinstance(x, dict) and x.get("index") is not None else str(x.get("id") or x.get("gpu") or x) if isinstance(x, dict) else str(x)) for x in v]
                    ids = [x for x in ids if x]
                    if ids:
                        return ids
    except Exception:
        pass
    try:
        av = read_json(path_for(root, "worker_availability.json"), {})
        workers = av.get("workers") if isinstance(av, dict) else None
        if isinstance(workers, dict):
            for w in workers.values():
                if isinstance(w, dict):
                    ids = w.get("availableGpuIds") or w.get("gpuIds") or w.get("gpu_ids") or []
                    if ids:
                        return [str(x) for x in ids]
        if isinstance(av, list):
            for w in av:
                if isinstance(w, dict):
                    ids = w.get("availableGpuIds") or []
                    if ids:
                        return [str(x) for x in ids]
    except Exception:
        pass
    try:
        prefix_probe = _resolve_tmux_prefix(None, None, None)
        out = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True, timeout=3)
        if out.returncode == 0 and out.stdout:
            ids = []
            for name in (out.stdout or "").splitlines():
                if name.startswith(prefix_probe + "-gpu-"):
                    gid = name[len(prefix_probe + "-gpu-"):]
                    if gid:
                        ids.append(gid)
            if ids:
                return sorted(set(ids))
    except Exception:
        pass
    return ["0","1","2","3"]

def _safe_kill_pane(pane_id, gpu_window=None):
    # 任务完成后 pane 回收：tmux kill-pane -t pane_id，容错 pane_id==gpu_window；增加 pane_id 探活避免黑屏
    try:
        pid = str(pane_id or "").strip()
        gw = str(gpu_window or "").strip()
        if not pid:
            return
        if gw and pid == gw:
            return
        # 探活 pane_id 再 kill，避免误杀导致黑屏
        try:
            if subprocess.run(["tmux", "has-session", "-t", pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3).returncode != 0:
                return
        except Exception:
            pass
        subprocess.run(["tmux", "kill-pane", "-t", pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass

def start_gpu_log_tail_sampler(root, poll_seconds=60, jitter_seconds=30):
    interval = sampler_interval_seconds(poll_seconds, 60.0)
    def loop():
        while True:
            if not has_running_plan(root):
                time.sleep(30)
                continue
            try:
                prefix = _resolve_tmux_prefix(None, None, None)
                for gid in _resolve_dynamic_gpu_ids(root):
                    win = fixed_gpu_window_name(prefix, gid)
                    if not tmux_session_alive(win):
                        continue
                    cap = _tmux_capture_tail(win, None, 120)
                    if cap:
                        _safe_win = re.sub(r"[^A-Za-z0-9_.-]+", "-", win).strip("-") or win
                        for _live_key in (_safe_win, str(gid)):
                            try:
                                live_path = os.path.join(agent_dir(root), "live_output", f"{_live_key}.json")
                                os.makedirs(os.path.dirname(live_path), exist_ok=True)
                                atomic_write(live_path, {"gpu": gid, "window": win, "tmuxTarget": win, "tail": cap.splitlines()[-120:], "updatedAt": now_iso()})
                            except Exception:
                                pass
                        append_event(root, {"type": "log_tail", "payload": {"gpu": gid, "window": win, "tmuxTarget": win, "tail": cap[-4000:]}, "source": "gpu_log_sampler"})
            except Exception:
                pass
            import time as _tt, random as _rd
            _tt.sleep(interval + (_rd.random()*jitter_seconds if jitter_seconds else 0))
    import threading as _th
    _th.Thread(target=loop, daemon=True, name="gpu-log-tail-sampler").start()


def read_task_exit_code(exit_code_path):
    try:
        return int(str(pathlib.Path(exit_code_path).read_text(encoding="utf-8")).strip())
    except Exception:
        return 255


def exit_code_ready(path):
    # A task/scheduler command writes an integer rc when it finishes. In-progress markers,
    # empty files and partial writes are not completion evidence.
    try:
        if not os.path.isfile(path) or os.path.getsize(path) <= 0:
            return False
        value = pathlib.Path(path).read_text(encoding="utf-8").strip()
        return bool(re.fullmatch(r"-?\d+", value))
    except Exception:
        return False

def current_worker_task(root, task):
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        key = worker_task_snapshot_key(task)
        for item in reversed(tasks):
            if isinstance(item, dict) and worker_task_snapshot_key(item) == key:
                return item
    return {}

def worker_task_was_stopped(root, task):
    current = current_worker_task(root, task)
    return str(current.get("status") or "") == "stopped" or bool(current.get("manualStopType") or current.get("stopReason"))

def reconcile_worker_task_exit_codes(root):
    """Consume persisted exit codes without inferring completion from tmux state."""
    events = []
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        for task in tasks:
            if not isinstance(task, dict) or str(task.get("status") or "").lower() != "running":
                continue
            if task.get("manualStopType") or task.get("stopReason"):
                continue
            exit_rel = str(task.get("exitCodePath") or "").strip()
            if not exit_rel:
                continue
            try:
                exit_path = safe_project_path(root, exit_rel)
            except Exception:
                continue
            if not exit_code_ready(exit_path):
                continue
            exit_code = read_task_exit_code(exit_path)
            task["status"] = "completed" if exit_code == 0 else "failed"
            task["exitCode"] = exit_code
            task["finishedAt"] = now_iso()
            task["reconciledAt"] = task["finishedAt"]
            events.append(("worker_task_completed" if exit_code == 0 else "worker_task_failed", dict(task)))
        if events:
            atomic_write(path_for(root, "worker_task_snapshot.json"), {"schemaVersion": SCHEMA_VERSION, "tasks": retain_worker_task_snapshot(tasks), "generatedAt": now_iso()})
    for event_type, task in events:
        append_event(root, {"type": event_type, "workerId": task.get("workerId") or "", "operationId": task.get("commandId") or "", "payload": task})
    return {"changed": len(events)}

def reconcile_worker_tasks_after_restart(root, eligible_ids=None):
    """Recover terminal task state after the previous Agent's waiter threads disappear."""
    exit_result = reconcile_worker_task_exit_codes(root)
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
    missing_panes = set()
    for task in tasks:
        if not isinstance(task, dict) or str(task.get("status") or "").lower() != "running":
            continue
        if task.get("manualStopType") or task.get("stopReason"):
            continue
        if eligible_ids is not None and str(task.get("commandId") or "") not in eligible_ids:
            continue
        pane_id = str(task.get("pid") or "").strip()
        session = str(task.get("tmuxSession") or "").strip()
        if not re.fullmatch(r"%[0-9]+", pane_id) or not session:
            continue
        exit_rel = str(task.get("exitCodePath") or "").strip()
        if exit_rel:
            try:
                if exit_code_ready(safe_project_path(root, exit_rel)):
                    continue
            except Exception:
                pass
        try:
            pane = subprocess.run(["tmux", "display-message", "-p", "-t", pane_id, "#{session_name}"],
                                  capture_output=True, text=True, timeout=3, cwd=root)
        except Exception:
            continue  # Missing tmux service is not proof that the task exited.
        if pane.returncode != 0 or pane.stdout.strip() != session:
            missing_panes.add(worker_task_snapshot_key(task))
    events = []
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        for task in tasks:
            if not isinstance(task, dict) or worker_task_snapshot_key(task) not in missing_panes:
                continue
            if str(task.get("status") or "").lower() != "running" or task.get("manualStopType") or task.get("stopReason"):
                continue
            exit_rel = str(task.get("exitCodePath") or "").strip()
            if exit_rel:
                try:
                    if exit_code_ready(safe_project_path(root, exit_rel)):
                        continue
                except Exception:
                    pass
            task["status"] = "failed"
            task["error"] = "Agent 重启后未找到原任务 tmux pane，且没有完成退出码。"
            task["finishedAt"] = now_iso()
            task["reconciledAt"] = task["finishedAt"]
            events.append(("worker_task_failed", dict(task)))
        if events:
            atomic_write(path_for(root, "worker_task_snapshot.json"), {"schemaVersion": SCHEMA_VERSION, "tasks": retain_worker_task_snapshot(tasks), "generatedAt": now_iso()})
    for event_type, task in events:
        append_event(root, {"type": event_type, "workerId": task.get("workerId") or "", "operationId": task.get("commandId") or "", "payload": task})
    return {"changed": exit_result["changed"] + len(events)}

def worker_task_pane_presence(root, task):
    """A successful full inventory proves absence; a failed target lookup does not."""
    pane = str(task.get("tmuxPane") or "").strip()
    session = str(task.get("tmuxSession") or "").strip()
    if not re.fullmatch(r"%[0-9]+", pane) or not session:
        raise ValueError("任务缺少可信 tmux pane/session 身份")
    listed = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}"],
                            capture_output=True, text=True, timeout=3, cwd=root)
    if listed.returncode != 0:
        error = str(listed.stderr or "").strip()
        if error.lower().startswith("no server running on ") or error.lower() == "no sessions":
            return False
        raise RuntimeError("tmux 清单读取失败：" + (error[-500:] or str(listed.returncode)))
    sessions = []
    for line in str(listed.stdout or "").splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) != 2 or not re.fullmatch(r"%[0-9]+", fields[0]) or not fields[1]:
            raise ValueError("tmux 清单格式无效，不能确认窗口消失")
        if fields[0] == pane:
            sessions.append(fields[1])
    if not sessions:
        return False
    if session not in sessions:
        raise ValueError("tmux pane 所属会话与 job 身份不一致，未停止该窗格")
    return True

def close_worker_task_pane(root, task):
    try:
        if not worker_task_pane_presence(root, task):
            return {"paneClosed": True, "paneAlreadyMissing": True}
        pane = str(task["tmuxPane"])
        killed = subprocess.run(["tmux", "kill-pane", "-t", pane],
                                capture_output=True, text=True, timeout=5, cwd=root)
        # The task can exit between inventory and kill. Only a fresh absence proof
        # accepts that race; an error or timeout still leaves the job uncleared.
        if not worker_task_pane_presence(root, task):
            return {"paneClosed": True, "paneAlreadyMissing": False}
        error = str(killed.stderr or "").strip()[-500:]
        return {"paneClosed": False, "paneCloseError": error or "停止后 tmux pane 仍存在"}
    except Exception as exc:
        return {"paneClosed": False, "paneCloseError": str(exc)[-500:]}

def _execute_worker_command_unfenced(root, command, worker_id):
    action = str(command.get("action") or "").strip()
    command_id = str(command.get("commandId") or command.get("operationId") or f"cmd-{int(time.time() * 1000)}")
    append_event(root, {"type": "worker_command_started", "workerId": worker_id, "operationId": command_id, "payload": command})
    if action == "stop-worker-task" and command.get("requeueRequested") is True:
        try:
            result = requeue_durable_plan_job(root, command)
        except Exception as exc:
            result = {"commandId": command_id, "status": "failed", "durableReleased": False,
                      "message": str(exc), "stoppedPids": [], "stoppedTasks": []}
        if result is None:
            result = {"commandId": command_id, "status": "failed", "durableReleased": False,
                      "message": "requeue request requires targetCommandId", "stoppedPids": [], "stoppedTasks": []}
        result["stopCommandId"] = command_id
        result.setdefault("stoppedPids", [])
        result.setdefault("stoppedTasks", [])
        append_event(root, {"type": "worker_task_stopped", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    if action == "stop-worker-task":
        session = str(command.get("session") or command.get("runKey") or command.get("experimentId") or "").strip()
        target_command = str(command.get("targetCommandId") or command.get("commandIdTarget") or "").strip()
        own_command = str(command.get("commandId") or command.get("operationId") or "").strip()
        if own_command and own_command == target_command:
            result = {"commandId": command_id, "status": "failed", "message": "停止操作 ID 不能与目标 job ID 相同", "stoppedPids": [], "stoppedTasks": []}
            append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
            return result
        identity_fields = LEGACY_WORKER_STOP_IDENTITY_FIELDS
        if target_command:
            missing_identity = [field for field in identity_fields if command.get(field) in (None, "") and field != "gpuId"]
            if missing_identity:
                result = {"commandId": command_id, "status": "failed", "message": "精确停止缺少完整身份：" + ",".join(missing_identity), "stoppedPids": [], "stoppedTasks": []}
                append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
                return result
        elif not session:
            result = {"commandId": command_id, "status": "failed", "message": "缺少任务身份，拒绝停止全部任务", "stoppedPids": [], "stoppedTasks": []}
            append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
            return result
        stop_reason = str(command.get("manualStopType") or command.get("stopReason") or command.get("reason") or "manual_stop_bad_code_or_no_effect").strip()
        stop_source = str(command.get("stopSource") or command.get("source") or "user").strip()
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        try:
            cancelled = cancel_durable_plan_job(root, command) if target_command else None
        except ValueError as exc:
            result = {"commandId": command_id, "status": "failed", "message": str(exc), "stoppedPids": [], "stoppedTasks": []}
            append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
            return result
        if cancelled:
            result = {"commandId": command_id, "status": "completed", "message": "已确认取消尚未启动的 Agent 队列 job", "stoppedPids": [],
                      "stoppedTasks": [{key: cancelled.get(key) for key in (*DURABLE_PLAN_IDENTITY_FIELDS, "planJobCount", "enqueuedAt", "gpuId")} | {"paneClosed": True}]}
            append_event(root, {"type": "worker_task_stopped", "workerId": worker_id, "operationId": command_id, "payload": result})
            return result
        matched = []
        stopped = []
        stopped_tasks = []
        pane_close_proofs = {}
        for task in tasks:
            if not isinstance(task, dict):
                continue
            task_command = str(task.get("commandId") or task.get("operationId") or "").strip()
            task_key = str(task.get("session") or task.get("runKey") or task_command or "").strip()
            if target_command:
                if not worker_task_matches_stop_identity(command, task):
                    continue
            elif session not in (task_key, task_command, str(task.get("runKey") or "")):
                continue
            raw_pid = str(task.get("pid") or "").strip()
            pid = int(raw_pid) if raw_pid.isdigit() else 0
            matched.append(task)
            pane = str(task.get("tmuxPane") or "").strip()
            proof_key = (task_command, pane)
            proof = pane_close_proofs.get(proof_key)
            if pane and proof is None:
                proof = close_worker_task_pane(root, task)
                pane_close_proofs[proof_key] = proof
                if proof.get("paneClosed") and not proof.get("paneAlreadyMissing"):
                    stopped.append(pane)
            pane_closed = bool((proof or {}).get("paneClosed"))
            task["_paneClosed"] = pane_closed
            if pane and not pane_closed:
                result = {"commandId": command_id, "status": "failed", "message": "该 job 的 tmux 标签未确认关闭，未结束整会话：" + str((proof or {}).get("paneCloseError") or "关闭证据不足"), "stoppedPids": stopped, "stoppedTasks": [], "stopReason": stop_reason, "manualStopType": stop_reason, "stopSource": stop_source}
                append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
                return result
            if pid > 0 and not str(task.get("pid") or "").strip().startswith("%"):
                try:
                    os.kill(pid, signal.SIGTERM)
                    stopped.append(pid)
                except ProcessLookupError:
                    pass
                except Exception as exc:
                    append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": {"commandId": command_id, "status": "failed", "message": str(exc)}})
                    return {"commandId": command_id, "status": "failed", "message": str(exc)}
            with WORKER_TASK_SNAPSHOT_LOCK:
                current = current_worker_task(root, task)
                status_now = str(current.get("status") or "").lower()
                if status_now == "running":
                    stopped_task = {**current, "status": "stopped", "finishedAt": now_iso(), "stopReason": stop_reason, "manualStopType": stop_reason, "stopSource": stop_source}
                    append_worker_task(root, stopped_task)
                    current = stopped_task
                elif target_command and task.get("tmuxPane") and not task.get("_paneClosed"):
                    result = {"commandId": command_id, "status": "failed", "message": "该 job 的 tmux 标签未确认关闭，未结束整会话", "stoppedPids": stopped, "stoppedTasks": [], "stopReason": stop_reason, "manualStopType": stop_reason, "stopSource": stop_source}
                    append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
                    return result
                receipt = {k: current.get(k) for k in (*DURABLE_PLAN_IDENTITY_FIELDS, "operationId", "session", "gpuId", "planJobCount", "enqueuedAt", "stopReason", "manualStopType", "stopSource", "planId", "tmuxPane", "tmuxSession") if current.get(k) not in (None, "")}
                receipt["paneClosed"] = bool(task.get("_paneClosed")) or not str(task.get("tmuxPane") or "").strip()
                if proof:
                    receipt["paneAlreadyMissing"] = proof.get("paneAlreadyMissing") is True
                if task.get("tmuxPane") and not task.get("_paneClosed"):
                    receipt["paneCloseError"] = "tmux 标签未确认关闭，未结束整会话"
                stopped_tasks.append(receipt)
        if target_command and not matched:
            result = {"commandId": command_id, "status": "failed", "message": "没有与指定 job 身份一致的任务，未停止其他任务", "stoppedPids": [], "stoppedTasks": [], "stopReason": stop_reason, "manualStopType": stop_reason, "stopSource": stop_source}
            append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
            return result
        result = {"commandId": command_id, "status": "completed", "message": f"stopped={len(stopped)} matched={len(matched)}", "stoppedPids": stopped, "stoppedTasks": stopped_tasks, "stopReason": stop_reason, "manualStopType": stop_reason, "stopSource": stop_source}
        append_event(root, {"type": "worker_task_stopped", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    if action in ("delete-worker-artifacts", "archive-worker-artifacts"):
        payload = dict(command)
        payload["opId"] = command_id
        payload["operationId"] = command_id
        return handle_action(root, action, payload, command_id, command_id)
    if action in ("clear-cache", "clearCache"):
        return {"commandId": command_id, "status": "failed", "message": "旧清缓存入口已停用，请使用缓存回收审核清单并二次确认完整路径"}
    if action not in ("start-worker-task", "retry-worker-task"):
        result = {"commandId": command_id, "status": "failed", "message": f"不支持的 Worker 命令：{action}"}
        append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    if action == "start-worker-task" and command.get("durablePlanQueue") is True:
        try:
            return accept_durable_plan_job(root, command, worker_id)
        except Exception as exc:
            return {"commandId": command_id, "status": "failed", "durableAccepted": False, "message": str(exc)}
    options = command.get("options") if isinstance(command.get("options"), dict) else {}
    project_dir = str(command.get("projectDir") or options.get("projectDir") or root).strip()
    scheduler_path = str(command.get("schedulerPath") or options.get("schedulerPath") or os.path.join(agent_install_dir(root), "simple_cluster", "runtime", "cluster_scheduler.py"))
    plan = str(command.get("plan") or command.get("planFile") or options.get("plan") or options.get("planFile") or "").strip()
    if not plan:
        result = {"commandId": command_id, "status": "failed", "message": "启动或重试 Worker 任务时必须提供 plan。"}
        append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    experiment_index = int(command.get("experimentIndex") if command.get("experimentIndex") is not None else options.get("experimentIndex") or 0)
    gpu_id = str(command.get("gpuId") or options.get("gpuId") or "")
    case_name = str(command.get("case") or options.get("case") or "").strip()
    seed = command.get("seed") if command.get("seed") is not None else options.get("seed")
    output_dir = str(command.get("outputDir") or command.get("output_dir") or options.get("outputDir") or options.get("output_dir") or "").replace("\\", "/").strip()
    config_path = str(command.get("configPath") or command.get("config_path") or options.get("configPath") or options.get("config_path") or "").replace("\\", "/").strip()
    debug_mode = any(action_bool(value) for value in (command.get("debugMode"), command.get("debug_mode"), options.get("debugMode"), options.get("debug_mode")))
    if debug_mode:
        result = {"commandId": command_id, "status": "failed", "message": "Debug 运行模式已移除，请使用正式 Plan 运行。"}
        append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    debug_run_id = str(command.get("debugRunId") or command.get("debug_run_id") or options.get("debugRunId") or options.get("debug_run_id") or "").strip()
    debug_output_dir = str(command.get("debugOutputDir") or command.get("debug_output_dir") or options.get("debugOutputDir") or options.get("debug_output_dir") or "").strip()
    default_result_csv_dir = str(command.get("defaultResultCsvDir") or command.get("default_result_csv_dir") or options.get("defaultResultCsvDir") or options.get("default_result_csv_dir") or "experiments/results").strip()
    manual_reassignment = any(action_bool(value) for value in (command.get("manualReassignment"), command.get("manual_reassignment"), options.get("manualReassignment"), options.get("manual_reassignment")))
    source_worker_id = str(command.get("sourceWorkerId") or command.get("source_worker_id") or options.get("sourceWorkerId") or options.get("source_worker_id") or "").strip()
    original_run_key = str(command.get("originalRunKey") or command.get("original_run_key") or options.get("originalRunKey") or options.get("original_run_key") or "").strip()
    reassignment_run_key = str(command.get("runKey") or options.get("reassignmentRunKey") or options.get("reassignment_run_key") or "").strip()
    mode = verified_durable_execution_mode(project_dir, command) if command.get("projectId") and command.get("planRevision") else worker_command_plan_mode(project_dir, plan, command.get("mode") or options.get("mode"))
    # per-GPU单tmux(1C)：抽出 worker_tmux_session_name 纯函数，直传值仍经 simple_tmux_name 归一
    if command.get("session"):
        session = str(command.get("session"))
    else:
        session = worker_tmux_session_name(worker_id, gpu_id, os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID"))
    _raw_log = str(command.get("logPath") or f"tmp/tmux_logs/{session}.log")
    if os.path.isabs(_raw_log):
        rel_log = os.path.relpath(os.path.abspath(_raw_log), os.path.abspath(project_dir)).replace("\\", "/")
    else:
        rel_log = _raw_log.replace("\\", "/").lstrip("/")
    log_path = safe_project_path(project_dir, rel_log)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    env = simple_runtime_env(os.environ.copy())
    env["SIMPLE_EXPERIMENT_MANAGED_JOB"] = "1"
    distributed_results = options.get("distributedResults") is True or command.get("distributedResults") is True
    if distributed_results:
        if not output_dir or "/attempts/" not in output_dir or not str(command.get("planRevision") or "").strip() or not str(command.get("codeFingerprint") or "").strip():
            raise ValueError("分布式任务缺少 Plan、代码或独立 attempt 身份")
        try:
            if int(command.get("attempt")) < 1:
                raise ValueError("attempt must be positive")
        except (TypeError, ValueError) as exc:
            raise ValueError("分布式任务缺少有效 attempt") from exc
        if os.path.isabs(output_dir) or any(part in ("", ".", "..") for part in output_dir.split("/")):
            raise ValueError("分布式任务输出路径不安全")
        safe_project_path(project_dir, output_dir)
        env["SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS"] = "1"
    conda_declared = any(key in command for key in ("condaEnv", "conda_env")) or any(key in options for key in ("condaEnv", "conda_env"))
    conda_env = str(command.get("condaEnv") or command.get("conda_env") or options.get("condaEnv") or options.get("conda_env") or "").strip()
    if conda_env in {"-", "--"}:
        conda_env = ""
    if conda_declared:
        env["SIMPLE_EXPERIMENT_CONDA_ENV"] = conda_env
        env["SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV"] = "1" if conda_env else "0"
    if action in {"start-worker-task", "retry-worker-task"} and not conda_env:
        result = {"commandId": command_id, "status": "failed", "message": f"Worker {worker_id} 未配置 condaEnv；请在设置 > 服务器 或 project.prepare 的 workerTunnels[].condaEnv 中配置。"}
        append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    if gpu_id:
        env["CUDA_VISIBLE_DEVICES"] = gpu_id
    if debug_mode:
        env["SIMPLE_EXPERIMENT_DEBUG"] = "1"
        env["SIMPLE_EXPERIMENT_DEBUG_RUN_ID"] = debug_run_id
        env["SIMPLE_EXPERIMENT_DEBUG_OUTPUT_DIR"] = debug_output_dir
    if not os.path.isfile(scheduler_path):
        result = {"commandId": command_id, "status": "failed", "message": "Worker 上缺少 cluster_scheduler.py，请先部署最新版 Agent。"}
        append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    try:
        require_scheduler_dependencies(project_dir, scheduler_path, env)
    except Exception as exc:
        result = {"commandId": command_id, "status": "failed", "message": str(exc)}
        append_event(root, {"type": "worker_command_failed", "workerId": worker_id, "operationId": command_id, "payload": result})
        return result
    overwrite_existing = any(action_bool(value) for value in (command.get("overwriteExisting"), command.get("overwrite_existing"), command.get("overwrite"), options.get("overwriteExisting"), options.get("overwrite_existing"), options.get("overwrite")))
    args = [
        simple_runtime_python(env),
        scheduler_path,
        "--run-job",
        "--plan", plan,
        "--resume",
        "--mode", mode,
        "--only-index", str(experiment_index),
        "--gpu-ids", gpu_id,
        "--worker-id", worker_id,
        "--default-result-csv-dir", default_result_csv_dir,
    ]
    if distributed_results:
        args.extend(["--output-dir-override", output_dir])
    if overwrite_existing:
        args.append("--overwrite")
    if debug_mode:
        args.extend(["--debug-mode", "--debug-run-id", debug_run_id or command_id, "--debug-output-dir", debug_output_dir])
    # per-GPU固定窗口(1C)：主路径为 simple-gpu-{gpu_id} 复用 + split-window，log_path 仍按 session 归一，保证 tmux ls 仅 simple-gpu-0..3
    _tmux_prefix = str(os.environ.get("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX") or "").strip()
    try:
        _cfg_prefix = str((options.get("tmuxSessionPrefix") if isinstance(options, dict) else "") or (command.get("tmuxSessionPrefix") if isinstance(command, dict) else "") or "").strip()
        if _cfg_prefix:
            _tmux_prefix = _cfg_prefix
    except Exception:
        pass
    gpu_window = fixed_gpu_window_name(_tmux_prefix, gpu_id) if str(gpu_id or "").strip() else simple_tmux_name(session)
    tmux_session = gpu_window
    # Let the scheduler (run_job) publish the resolved experiment output_dir to a sidecar so the
    # tmux window can mirror stdout.log/stderr.log live (see start_simple_tmux_command split-pane).
    env["SIMPLE_EXPERIMENT_TMUX_SESSION"] = tmux_session
    env["SIMPLE_EXPERIMENT_TMUX_LOG_DIR"] = os.path.dirname(str(log_path))
    # Exit evidence belongs to the command identity, independent of which launch path
    # (GPU pane or fallback session) succeeds. This also reuses the same marker on fallback.
    exit_code_path = safe_project_path(project_dir, f"simple_cluster/tmux_logs/{command_id}.exit_code")
    try:
        env["SIMPLE_EXPERIMENT_EXIT_CODE_PATH"] = str(exit_code_path)
    except Exception:
        pass
    used_tmux = False
    proc = None
    pid = 0
    reserved_gpu = False
    if distributed_results:
        gpu_util_threshold = command.get("gpuIdleUtilThreshold", options.get("gpuIdleUtilThreshold", options.get("gpu_idle_util_threshold")))
        gpu_mem_threshold = command.get("gpuIdleMemThresholdMb", options.get("gpuIdleMemThresholdMb", options.get("gpu_idle_mem_threshold")))
        max_concurrent_gpus = command.get("maxConcurrentGpus", options.get("maxConcurrentGpus"))
        existing_task = reserve_distributed_gpu(root, gpu_id, command_id, gpu_util_threshold, gpu_mem_threshold,
                                                command.get("requireIdleGpu") is True, max_concurrent_gpus)
        if existing_task:
            return {"commandId": command_id, "status": str(existing_task.get("status") or "unknown"),
                    "message": "相同 job 指令已存在，未重复启动", "gpuId": gpu_id}
        reserved_gpu = True
    if tmux_available():
        try:
            pid = start_job_in_gpu_pane(gpu_window, args, project_dir, env, log_path, exit_code_path)
            used_tmux = True
        except Exception as exc:
            try:
                _fallback_session = simple_tmux_name(session)
                tmux_session = _fallback_session
                env["SIMPLE_EXPERIMENT_TMUX_SESSION"] = tmux_session
                pid = start_simple_tmux_command(tmux_session, args, project_dir, log_path, env, exit_code_path)
                used_tmux = True
            except Exception as exc2:
                if reserved_gpu:
                    release_distributed_gpu_reservation(gpu_id, command_id)
                raise RuntimeError(f"tmux launch failed: {exc} / fallback:{exc2}; refusing silent bash fallback")
    if not used_tmux:
        if reserved_gpu:
            release_distributed_gpu_reservation(gpu_id, command_id)
        raise RuntimeError("tmux available but launch failed and ALLOW_POPEN_FALLBACK not enabled; refusing silent bash fallback\uff1b\u8bf7\u5b89\u88c5 tmux \u6216\u542f\u7528 ALLOW_POPEN_FALLBACK")
    task = {
        "schemaVersion": SCHEMA_VERSION,
        "commandId": command_id,
        "operationId": command_id,
        "runKey": command.get("runKey") or command_id,
        **({key: command.get(key) for key in DURABLE_PLAN_IDENTITY_FIELDS if command.get(key) not in (None, "")} if command.get("planJobCount") is not None else {}),
        **({"planJobCount": command.get("planJobCount"), "enqueuedAt": command.get("enqueuedAt")} if command.get("planJobCount") is not None and command.get("enqueuedAt") else {}),
        "workerId": worker_id,
        "resultOwnerWorkerId": worker_id,
        "status": "running",
        "pid": pid,
        "tmuxPane": pid if used_tmux and str(pid).startswith("%") else "",
        "session": session,
        "tmuxSession": tmux_session if used_tmux else "",
        "exitCodePath": os.path.relpath(exit_code_path, project_dir).replace("\\", "/") if used_tmux else "",
        "experimentIndex": experiment_index,
        "gpuId": gpu_id,
        "case": case_name,
        "seed": seed,
        "mode": mode,
        **({"executionMode": mode, "executionModeSource": "matching_plan_revision"} if distributed_results else {}),
        **({"planRevision": str(command.get("planRevision")), "codeFingerprint": str(command.get("codeFingerprint")),
            "attempt": int(command.get("attempt"))} if distributed_results else {}),
        **({"stage": str(command.get("stage") or command.get("phase") or command.get("mode"))} if command.get("stage") or command.get("phase") or command.get("mode") else {}),
        **({"experimentCase": str(command.get("experimentCase") or command.get("experiment_case") or command.get("case"))} if command.get("experimentCase") or command.get("experiment_case") or command.get("case") else {}),
        **({"workflowId": str(command.get("workflowId") or command.get("workflow_id") or command.get("parentId"))} if command.get("workflowId") or command.get("workflow_id") or command.get("parentId") else {}),
        "condaEnv": str(env.get("SIMPLE_EXPERIMENT_CONDA_ENV") or ""),
        "logPath": rel_log,
        "plan": plan,
        "planFile": plan,
        **({"outputDir": output_dir} if output_dir else {}),
        **({"configPath": config_path} if config_path else {}),
        "debugMode": debug_mode,
        "debugRunId": debug_run_id,
        "debugOutputDir": debug_output_dir,
        "defaultResultCsvDir": default_result_csv_dir,
        "startedAt": now_iso(),
        **({
            "manualReassignment": True,
            "sourceWorkerId": source_worker_id,
            "targetWorkerId": worker_id,
            "originalRunKey": original_run_key,
            "reassignmentRunKey": reassignment_run_key or command_id,
        } if manual_reassignment else {}),
    }
    try:
        append_worker_task(root, task)
    except Exception as exc:
        # The remote command may already be running. Keep the in-memory GPU fence
        # and require operator reconciliation rather than dispatching a duplicate.
        raise RuntimeError(f"任务已启动但快照保存失败，GPU 保留占用并需人工核实：{exc}") from exc
    if reserved_gpu:
        release_distributed_gpu_reservation(gpu_id, command_id)
    result = {"commandId": command_id, "status": "running", "pid": pid, "session": session, "tmuxSession": tmux_session if used_tmux else "", "logPath": rel_log, "debugMode": debug_mode, "debugRunId": debug_run_id, "debugOutputDir": debug_output_dir, "resultOwnerWorkerId": worker_id, **({"manualReassignment": True, "sourceWorkerId": source_worker_id, "targetWorkerId": worker_id, "originalRunKey": original_run_key, "reassignmentRunKey": reassignment_run_key or command_id} if manual_reassignment else {}), "message": "Debug Worker 任务已启动" if debug_mode else "Worker 任务已启动"}
    append_event(root, {"type": "worker_task_started", "workerId": worker_id, "operationId": command_id, "payload": {**task, **result}})
    def wait_task():
        def _resolve_pane_id():
            # Target the task pane, never the session's currently selected pane.
            if str(task.get("tmuxPane") or "").startswith("%"):
                return str(task["tmuxPane"])
            try:
                rp = subprocess.run(["tmux", "list-panes", "-t", tmux_session, "-F", "#{pane_id}"], capture_output=True, text=True, timeout=3)
                if rp.returncode == 0 and rp.stdout.strip():
                    return rp.stdout.strip().splitlines()[0].strip()
            except Exception:
                pass
            return ""
        def _recycle_after_task():
            try:
                pane_id = _resolve_pane_id()
                if not pane_id:
                    return
                # 容错 pane_id == gpu_window：遍历 MANAGED 窗口或按 gpu_id 计算 gw
                prefix_gw = _resolve_tmux_prefix(None, None, env)
                gw = fixed_gpu_window_name(prefix_gw, gpu_id) if gpu_id else ""
                _safe_kill_pane(pane_id, gw)
            except Exception:
                pass
        try:
            if used_tmux:
                # Sessions are intentionally left open after the command finishes, so we must
                # wait for the exit-code file (written by the launched command) rather than tmux
                # liveness; otherwise a finished task would stay 'running' forever.
                while not exit_code_ready(exit_code_path) and tmux_task_pane_alive(task.get("tmuxPane"), tmux_session, project_dir, env):
                    time.sleep(3)
                rc = read_task_exit_code(exit_code_path)
            else:
                rc = proc.wait()
            with WORKER_TASK_SNAPSHOT_LOCK:
                if worker_task_was_stopped(root, task) or str(current_worker_task(root, task).get("status") or "").lower() != "running":
                    return
                finished = {**task, "status": "completed" if rc == 0 else "failed", "exitCode": rc, "finishedAt": now_iso()}
                append_worker_task(root, finished)
            append_event(root, {"type": "worker_task_completed" if rc == 0 else "worker_task_failed", "workerId": worker_id, "operationId": command_id, "payload": finished})
            if used_tmux and rc == 0:
                _recycle_after_task()
        except Exception as exc:
            with WORKER_TASK_SNAPSHOT_LOCK:
                if worker_task_was_stopped(root, task) or str(current_worker_task(root, task).get("status") or "").lower() != "running":
                    return
                failed = {**task, "status": "failed", "error": str(exc), "finishedAt": now_iso()}
                append_worker_task(root, failed)
            append_event(root, {"type": "worker_task_failed", "workerId": worker_id, "operationId": command_id, "payload": failed})
    threading.Thread(target=wait_task, daemon=True, name=f"worker-task-{command_id}").start()
    return result

def execute_worker_command(root, command, worker_id):
    action = str(command.get("action") or "").strip()
    if action == "retry-worker-task" and command.get("recoverTrainingOnly") is True:
        return recover_train_only_completion(root, command, worker_id)
    if action in ("start-worker-task", "retry-worker-task"):
        # Durable admission rechecks the tombstone while holding its queue lock.
        if command.get("durablePlanQueue") is True:
            with WORKER_TASK_SNAPSHOT_LOCK:
                tombstone = recalled_worker_command(root, command)
                if tombstone:
                    return {"commandId": str(command.get("commandId") or command.get("operationId") or ""),
                            "status": "cancelled", "durableAccepted": True, "durableReleased": True,
                            "recalled": True, "stopReason": "requeue",
                            "message": "durable worker command was recalled before admission"}
            return _execute_worker_command_unfenced(root, command, worker_id)
        # Persist a short claim under the snapshot lock, then do dependency and launch
        # work outside it. Recall serializes against this claim without delaying readers.
        with WORKER_TASK_SNAPSHOT_LOCK:
            tombstone = recalled_worker_command(root, command)
            if tombstone:
                return {"commandId": str(command.get("commandId") or command.get("operationId") or ""),
                        "status": "cancelled", "durableAccepted": False, "durableReleased": False,
                        "legacyReleased": True, "recalled": True, "stopReason": "requeue",
                        "message": "worker command was recalled before start"}
            command_id = str(command.get("commandId") or command.get("operationId") or "").strip()
            existing = worker_start_claim(root, command_id)
            if existing:
                snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
                tasks = snapshot.get("tasks") if isinstance(snapshot, dict) and isinstance(snapshot.get("tasks"), list) else []
                task = next((item for item in tasks if isinstance(item, dict)
                             and str(item.get("commandId") or item.get("operationId") or "") == command_id), None)
                return {"commandId": command_id, "status": str((task or {}).get("status") or "unknown").lower(),
                        "durableAccepted": False, "durableReleased": False,
                        "message": "worker start is already claimed; duplicate launch refused"}
            write_worker_start_claim(root, command)
        try:
            result = _execute_worker_command_unfenced(root, command, worker_id)
        except Exception:
            # Keep the claim as an unknown fence: launch outcome may be ambiguous.
            raise
        return result
    return _execute_worker_command_unfenced(root, command, worker_id)

def worker_command_plan_mode(project_dir, plan, explicit=""):
    raw = str(explicit or "").strip()
    if not raw and plan:
        try:
            text = pathlib.Path(safe_project_path(project_dir, plan)).read_text(encoding="utf-8", errors="replace")[:262144]
            match = re.search(r"(?m)^mode\s*:\s*([^#\r\n]+)", text)
            raw = str(match.group(1) if match else "").strip().strip("'\"")
        except Exception:
            raw = ""
    return normalized_experiment_mode(raw)

def verified_durable_execution_mode(project_dir, command):
    """Bind intended mode to the original PLAN revision, never a legacy hardcoded mode."""
    plan_path = safe_project_path(project_dir, durable_plan_value(command, "planFile"))
    raw = pathlib.Path(plan_path).read_bytes()
    if len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != durable_plan_value(command, "planRevision"):
        raise ValueError("Original Plan revision unavailable; execution mode cannot be recovered safely")
    scheduler = scalar_scheduler_module()
    plan = scheduler.load_plan(plan_path)
    if pathlib.Path(plan_path).read_bytes() != raw:
        raise ValueError("Original Plan changed during execution mode verification")
    mode = scheduler.plan_execution_mode(plan)
    # executionMode is introduced by the fixed Host. Old mode alone is not
    # evidence: affected versions always saved train_test regardless of validation.
    expected = command.get("executionMode")
    if expected is not None and (expected not in ("train", "test", "train_test") or expected != mode):
        raise ValueError("Validated execution mode disagrees with original Plan revision")
    if expected is not None and command.get("mode") not in (None, "", expected):
        raise ValueError("Worker mode disagrees with validated execution mode")
    return mode

def recover_train_only_completion(root, command, worker_id):
    """Review/adopt existing validation-only adapter evidence; never execute training or test."""
    import csv
    import math
    target_id = str(command.get("targetCommandId") or "")
    with WORKER_TASK_SNAPSHOT_LOCK:
        data = read_durable_plan_queue(root)
        row = next((item for item in data["jobs"] if item.get("commandId") == target_id), None)
        if not row or str(row.get("workerId")) != worker_id:
            raise ValueError("Training recovery target is unavailable")
        expected = {**command, "commandId": target_id, "runKey": target_id}
        if not durable_plan_same_identity(row, expected):
            raise ValueError("Training recovery identity mismatch")
        if row.get("trainingRecovery") and row.get("status") == "completed":
            snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
            old_task = next((item for item in snapshot.get("tasks", []) if item.get("commandId") == target_id), None)
            if old_task and durable_plan_same_identity(row, old_task) and old_task.get("status") == "failed":
                append_worker_task(root, {**old_task, "status": "completed", "trainingRecovery": row["trainingRecovery"],
                                         "originalExecution": row["originalExecution"], "executionMode": "train", "error": ""})
            return {"status": "completed", "trainingRecovery": row["trainingRecovery"], "recovered": True}
        if row.get("status") != "failed" or not row.get("finishedAt") or row.get("stopReason"):
            raise ValueError("Only a verified failed, stopped process can adopt training completion")
        if verified_durable_execution_mode(root, {key: value for key, value in row.items() if key != "executionMode"}) != "train":
            raise ValueError("Training recovery requires the original train-only PLAN")
        snapshot = read_json(path_for(root, "worker_task_snapshot.json"), {})
        task = next((item for item in snapshot.get("tasks", []) if item.get("commandId") == target_id), None)
        if not task or not durable_plan_same_identity(row, task) or task.get("status") != "failed" or task.get("stage") != "train_test":
            raise ValueError("Original unintended test failure is not verified")
        error = str(task.get("error") or row.get("error") or "")
        failure_evidence_path = ""
        failure_evidence_hash = ""
        if not error:
            # Exit-code reconciliation leaves error blank; task telemetry reads this exact attempt's stderr.
            failure_evidence_path = str(row["outputDir"]).rstrip("/") + "/stderr.log"
            filename = safe_project_path(root, failure_evidence_path)
            if os.path.isfile(filename) and not os.path.islink(filename):
                failure_evidence_hash = sha256_file(filename)
                error = worker_task_failure_message(root, task, use_cache=False)
        if "Validation-only tuning cannot access test patients" not in error:
            raise ValueError("Failure is not the validation-only test-access guard; manual review required")
        output = str(row["outputDir"])
        manifest = read_json(safe_project_path(root, output + "/artifact_manifest.json"), {})
        if manifest.get("selection_only") is not True or manifest.get("test_accessed") is not False or manifest.get("selection_metric") != "roc_auc":
            raise ValueError("Adapter does not certify validation-only checkpoint selection")
        evidence = {}
        def verified_file(relative):
            normalized = str(relative or "").replace("\\", "/").strip()
            if not normalized.startswith(output + "/"):
                raise ValueError("Training artifact belongs to another attempt")
            filename = safe_project_path(root, normalized)
            if not os.path.isfile(filename) or os.path.islink(filename):
                raise ValueError("Missing training artifact: " + normalized)
            evidence[normalized] = sha256_file(filename)
            return filename
        if failure_evidence_path:
            verified_file(failure_evidence_path)
            if evidence[failure_evidence_path] != failure_evidence_hash:
                raise ValueError("Training failure evidence changed during verification")
        checkpoint = verified_file(manifest.get("checkpoint_path"))
        checkpoint_index = read_json(verified_file(manifest.get("checkpoint_manifest")), {})
        if checkpoint_index.get("checkpoint_path") != manifest.get("checkpoint_path") or checkpoint_index.get("size_bytes") != os.path.getsize(checkpoint):
            raise ValueError("Checkpoint index disagrees with the existing checkpoint")
        config = verified_file(output + "/config.yaml")
        snapshot_config = verified_file(manifest.get("config_snapshot"))
        scheduler = scalar_scheduler_module()
        final_config = scheduler.load_config(config)
        if final_config != scheduler.load_config(snapshot_config):
            raise ValueError("Final training config differs from adapter snapshot")
        if (int(final_config.get("seed", -1)) != row["seed"]
                or final_config.get("train", {}).get("selection_only") is not True
                or final_config.get("paper", {}).get("case") != row["case"]
                or final_config.get("tuning", {}).get("candidate") != manifest.get("selection_candidate")
                or final_config.get("data", {}).get("dataset") != manifest.get("selection_dataset")):
            raise ValueError("Final config is not the selected validation candidate/case/seed")
        metric_path = verified_file(manifest.get("metrics_summary"))
        if os.path.getmtime(checkpoint) > os.path.getmtime(metric_path):
            raise ValueError("Checkpoint changed after validation export")
        with open(metric_path, encoding="utf-8-sig", newline="") as stream:
            metrics = list(csv.DictReader(stream))
        if not metrics or any(item.get("split") != "val" or item.get("source") != "p100_validation_checkpoint"
                              or item.get("eval_protocol") != "p100_low"
                              or str(item.get("seed")) != str(row["seed"]) or item.get("case") != row["case"]
                              or not math.isfinite(float(item.get("value", "nan"))) for item in metrics):
            raise ValueError("Metrics are not finite validation evidence for this exact case/seed")
        if not any(item.get("metric") == "roc_auc" for item in metrics):
            raise ValueError("Validation checkpoint selection metric is missing")
        verified_file(output + "/artifact_manifest.json")
        proof = {"kind": "validation_adapter_checkpoint", "projectId": row["projectId"], "planFile": row["planFile"],
                 "planRevision": row["planRevision"], "codeFingerprint": row["codeFingerprint"],
                 "experimentIndex": row["experimentIndex"], "case": row["case"], "seed": row["seed"],
                 "workflowId": row["workflowId"], "attempt": row["attempt"],
                 "commandId": target_id, "outputDir": output, "workerId": worker_id, "sha256": evidence,
                 "metricSplit": "val", "checkpointPath": manifest["checkpoint_path"]}
        signature = hashlib.sha256(json.dumps(proof, sort_keys=True).encode("utf-8")).hexdigest()
        if command.get("confirm") is not True:
            return {"status": "completed", "preview": True, "recovered": False, "evidenceSignature": signature,
                    "trainingRecovery": proof, "message": "Existing checkpoint/config/validation evidence verified; confirmation required"}
        if command.get("evidenceSignature") != signature:
            raise ValueError("Training recovery evidence changed after review")
        for filename, digest in evidence.items():
            if sha256_file(safe_project_path(root, filename)) != digest:
                raise ValueError("Training recovery artifact changed during verification")
        proof["confirmedAt"] = now_iso()
        original = {"status": task["status"], "exitCode": task.get("exitCode"), "error": error, "mode": task.get("mode") or task.get("stage")}
        row.update({"status": "completed", "trainingRecovery": proof, "originalExecution": original,
                    "executionMode": "train", "mode": "train", "error": ""})
        write_durable_plan_queue(root, data)
        append_worker_task(root, {**task, "status": "completed", "trainingRecovery": proof,
                                 "originalExecution": original, "executionMode": "train", "error": ""})
        return {"status": "completed", "recovered": True, "trainingRecovery": proof,
                "message": "Existing training completion adopted; no command or result file was changed"}

def normalized_experiment_mode(raw):
    normalized = re.sub(r"[\s-]+", "_", str(raw or "").strip().lower()) or "train_test"
    aliases = {"training": "train", "train_only": "train", "eval": "test", "evaluate": "test", "evaluation": "test", "test_only": "test", "eval_only": "test", "train_and_test": "train_test", "both": "train_test", "all": "train_test"}
    mode = aliases.get(normalized, normalized)
    if mode not in ("train", "test", "train_test"):
        raise ValueError("Unsupported Plan execution mode: " + mode)
    return mode

def read_events_after_seq(root, since, limit=100, cursor_id=""):
    journal = os.path.abspath(path_for(root, "events.jsonl"))
    if not os.path.isfile(journal):
        return []
    requested_since = max(0, int(since or 0))
    requested_limit = max(1, int(limit or 100))
    stat = os.stat(journal)
    now_value = time.time()
    cursor_name = re.sub(r"[^A-Za-z0-9_.:-]+", "_", str(cursor_id or "").strip())[:120]
    cache_key = journal + "::" + cursor_name if cursor_name else journal
    with EVENT_CURSOR_LOCK:
        prune_event_cursor_cache(now_value, cache_key)
        cached = dict(EVENT_CURSOR_CACHE.get(cache_key) or {})
    same_file = cached.get("device") == stat.st_dev and cached.get("inode") == stat.st_ino
    cached_offset = int(cached.get("offset") or 0)
    use_cursor = same_file and int(cached.get("seq") or 0) == requested_since and 0 <= cached_offset <= stat.st_size
    current_seq = requested_since if use_cursor else 0
    current_offset = cached_offset if use_cursor else 0
    events = deque(maxlen=requested_limit)
    omitted_oversized = False
    with open(journal, "rb") as f:
        if current_offset:
            f.seek(current_offset)
        while True:
            raw = f.readline(MAX_AGENT_EVENT_RECORD_BYTES + 1)
            if not raw:
                break
            current_offset = f.tell()
            if len(raw) > MAX_AGENT_EVENT_RECORD_BYTES:
                omitted_oversized = True
                while raw and not raw.endswith(b"\n"):
                    raw = f.readline(MAX_AGENT_EVENT_RECORD_BYTES + 1)
                current_offset = f.tell()
                continue
            item = parse_event_line(raw.decode("utf-8", errors="replace"))
            if not item:
                continue
            seq = event_seq(item)
            current_seq = max(current_seq, seq)
            if seq > requested_since:
                events.append(item)
    if omitted_oversized:
        if len(events) >= requested_limit:
            events.popleft()
        events.append({"schemaVersion": SCHEMA_VERSION, "seq": 0, "type": "diagnostics_updated", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "reason": "oversized_journal_record", "resetSince": 0}})
    with EVENT_CURSOR_LOCK:
        EVENT_CURSOR_CACHE[cache_key] = {
            "seq": current_seq,
            "offset": current_offset,
            "device": stat.st_dev,
            "inode": stat.st_ino,
            "lastUsedAt": now_value,
        }
        prune_event_cursor_cache(now_value, cache_key)
    return events

def post_json(url, payload, timeout=5):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body or "{}")

def start_worker_hub_uplink(root, hub_uplink_url="", worker_id="", availability_seconds=60, jitter_seconds=30, event_delay_ms=1000):
    url = str(hub_uplink_url or os.environ.get("SIMPLE_EXPERIMENT_HUB_UPLINK_URL") or "").strip()
    if not url:
        return
    worker_id = str(worker_id or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
    availability_base = 0.5
    jitter = 0.0
    event_delay = 0.5
    def loop():
        last_seq = read_seq(root)
        last_command_seq = 0
        next_availability = time.time()
        backoff = 1.0
        while True:
            try:
                now_ts = time.time()
                events = read_events_after_seq(root, last_seq, 100, "worker-uplink")
                availability = None
                if now_ts >= next_availability:
                    availability = availability_from_gpu(worker_id, api_worker_gpu(root), "worker_uplink", 180)
                    next_availability = now_ts + availability_base + (random.random() * jitter if jitter else 0)
                if events or availability:
                    payload = {
                        "schemaVersion": SCHEMA_VERSION,
                        "workerId": worker_id,
                        "generatedAt": now_iso(),
                        "events": events,
                        "availability": availability,
                        "commandsSince": last_command_seq,
                    }
                    response = post_json(url, payload, timeout=5)
                    if events:
                        last_seq = max(int(event.get("seq") or last_seq) for event in events)
                    command_results = []
                    for command in response.get("commands") or []:
                        if not isinstance(command, dict):
                            continue
                        last_command_seq = max(last_command_seq, int(command.get("queueSeq") or last_command_seq))
                        command_results.append(execute_worker_command(root, command, worker_id))
                    if command_results:
                        post_json(url, {"schemaVersion": SCHEMA_VERSION, "workerId": worker_id, "generatedAt": now_iso(), "commandResults": command_results, "commandsSince": last_command_seq}, timeout=5)
                    backoff = 1.0
                time.sleep(event_delay)
            except Exception as exc:
                append_event(root, {"type": "worker_uplink_error", "source": "worker_telemetry", "payload": {"error": str(exc), "hubUplinkUrl": url}})
                time.sleep(backoff + random.random() * min(backoff, 30.0))
                backoff = min(backoff * 2, 60.0)
    thread = threading.Thread(target=loop, daemon=True, name="worker-hub-uplink")
    thread.start()

def start_worker_local_command_processor(root, worker_id, poll_seconds=5, jitter_seconds=2):
    """Single-worker (no-hub) command executor.

    When there is no hub uplink, nothing drives execute_worker_command, so scheduler-
    enqueued start-worker-task commands would sit in the queue file forever. This loop
    polls the worker command queue directly and executes commands locally, which is what
    makes run-plan actually launch tmux tasks in single-worker mode.
    """
    worker_id = str(worker_id or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"

    def already_processed(command_id):
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        for task in tasks:
            if isinstance(task, dict) and str(task.get("commandId") or "") == str(command_id):
                return True
        return False

    def loop():
        last_seq = initial_worker_command_checkpoint(root, worker_id)
        while True:
            try:
                commands = read_worker_commands(root, worker_id, last_seq, 50)
                for command in commands:
                    if not isinstance(command, dict):
                        continue
                    command_seq = max(last_seq, int(command.get("queueSeq") or last_seq))
                    command_id = command.get("commandId") or command.get("operationId")
                    if command_id and already_processed(command_id):
                        last_seq = command_seq
                        save_worker_command_checkpoint(root, worker_id, last_seq)
                        continue
                    try:
                        execute_worker_command(root, command, worker_id)
                    except Exception as exc:
                        append_event(root, {"type": "worker_command_exec_error", "workerId": worker_id, "payload": {"error": str(exc), "commandId": str(command_id)}})
                    last_seq = command_seq
                    save_worker_command_checkpoint(root, worker_id, last_seq)
                jitter = random.random() * jitter_seconds if jitter_seconds else 0
                time.sleep(poll_seconds + jitter)
            except Exception as exc:
                append_event(root, {"type": "worker_local_command_error", "payload": {"error": str(exc)}})
                time.sleep(max(1.0, poll_seconds))

    threading.Thread(target=loop, daemon=True, name="worker-local-command-processor").start()

def write_worker_gpu_snapshot(root):
    gpus, err = collect_local_gpu()
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "source": "worker_telemetry",
        "gpu": gpus,
        "gpus": gpus,
        "status": "ok" if not err else "degraded",
        "error": err,
    }
    worker_id = str(os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
    try:
        record_gpu_history(root, {worker_id: gpus}, payload["generatedAt"])
    except Exception as exc:
        payload["historyError"] = str(exc)
    atomic_write(path_for(root, "gpu_snapshot.json"), payload)
    return payload

def sampler_interval_seconds(value, default_seconds=1.0):
    return max(1.0, float(value or default_seconds))

def sampler_sleep_seconds(interval, jitter_seconds=30.0):
    jitter = max(0.0, float(jitter_seconds or 0.0))
    return interval + (random.random() * jitter if jitter else 0.0)

def worker_gpu_sample_delay(interval, jitter_seconds, has_plan):
    if has_plan:
        return min(5.0, sampler_interval_seconds(interval, 5.0))
    return sampler_sleep_seconds(interval, jitter_seconds)

def wait_for_worker_gpu_sample(root, interval, jitter_seconds, has_plan):
    delay = worker_gpu_sample_delay(interval, jitter_seconds, has_plan)
    if has_plan:
        time.sleep(delay)
        return
    # Check local task state every five seconds, but avoid GPU queries and snapshot writes
    # while idle. A newly-started plan wakes the next loop immediately.
    remaining = delay
    while remaining > 0:
        sleep_for = min(5.0, remaining)
        time.sleep(sleep_for)
        remaining -= sleep_for
        if has_running_plan(root):
            return

def has_running_plan(root):
    # 计划未接入时返回 False，调用方应 30s 休眠且不探活；有运行中任务/调度态时返回 True
    try:
        data = read_runtime_json_cached(path_for(root, "worker_task_snapshot.json"), None)
        if isinstance(data, dict):
            tasks = data.get("tasks") if isinstance(data.get("tasks"), list) else []
            for t in tasks:
                if not isinstance(t, dict):
                    continue
                st = str(t.get("status") or "").strip().lower()
                if st in ("running", "pending", "queued", "starting"):
                    return True
        for p in scheduler_state_paths(root):
            st_data = read_runtime_json_cached(p, None)
            if not isinstance(st_data, dict):
                continue
            s = str(st_data.get("status") or st_data.get("state") or st_data.get("phase") or "").strip().lower()
            if s in ("running", "pending", "active", "executing"):
                return True
            for bucket in ("running_experiments", "testing_experiments", "queued_experiments", "pending_experiments"):
                vals = st_data.get(bucket)
                if isinstance(vals, list) and len(vals) > 0:
                    return True
        snap = read_runtime_json_cached(path_for(root, "cluster_snapshot.json"), None)
        if isinstance(snap, dict):
            states = snap.get("schedulerStates") if isinstance(snap.get("schedulerStates"), list) else []
            for st in states:
                if not isinstance(st, dict):
                    continue
                s = str(st.get("status") or st.get("state") or st.get("phase") or "").strip().lower()
                if s in ("running", "pending", "active", "executing"):
                    return True
                for bucket in ("running_experiments", "testing_experiments", "queued_experiments", "pending_experiments"):
                    vals = st.get(bucket)
                    if isinstance(vals, list) and len(vals) > 0:
                        return True
    except Exception:
        pass
    return False

def payload_cache_changed(cache, key, payload):
    if key in cache and cache[key] == payload:
        return False
    cache[key] = payload
    return True

def start_worker_telemetry_sampler(root, poll_seconds=1, jitter_seconds=30):
    interval = sampler_interval_seconds(poll_seconds, 60.0)
    heartbeat_interval = max(60.0, interval)
    worker_id_local = str(os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
    def loop():
        last_payloads = {}
        last_heartbeat = 0.0
        while True:
            has_plan = has_running_plan(root)
            try:
                payload = write_worker_gpu_snapshot(root)
                # 单机 worker_telemetry 模式自刷新 worker_availability.json 避免调度停滞
                try:
                    avail = availability_from_gpu(worker_id_local, payload, "worker_agent_direct")
                    write_availability_batch(root, {"schemaVersion": SCHEMA_VERSION, "source": "worker_agent_direct", "generatedAt": avail.get("updatedAt"), "workers": [avail]})
                except Exception:
                    pass
                gpu_event = {"gpus": payload.get("gpus") or [], "status": payload.get("status"), "error": payload.get("error") or ""}
                if payload_cache_changed(last_payloads, "gpu", gpu_event):
                    append_event(root, {"type": "gpu_snapshot", "source": "worker_telemetry", "payload": gpu_event})
                health_payload = {"status": payload.get("status"), "lastError": payload.get("error") or "", "generatedAt": payload.get("generatedAt"), "gpuCount": len(payload.get("gpus") or [])}
                if payload_cache_changed(last_payloads, "health", health_payload):
                    append_event(root, {"type": "worker_health", "source": "worker_telemetry", "payload": health_payload})
                tasks_payload = api_worker_tasks(root)
                if payload_cache_changed(last_payloads, "tasks", tasks_payload):
                    append_event(root, {"type": "worker_task_snapshot", "source": "worker_telemetry", "payload": tasks_payload})
                if time.time() - last_heartbeat >= heartbeat_interval:
                    append_event(root, {"type": "agent_heartbeat", "source": "worker_telemetry", "payload": {"status": payload.get("status"), "gpuPollSeconds": interval, "agentVersion": AGENT_VERSION}})
                    last_heartbeat = time.time()
            except Exception as exc:
                try:
                    append_event(root, {"type": "worker_health", "source": "worker_telemetry", "payload": {"status": "degraded", "lastError": str(exc), "generatedAt": now_iso()}})
                except Exception:
                    pass
            wait_for_worker_gpu_sample(root, interval, jitter_seconds, has_plan)
    thread = threading.Thread(target=loop, name="simple-worker-telemetry-sampler", daemon=True)
    thread.start()
    return thread

def start_hub_control_sampler(root, poll_seconds=60, jitter_seconds=30):
    interval = sampler_interval_seconds(poll_seconds, 60.0)
    heartbeat_interval = max(60.0, interval)
    def loop():
        last_payloads = {}
        last_heartbeat = 0.0
        while True:
            try:
                scheduler = collect_scheduler(root)
                traces = collect_traces(root, scheduler)
                payloads = {
                    "scheduler_snapshot": {"schedulerStates": scheduler},
                    "experiment_trace": {"experimentTraces": traces},
                }
                for item in collect_live_output(scheduler, 120, root):
                    payloads[f"log_tail:{item.get('runKey') or item.get('key')}"] = item
                for name, payload in payloads.items():
                    if payload_cache_changed(last_payloads, name, payload):
                        typ = name.split(":", 1)[0]
                        event = {"type": typ, "payload": payload}
                        if typ == "log_tail":
                            event["runKey"] = payload.get("runKey") or payload.get("key") or ""
                        append_event(root, event)
                if time.time() - last_heartbeat >= heartbeat_interval:
                    append_event(root, {"type": "agent_heartbeat", "payload": {"status": "ok", "pollSeconds": interval, "agentVersion": AGENT_VERSION}})
                    last_heartbeat = time.time()
            except Exception as exc:
                try:
                    append_event(root, {"type": "diagnostics_updated", "payload": {"status": "degraded", "lastError": str(exc), "generatedAt": now_iso()}})
                except Exception:
                    pass
            time.sleep(interval)
    thread = threading.Thread(target=loop, name="simple-hub-control-sampler", daemon=True)
    thread.start()
    return thread

def write_snapshots(root, hub_id, workers, scheduler, traces, gpu, health, errors, ttl):
    generated = now_iso()
    expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + ttl))
    base = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated,
        "expiresAt": expires,
        "ttlSeconds": ttl,
        "hubId": hub_id,
        "workers": workers,
        "errors": errors,
        "partialFailure": bool(errors),
        "source": "hub_agent_snapshot",
        "agentVersion": AGENT_VERSION,
    }
    # TB健康入快照(2B)：供面板免轮询展示，端口默认6006，配置由扩展侧覆盖
    tb_info = {}
    try:
        tb_prefix = _resolve_tmux_prefix(None, None, None)
        tb_sess = tb_tmux_session_name(tb_prefix)
        tb_port = 6006
        tb_running = tmux_session_alive(tb_sess)
        tb_listening = tb_port_listening(tb_port) if tb_running else False
        tb_info = {"session": tb_sess, "port": tb_port, "running": tb_running, "listening": tb_listening, "checkedAt": generated}
    except Exception:
        tb_info = {}
    gpu_payload = {**base, "gpu": gpu, "health": health}
    try:
        record_gpu_history(root, gpu, generated)
    except Exception as exc:
        gpu_payload["historyError"] = str(exc)
    atomic_write(path_for(root, "cluster_snapshot.json"), {**base, "schedulerStates": scheduler, "tb": tb_info})
    atomic_write(path_for(root, "gpu_snapshot.json"), gpu_payload)
    atomic_write(path_for(root, "experiment_traces_snapshot.json"), {**base, "experimentTraces": traces})
    atomic_write(path_for(root, "health_snapshot.json"), {**base, "health": health})

def run_agent(args):
    global MAX_EVENTS
    MAX_EVENTS = max(100, int(getattr(args, "journal_max_events", MAX_EVENTS) or MAX_EVENTS))
    run_id = uuid.uuid4().hex
    if not acquire_pid(args.project_dir, run_id):
        return 0
    stop_path = path_for(args.project_dir, "stop")
    workers = json.loads(args.workers_json or "[]")
    poll_seconds = max(60, int(args.poll_seconds or 60))
    ttl_seconds = max(60, int(args.ttl_seconds or 180))
    atomic_write(path_for(args.project_dir, "agent.config.json"), {"hubId": args.hub_id, "workers": workers, "pollSeconds": poll_seconds, "ttlSeconds": ttl_seconds, "journalMaxEvents": MAX_EVENTS, "journalMaxBytes": MAX_JOURNAL_BYTES, "stateRetentionSeconds": STATE_RETENTION_SECONDS, "maxAgentStateBytes": MAX_AGENT_STATE_BYTES, "pid": os.getpid(), "runId": run_id, "agentVersion": AGENT_VERSION})
    error_counts = {}
    last_payloads = {}
    while not agent_stop_requested(stop_path, os.getpid(), run_id):
        errors, gpu, health = [], {}, {}
        scheduler = collect_scheduler(args.project_dir)
        traces = collect_traces(args.project_dir, scheduler)
        for worker in workers:
            wid = str(worker.get("id") or worker.get("name") or worker.get("target") or "")
            gpus, err = collect_worker_gpu(worker)
            if err:
                error_counts[wid] = error_counts.get(wid, 0) + 1
                errors.append(f"{wid}: {err}")
                health[wid] = {"status": "degraded", "lastError": err, "errorCount": error_counts[wid], "generatedAt": now_iso()}
            else:
                error_counts[wid] = 0
                gpu[wid] = gpus
                health[wid] = {"status": "ok", "lastOkAt": now_iso(), "errorCount": 0, "generatedAt": now_iso()}
        write_snapshots(args.project_dir, args.hub_id, workers, scheduler, traces, gpu, health, errors, ttl_seconds)
        payloads = {
            "scheduler_snapshot": {"schedulerStates": scheduler},
            "experiment_trace": {"experimentTraces": traces},
            "worker_health": {"health": health, "errors": errors},
        }
        for wid, gpus in gpu.items():
            payloads[f"gpu_snapshot:{wid}"] = {"workerId": wid, "gpus": gpus}
        for item in collect_live_output(scheduler):
            payloads[f"log_tail:{item.get('key')}"] = item
        for name, payload in payloads.items():
            text = json.dumps(payload, sort_keys=True, ensure_ascii=False)
            if last_payloads.get(name) != text or name == "health":
                typ = name.split(":", 1)[0]
                append_event(args.project_dir, {"type": typ, "workerId": payload.get("workerId", ""), "payload": payload, "partialFailure": bool(errors), "hubId": args.hub_id})
                last_payloads[name] = text
        append_event(args.project_dir, {"type": "agent_heartbeat", "payload": {"errors": errors, "partialFailure": bool(errors), "agentVersion": AGENT_VERSION}, "errors": [{"code": "worker_error", "message": e, "retryable": True} for e in errors], "partialFailure": bool(errors), "hubId": args.hub_id})
        time.sleep(sampler_sleep_seconds(poll_seconds, getattr(args, "jitter_seconds", 30.0)))
    append_event(args.project_dir, {"type": "worker_health", "payload": {"status": "stopped"}})
    return 0

def read_stream_event_batch(root, since, pos=0, journal_identity=None, warned_gap=False):
    journal = path_for(root, "events.jsonl")
    if not os.path.exists(journal):
        return [], None, pos, since, journal_identity, warned_gap
    try:
        with open(journal, "r", encoding="utf-8") as f:
            stat = os.fstat(f.fileno())
            current_identity = (int(stat.st_dev), int(stat.st_ino))
            if (journal_identity is not None and current_identity != journal_identity) or int(stat.st_size) < int(pos or 0):
                pos = 0
                warned_gap = False
            warning = None
            if not warned_gap:
                first_line = f.readline()
                if first_line:
                    try:
                        first = int(json.loads(first_line).get("seq", 0))
                        if since and since < first - 1:
                            warning = {"schemaVersion": SCHEMA_VERSION, "seq": first, "type": "agent_warning", "generatedAt": now_iso(), "source": "hub_agent", "hubId": "hub", "payload": {"code": "journal_gap", "message": "journal gap; read snapshot"}}
                    except Exception:
                        pass
                    warned_gap = True
            f.seek(int(pos or 0))
            events = []
            for line in f:
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                seq = int(event.get("seq") or 0)
                if seq > since:
                    events.append(event)
                    since = seq
            return events, warning, f.tell(), since, current_identity, warned_gap
    except (FileNotFoundError, OSError):
        return [], None, pos, since, journal_identity, warned_gap

def stream_events(args):
    pos = 0
    since = int(args.since or 0)
    journal_identity = None
    warned_gap = False
    while True:
        events, warning, pos, since, journal_identity, warned_gap = read_stream_event_batch(
            args.project_dir, since, pos, journal_identity, warned_gap
        )
        if warning:
            print(json.dumps(warning, ensure_ascii=False, separators=(",", ":")), flush=True)
        for event in events:
            handle_read_event_side_effects(args.project_dir, event)
            print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)
        time.sleep(0.5)

def iso_age_seconds(value):
    parsed = parse_iso_epoch(value)
    if parsed is None:
        return None
    return max(0, int(time.time() - parsed))

def api_snapshot(root):
    scheduler = read_runtime_json_cached(path_for(root, "cluster_snapshot.json"), {})
    gpu = read_runtime_json_cached(path_for(root, "gpu_snapshot.json"), {})
    traces = read_runtime_json_cached(path_for(root, "experiment_traces_snapshot.json"), {})
    diagnostics = api_diagnostics(root, include_token=False)
    tb = scheduler.get("tb") if isinstance(scheduler, dict) else {}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "gpu": gpu.get("gpu", {}),
        "scheduler": scheduler,
        "schedulerStates": scheduler.get("schedulerStates", []),
        "tb": tb if isinstance(tb, dict) else {},
        "traces": traces,
        "experimentTraces": traces.get("experimentTraces", []),
        "operations": recent_operations(root, 100),
        "diagnostics": diagnostics,
    }

def api_health(root, mode="realtime"):
    serving = mode in ("worker_telemetry", "hub_control")
    snapshot_name = "gpu_snapshot.json" if mode == "worker_telemetry" else "cluster_snapshot.json"
    snapshot = read_runtime_json_cached(path_for(root, snapshot_name), {})
    health = inspect_agent(root)
    age = iso_age_seconds(snapshot.get("generatedAt"))
    session = read_runtime_json_cached(path_for(root, "agent.session.json"), {}) if serving else {}
    started_at = session.get("startedAt") or health.get("startedAt") or now_iso()
    uptime = iso_age_seconds(started_at)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "state": "agent_ok",
        "agentVersion": health.get("agentVersion") or AGENT_VERSION,
        "apiVersion": API_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "schedulerVersion": RUNTIME_VERSION,
        "mode": "worker_telemetry" if mode == "worker_telemetry" else "realtime",
        "startedAt": started_at,
        "serverTime": now_iso(),
        "uptimeSeconds": uptime if uptime is not None else 0,
        "projectRoot": os.path.abspath(root),
        "agentInstallDir": agent_install_dir(root),
        "agentStateDir": agent_dir(root),
        "status": "ok" if serving or health.get("running") is not False else "degraded",
        "snapshotAge": age if age is not None else 999999,
        "workerCount": (1 if snapshot.get("gpu") or snapshot.get("gpus") else 0) if mode == "worker_telemetry" else len(snapshot.get("workers") or []),
        "schedulerDependencies": scheduler_dependency_health(root),
        "checkedAt": now_iso(),
    }

def api_version(root, mode="realtime"):
    health = api_health(root, mode)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "agentVersion": health.get("agentVersion") or AGENT_VERSION,
        "apiVersion": API_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "schedulerVersion": RUNTIME_VERSION,
        "mode": health.get("mode"),
        "checkedAt": now_iso(),
    }

def api_capabilities(root, token_required=False, mode="hub_control"):
    if mode == "worker_telemetry":
        return {
            "schemaVersion": SCHEMA_VERSION,
            "apiVersion": API_VERSION,
            "agentVersion": AGENT_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "pluginVersion": PLUGIN_VERSION,
            "schedulerVersion": RUNTIME_VERSION,
            "mode": "worker_telemetry",
            "actionApiVersion": 2,
            "realActionRuntime": True,
            "endpoints": {
                "health": True,
                "version": True,
                "capabilities": True,
                "gpu": True,
                "gpuHistory": True,
                "workerAvailability": True,
                "workerHubUplink": True,
                "workerTasks": True,
                "durablePlanQueue": True,
                "codeSyncProof": True,
                "idleGpuAdmission": True,
                "queuedJobRecall": True,
                "liveOutput": True,
                "diagnostics": True,
                "resultsSummary": True,
                "websocketEvents": False,
                "sseEvents": True,
                "actions": True,
                "fileList": False,
                "fileDownload": True,
                "fileUploadChunk": False,
            },
            "actionEndpoints": {
                "start-worker-task": True,
                "register-code-sync-proof": True,
                "rebuild-distributed-results": True,
                "retry-worker-task": True,
                "stop-worker-task": True,
                "stop-worker-task-exact-pane": True,
                "delete-worker-artifacts": True,
                "archive-worker-artifacts": True,
                "validate-plan": True,
                "dry-run-plan": True,
                "run-plan": True,
                "reproduce-plan": True,
                "stop-scheduler-operation": True,
                **{name: True for name in WORKER_RESULT_ACTIONS},
                **{name: True for name in WORKER_TENSORBOARD_ACTIONS},
                **{name: True for name in WORKER_ENV_ACTIONS},
            },
        }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "apiVersion": API_VERSION,
        "agentVersion": AGENT_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "schedulerVersion": RUNTIME_VERSION,
        "mode": "hub_control",
        "actionApiVersion": 2,
        "realActionRuntime": True,
        "endpoints": {
            "health": True,
            "version": True,
            "snapshot": True,
            "gpu": True,
            "gpuHistory": True,
            "workerAvailability": True,
            "workerHubUplink": True,
            "scheduler": True,
            "traces": True,
            "liveOutput": True,
            "diagnostics": True,
            "auditTail": True,
            "resultsSummary": True,
            "openapi": True,
            "websocketEvents": False,
            "sseEvents": True,
            "logsTail": True,
            "fileList": True,
            "fileStat": True,
            "fileDownload": True,
            "fileRangeDownload": True,
            "fileUploadInit": True,
            "fileUploadChunk": True,
            "fileUploadComplete": True,
            "fileUploadCancel": True,
            "fileTransferStatus": True,
            "actions": True,
        },
        "actionEndpoints": {name: True for name in ACTION_NAMES},
        "limits": {
            "maxUploadChunkBytes": 1024 * 1024,
            "maxDownloadChunkBytes": 8 * 1024 * 1024,
            "maxConcurrentTransfers": 1,
            "maxPathLength": 4096,
        },
        "auth": {
            "required": bool(token_required),
            "scheme": "bearer" if token_required else "none",
        },
    }

def api_file_capabilities():
    return {
        "schemaVersion": SCHEMA_VERSION,
        "rootPolicy": "project_root_only",
        "supportsList": True,
        "supportsStat": True,
        "supportsDownload": True,
        "supportsRangeDownload": True,
        "supportsUploadChunk": True,
        "supportsUploadCancel": True,
        "supportsSha256": True,
        "supportsResume": True,
        "maxUploadChunkBytes": 1024 * 1024,
        "safeRoots": ["simple_cluster", "work_dirs", "experiments", "exports", "results", "paper"],
    }

def cluster_scheduler_path(root):
    here = os.path.abspath(__file__)
    sibling = os.path.join(os.path.dirname(here), "cluster_scheduler.py")
    if os.path.exists(sibling):
        return sibling
    project = os.path.join(os.path.abspath(root), "simple_cluster", "runtime", "cluster_scheduler.py")
    return project if os.path.exists(project) else ""

def action_payload_text(payload, *keys):
    for key in keys:
        value = str(payload.get(key) or "").strip()
        if value and value != "-":
            return value
    return ""

def action_options(payload):
    value = payload.get("options")
    return value if isinstance(value, dict) else {}

def action_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")

def action_debug_mode(payload):
    body = payload if isinstance(payload, dict) else {}
    options = action_options(body)
    return any(action_bool(value) for value in (body.get("debugMode"), body.get("debug_mode"), options.get("debugMode"), options.get("debug_mode")))

def action_debug_run_id(payload):
    body = payload if isinstance(payload, dict) else {}
    options = action_options(body)
    return str(body.get("debugRunId") or body.get("debug_run_id") or options.get("debugRunId") or options.get("debug_run_id") or "").strip()

DEBUG_BLOCKED_ACTIONS = {
    "archive-artifacts", "archive-worker-artifacts", "archive-plan-copy", "exclude-results", "sync-artifacts", "complete-three-way",
    "delete-artifacts", "delete-worker-artifacts", "reconcile-deletions", "parse-results",
    "refresh-results", "rescan-results", "run-quality-gate", "run-statistics", "export-paper-table",
    "check-claim-evidence", "check-output-contract", "parse-case-level", "run-leakage-check",
    "run-subgroup-analysis", "export-case-analysis", "plan-checkpoint-retention", "export-plotting-contract",
    "inspect-dataset", "create-offline-bundle", "infer-config-from-run", "recover-plan-from-run", "diagnose-result-anomaly", "compare-with-best-config",
}

def action_targets_debug_run(payload):
    values = action_values(payload, "selectedArchiveKeys", "selectedRunKeys", "archiveKey", "runKey", "artifactPath", "resultPath", "logPath", "path", "remotePath") + action_task_target_values(payload)
    return any(str(value or "").replace("\\", "/").lstrip("/").startswith("simple_cluster/debug_runs/") for value in values)

def action_plan_file(payload):
    options = action_options(payload)
    return action_payload_text(payload, "planFile", "plan", "selectedPlanId") or action_payload_text(options, "planFile", "plan", "selectedPlanId")

def action_values(payload, *keys):
    out = []
    options = action_options(payload)
    for source in (payload, options):
        for key in keys:
            value = source.get(key) if isinstance(source, dict) else None
            if isinstance(value, list):
                out.extend(str(item).strip() for item in value if str(item or "").strip() and str(item or "").strip() != "-")
            elif value is not None:
                text = str(value).strip()
                if text and text != "-":
                    out.append(text)
    return list(dict.fromkeys(out))

def action_task_target_values(payload):
    out = []
    options = action_options(payload)
    for source in (payload, options):
        targets = source.get("selectedTaskTargets") if isinstance(source, dict) else None
        if not isinstance(targets, list):
            continue
        for target in targets:
            if not isinstance(target, dict):
                continue
            for key in ("resultPath", "result_path", "archiveKey", "archive_key", "runKey", "run_key", "experimentId", "experiment_id", "taskUiKey", "task_ui_key", "logPath", "log_path", "remotePath", "path"):
                text = str(target.get(key) or "").strip()
                if text and text != "-":
                    out.append(text)
    return list(dict.fromkeys(out))

def append_project_jsonl(root, relative, rows):
    target = safe_project_path(root, relative)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

def scheduler_plan_runtime_key(root, plan=""):
    raw = str(plan or "").strip()
    try:
        path = pathlib.Path(raw)
        resolved = path.resolve()
        try:
            identity = resolved.relative_to(pathlib.Path(root).resolve()).as_posix()
        except Exception:
            identity = resolved.as_posix()
    except Exception:
        identity = raw.replace("\\", "/")
    stem = os.path.splitext(os.path.basename(raw))[0] or "plan"
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in stem).strip(".-_") or "plan"
    if len(safe) > 34:
        safe = safe[:34].rstrip(".-_") or "plan"
    digest = hashlib.sha1((identity or raw or "plan").encode("utf-8")).hexdigest()[:10]
    return f"{safe}-{digest}"

def scheduler_control_paths(root, plan=""):
    base = os.path.join(root, "simple_cluster", "tmp", "cluster_scheduler")
    if plan:
        safe = scheduler_plan_runtime_key(root, plan)
        return [os.path.join(base, f"{safe}_control.json")] if safe else []
    return glob.glob(os.path.join(base, "*_control.json"))

def write_scheduler_control(root, action, plan="", reason="manual_action", extra=None):
    paths = scheduler_control_paths(root, plan)
    if not paths:
        base = os.path.join(root, "simple_cluster", "tmp", "cluster_scheduler")
        os.makedirs(base, exist_ok=True)
        paths = [os.path.join(base, "manual_control.json")]
    payload = {"action": action, "reason": reason, "updated_at": now_iso()}
    if isinstance(extra, dict):
        payload.update(extra)
    for path in paths:
        atomic_write(path, payload)
    return paths

def archive_state_relpath(plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    slug = plan_summary_slug(plan_norm)
    if slug:
        return f"simple_cluster/archive_state/by_plan/{slug}.json"
    return "simple_cluster/archive_state.json"

def archive_ownership_fields(ownership=None):
    fields = ownership if isinstance(ownership, dict) else {}
    owner = str(fields.get("resultOwnerWorkerId") or fields.get("schedulerOwnerWorkerId") or "").strip()
    return {
        **({"topologyMode": str(fields.get("topologyMode") or "").strip()} if str(fields.get("topologyMode") or "").strip() else {}),
        **({"workerSetRevision": str(fields.get("workerSetRevision") or "").strip()} if str(fields.get("workerSetRevision") or "").strip() else {}),
        **({"resultOwnerWorkerId": owner, "workerId": owner} if owner else {}),
        **({"automaticBackup": False} if str(fields.get("topologyMode") or "").strip() in ("single_worker", "worker_pool") else {}),
    }

def mark_archive_state(root, keys, status, plan=None, plan_revision="", ownership=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    revision = str(plan_revision or "").strip()
    path = safe_project_path(root, archive_state_relpath(plan_norm or None))
    data = read_json(path, {})
    if not isinstance(data, dict):
        data = {}
    entries = data.get("entries") if isinstance(data.get("entries"), dict) else {}
    owner_fields = archive_ownership_fields(ownership)
    for key in keys:
        entries[key] = {
            "archived": True,
            "path": key,
            "status": status,
            "archived_at": entries.get(key, {}).get("archived_at") or now_iso(),
            "last_verified_at": now_iso(),
            "planFile": plan_norm or entries.get(key, {}).get("planFile") or "",
            "planRevision": revision or entries.get(key, {}).get("planRevision") or "",
            **owner_fields,
        }
    data["schemaVersion"] = 1
    data["project"] = os.path.basename(os.path.abspath(root))
    data["updated_at"] = now_iso()
    data["planFile"] = plan_norm or data.get("planFile") or ""
    data["planRevision"] = revision or data.get("planRevision") or ""
    data.update(owner_fields)
    data["entries"] = entries
    atomic_write(path, data)
    # Keep project-level latest alias for unscoped consumers.
    if plan_norm:
        atomic_write(safe_project_path(root, "simple_cluster/archive_state.json"), data)

def mark_result_review_state(root, keys, status, plan=None, plan_revision="", ownership=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    revision = str(plan_revision or "").strip()
    if not plan_norm:
        raise ValueError("缺少 planFile，不能安全修改结果取舍状态。")
    if not revision:
        raise ValueError("缺少 Plan revision，不能安全修改旧任务或历史结果。")
    path = safe_project_path(root, archive_state_relpath(plan_norm))
    data = read_json(path, {})
    if not isinstance(data, dict):
        data = {}
    entries = data.get("entries") if isinstance(data.get("entries"), dict) else {}
    now = now_iso()
    owner_fields = archive_ownership_fields(ownership)
    for key in keys:
        normalized = normalize_artifact_key(key)
        if not normalized:
            continue
        previous = entries.get(normalized) if isinstance(entries.get(normalized), dict) else {}
        entries[normalized] = {
            **previous,
            "archived": False,
            "excluded": status == "excluded",
            "path": normalized,
            "status": status,
            "excluded_at": previous.get("excluded_at") or now if status == "excluded" else "",
            "last_verified_at": now,
            "planFile": plan_norm,
            "planRevision": revision,
            **owner_fields,
        }
    data["schemaVersion"] = 1
    data["project"] = os.path.basename(os.path.abspath(root))
    data["updated_at"] = now
    data["planFile"] = plan_norm
    data["planRevision"] = revision
    data.update(owner_fields)
    data["entries"] = entries
    atomic_write(path, data)
    atomic_write(safe_project_path(root, "simple_cluster/archive_state.json"), data)

def archive_manifest_entry(root, target):
    item = {"path": str(target), "exists": False, "files": [], "fileCount": 0, "totalBytes": 0}
    try:
        path = safe_project_path(root, target)
    except Exception as exc:
        item["error"] = str(exc)
        return item
    if not os.path.exists(path):
        item["error"] = "target not found"
        return item
    item["exists"] = True
    if os.path.islink(path):
        item["error"] = "archive path crosses symbolic link"
        return item
    if os.path.isfile(path):
        size = os.path.getsize(path)
        file_item = {"path": relpath(root, path), "size": size, "mtime": int(os.path.getmtime(path))}
        if safe_small_file(path, 20 * 1024 * 1024):
            file_item["sha256"] = sha256_file(path)
        item["files"].append(file_item)
        item["fileCount"] = 1
        item["totalBytes"] = size
        return item
    for current, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features") and not d.startswith(".") and not os.path.islink(os.path.join(current, d))]
        for name in files:
            full = os.path.join(current, name)
            try:
                if os.path.islink(full):
                    item.setdefault("errors", []).append({"path": relpath(root, full), "error": "archive path crosses symbolic link"})
                    continue
                size = os.path.getsize(full)
                item["fileCount"] += 1
                item["totalBytes"] += size
                if len(item["files"]) < 500:
                    file_item = {"path": relpath(root, full), "size": size, "mtime": int(os.path.getmtime(full))}
                    if safe_small_file(full, 20 * 1024 * 1024):
                        file_item["sha256"] = sha256_file(full)
                    item["files"].append(file_item)
            except Exception as exc:
                item.setdefault("errors", []).append({"path": relpath(root, full), "error": str(exc)})
    if item["fileCount"] > len(item["files"]):
        item["truncated"] = True
    return item

def prepare_archive_manifest(root, keys, action, op_id, plan=None, ownership=None):
    resolved_keys, legacy_resolved = resolve_archive_target_keys(root, keys)
    plan_norm = normalize_result_candidate(plan) if plan else ""
    slug = plan_summary_slug(plan_norm)
    rel_dir = f"simple_cluster/archive_manifests/by_plan/{slug}" if slug else "simple_cluster/archive_manifests"
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "action": action,
        "opId": op_id,
        "project": os.path.basename(os.path.abspath(root)),
        "preparedAt": now_iso(),
        "requestedTargets": list(keys),
        "legacyResolved": legacy_resolved,
        "planFile": plan_norm or "",
        "targets": [archive_manifest_entry(root, key) for key in resolved_keys],
        **archive_ownership_fields(ownership),
    }
    manifest["targetCount"] = len(manifest["targets"])
    manifest["fileCount"] = sum(int(item.get("fileCount") or 0) for item in manifest["targets"])
    manifest["totalBytes"] = sum(int(item.get("totalBytes") or 0) for item in manifest["targets"])
    manifest["missingCount"] = len([item for item in manifest["targets"] if not item.get("exists")])
    out = safe_project_path(root, f"{rel_dir}/{op_id}.json")
    atomic_write(out, manifest)
    atomic_write(safe_project_path(root, "simple_cluster/archive_manifests/latest.json"), manifest)
    if slug:
        atomic_write(safe_project_path(root, f"{rel_dir}/latest.json"), manifest)
    append_event(root, {"type": "archive_manifest_prepared", "operationId": op_id, "payload": {"action": action, "path": relpath(root, out), "targetCount": manifest["targetCount"], "fileCount": manifest["fileCount"], "missingCount": manifest["missingCount"], "planFile": plan_norm or ""}})
    return manifest, relpath(root, out), resolved_keys

def resolve_archive_target_keys(root, keys):
    resolved = []
    legacy_resolved = {}
    for key in keys:
        text = str(key or "").strip()
        exists = False
        try:
            exists = os.path.exists(safe_project_path(root, text))
        except Exception:
            exists = False
        if exists:
            resolved.append(text)
            continue
        paths = legacy_delete_candidate_paths(root, text)
        if paths:
            rels = [relpath(root, path) for path in paths]
            legacy_resolved[text] = rels
            resolved.extend(rels)
            append_event(root, {"type": "legacy_archive_resolved", "payload": {"target": text, "resolvedPaths": rels}})
        else:
            resolved.append(text)
    return unique_preserve_order(resolved), legacy_resolved

def unique_preserve_order(values):
    out = []
    seen = set()
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out

def complete_three_way_report(root, keys, op_id, plan=None, ownership=None):
    keys, legacy_resolved = resolve_archive_target_keys(root, keys)
    plan_norm = normalize_result_candidate(plan) if plan else ""
    slug = plan_summary_slug(plan_norm)
    rel_dir = f"simple_cluster/archive_manifests/by_plan/{slug}" if slug else "simple_cluster/archive_manifests"
    entries = read_archive_entries(root, plan_norm or None)
    targets = []
    missing_count = 0
    unarchived_count = 0
    for key in keys:
        item = archive_manifest_entry(root, key)
        archived = bool((entries.get(key) or {}).get("archived"))
        if not item.get("exists"):
            missing_count += 1
        if not archived:
            unarchived_count += 1
        item["archiveState"] = entries.get(key) or {}
        item["threeWayStatus"] = "ok" if item.get("exists") and archived else ("missing" if not item.get("exists") else "not_archived")
        targets.append(item)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "opId": op_id,
        "checkedAt": now_iso(),
        "project": os.path.basename(os.path.abspath(root)),
        "legacyResolved": legacy_resolved,
        "planFile": plan_norm or "",
        "targetCount": len(targets),
        "missingCount": missing_count,
        "unarchivedCount": unarchived_count,
        "status": "passed" if targets and missing_count == 0 and unarchived_count == 0 else "failed",
        "targets": targets,
        **archive_ownership_fields(ownership),
    }
    out = safe_project_path(root, f"{rel_dir}/{op_id}_three_way.json")
    atomic_write(out, report)
    if slug:
        atomic_write(safe_project_path(root, f"{rel_dir}/latest_three_way.json"), report)
        atomic_write(safe_project_path(root, f"simple_cluster/archive_manifests/{op_id}_three_way.json"), report)
    append_event(root, {"type": "three_way_checked", "operationId": op_id, "payload": {"opId": op_id, "path": relpath(root, out), "status": report["status"], "targetCount": report["targetCount"], "missingCount": missing_count, "unarchivedCount": unarchived_count, "planFile": plan_norm or ""}})
    return report, relpath(root, out)

def validate_exact_delete_tree(root_real, target_path, root_device):
    if os.path.islink(target_path):
        raise ValueError("拒绝删除符号链接")
    if not os.path.lexists(target_path):
        return
    target_stat = os.stat(target_path, follow_symlinks=False)
    if target_stat.st_dev != root_device:
        raise ValueError("删除目标跨越文件系统边界")
    if not os.path.isdir(target_path):
        if not os.path.isfile(target_path):
            raise ValueError("删除目标不是普通文件或目录")
        return
    inspected = 0
    for current, dirs, files in os.walk(target_path, topdown=True, followlinks=False):
        inspected += 1 + len(dirs) + len(files)
        if inspected > 100000:
            raise ValueError("删除目录包含过多条目，拒绝递归删除")
        if os.path.realpath(current) != current or os.stat(current, follow_symlinks=False).st_dev != root_device:
            raise ValueError("删除目录包含越界路径或挂载点")
        for name in list(dirs) + list(files):
            child = os.path.join(current, name)
            child_stat = os.lstat(child)
            if stat.S_ISLNK(child_stat.st_mode):
                raise ValueError(f"删除目录包含符号链接：{os.path.relpath(child, root_real)}")
            if child_stat.st_dev != root_device:
                raise ValueError(f"删除目录包含跨文件系统条目：{os.path.relpath(child, root_real)}")

def remove_project_targets(root, targets, confirmed=False, path_confirmed=False):
    if confirmed is not True or path_confirmed is not True:
        raise ValueError("CONFIRM_REQUIRED: 必须分别确认删除操作和完整路径")
    deleted, residues, skipped = [], [], []
    root_real = os.path.realpath(root)
    if not os.path.isdir(root_real) or root_real == os.path.dirname(root_real):
        raise ValueError("PARENT_CD_FAILED: 项目安全根目录不可用")
    root_device = os.stat(root_real, follow_symlinks=False).st_dev
    for target in targets:
        raw = str(target or "").strip().replace("\\", "/")
        if not raw or raw in (".", "..") or raw.startswith("-"):
            skipped.append({"path": raw, "reason": "必须提供精确的完整路径"})
            continue
        try:
            path = safe_project_delete_path(root_real, raw)
            relative = os.path.relpath(path, root_real)
            if relative in (".", "..") or relative.startswith(".." + os.sep):
                raise ValueError("删除目标超出项目根目录")
            parent = os.path.dirname(path)
            if os.path.realpath(parent) != parent or os.path.commonpath((root_real, parent)) != root_real or parent == root_real:
                raise ValueError("PARENT_CD_FAILED: 父目录不在项目安全根内")
            parent_relative = os.path.relpath(parent, root_real)
            cursor = root_real
            if parent_relative != ".":
                for part in parent_relative.split(os.sep):
                    cursor = os.path.join(cursor, part)
                    if os.path.islink(cursor) or os.path.realpath(cursor) != cursor:
                        raise ValueError("PARENT_CD_FAILED: 父目录路径包含符号链接")
                    if os.stat(cursor, follow_symlinks=False).st_dev != root_device:
                        raise ValueError("PARENT_CD_FAILED: 父目录跨越文件系统边界")
            if not os.path.lexists(path):
                skipped.append({"path": raw, "resolvedPath": relative.replace(os.sep, "/"), "reason": "missing"})
                continue
            validate_exact_delete_tree(root_real, path, root_device)
            if os.name != "posix":
                raise ValueError("PARENT_CD_FAILED: 当前平台不支持经过物理父目录校验的精确删除")
            leaf = os.path.basename(path)
            relative_target = "./" + leaf
            script = 'cd -- "$1" || exit 41; [ "$(pwd -P)" = "$1" ] || exit 42; [ -e "$2" ] && [ ! -L "$2" ] || exit 43; if [ -d "$2" ]; then rm -r -- "$2"; else rm -- "$2"; fi'
            completed = subprocess.run(["/bin/sh", "-c", script, "artifact-delete", parent, relative_target],
                cwd=parent, capture_output=True, text=True, timeout=120)
            if completed.returncode != 0:
                reason = "PARENT_CD_FAILED" if completed.returncode in (41, 42) else (completed.stderr.strip()[:240] or "精确删除命令失败")
                raise ValueError(reason)
            if os.path.lexists(path):
                raise ValueError("删除后目标仍存在")
            deleted.append(relative.replace(os.sep, "/"))
        except Exception as exc:
            residues.append({"path": raw, "error": str(exc)[:320]})
    return deleted, residues, skipped

METRIC_ALIASES = {
    "acc": "accuracy",
    "top1": "top1_accuracy",
    "top_1": "top1_accuracy",
    "top1_acc": "top1_accuracy",
    "top5": "top5_accuracy",
    "top_5": "top5_accuracy",
    "top5_acc": "top5_accuracy",
    "auc": "AUC",
    "auroc": "AUC",
    "roc_auc": "AUC",
    "pr_auc": "AUPRC",
    "auprc": "AUPRC",
    "average_precision": "AUPRC",
    "ap": "AUPRC",
    "macro_f1": "F1",
    "micro_f1": "F1",
    "weighted_f1": "F1",
    "f1_macro": "F1",
    "f1_micro": "F1",
    "f1_weighted": "F1",
    "macro_precision": "precision",
    "micro_precision": "precision",
    "weighted_precision": "precision",
    "macro_recall": "recall",
    "micro_recall": "recall",
    "weighted_recall": "recall",
    "sensitivity": "recall",
    "tpr": "recall",
    "tnr": "specificity",
    "balanced_acc": "balanced_accuracy",
    "bal_acc": "balanced_accuracy",
    "npv": "NPV",
    "negative_predictive_value": "NPV",
    "ppv": "PPV",
    "positive_predictive_value": "PPV",
    "fpr": "FPR",
    "false_positive_rate": "FPR",
    "fnr": "FNR",
    "false_negative_rate": "FNR",
    "mcc": "MCC",
    "matthews_corrcoef": "MCC",
    "cohen_kappa": "kappa",
    "brier_score": "brier",
    "log_loss": "loss",
    "cross_entropy": "loss",
    "ce_loss": "loss",
    "dice": "DSC",
    "dsc": "DSC",
    "iou": "IoU",
    "hd95": "HD95",
    "asd": "ASD",
    "mae": "MAE",
    "mse": "MSE",
    "rmse": "RMSE",
    "r2": "R2",
}
KNOWN_METRICS = {
    "AUC", "AUPRC", "accuracy", "top1_accuracy", "top5_accuracy", "F1", "precision", "recall",
    "specificity", "balanced_accuracy", "NPV", "PPV", "FPR", "FNR", "MCC", "kappa", "ECE", "brier", "loss",
    "DSC", "Dice", "IoU", "HD95", "ASD", "MAE", "MSE", "RMSE", "R2",
}
LOWER_IS_BETTER = {"loss", "ECE", "brier", "HD95", "ASD", "FPR", "FNR", "MAE", "MSE", "RMSE"}
CLASSIFICATION_METRIC_PRIORITY = ["AUC", "accuracy", "F1", "AUPRC", "precision", "recall", "specificity", "balanced_accuracy", "NPV", "PPV", "MCC", "kappa", "ECE", "brier", "loss"]
SEGMENTATION_METRIC_PRIORITY = ["DSC", "Dice", "IoU", "HD95", "ASD"]
METRIC_DECORATORS = {"train", "val", "valid", "validation", "test", "external", "ext", "best", "final", "last", "mean", "avg", "average", "eval", "score", "metric", "macro", "micro", "weighted"}
DIMENSION_COLUMNS = {"experiment_id", "experimentId", "run_key", "runKey", "suite", "method", "dataset", "split", "fold", "seed", "case", "case_name", "model", "tag"}
NON_METRIC_COLUMNS = {"index", "experiment_index", "job_index", "job_count", "gpu_id", "gpu", "pid", "exit_code", "status", "state", "output_dir", "log_path"}
RESULT_FILE_NAMES = {"results.csv", "metrics.csv", "metrics_summary.csv", "metrics_case.csv", "summary.csv", "scores.csv", "score.csv", "detailed_metrics.csv", "test_metrics.csv", "classification_report.csv", "result.csv"}
JSON_RESULT_NAMES = {"metrics.json", "summary.json", "result.json", "results.json", "classification_report.json"}
TEXT_RESULT_NAMES = {"summary.txt", "result.txt", "results.txt", "classification_report.txt", "stdout.log", "stderr.log", "train.log", "test.log", "console.log", "output.out"}
STRUCTURED_RESULT_DIAGNOSTIC_LOGS = {"stdout.log", "stderr.log"}
IGNORED_RESULT_FILES = {
    "experiments/results/jobs.csv",
    "jobs.csv",
    "simple_cluster/results/summary.json",
    "simple_cluster/results_summary.json",
    "simple_cluster/results/result_registry.json",
    "simple_cluster/results/statistics.json",
    "simple_cluster/results/quality_gate.json",
    "simple_cluster/results/claim_evidence.json",
    "simple_cluster/results/case_level_index.json",
    "simple_cluster/results/leakage_check.json",
    "simple_cluster/results/subgroup_analysis.json",
}

def metric_name(value, aliases=None):
    raw = str(value or "").strip()
    if not raw:
        return ""
    lower = raw.lower().replace("-", "_").replace(" ", "_")
    alias_map = aliases or {}
    for key in (raw, lower):
        if key in alias_map:
            return alias_map[key]
    parts = [part for part in lower.split("_") if part]
    while parts and parts[0] in METRIC_DECORATORS:
        parts.pop(0)
    while parts and parts[-1] in METRIC_DECORATORS:
        parts.pop()
    compact = "_".join(parts) if parts else lower
    return METRIC_ALIASES.get(raw, METRIC_ALIASES.get(lower, METRIC_ALIASES.get(compact, raw)))

def metric_direction(metric):
    return "lower" if metric in LOWER_IS_BETTER or metric.lower() in LOWER_IS_BETTER else "higher"

def coerce_metric_value(value):
    text = str(value if value is not None else "").strip()
    if not text:
        return None
    percent = text.endswith("%")
    if percent:
        text = text[:-1].strip()
    try:
        number = float(text)
        if percent:
            number = number / 100.0
        return number
    except Exception:
        return value

def is_number(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value not in (float("inf"), float("-inf"))
    except Exception:
        return False

def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()

def relpath(root, path):
    return os.path.relpath(path, root).replace("\\", "/")

def safe_small_file(path, max_bytes=5 * 1024 * 1024):
    try:
        return os.path.isfile(path) and os.path.getsize(path) <= max_bytes
    except Exception:
        return False

def discover_result_files(root, limit=240, max_dirs=4000, max_depth=8, deadline_seconds=6.0):
    roots = ["experiments", "work_dirs", "results", "simple_cluster", "outputs", "runs", "logs", "test_results", "lightning_logs", "custom_results", "reports", "artifacts", "evals", "eval", "evaluation", "predictions", "submissions"]
    out = []
    started = time.time()
    visited_dirs = 0
    for name in sorted(RESULT_FILE_NAMES.union(JSON_RESULT_NAMES, TEXT_RESULT_NAMES) - STRUCTURED_RESULT_DIAGNOSTIC_LOGS):
        path = os.path.join(root, name)
        if safe_small_file(path):
            out.append(name)
    for top in roots:
        base = os.path.join(root, top)
        if not os.path.isdir(base):
            continue
        for current, dirs, files in os.walk(base):
            visited_dirs += 1
            if visited_dirs >= max_dirs or time.time() - started >= deadline_seconds:
                dirs[:] = []
                return sorted(dict.fromkeys(out))
            depth = len(os.path.relpath(current, base).split(os.sep)) if os.path.relpath(current, base) != "." else 0
            if depth >= max_depth:
                dirs[:] = []
            else:
                dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features", "debug_runs") and not d.startswith(".")]
            for name in files:
                lower = name.lower()
                if lower in STRUCTURED_RESULT_DIAGNOSTIC_LOGS:
                    continue
                rel = relpath(root, os.path.join(current, name))
                if rel.replace("\\", "/").lstrip("/").startswith("simple_cluster/debug_runs/"):
                    continue
                if rel.lower() in IGNORED_RESULT_FILES or os.path.basename(rel).lower() == "jobs.csv":
                    continue
                if "/checkpoints/" in rel or "/weights/" in rel or "/datasets/" in rel:
                    continue
                result_dir = rel.startswith("experiments/results/") or rel.startswith("results/") or rel.startswith("outputs/") or rel.startswith("runs/") or rel.startswith("logs/") or rel.startswith("test_results/") or rel.startswith("lightning_logs/") or rel.startswith("custom_results/") or rel.startswith("reports/") or rel.startswith("artifacts/") or rel.startswith("evals/") or rel.startswith("eval/") or rel.startswith("evaluation/") or rel.startswith("predictions/") or rel.startswith("submissions/") or "/test_results/" in rel or "/logs/" in rel or "/lightning_logs/" in rel or "/custom_results/" in rel or "/reports/" in rel or "/artifacts/" in rel or "/evals/" in rel or "/evaluation/" in rel or "/predictions/" in rel or "/submissions/" in rel
                result_like_csv = result_dir and lower.endswith(".csv")
                result_like_json = result_dir and lower.endswith(".json")
                result_like_text = result_dir and lower.endswith((".txt", ".log", ".out"))
                if (lower in RESULT_FILE_NAMES or lower in TEXT_RESULT_NAMES or lower in JSON_RESULT_NAMES or result_like_csv or result_like_json or result_like_text or lower.endswith(".metrics.json")) and parseable_result_candidate(rel):
                    path = os.path.join(current, name)
                    if safe_small_file(path):
                        out.append(rel)
                if len(out) >= limit:
                    return sorted(dict.fromkeys(out))
    return sorted(dict.fromkeys(out))

def plan_suite_value(root, plan):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    if not plan_norm:
        return ""
    try:
        plan_path = safe_project_path(root, plan_norm)
        plan_text = open(plan_path, "r", encoding="utf-8", errors="replace").read()
        return str(yaml_scalar(uncommented_yaml_text(plan_text), "suite", "") or "").strip()
    except Exception:
        return ""


def job_result_candidates(root, limit=240, plan=None):
    path = os.path.join(root, "experiments", "results", "jobs.csv")
    if not safe_small_file(path):
        return []
    out = []
    plan_norm = normalize_result_candidate(plan) if plan else ""
    plan_suite = plan_suite_value(root, plan_norm)
    try:
        rows = read_csv_dicts(open(path, "r", encoding="utf-8", errors="replace").read())
    except Exception:
        return []
    for row in rows:
        if plan_norm:
            row_plan = normalize_result_candidate(row.get("plan_file") or row.get("planFile") or "")
            if row_plan:
                if row_plan != plan_norm:
                    continue
            elif plan_suite and str(row.get("suite") or "").strip() != plan_suite:
                continue
            elif not plan_suite:
                continue
        for key in ("result_csv", "resultCsv", "results_csv", "resultsCsv", "metrics_csv", "metricsCsv", "summary_csv", "summaryCsv", "output_csv", "outputCsv", "result_json", "resultJson", "metrics_json", "metricsJson", "summary_txt", "summaryTxt", "log_file", "logFile", "metrics_summary", "metricsSummary", "metrics_case", "metricsCase", "result_path", "resultPath", "output_path", "outputPath"):
            candidate = normalize_result_candidate(row.get(key))
            if candidate:
                out.append(candidate)
        for key in ("output_dir", "outputDir", "work_dir", "workDir", "result_dir", "resultDir", "results_dir", "resultsDir", "log_dir", "logDir"):
            out.extend(default_result_candidates_for_dir(row.get(key)))
        if len(out) >= limit:
            break
    return sorted(dict.fromkeys(out))

def plan_scoped_discover_candidates(root, plan, limit=120):
    declared = plan_declared_result_candidates(root, plan, limit=limit)
    plan_suite = plan_suite_value(root, plan).lower()
    dirs = []
    for item in declared:
        text = normalize_result_candidate(item)
        if not text:
            continue
        if re.search(r"\.(csv|json|txt|log|out)$", text, re.I):
            parent = "/".join(text.split("/")[:-1])
            parent_parts = [part.lower() for part in parent.split("/") if part]
            if parent and plan_suite and plan_suite in parent_parts and not any(ch in parent for ch in "*?[]"):
                dirs.append(parent)
        elif not any(ch in text for ch in "*?[]"):
            dirs.append(text)
    out = []
    for directory in unique_values(dirs)[:24]:
        if len(out) >= limit:
            break
        out.extend(discover_result_files_under(root, directory, max(0, limit - len(out)), max_dirs=80, max_depth=3))
    return sorted(dict.fromkeys(out))[:limit]

def job_result_candidates_for_keys(root, keys, limit=240):
    path = os.path.join(root, "experiments", "results", "jobs.csv")
    if not safe_small_file(path):
        return []
    wanted = {str(item or "").strip() for item in keys or [] if str(item or "").strip()}
    if not wanted:
        return []
    out = []
    try:
        rows = read_csv_dicts(open(path, "r", encoding="utf-8", errors="replace").read())
    except Exception:
        return []
    id_keys = ("run_key", "runKey", "experiment_id", "experimentId", "case", "case_id", "id", "name", "archiveKey", "archive_key")
    result_keys = ("result_csv", "resultCsv", "results_csv", "resultsCsv", "metrics_csv", "metricsCsv", "summary_csv", "summaryCsv", "output_csv", "outputCsv", "result_json", "resultJson", "metrics_json", "metricsJson", "summary_txt", "summaryTxt", "log_file", "logFile", "metrics_summary", "metricsSummary", "metrics_case", "metricsCase", "result_path", "resultPath", "output_path", "outputPath")
    for row in rows:
        row_ids = {str(row.get(key) or "").strip() for key in id_keys if str(row.get(key) or "").strip()}
        if not row_ids.intersection(wanted):
            continue
        for key in result_keys:
            candidate = normalize_result_candidate(row.get(key))
            if candidate:
                out.append(candidate)
        for key in ("output_dir", "outputDir", "work_dir", "workDir", "result_dir", "resultDir", "results_dir", "resultsDir", "log_dir", "logDir"):
            out.extend(default_result_candidates_for_dir(row.get(key)))
        if len(out) >= limit:
            break
    return sorted(dict.fromkeys(out))

def parse_csv_line(line):
    return next(csv.reader([line]))

def read_csv_dicts(text):
    reader = csv.DictReader(io.StringIO(text))
    return list(reader)

def infer_dimension(row, key, fallback=""):
    for candidate in (key, key.replace("_", ""), key.replace("_", "-")):
        if row.get(candidate):
            return row.get(candidate)
    return fallback

def row_dimension_value(row, key):
    if not isinstance(row, dict):
        return ""
    camel = "".join(part[:1].upper() + part[1:] if i else part for i, part in enumerate(str(key).split("_")))
    aliases = {
        "method": ("method", "Method", "model_name", "modelName", "algorithm", "algo", "baseline", "approach"),
        "dataset": ("dataset", "Dataset", "data", "data_name", "dataName"),
        "split": ("split", "Split", "partition"),
        "fold": ("fold", "Fold", "cv_fold", "cvFold"),
        "seed": ("seed", "Seed", "random_seed", "randomSeed"),
        "case": ("case", "Case", "case_name", "caseName", "case_id", "caseId"),
        "eval_protocol": ("eval_protocol", "evaluation_protocol", "test_endpoint", "endpoint"),
        "rate_percent": ("rate_percent", "train_rate_percent"),
        "train_rate": ("train_rate", "training_rate"),
        "result_family": ("result_family", "family"),
        "model": ("model", "Model", "model_name", "modelName"),
        "tag": ("tag", "Tag", "label", "variant"),
        "suite": ("suite", "Suite", "study", "Study"),
    }
    candidates = aliases.get(str(key), (key, camel, str(key).capitalize()))
    for candidate in candidates:
        value = row.get(candidate)
        if value not in (None, ""):
            return value
    return row.get(key) or row.get(camel) or row.get(str(key).capitalize()) or ""

def record_identity(source_rel, row, index=0):
    experiment_id = str(row.get("experiment_id") or row.get("experimentId") or row.get("id") or "").strip()
    run_key = str(row.get("run_key") or row.get("runKey") or row.get("run") or "").strip()
    if not experiment_id:
        dimension_parts = []
        for key in ("suite", "method", "dataset", "split", "fold", "seed", "case", "case_name", "eval_protocol", "rate_percent", "train_rate", "model", "tag"):
            value = row_dimension_value(row, "case" if key == "case_name" else key) or row.get(key) or row.get(str(key).capitalize())
            if value not in (None, ""):
                dimension_parts.append(f"{key}={value}")
        experiment_id = run_key or (source_rel.replace("/", ":").rsplit(".", 1)[0] + (":" + "|".join(dimension_parts) if dimension_parts else f":row{index}"))
    if not run_key:
        run_key = experiment_id
    return experiment_id, run_key

def make_result_record(source_rel, row, metrics, index=0):
    experiment_id, run_key = record_identity(source_rel, row, index)
    now = now_iso()
    suite = str(row_dimension_value(row, "suite") or row.get("study") or (source_rel.split("/")[1] if "/" in source_rel else "default"))
    dimensions = {}
    for key in ("method", "dataset", "split", "fold", "seed", "case", "model", "tag", "eval_protocol", "rate_percent", "train_rate", "result_family"):
        value = row_dimension_value(row, key)
        if value not in (None, ""):
            dimensions[key] = coerce_metric_value(value) if key in ("fold", "seed") else str(value)
    method = str(dimensions.get("method") or "")
    result_id = sha256_text(source_rel + ":" + experiment_id + ":" + run_key + ":" + str(index) + ":" + method)[:16]
    return {
        "schemaVersion": 1,
        "resultId": result_id,
        "experimentId": experiment_id,
        "runKey": run_key,
        "suite": suite or "default",
        "method": method or None,
        "experimentName": str(row.get("experiment_name") or row.get("experimentName") or method or run_key),
        "status": "parsed",
        "sourceFiles": [{"path": source_rel, "type": "csv" if source_rel.lower().endswith(".csv") else "json" if source_rel.lower().endswith(".json") else "log", "endpoint": "hub"}],
        "metrics": metrics,
        "dimensions": dimensions,
        "primaryMetric": next(iter(metrics.keys()), ""),
        "higherIsBetter": next(iter(metrics.values()), {}).get("higherIsBetter", True) if metrics else True,
        "parsedAt": now,
        "createdAt": now,
        "updatedAt": now,
        "provenance": {"artifactKey": source_rel, **({"planFile": normalize_result_candidate(row.get("plan_file") or row.get("planFile") or "")} if normalize_result_candidate(row.get("plan_file") or row.get("planFile") or "") else {})},
        **({"method": method} if method else {}),
        **({"planFile": normalize_result_candidate(row.get("plan_file") or row.get("planFile") or "")} if normalize_result_candidate(row.get("plan_file") or row.get("planFile") or "") else {}),
    }

def metric_value(value, metric, source_col, source_rel):
    parsed = coerce_metric_value(value)
    return {
        "value": parsed,
        "higherIsBetter": metric_direction(metric) != "lower",
        "sourceColumn": source_col,
        "sourceFile": source_rel,
    }

def parse_csv_result_file(root, source_rel, policy=None):
    if str(source_rel or "").replace("\\", "/").lower() in IGNORED_RESULT_FILES or os.path.basename(str(source_rel or "")).lower() == "jobs.csv":
        return []
    if os.path.basename(str(source_rel or "")).lower() == "metrics_case.csv":
        return []
    policy = policy or read_project_metric_policy(root)
    path = safe_project_path(root, source_rel)
    text = open(path, "r", encoding="utf-8-sig", errors="replace").read()
    rows = read_csv_dicts(text)
    if not rows:
        return []
    headers = list(rows[0].keys())
    lower_headers = {h.lower(): h for h in headers}
    mapping = policy.get("csvColumnMapping") or {}
    aliases = policy.get("metricAliases") or {}
    def mapped_col(name, fallbacks):
        wanted = str(mapping.get(name) or "").strip()
        if wanted and wanted.lower() in lower_headers:
            return lower_headers[wanted.lower()]
        return next((lower_headers.get(item) for item in fallbacks if lower_headers.get(item)), None)
    dimension_columns = {name: mapped_col(name, [name, name + "_name", name + "_id", "random_seed" if name == "seed" else name]) for name in ("case", "seed", "split", "dataset", "method", "eval_protocol", "rate_percent", "train_rate", "result_family")}
    def canonical_row(row):
        result = dict(row)
        for name, column in dimension_columns.items():
            if column and result.get(column) not in (None, ""):
                result[name] = result[column]
        return result
    metric_col = mapped_col("metric", ["metric", "metric_name", "name", "m"])
    value_col = mapped_col("value", ["value", "score", "result"])
    records = []
    if metric_col and value_col:
        grouped = {}
        for i, row in enumerate(rows):
            metric = metric_name(row.get(metric_col), aliases)
            value = coerce_metric_value(row.get(value_col))
            if not metric or not is_number(value):
                continue
            row = canonical_row(row)
            experiment_id, run_key = record_identity(source_rel, row, i)
            key = (experiment_id, run_key, *(str(row_dimension_value(row, name) or "") for name in ("case", "seed", "dataset", "method", "eval_protocol", "rate_percent", "train_rate")))
            item = grouped.setdefault(key, {"row": row, "metrics": {}, "index": i})
            item["metrics"][metric] = metric_value(value, metric, value_col, source_rel)
        for item in grouped.values():
            if item["metrics"]:
                records.append(make_result_record(source_rel, item["row"], item["metrics"], item["index"]))
        return records
    metric_headers = []
    mapped_dimension_headers = {column for column in dimension_columns.values() if column}
    for h in headers:
        normalized = metric_name(h, aliases)
        if h in mapped_dimension_headers:
            continue
        if normalized in KNOWN_METRICS or (h not in DIMENSION_COLUMNS and h.lower() not in NON_METRIC_COLUMNS and any(is_number(coerce_metric_value(row.get(h))) for row in rows[:20])):
            metric_headers.append(h)
    for i, source_row in enumerate(rows):
        row = canonical_row(source_row)
        metrics = {}
        for h in metric_headers:
            metric = metric_name(h, aliases)
            value = coerce_metric_value(row.get(h))
            if value is None or not is_number(value):
                continue
            metrics[metric] = metric_value(row.get(h), metric, h, source_rel)
        if metrics:
            records.append(make_result_record(source_rel, row, metrics, i))
    return records

def flatten_json(prefix, value, out):
    if isinstance(value, dict):
        for key, child in value.items():
            flatten_json(f"{prefix}.{key}" if prefix else str(key), child, out)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            flatten_json(f"{prefix}.{i}" if prefix else str(i), child, out)
    else:
        out[prefix] = value

def json_scalar_present(value):
    return value not in (None, "") and not isinstance(value, (dict, list, tuple))

def normalize_json_result_row(row):
    out = dict(row or {})
    aliases = {
        "experiment_id": ("experiment_id", "experimentId", "id"),
        "run_key": ("run_key", "runKey", "run_id", "runId", "id"),
        "experiment_name": ("experiment_name", "experimentName"),
        "suite": ("suite", "study"),
        "method": ("method", "approach", "algorithm"),
        "dataset": ("dataset", "data_name", "dataName"),
        "split": ("split", "partition"),
        "fold": ("fold", "cv_fold", "cvFold"),
        "seed": ("seed", "random_seed", "randomSeed"),
        "case": ("case", "case_name", "caseName", "case_id", "caseId"),
        "model": ("model", "model_name", "modelName"),
        "tag": ("tag", "variant", "label"),
    }
    for container_name in ("dimensions", "metadata", "config", "params", "run", "context"):
        container = row.get(container_name) if isinstance(row, dict) else None
        if not isinstance(container, dict):
            continue
        for target, candidates in aliases.items():
            if json_scalar_present(out.get(target)):
                continue
            value = next((container.get(key) for key in candidates if json_scalar_present(container.get(key))), None)
            if value is not None:
                out[target] = value
    model = row.get("model") if isinstance(row, dict) else None
    if isinstance(model, dict):
        model_name = next((model.get(key) for key in ("name", "type", "model_name", "modelName") if json_scalar_present(model.get(key))), None)
        if model_name is not None:
            if not json_scalar_present(out.get("model")):
                out["model"] = model_name
            if not json_scalar_present(out.get("method")):
                out["method"] = model_name
    return out

def collect_json_metric_entries(value, path=None, out=None, depth=0):
    path = list(path or [])
    out = out if isinstance(out, list) else []
    if depth > 8 or len(out) >= 200 or value is None:
        return out
    if isinstance(value, list):
        for item in value[:200]:
            if not isinstance(item, dict):
                continue
            name = next((item.get(key) for key in ("metric", "metric_name", "metricName", "name", "key", "label") if json_scalar_present(item.get(key))), None)
            raw = next((item.get(key) for key in ("value", "score", "result", "val") if json_scalar_present(item.get(key))), None)
            if name is not None and raw is not None:
                out.append((json_metric_name_with_context(name, item), raw, path))
            else:
                collect_json_metric_entries(item, path, out, depth + 1)
        return out
    if isinstance(value, dict):
        name = next((value.get(key) for key in ("metric", "metric_name", "metricName", "name", "key", "label") if json_scalar_present(value.get(key))), None)
        raw = next((value.get(key) for key in ("value", "score", "result", "val") if json_scalar_present(value.get(key))), None)
        if name is not None and raw is not None:
            out.append((json_metric_name_with_context(name, value), raw, path))
            return out
        for key, child in value.items():
            collect_json_metric_entries(child, [*path, str(key)], out, depth + 1)
        return out
    parsed = coerce_metric_value(value)
    if not path or not is_number(parsed):
        return out
    leaf = path[-1]
    split = next((part for part in reversed(path[:-1]) if str(part).lower() in ("train", "val", "valid", "validation", "test", "external", "ext")), "")
    out.append(((str(split) + "_" + str(leaf)) if split else str(leaf), value, path))
    return out

def json_metric_name_with_context(name, item):
    value = str(name or "")
    split = next((item.get(key) for key in ("split", "partition", "phase", "stage") if json_scalar_present(item.get(key))), None) if isinstance(item, dict) else None
    if split is None or re.match(r"^(?:train|val|valid|validation|test|external|ext)[_.-]", value, re.I):
        return value
    return str(split) + "_" + value

def json_metric_entries(row):
    for key in ("metrics", "metric_values", "scores", "summary", "results"):
        value = row.get(key) if isinstance(row, dict) else None
        if isinstance(value, (dict, list)):
            entries = collect_json_metric_entries(value, [key])
            if entries:
                return entries, True
    entries = []
    for key, value in (row or {}).items():
        if not json_metric_name_allowed(key):
            continue
        parsed = coerce_metric_value(value)
        if is_number(parsed):
            entries.append((str(key), value, [str(key)]))
    return entries, False

def json_metric_name_allowed(name):
    normalized = re.sub(r"^(?:train|val|valid|validation|test|external|ext)[_.-]+", "", str(name or "").lower())
    blocked = {"experiment_id", "experimentid", "attempt_id", "attemptid", "run_key", "runkey", "run_id", "runid", "suite", "method", "dataset", "split", "fold", "seed", "case", "model", "tag", "index", "experiment_index", "job_index", "job_count", "gpu_id", "gpu", "pid", "exit_code", "status", "state", "epoch", "step", "timestamp", "output_dir", "log_path"}
    return normalized not in blocked

def json_metric_split(name, path):
    parts = str(name or "").lower().replace("-", "_").split("_")
    aliases = {"valid": "val", "validation": "val", "ext": "external"}
    for part in [*parts, *[str(item).lower() for item in path or []]]:
        normalized = aliases.get(part, part)
        if normalized in ("train", "val", "test", "external"):
            return normalized
    return ""

def json_metric_storage_key(metrics, splits, metric, split):
    if metric not in metrics:
        splits[metric] = split
        return metric
    existing_split = splits.get(metric) or ""
    if split == "test" or (split == "val" and existing_split == "train"):
        if existing_split:
            backup = existing_split + "_" + metric
            if backup not in metrics:
                metrics[backup] = metrics.pop(metric)
                splits[backup] = existing_split
        splits[metric] = split
        return metric
    key = (split + "_" + metric) if split else metric
    index = 2
    while key in metrics:
        key = ((split + "_") if split else "") + metric + "_" + str(index)
        index += 1
    splits[key] = split
    return key

def parse_json_result_file(root, source_rel, policy=None):
    policy = policy or read_project_metric_policy(root)
    aliases = policy.get("metricAliases") or {}
    path = safe_project_path(root, source_rel)
    data = read_json(path, None)
    if data is None:
        return []
    rows = data.get("results") if isinstance(data, dict) and isinstance(data.get("results"), list) else data
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list):
        return []
    records = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        normalized_row = normalize_json_result_row(row)
        entries, _explicit_container = json_metric_entries(normalized_row)
        metrics = {}
        metric_splits = {}
        for name, value, metric_path in entries:
            leaf = str(name).rsplit(".", 1)[-1]
            metric = metric_name(leaf, aliases)
            parsed = coerce_metric_value(value)
            if not is_number(parsed):
                continue
            if not json_metric_name_allowed(leaf):
                continue
            split = json_metric_split(name, metric_path)
            storage_key = json_metric_storage_key(metrics, metric_splits, metric, split)
            metric_item = metric_value(parsed, metric, ".".join(metric_path), source_rel)
            if split:
                metric_item["split"] = split
            metrics[storage_key] = metric_item
        if metrics:
            records.append(make_result_record(source_rel, normalized_row, metrics, i))
    return records

def parse_text_result_file(root, source_rel, policy=None):
    policy = policy or read_project_metric_policy(root)
    path = safe_project_path(root, source_rel)
    text = open(path, "r", encoding="utf-8", errors="replace").read()
    metrics = {}
    import re
    custom = str(policy.get("metricRegex") or "").strip()
    patterns = []
    if custom:
        try:
            patterns.append(re.compile(custom, re.I))
        except Exception:
            pass
    patterns.append(re.compile(r"\b(accuracy|acc|top1|top_1|top1_acc|top1_accuracy|top5|top_5|top5_acc|top5_accuracy|auc|auroc|roc_auc|auprc|pr_auc|average_precision|ap|f1|macro_f1|micro_f1|weighted_f1|precision|recall|sensitivity|specificity|balanced_accuracy|balanced_acc|bal_acc|mcc|kappa|loss|log_loss|cross_entropy|ece|brier|dice|dsc|iou|hd95|asd)\b\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(\s*%)?", re.I))
    for pattern in patterns:
        for match in pattern.finditer(text[-256 * 1024:]):
            groups = match.groupdict()
            metric_raw = groups.get("metric") if groups else None
            value_raw = groups.get("value") if groups else None
            try:
                fallback_metric = match.group(1)
            except Exception:
                fallback_metric = ""
            try:
                fallback_value = match.group(2)
            except Exception:
                fallback_value = ""
            if not metric_raw and not fallback_metric:
                continue
            metric = metric_name(metric_raw or fallback_metric, policy.get("metricAliases") or {})
            if not metric:
                continue
            raw = str(value_raw) if value_raw is not None else fallback_value + ("%" if len(match.groups()) >= 3 and match.group(3) else "")
            metrics[metric] = metric_value(raw, metric, "text", source_rel)
    if not metrics:
        return []
    return [make_result_record(source_rel, {}, metrics, 0)]

def parse_result_file(root, source_rel, policy=None):
    lower = source_rel.lower()
    if not parseable_result_candidate(source_rel):
        return []
    policy = policy or read_project_metric_policy(root)
    if lower.endswith(".csv"):
        return parse_csv_result_file(root, source_rel, policy)
    if lower.endswith(".json"):
        return parse_json_result_file(root, source_rel, policy)
    return parse_text_result_file(root, source_rel, policy)

def plan_summary_slug(plan):
    text = normalize_result_candidate(plan) if plan else ""
    if not text:
        return ""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", text.replace("\\", "/")).strip("._-")
    return (slug or "plan")[:120]

def plan_results_summary_relpath(plan):
    slug = plan_summary_slug(plan)
    if not slug:
        return "simple_cluster/results/summary.json"
    return f"simple_cluster/results/by_plan/{slug}/summary.json"

def plan_results_registry_relpath(plan):
    slug = plan_summary_slug(plan)
    if not slug:
        return "simple_cluster/results/result_registry.json"
    return f"simple_cluster/results/by_plan/{slug}/result_registry.json"

def plan_results_artifact_relpath(plan, filename):
    slug = plan_summary_slug(plan)
    name = str(filename or "").strip().lstrip("/")
    if not name:
        raise ValueError("artifact filename required")
    if not slug:
        return f"simple_cluster/results/{name}"
    return f"simple_cluster/results/by_plan/{slug}/{name}"

def plan_datasets_artifact_relpath(plan, filename):
    slug = plan_summary_slug(plan)
    name = str(filename or "").strip().lstrip("/")
    if not name:
        raise ValueError("artifact filename required")
    if not slug:
        return f"simple_cluster/datasets/{name}"
    return f"simple_cluster/datasets/by_plan/{slug}/{name}"

def plan_checkpoints_artifact_relpath(plan, filename):
    slug = plan_summary_slug(plan)
    name = str(filename or "").strip().lstrip("/")
    if not name:
        raise ValueError("artifact filename required")
    if not slug:
        return f"simple_cluster/checkpoints/{name}"
    return f"simple_cluster/checkpoints/by_plan/{slug}/{name}"

def write_atomic_csv(path, header, rows):
    def write(stream):
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)
    atomic_write_file(path, write)

def plan_result_identity(root, plan):
    try:
        text = uncommented_yaml_text(open(safe_project_path(root, plan), "r", encoding="utf-8").read())
    except Exception:
        return [], []
    seeds = [str(value).strip() for value in yaml_list(text, "seeds") if str(value).strip()]
    cases = [yaml_clean_value(value) for value in re.findall(r"^\s*-\s*case\s*:\s*([^\n#]+)", yaml_section_text(text, "cases"), re.M)]
    return list(dict.fromkeys(seeds)), list(dict.fromkeys(value for value in cases if value))

def result_seed_key(value):
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    try:
        number = float(text)
        if math.isfinite(number) and number.is_integer():
            return str(int(number))
    except (TypeError, ValueError, OverflowError):
        pass
    return text

def result_column_mapping_preview(root, source, policy):
    try:
        with open(safe_project_path(root, source), "r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            headers = reader.fieldnames or []
            samples = [row for _, row in zip(range(20), reader)]
    except Exception:
        return {"source": source, "headers": [], "mapping": {}}
    lookup = {str(header).lower(): header for header in headers}
    configured = policy.get("csvColumnMapping") or {}
    defaults = {"case": ("case", "case_name", "case_id"), "seed": ("seed", "random_seed"), "split": ("split", "partition"), "dataset": ("dataset", "data_name"), "method": ("method", "model_name"), "eval_protocol": ("eval_protocol", "evaluation_protocol", "test_endpoint", "endpoint"), "rate_percent": ("rate_percent", "train_rate_percent"), "train_rate": ("train_rate", "training_rate"), "metric": ("metric", "metric_name"), "value": ("value", "score", "result")}
    mapping = {}
    for name, aliases in defaults.items():
        preferred = str(configured.get(name) or "").lower()
        match = lookup.get(preferred) if preferred else None
        mapping[name] = match or next((lookup[alias] for alias in aliases if alias in lookup), "")
    excluded = set(value for value in mapping.values() if value)
    metrics = [{"column": header, "metric": metric_name(header, policy.get("metricAliases") or {})} for header in headers if header not in excluded and any(is_number(coerce_metric_value(row.get(header))) for row in samples)]
    sample_values = {}
    for header in headers[:120]:
        values = []
        for row in samples:
            value = str(row.get(header) or "").strip().replace("\r", " ").replace("\n", " ")[:48]
            if value and value not in values:
                values.append(value)
            if len(values) >= 2:
                break
        sample_values[header] = values
    return {"source": source, "headers": headers[:120], "mapping": mapping, "metricColumns": metrics[:120], "configured": configured, "sampleValues": sample_values}

def project_dataset_table_outputs(root, current_summary, kind):
    parent = safe_project_path(root, "simple_cluster/results/by_plan")
    saved_by_plan = {}
    if os.path.isdir(parent):
        for slug in sorted(os.listdir(parent))[:500]:
            directory = os.path.join(parent, slug)
            if not os.path.isdir(directory) or os.path.islink(directory):
                continue
            for name in ("summary.json", "dataset-index.json"):
                saved_path = os.path.join(directory, name)
                if os.path.islink(saved_path) or not safe_small_file(saved_path):
                    continue
                saved = read_json(saved_path, {})
                if isinstance(saved, dict) and saved.get("planFile"):
                    plan = saved["planFile"]
                    if name == "dataset-index.json" or plan not in saved_by_plan:
                        saved_by_plan[plan] = saved
    if current_summary and current_summary.get("planFile"):
        saved_by_plan[current_summary["planFile"]] = current_summary
    groups = {}
    source_field = "aggregateCsvPath" if kind == "seed" else "finalCsvPath"
    total = 0
    for plan, saved in saved_by_plan.items():
        if saved.get("aggregateStatus") != "ready":
            continue
        sources = saved.get("datasetResultTables") or [saved]
        for table in sources:
            relative = table.get(source_field) or ""
            if not relative.startswith("simple_cluster/results/by_plan/"):
                continue
            if "datasetKey" in table:
                expected_path = dataset_plan_artifact_path(plan, table.get("dataset", ""), "seed_mean_std.csv" if kind == "seed" else "final.csv")
                if relative != expected_path:
                    raise ValueError("Dataset table path does not match Plan ownership")
            source = safe_project_path(root, relative)
            if not os.path.isfile(source) or os.path.islink(source) or not safe_small_file(source):
                continue
            with open(source, "r", encoding="utf-8", newline="") as stream:
                reader = csv.DictReader(stream)
                for row in reader:
                    if total >= 50000:
                        raise ValueError("Project aggregate row budget exceeded")
                    dataset = str(row.get("dataset") or "").strip()
                    if "datasetKey" in table and (dataset != table.get("dataset", "") or dataset_path_key(dataset) != table["datasetKey"]):
                        raise ValueError("Dataset table does not match its directory metadata")
                    group = groups.setdefault(dataset, {"headers": ["plan_file", "dataset"], "rows": []})
                    for header in reader.fieldnames or []:
                        if header not in group["headers"]:
                            group["headers"].append(header)
                    group["rows"].append({**row, "plan_file": plan, "dataset": dataset})
                    total += 1
    partitions = dataset_partitions(list(groups))
    outputs, tables = [], []
    for partition in partitions:
        group = groups[partition["dataset"]]
        headers, rows = group["headers"], group["rows"]
        base = f"simple_cluster/results/by_dataset/{partition['datasetKey']}"
        csv_rel = base + ("/project_seed_mean_std.csv" if kind == "seed" else "/project_final.csv")
        outputs.append(("csv", csv_rel, headers, [[row.get(header, "") for header in headers] for row in rows]))
        table = {**partition, source_field: csv_rel, "rowCount": len(rows)}
        if kind == "final":
            md_rel = base + "/project_final.md"
            markdown_headers = [header[:-5] if header.endswith("_mean") and header[:-5] + "_sd" in headers else header for header in headers if not header.endswith("_sd")]
            markdown_rows = []
            for row in rows:
                cells = []
                for header in headers:
                    if header.endswith("_sd"):
                        continue
                    value = row.get(header, "")
                    if header.endswith("_mean") and header[:-5] + "_sd" in headers:
                        try:
                            value = f"{float(value):.4f} ± {float(row[header[:-5] + '_sd']):.4f}" if row.get(header[:-5] + "_sd") else f"{float(value):.4f}"
                        except (TypeError, ValueError):
                            value = "—" if not value else str(value)
                    cells.append(value)
                markdown_rows.append(cells)
            outputs.append(("text", md_rel, result_markdown_table(markdown_headers, markdown_rows, (partition["dataset"] or "Unassigned") + " project results")))
            table["finalMarkdownPath"] = md_rel
        tables.append(table)
    publish_dataset_outputs(root, outputs)
    return tables

def write_project_seed_aggregate(root, current_summary=None):
    return project_dataset_table_outputs(root, current_summary, "seed")

def final_rate_percent(dimensions):
    raw = str(dimensions.get("rate_percent") or dimensions.get("train_rate") or "").strip().rstrip("%")
    if not raw:
        return ""
    try:
        number = float(raw)
        if not math.isfinite(number):
            return ""
        from_fraction = bool(dimensions.get("train_rate")) and (not dimensions.get("rate_percent") or str(dimensions.get("rate_percent")) == str(dimensions.get("train_rate")))
        if from_fraction and 0 <= number <= 1:
            number *= 100
        return str(int(number)) if number.is_integer() else format(number, ".8g")
    except (TypeError, ValueError, OverflowError):
        return raw

def final_metric_label(metric):
    preferred = {"AUC": "roc_auc", "AUPRC": "auprc", "F1": "f1_score", "ECE": "ece", "brier": "brier_score"}
    raw = preferred.get(str(metric), str(metric))
    return re.sub(r"(?u)[^\w]+", "_", raw).strip("_").lower() or "metric"

def write_atomic_text(path, content):
    def write(stream):
        stream.write(content)
    atomic_write_file(path, write)

def result_markdown_table(headers, rows, title, notes=None):
    escape = lambda value: str(value if value is not None else "").replace("|", chr(92) + "|").replace("\n", " ").replace("\r", " ")
    lines = [f"# {title}", "", *(notes or []), "", "| " + " | ".join(escape(header) for header in headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(escape(value) for value in row) + " |")
    return "\n".join(lines) + "\n"

def write_plan_final_summary(root, summary, policy, group_keys, groups, metric_names, expected_seeds, dataset, outputs):
    plan = normalize_result_candidate(summary.get("planFile") or "")
    derived = policy.get("derivedMetric") if isinstance(policy.get("derivedMetric"), dict) else {}
    derived_metric = metric_name(derived.get("metric"), policy.get("metricAliases") or {}) if derived else ""
    left, right = str(derived.get("leftEndpoint") or "").strip(), str(derived.get("rightEndpoint") or "").strip()
    scale = float(derived.get("scale") or 1) if derived else 1
    derived_name = str(derived.get("outputName") or "").strip() if derived else ""
    if not (derived_metric and left and right and derived_name and "eval_protocol" in group_keys):
        derived_metric = ""
    metric_labels = {}
    used_labels = set()
    for metric in metric_names:
        label = final_metric_label(metric)
        original = label
        suffix = 2
        while label in used_labels:
            label = f"{original}_{suffix}"
            suffix += 1
        used_labels.add(label)
        metric_labels[metric] = label
    if derived_metric:
        derived_name = final_metric_label(derived_name)
        if derived_name in used_labels:
            raise ValueError("派生指标列名与已有指标重复，请修改输出列名。")
    entries = []
    for key, seeds in sorted(groups.items()):
        dims = dict(zip(group_keys, key))
        expected = len(expected_seeds) if expected_seeds else len(seeds)
        counts = [sum(metric in values for values in seeds.values()) for metric in metric_names]
        present_counts = [count for count in counts if count]
        jobs = min(present_counts) if present_counts else len(seeds)
        jobs_text = str(jobs) if jobs == expected else f"{jobs}/{expected}"
        entries.append({"key": key, "dims": dims, "seeds": seeds, "jobs": jobs_text})
    def entry_order(entry):
        dims = entry["dims"]
        rate = final_rate_percent(dims)
        try:
            rate_order = (0, float(rate))
        except (TypeError, ValueError):
            rate_order = (1, rate)
        return (str(dims.get("result_family") or dims.get("method") or ""), str(dims.get("dataset") or ""), rate_order, str(dims.get("eval_protocol") or ""), str(dims.get("case") or ""))
    entries.sort(key=entry_order)
    display_fields = ["result_family", "dataset"] + [name for name in ("rate_percent", "eval_protocol") if any((entry["dims"].get(name) if name != "rate_percent" else final_rate_percent(entry["dims"])) for entry in entries)]
    def display_value(entry, name):
        dims = entry["dims"]
        if name == "result_family":
            return dims.get("result_family") or dims.get("method") or os.path.splitext(os.path.basename(plan))[0]
        return final_rate_percent(dims) if name == "rate_percent" else dims.get(name, "")
    for extra in ("case", "split", "fold", "model", "tag"):
        identity = [tuple(display_value(entry, name) for name in display_fields) for entry in entries]
        if len(identity) == len(set(identity)):
            break
        if extra in group_keys and extra not in display_fields:
            display_fields.append(extra)
    identity = [tuple(display_value(entry, name) for name in display_fields) for entry in entries]
    if len(identity) != len(set(identity)):
        raise ValueError("简洁表存在无法区分的行；请检查 Plan case 和结果维度。")
    paired = {}
    if derived_metric:
        endpoint_index = group_keys.index("eval_protocol")
        for entry in entries:
            shared = entry["key"][:endpoint_index] + entry["key"][endpoint_index + 1:]
            paired[(shared, entry["dims"].get("eval_protocol"))] = entry["seeds"]
    header = [*display_fields, "jobs"]
    for metric in metric_names:
        header.extend((metric_labels[metric] + "_mean", metric_labels[metric] + "_sd"))
    if derived_metric:
        header.extend((derived_name + "_mean", derived_name + "_sd"))
    rows = []
    markdown_rows = []
    for entry in entries:
        row = [*(display_value(entry, name) for name in display_fields), entry["jobs"]]
        md_row = list(row)
        for metric in metric_names:
            values = [values[metric] for values in entry["seeds"].values() if metric in values]
            mean = statistics.mean(values) if values else ""
            sd = statistics.stdev(values) if len(values) > 1 else ""
            row.extend((mean, sd))
            md_row.append((f"{mean:.4f} ± {sd:.4f}" if sd != "" else f"{mean:.4f}" if mean != "" else "—"))
        if derived_metric:
            endpoint_index = group_keys.index("eval_protocol")
            shared = entry["key"][:endpoint_index] + entry["key"][endpoint_index + 1:]
            left_seeds = paired.get((shared, left), {})
            right_seeds = paired.get((shared, right), {})
            values = [(left_seeds[seed][derived_metric] - right_seeds[seed][derived_metric]) * scale for seed in left_seeds.keys() & right_seeds.keys() if derived_metric in left_seeds[seed] and derived_metric in right_seeds[seed]]
            mean = statistics.mean(values) if values else ""
            sd = statistics.stdev(values) if len(values) > 1 else ""
            row.extend((mean, sd))
            md_row.append((f"{mean:.4f} ± {sd:.4f}" if sd != "" else f"{mean:.4f}" if mean != "" else "—"))
        rows.append(row)
        markdown_rows.append(md_row)
    csv_rel = dataset_plan_artifact_path(plan, dataset, "final.csv")
    md_rel = dataset_plan_artifact_path(plan, dataset, "final.md")
    outputs.append(("csv", csv_rel, header, rows))
    md_headers = [*display_fields, "jobs", *(metric_labels[metric] for metric in metric_names), *([derived_name] if derived_metric else [])]
    notes = [f"Plan: {plan}. Rows: {len(rows)}. CSV keeps full precision; this table shows four decimals.", "", "Incomplete jobs values use available/expected seeds. Per-metric counts remain in seed_mean_std.csv."]
    if derived_metric:
        notes.extend(["", f"Derived {derived_name}: same-seed {left} minus {right} for {derived_metric}, multiplied by {scale:g}."])
    outputs.append(("text", md_rel, result_markdown_table(md_headers, markdown_rows, f"{dataset or 'Unassigned'} final results", notes)))
    summary["finalCsvPath"] = csv_rel
    summary["finalMarkdownPath"] = md_rel
    summary["finalRowCount"] = len(rows)

def write_project_final_summary(root, current_summary=None):
    return project_dataset_table_outputs(root, current_summary, "final")

def dataset_plan_artifact_path(plan, dataset, filename):
    return f"simple_cluster/results/by_plan/{result_plan_directory_key(plan)}/datasets/{dataset_path_key(dataset)}/{filename}"

def publish_dataset_outputs(root, outputs):
    prepared = []
    for output in outputs:
        target = safe_project_path(root, output[1])
        cursor = os.path.abspath(root)
        for part in os.path.relpath(target, root).split(os.sep):
            cursor = os.path.join(cursor, part)
            if os.path.islink(cursor):
                raise ValueError("Dataset output cannot pass through a link")
        if output[0] == "csv":
            buffer = io.StringIO(newline="")
            csv.writer(buffer).writerows([output[2], *output[3]])
            content = buffer.getvalue()
        else:
            content = output[2]
        prepared.append((target, content))
    for target, content in prepared:
        write_atomic_text(target, content)

def write_plan_seed_aggregate(root, summary, policy):
    plan = normalize_result_candidate(summary.get("planFile") or "")
    if not plan:
        return
    records = [row for row in (summary.get("results") or []) if isinstance(row, dict)]
    partitions = dataset_partitions([(row.get("dimensions") or {}).get("dataset") for row in records])
    outputs, tables = [], []
    for partition in partitions:
        dataset = partition["dataset"]
        child = {**summary, "results": [{**row, "dimensions": {**(row.get("dimensions") or {}), "dataset": dataset}} for row in records if str((row.get("dimensions") or {}).get("dataset") or "").strip() == dataset]}
        for field in ("aggregateCsvPath", "finalCsvPath", "finalMarkdownPath", "finalRowCount", "aggregateStatus"):
            child.pop(field, None)
        _write_dataset_seed_aggregate(root, child, policy, dataset, outputs)
        if child.get("columnMappingPreview"):
            summary["columnMappingPreview"] = child["columnMappingPreview"]
        tables.append({**partition, **{field: child.get(field, "") for field in ("rawResultCsvPath", "aggregateCsvPath", "finalCsvPath", "finalMarkdownPath", "finalRowCount", "aggregateStatus", "aggregateMessage", "aggregateIncompleteCount")}})
    for field in ("aggregateCsvPath", "finalCsvPath", "finalMarkdownPath", "finalRowCount", "rawResultCsvPath"):
        summary.pop(field, None)
    summary["datasetResultTables"] = tables
    ready = bool(tables) and all(table.get("aggregateStatus") == "ready" for table in tables)
    summary["aggregateStatus"] = "ready" if ready else next((table.get("aggregateStatus") for table in tables if table.get("aggregateStatus") != "ready"), "no_matching_rows")
    summary["aggregateMessage"] = "; ".join(str(table.get("aggregateMessage") or "") for table in tables)
    raw_paths = list(dict.fromkeys(table["rawResultCsvPath"] for table in tables if table.get("rawResultCsvPath")))
    summary["rawResultCsvPaths"] = raw_paths
    if len(raw_paths) == 1:
        summary["rawResultCsvPath"] = raw_paths[0]
    if not ready:
        for table in tables:
            if table.get("aggregateStatus") == "ready":
                table["aggregateStatus"] = "batch_blocked"
        return
    publish_dataset_outputs(root, outputs)
    if len(tables) == 1:
        for field in ("aggregateCsvPath", "finalCsvPath", "finalMarkdownPath", "finalRowCount"):
            summary[field] = tables[0][field]
    summary["aggregateIncompleteCount"] = sum(int(table.get("aggregateIncompleteCount") or 0) for table in tables)
    index_rel = f"simple_cluster/results/by_plan/{result_plan_directory_key(plan)}/dataset-index.json"
    atomic_write(safe_project_path(root, index_rel), {"planFile": plan, "aggregateStatus": "ready", "datasetResultTables": tables})

def _write_dataset_seed_aggregate(root, summary, policy, dataset, outputs):
    plan = normalize_result_candidate(summary.get("planFile") or "")
    if not plan:
        return
    expected_seeds, expected_cases = plan_result_identity(root, plan)
    expected_seeds = list(dict.fromkeys(result_seed_key(item) for item in expected_seeds))
    declared = [item for item in plan_declared_result_candidates(root, plan) if str(item).lower().endswith(".csv")]
    records = [record for record in (summary.get("results") or []) if isinstance(record, dict)]
    source_records = {}
    for record in records:
        source_files = record.get("sourceFiles") or []
        source = normalize_result_candidate((source_files[0] or {}).get("path") if source_files and isinstance(source_files[0], dict) else "")
        if source and source.lower().endswith(".csv"):
            source_records.setdefault(source, []).append(record)
    candidates = [source for source in declared if source in source_records]
    if not candidates:
        summary["aggregateStatus"] = "no_declared_csv"
        summary["aggregateMessage"] = "Plan 未声明可解析的原始 CSV；请配置结果路径。"
        return
    source = max(candidates, key=lambda item: (sum(bool((row.get("dimensions") or {}).get("case") and (row.get("dimensions") or {}).get("seed") not in (None, "")) for row in source_records[item]), -declared.index(item)))
    summary["rawResultCsvPath"] = source
    summary["columnMappingPreview"] = result_column_mapping_preview(root, source, policy)
    relevant = []
    missing_identity = 0
    for record in source_records[source]:
        dimensions = record.get("dimensions") or {}
        case = str(dimensions.get("case") or "").strip()
        seed = result_seed_key(dimensions.get("seed"))
        if case and expected_cases and case not in expected_cases:
            continue
        if seed and expected_seeds and seed not in expected_seeds:
            continue
        if not case or not seed:
            missing_identity += 1
            continue
        relevant.append(record)
    if missing_identity:
        summary["aggregateStatus"] = "mapping_required"
        summary["aggregateMessage"] = f"原始表有 {missing_identity} 条记录缺少可信 case 或 seed；请检查列映射。"
        return
    if not relevant:
        summary["aggregateStatus"] = "no_matching_rows"
        summary["aggregateMessage"] = "原始表没有与当前 Plan case/seed 对应的有效指标。"
        return
    group_keys = ("case", "dataset", "split", "fold", "method") + tuple(name for name in ("eval_protocol", "rate_percent", "train_rate", "result_family", "model", "tag") if any((record.get("dimensions") or {}).get(name) not in (None, "") for record in relevant))
    groups = {}
    metric_names = set()
    for record in relevant:
        dims = record.get("dimensions") or {}
        key = tuple(str(dims.get(name) if dims.get(name) is not None else "") for name in group_keys)
        seed = result_seed_key(dims.get("seed"))
        bucket = groups.setdefault(key, {})
        seed_metrics = bucket.setdefault(seed, {})
        for metric, payload in (record.get("metrics") or {}).items():
            value = coerce_metric_value(payload.get("value") if isinstance(payload, dict) else payload)
            if is_number(value) and math.isfinite(float(value)):
                seed_metrics[str(metric)] = float(value)
                metric_names.add(str(metric))
    metric_names = ordered_metric_list(metric_names, policy)
    header = ["plan_file", *group_keys, "expected_seed_count", "available_seeds", "complete"]
    for metric in metric_names:
        header.extend((metric + "_mean", metric + "_std", metric + "_n", metric + "_coverage"))
    rows = []
    for key, seeds in sorted(groups.items()):
        expected = len(expected_seeds) if expected_seeds else len(seeds)
        available = len(seeds)
        row = [plan, *key, expected, available, "complete" if available == expected else "incomplete"]
        for metric in metric_names:
            values = [values[metric] for values in seeds.values() if metric in values]
            count = len(values)
            if count != expected:
                row[header.index("complete")] = "incomplete"
            row.extend((statistics.mean(values) if count else "", statistics.stdev(values) if count > 1 else "", count, f"{count}/{expected}"))
        rows.append(row)
    output = dataset_plan_artifact_path(plan, dataset, "seed_mean_std.csv")
    outputs.append(("csv", output, header, rows))
    summary["aggregateCsvPath"] = output
    summary["aggregateStatus"] = "ready"
    summary["aggregateRowCount"] = len(rows)
    summary["aggregateIncompleteCount"] = sum(row[header.index("complete")] == "incomplete" for row in rows)
    summary["aggregateMessage"] = f"已生成 {len(rows)} 行；不完整 {summary['aggregateIncompleteCount']} 行。"
    write_plan_final_summary(root, summary, policy, group_keys, groups, metric_names, expected_seeds, dataset, outputs)

def archive_plan_copy_action(root, plan, snapshot_name=""):
    plan = normalize_result_candidate(plan)
    if not plan or not plan.lower().endswith((".yaml", ".yml")):
        raise ValueError("需要当前 Plan YAML 路径")
    plan_path = safe_project_path(root, plan)
    if not os.path.isfile(plan_path):
        raise ValueError("当前 Plan 文件不存在")
    plan_text = uncommented_yaml_text(open(plan_path, "r", encoding="utf-8").read())
    expected_seeds, expected_cases = plan_result_identity(root, plan)
    if not expected_seeds or not expected_cases:
        raise ValueError("Plan 缺少可信 cases 或 seeds，已阻止宽范围归档")
    summary = read_results_summary(root, plan)
    if summary.get("aggregateStatus") != "ready":
        raise ValueError("当前 Plan 汇总表尚未生成；请先解析结果并检查列映射")
    token = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.splitext(os.path.basename(plan))[0]).strip("._-")[:80] or "plan"
    stamp = re.sub(r"[^A-Za-z0-9._-]+", "_", str(snapshot_name or "")).strip("._-")[:80] or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{time.time_ns() % 1000000000:09d}"
    archive_rel = f"archives/{token}/{stamp}"
    archive_root = safe_project_path(root, archive_rel)
    os.makedirs(archive_root, exist_ok=False)
    files, skipped, total_bytes = [], [], 0
    max_file_bytes, max_total_bytes, max_files = 4 * 1024 * 1024, 128 * 1024 * 1024, 800
    raw_source = normalize_result_candidate(summary.get("rawResultCsvPath") or "")
    seeds = set(result_seed_key(seed) for seed in expected_seeds)
    cases = set(expected_cases)
    def add(source_rel, filtered=False, required=False):
        nonlocal total_bytes
        source_rel = normalize_result_candidate(source_rel)
        if not source_rel or any(item["source"] == source_rel for item in files):
            return
        if len(files) >= max_files:
            skipped.append({"source": source_rel, "reason": "文件数量上限"})
            return
        try:
            source = safe_project_path(root, source_rel)
            if not os.path.isfile(source) or os.path.islink(source):
                raise ValueError("文件缺失或为链接")
            size = os.path.getsize(source)
            if size > max_file_bytes or total_bytes + size > max_total_bytes:
                raise ValueError("超过轻量归档容量上限")
            target_rel = f"{archive_rel}/files/{source_rel}"
            target = safe_project_path(root, target_rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if filtered:
                mapping = (summary.get("columnMappingPreview") or {}).get("mapping") or {}
                case_col, seed_col = mapping.get("case"), mapping.get("seed")
                with open(source, "r", encoding="utf-8-sig", newline="") as stream:
                    reader = csv.DictReader(stream)
                    if not case_col or not seed_col or case_col not in (reader.fieldnames or []) or seed_col not in (reader.fieldnames or []):
                        raise ValueError("原始表缺少可信 case/seed 列映射")
                    kept = [row for row in reader if str(row.get(case_col) or "").strip() in cases and result_seed_key(row.get(seed_col)) in seeds]
                    header = reader.fieldnames or []
                if not kept:
                    raise ValueError("原始表没有当前 Plan 行")
                write_atomic_csv(target, header, [[row.get(name, "") for name in header] for row in kept])
            else:
                shutil.copy2(source, target)
            copied_bytes = os.path.getsize(target)
            total_bytes += copied_bytes
            files.append({"source": source_rel, "path": target_rel, "bytes": copied_bytes, "sha256": sha256_file(target)})
        except Exception as exc:
            if required:
                raise ValueError(f"必需的当前 Plan 归档文件无法复制：{source_rel}：{exc}") from exc
            skipped.append({"source": source_rel, "reason": str(exc)})
    add(plan, required=True)
    for key in ("base_config", "config"):
        config = str(yaml_scalar(plan_text, key, "") or "").strip()
        if config and "{" not in config:
            add(config)
    if os.path.isfile(os.path.join(root, "experiments", "simple_project.yaml")):
        add("experiments/simple_project.yaml")
    if summary.get("datasetResultTables"):
        for table in summary["datasetResultTables"]:
            add(table.get("aggregateCsvPath"), required=True)
            add(table.get("finalCsvPath"))
            add(table.get("finalMarkdownPath"))
    else:
        add(summary.get("aggregateCsvPath"), required=True)
        add(summary.get("finalCsvPath"))
        add(summary.get("finalMarkdownPath"))
    for field in ("summaryPath", "previewCsvPath"):
        add(summary.get(field))
    if raw_source:
        add(raw_source, filtered=True, required=True)
    sweep = str(yaml_scalar(plan_text, "sweep_dir", "") or "").replace("{suite}", str(yaml_scalar(plan_text, "suite", "") or ""))
    if sweep and "{" not in sweep:
        try:
            sweep_root = safe_project_path(root, sweep)
            if os.path.isdir(sweep_root) and not os.path.islink(sweep_root):
                visited = 0
                for directory, subdirs, names in os.walk(sweep_root, followlinks=False):
                    visited += 1
                    if visited > 2000:
                        skipped.append({"source": sweep, "reason": "目录数量上限"})
                        break
                    subdirs[:] = [name for name in subdirs if name not in ("checkpoints", "weights", "events", ".git", "__pycache__") and not os.path.islink(os.path.join(directory, name))]
                    for name in names:
                        if name in ("stdout.log", "stderr.log", "metrics_summary.csv", "metrics_case.csv") or name.endswith((".yaml", ".yml", ".log", ".out")):
                            relative_job_path = os.path.relpath(os.path.join(directory, name), sweep_root).replace("\\", "/")
                            belongs_to_case = any(re.search(r"(?:^|[/_-])" + re.escape(case) + r"(?=$|[/_.-])", relative_job_path) for case in cases)
                            belongs_to_seed = any(re.search(r"(?:^|[/_-])(?:seed|s)[_-]?" + re.escape(seed) + r"(?=$|[/_.-])", relative_job_path, re.I) or re.search(r"(?:^|/)" + re.escape(seed) + r"(?=/)", relative_job_path) for seed in seeds)
                            if belongs_to_case and belongs_to_seed:
                                add(relpath(root, os.path.join(directory, name)))
        except Exception as exc:
            skipped.append({"source": sweep, "reason": str(exc)})
    manifest_rel = f"{archive_rel}/manifest.json"
    manifest = {"schemaVersion": 1, "planFile": plan, "createdAt": now_iso(), "scope": {"cases": expected_cases, "seeds": expected_seeds}, "files": files, "skipped": skipped, "totalBytes": total_bytes, "rawResultFiltered": True, "note": "仅复制轻量 Plan、配置、结果表和日志；不复制 checkpoint。"}
    atomic_write(safe_project_path(root, manifest_rel), manifest)
    file_sizes = {manifest_rel: os.path.getsize(safe_project_path(root, manifest_rel))}
    file_sizes.update({item["path"]: int(item["bytes"]) for item in files})
    file_hashes = {manifest_rel: sha256_file(safe_project_path(root, manifest_rel))}
    file_hashes.update({item["path"]: item["sha256"] for item in files})
    return {"archivePath": archive_rel, "manifestPath": manifest_rel, "files": [manifest_rel, *[item["path"] for item in files]], "fileSizes": file_sizes, "fileHashes": file_hashes, "fileCount": len(files), "skipped": skipped, "totalBytes": total_bytes}

def result_csv_rows(records):
    rows = []
    for record in records or []:
        if not isinstance(record, dict):
            continue
        dimensions = record.get("dimensions") if isinstance(record.get("dimensions"), dict) else {}
        metrics = record.get("metrics") if isinstance(record.get("metrics"), dict) else {}
        for metric, data in metrics.items():
            payload = data if isinstance(data, dict) else {"value": data}
            rows.append([
                record.get("resultId") or record.get("result_id") or "",
                record.get("experimentId") or record.get("experiment_id") or "",
                record.get("runKey") or record.get("run_key") or "",
                dimensions.get("method") or record.get("method") or "",
                dimensions.get("dataset") or record.get("dataset") or "",
                dimensions.get("split") or record.get("split") or "",
                dimensions.get("seed") or record.get("seed") or "",
                metric,
                payload.get("value", ""),
                record.get("sourceFile") or record.get("source") or "",
                record.get("artifactPath") or record.get("artifact_path") or "",
                record.get("finalEvidenceState") or record.get("final_evidence_state") or "",
                bool(record.get("eligibleForFinalAnalysis")),
            ])
    return rows

def write_result_csv_views(root, summary, plan):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    preview_rel = plan_results_artifact_relpath(plan_norm, "results_preview_all.csv")
    effective_rel = plan_results_artifact_relpath(plan_norm, "results_effective_archived.csv")
    records = [record for record in (summary.get("results") or []) if isinstance(record, dict)]
    effective = [record for record in records if str(record.get("finalEvidenceState") or "").lower() == "archived"]
    header = ["result_id", "experiment_id", "run_key", "method", "dataset", "split", "seed", "metric", "value", "source_file", "artifact_path", "final_evidence_state", "eligible_for_final_analysis"]
    write_atomic_csv(safe_project_path(root, preview_rel), header, result_csv_rows(records))
    write_atomic_csv(safe_project_path(root, effective_rel), header, result_csv_rows(effective))
    if plan_norm:
        write_atomic_csv(safe_project_path(root, "simple_cluster/results/results_preview_all.csv"), header, result_csv_rows(records))
        write_atomic_csv(safe_project_path(root, "simple_cluster/results/results_effective_archived.csv"), header, result_csv_rows(effective))
    summary["previewCsvPath"] = preview_rel
    summary["effectiveResultsCsvPath"] = effective_rel
    summary["effectiveArchivedResultCount"] = len(effective)
    summary["previewResultCount"] = len(records)

def write_results_summary_v2(root, summary):
    plan = normalize_result_candidate((summary or {}).get("planFile") or "")
    summary_rel = plan_results_summary_relpath(plan) if plan else "simple_cluster/results/summary.json"
    if isinstance(summary, dict):
        summary["summaryPath"] = summary_rel
        if plan and not summary.get("planFile"):
            summary["planFile"] = plan
        write_result_csv_views(root, summary, plan)
        if plan:
            seeds = write_project_seed_aggregate(root, summary)
            finals = write_project_final_summary(root, summary)
            merged = {table["datasetKey"]: dict(table) for table in seeds}
            for table in finals:
                merged.setdefault(table["datasetKey"], {}).update(table)
            summary["projectDatasetTables"] = list(merged.values())
            for field in ("projectAggregateCsvPath", "projectFinalCsvPath", "projectFinalMarkdownPath"):
                summary.pop(field, None)
            if len(merged) == 1:
                table = next(iter(merged.values()))
                summary["projectAggregateCsvPath"] = table.get("aggregateCsvPath", "")
                summary["projectFinalCsvPath"] = table.get("finalCsvPath", "")
                summary["projectFinalMarkdownPath"] = table.get("finalMarkdownPath", "")
    target = safe_project_path(root, summary_rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, summary)
    # Keep a project-latest copy for unscoped consumers / offline diagnostics.
    atomic_write(safe_project_path(root, "simple_cluster/results/summary.json"), summary)
    atomic_write(safe_project_path(root, "simple_cluster/results_summary.json"), summary)
    registry = safe_project_path(root, plan_results_registry_relpath(plan) if plan else "simple_cluster/results/result_registry.json")
    os.makedirs(os.path.dirname(registry), exist_ok=True)
    final_records = final_analysis_results(root, summary)
    atomic_write(registry, {"schemaVersion": 1, "records": final_records, "pendingReviewRecords": [record for record in (summary.get("results") or []) if isinstance(record, dict) and not record.get("eligibleForFinalAnalysis")], "inclusionPolicy": summary.get("inclusionPolicy") or "archived_or_manual_verified", "updatedAt": summary.get("generatedAt"), "planFile": plan or ""})
    if plan:
        atomic_write(safe_project_path(root, "simple_cluster/results/result_registry.json"), {"schemaVersion": 1, "records": final_records, "pendingReviewRecords": [record for record in (summary.get("results") or []) if isinstance(record, dict) and not record.get("eligibleForFinalAnalysis")], "inclusionPolicy": summary.get("inclusionPolicy") or "archived_or_manual_verified", "updatedAt": summary.get("generatedAt"), "planFile": plan or ""})
    return target

def read_archive_entries(root, plan=None, plan_revision=""):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    state = read_json(safe_project_path(root, archive_state_relpath(plan_norm or None)), {})
    if (not isinstance(state, dict) or not state.get("entries")) and plan_norm:
        # Fall back to project-level archive state only when plan-scoped state is absent.
        state = read_json(safe_project_path(root, "simple_cluster/archive_state.json"), {})
    entries = state.get("entries") if isinstance(state, dict) and isinstance(state.get("entries"), dict) else {}
    revision = str(plan_revision or "").strip()
    if not isinstance(entries, dict) or not revision:
        return entries if isinstance(entries, dict) else {}
    return {
        key: entry for key, entry in entries.items()
        if not isinstance(entry, dict) or not str(entry.get("planRevision") or entry.get("plan_revision") or "").strip()
        or str(entry.get("planRevision") or entry.get("plan_revision") or "").strip() == revision
    }

def normalize_artifact_key(value):
    text = str(value or "").replace("\\", "/").strip().lstrip("/")
    text = re.sub(r"/+", "/", text)
    return text.rstrip("/")

def archive_entry_is_final(entry):
    if not isinstance(entry, dict):
        return False
    status = str(entry.get("status") or entry.get("state") or "").lower()
    return bool(entry.get("archived") or status == "archived")

def archive_entry_is_excluded(entry):
    if not isinstance(entry, dict):
        return False
    status = str(entry.get("status") or entry.get("state") or "").lower()
    return bool(entry.get("excluded") or status == "excluded") and not archive_entry_is_final(entry)

def artifact_key_is_excluded(entries, key):
    normalized = normalize_artifact_key(key)
    if not normalized:
        return False
    for raw_key, entry in entries.items():
        excluded_key = normalize_artifact_key(raw_key)
        if not excluded_key or not archive_entry_is_excluded(entry):
            continue
        if normalized == excluded_key or normalized.startswith(excluded_key + "/"):
            return True
    return False

def artifact_key_is_archived(entries, key):
    normalized = normalize_artifact_key(key)
    if not normalized:
        return False
    for raw_key, entry in entries.items():
        archived_key = normalize_artifact_key(raw_key)
        if not archived_key or not archive_entry_is_final(entry):
            continue
        if normalized == archived_key or normalized.startswith(archived_key + "/"):
            return True
    return False

def result_evidence_keys(record):
    keys = []
    if not isinstance(record, dict):
        return keys
    for field in ("resultId", "result_id", "id", "artifactPath", "artifact_path", "hub_job_dir", "worker_job_dir", "native_job_dir", "archiveKey", "archive_key", "sourceFile", "source", "resultPath", "result_path", "results_csv", "result_csv", "runKey", "run_key", "run_id", "experimentId", "experiment_id"):
        value = record.get(field)
        if value:
            keys.append(value)
    for item in record.get("sourceFiles") or []:
        if isinstance(item, dict) and item.get("path"):
            keys.append(item.get("path"))
    provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
    for field in ("artifactKey", "artifactPath", "sourceFile"):
        if provenance.get(field):
            keys.append(provenance.get(field))
    return sorted(dict.fromkeys(normalize_artifact_key(k) for k in keys if normalize_artifact_key(k)))

def result_final_evidence_decision(record, entries):
    keys = result_evidence_keys(record)
    if any(artifact_key_is_archived(entries, key) for key in keys):
        return {"state": "archived", "eligibleForFinalAnalysis": True, "reason": "已归档结果，可进入最终统计。", "matchedKeys": [key for key in keys if artifact_key_is_archived(entries, key)][:8]}
    excluded_keys = [key for key in keys if artifact_key_is_excluded(entries, key)]
    if excluded_keys:
        return {"state": "excluded", "eligibleForFinalAnalysis": False, "reason": "已排除结果；保留在完整预览中，不进入有效 CSV、统计、论文或 PPT。", "matchedKeys": excluded_keys[:8]}
    manual_state = str(record.get("manualReviewState") or record.get("reviewState") or record.get("paperReady") or record.get("paper_ready") or "").lower()
    if manual_state in ("paper_ready", "manual_verified", "approved", "true", "yes", "1"):
        return {"state": "manual_verified", "eligibleForFinalAnalysis": False, "reason": "人工审核不替代归档；保留为待归档候选，不进入最终统计或绘图。", "matchedKeys": []}
    return {"state": "pending_review", "eligibleForFinalAnalysis": False, "reason": "未归档或未人工审核，仅作为待审核线索。", "matchedKeys": []}

def annotate_final_evidence(root, records, plan=None, plan_revision=""):
    entries = read_archive_entries(root, plan, plan_revision)
    out = []
    for record in records or []:
        if not isinstance(record, dict):
            continue
        item = dict(record)
        decision = result_final_evidence_decision(item, entries)
        item["finalEvidenceState"] = decision["state"]
        item["eligibleForFinalAnalysis"] = bool(decision["eligibleForFinalAnalysis"])
        item["finalEvidenceReason"] = decision["reason"]
        item["finalEvidenceKeys"] = result_evidence_keys(item)[:12]
        item["matchedArchiveKeys"] = decision.get("matchedKeys") or []
        out.append(item)
    return out

def final_analysis_results(root, summary):
    records = (summary or {}).get("results") or []
    if not records:
        return []
    if not all(isinstance(record, dict) and "eligibleForFinalAnalysis" in record for record in records):
        records = annotate_final_evidence(root, records, (summary or {}).get('planFile') or None, (summary or {}).get('planRevision') or "")
    return [record for record in records if isinstance(record, dict) and str(record.get("finalEvidenceState") or "").lower() == "archived"]

def apply_final_evidence_summary(root, summary):
    records = annotate_final_evidence(root, (summary or {}).get("results") or [], (summary or {}).get("planFile") or None, (summary or {}).get("planRevision") or "")
    final_records = [record for record in records if str(record.get("finalEvidenceState") or "").lower() == "archived"]
    excluded_records = [record for record in records if str(record.get("finalEvidenceState") or "").lower() == "excluded"]
    summary["results"] = records
    summary["finalResults"] = final_records
    summary["finalResultCount"] = len(final_records)
    summary["excludedResultCount"] = len(excluded_records)
    summary["pendingReviewCount"] = max(0, len(records) - len(final_records) - len(excluded_records))
    summary["inclusionPolicy"] = "archived_only"
    summary["inclusionPolicyMessage"] = "最终统计、论文表、claim 证据和 PPT 只使用已归档结果；完整预览 CSV 保留所有解析结果供人工筛选。"
    return summary

def final_evidence_catalog_from_records(records):
    sources, keys = [], set()
    for record in records or []:
        for key in result_evidence_keys(record):
            if key:
                sources.append(key)
                keys.add(key)
        for field in ("resultId", "experimentId", "runKey"):
            value = str(record.get(field) or "").strip()
            if value:
                keys.add(value)
    return {"sources": sorted(dict.fromkeys(sources))[:240], "keys": sorted(k for k in keys if k)}

def parse_claim_lines(text):
    claims = []
    in_code = False
    for line_no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if line.startswith(chr(96) * 3):
            in_code = not in_code
            continue
        if in_code or not line or line.startswith("#"):
            continue
        if re.match(r"^\|[-:\s|]+\|$", line):
            continue
        cleaned = re.sub(r"^\s*(?:[-*+]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s*)", "", line).strip()
        cleaned = re.sub(r"^(claim|claims|结论|声明|主张)\s*[:：]\s*", "", cleaned, flags=re.I).strip()
        cleaned = cleaned.strip("| ")
        if len(cleaned) < 6:
            continue
        claims.append({"line": line_no, "text": cleaned, "raw": raw})
    return claims

def discover_claim_evidence_catalog(root, summary=None):
    final_records = final_analysis_results(root, summary or {}) if summary is not None else []
    return final_evidence_catalog_from_records(final_records) if final_records else {"sources": [], "keys": []}

def extract_claim_evidence_refs(text):
    refs = []
    pattern = re.compile(r"(experiments/results\.csv|experiments/(?:runs|results)(?:/[^\s\])},;，。；]+)?|paper/claims\.md)", re.I)
    for match in pattern.finditer(text or ""):
        ref = match.group(1).strip().rstrip(".,;，。；)]）")
        if ref and ref not in refs:
            refs.append(ref)
    return refs

def evidence_ref_exists(root, ref):
    normalized = str(ref or "").replace("\\", "/").strip().lstrip("/")
    if normalized == "paper/claims.md":
        return os.path.isfile(os.path.join(root, "paper", "claims.md"))
    if normalized.startswith(("experiments/runs", "experiments/results", "experiments/results.csv")):
        try:
            return os.path.exists(safe_project_path(root, normalized))
        except Exception:
            return False
    return False

def evidence_ref_is_final(catalog, ref):
    normalized = normalize_artifact_key(ref)
    if not normalized or normalized == "paper/claims.md":
        return False
    keys = set(str(key or "").strip() for key in (catalog.get("keys") or []))
    sources = set(normalize_artifact_key(source) for source in (catalog.get("sources") or []))
    return normalized in sources or normalized in keys or os.path.basename(normalized) in keys

def claim_known_key_matches(text, catalog):
    lowered = str(text or "").lower()
    has_signal = any(word in lowered for word in ("evidence", "run", "result", "experiment", "证据", "实验", "结果", "支持"))
    if not has_signal:
        return []
    matches = []
    for key in catalog.get("keys") or []:
        key_text = str(key or "").strip()
        if len(key_text) < 4:
            continue
        pattern = re.compile(r"(?<![A-Za-z0-9_.-])" + re.escape(key_text.lower()) + r"(?![A-Za-z0-9_.-])")
        match = pattern.search(lowered)
        if not match:
            continue
        start = max(0, match.start() - 36)
        end = min(len(lowered), match.end() + 36)
        window = lowered[start:end]
        if any(word in window for word in ("evidence", "run", "runkey", "result id", "experiment id", "证据", "运行编号", "任务编号", "实验编号", "结果id")):
            matches.append(key_text)
        if len(matches) >= 12:
            break
    return sorted(dict.fromkeys(matches))

def evaluate_claim_evidence(root, summary=None):
    claims_path = os.path.join(root, "paper", "claims.md")
    catalog = discover_claim_evidence_catalog(root, summary or {})
    plan_norm = normalize_result_candidate((summary or {}).get("planFile") or "")
    rel_target = plan_results_artifact_relpath(plan_norm, "claim_evidence.json")
    target = safe_project_path(root, rel_target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if not os.path.isfile(claims_path):
        report = {
            "schemaVersion": 1,
            "status": "needs_claims_file",
            "message": "未找到 paper/claims.md，论文 claim 证据链尚未建立。",
            "generatedAt": now_iso(),
            "claimCount": 0,
            "supportedCount": 0,
            "unsupportedCount": 0,
            "needsExperimentCount": 0,
            "claims": [],
            "evidenceSources": catalog.get("sources") or [],
        }
        atomic_write(target, report)
        atomic_write(safe_project_path(root, "simple_cluster/results/claim_evidence.json"), report)
        report = {**report, "path": relpath(root, target), "planFile": plan_norm or ""}
        return report
    text = open(claims_path, "r", encoding="utf-8", errors="replace").read()
    rows = []
    for claim in parse_claim_lines(text):
        claim_text = claim.get("text") or ""
        lowered = claim_text.lower()
        refs = extract_claim_evidence_refs(claim_text)
        existing_refs = [ref for ref in refs if evidence_ref_exists(root, ref) and evidence_ref_is_final(catalog, ref)]
        missing_refs = [ref for ref in refs if ref not in existing_refs]
        key_matches = claim_known_key_matches(claim_text, catalog)
        has_evidence = bool(existing_refs or key_matches)
        if re.search(r"\b(needs?\s+experiment|todo|tbd|unsupported)\b|待实验|需要实验|缺证据|未支持", lowered, re.I):
            status = "needs experiment" if ("need" in lowered or "待实验" in claim_text or "需要实验" in claim_text or "todo" in lowered or "tbd" in lowered) else "unsupported"
        elif has_evidence:
            status = "supported"
        elif missing_refs:
            status = "unsupported"
        else:
            status = "needs experiment" if not (catalog.get("sources") or []) else "unsupported"
        rows.append({
            "claimId": sha256_text(str(claim.get("line")) + ":" + claim_text)[:16],
            "line": claim.get("line"),
            "text": claim_text,
            "status": status,
            "evidenceRefs": existing_refs,
            "missingRefs": missing_refs,
            "matchedKeys": key_matches,
        })
    supported = len([row for row in rows if row.get("status") == "supported"])
    needs = len([row for row in rows if row.get("status") == "needs experiment"])
    unsupported = len([row for row in rows if row.get("status") == "unsupported"])
    status = "passed" if rows and not needs and not unsupported else ("needs experiment" if needs else "unsupported" if unsupported else "empty")
    report = {
        "schemaVersion": 1,
        "status": status,
        "message": "claim 证据链完整。" if status == "passed" else "存在缺证据或待实验 claim。",
        "generatedAt": now_iso(),
        "claimsPath": "paper/claims.md",
        "claimCount": len(rows),
        "supportedCount": supported,
        "unsupportedCount": unsupported,
        "needsExperimentCount": needs,
        "claims": rows,
        "evidenceSources": catalog.get("sources") or [],
    }
    atomic_write(target, report)
    atomic_write(safe_project_path(root, "simple_cluster/results/claim_evidence.json"), report)
    report = {**report, "path": relpath(root, target), "planFile": plan_norm or report.get("planFile") or ""}
    return report

def apply_claim_evidence_summary(summary, report):
    summary["claimEvidenceStatus"] = report.get("status")
    summary["claimEvidencePath"] = (report or {}).get("path") or "simple_cluster/results/claim_evidence.json"
    summary["claimEvidenceCheckedAt"] = report.get("generatedAt")
    summary["claimCount"] = report.get("claimCount", 0)
    summary["claimSupportedCount"] = report.get("supportedCount", 0)
    summary["claimUnsupportedCount"] = report.get("unsupportedCount", 0)
    summary["claimNeedsExperimentCount"] = report.get("needsExperimentCount", 0)
    summary["claimEvidencePreview"] = (report.get("claims") or [])[:12]
    summary["claimEvidence"] = {
        "status": report.get("status"),
        "message": report.get("message"),
        "claimCount": report.get("claimCount", 0),
        "supportedCount": report.get("supportedCount", 0),
        "unsupportedCount": report.get("unsupportedCount", 0),
        "needsExperimentCount": report.get("needsExperimentCount", 0),
        "path": "simple_cluster/results/claim_evidence.json",
        "preview": (report.get("claims") or [])[:12],
    }
    return summary

def unique_metric_names(values):
    out = []
    for value in values or []:
        metric = metric_name(value)
        if metric and metric not in out:
            out.append(metric)
    return out

def yaml_scalar(text, key, fallback=""):
    match = re.search(r"^\s*" + re.escape(key) + r"\s*:[ \t]*['\"]?([^'\"\n#\[\]]+)", text, re.M)
    return match.group(1).strip() if match else fallback

def yaml_has_scalar(text, key):
    return bool(re.search(r"^\s*" + re.escape(key) + r"\s*:", str(text or ""), re.M))

def yaml_clean_value(value):
    text = str(value or "").strip()
    if "#" in text:
        text = text.split("#", 1)[0].strip()
    return text.strip().strip("'\"")

def yaml_list(text, key):
    inline = re.search(r"^\s*" + re.escape(key) + r"\s*:\s*\[([^\]]*)\]", text, re.M)
    if inline:
        return [yaml_clean_value(item) for item in inline.group(1).split(",") if yaml_clean_value(item)]
    block = re.search(r"^\s*" + re.escape(key) + r"\s*:\s*\n((?:\s+-\s*[^\n#]+(?:\n|$))+)", text, re.M)
    if not block:
        return []
    return [yaml_clean_value(item) for item in re.findall(r"^\s+-\s*([^\n#]+)", block.group(1), re.M)]

def yaml_section_text(text, section):
    lines = str(text or "").splitlines()
    for i, raw in enumerate(lines):
        match = re.match(r"^(\s*)" + re.escape(section) + r"\s*:\s*(?:#.*)?$", raw)
        if not match:
            continue
        indent = len(match.group(1))
        out = []
        for child in lines[i + 1:]:
            if child.strip() and (len(child) - len(child.lstrip(" "))) <= indent:
                break
            if len(child) >= indent + 2:
                out.append(child[indent + 2:])
            else:
                out.append(child)
        return "\n".join(out)
    return ""

def yaml_map(text, key):
    lines = str(text or "").splitlines()
    for i, raw in enumerate(lines):
        match = re.match(r"^(\s*)" + re.escape(key) + r"\s*:\s*(?:#.*)?$", raw)
        if not match:
            continue
        indent = len(match.group(1))
        out = {}
        for child in lines[i + 1:]:
            if not child.strip():
                continue
            child_indent = len(child) - len(child.lstrip(" "))
            if child_indent <= indent:
                break
            item = re.match(r"^\s*([A-Za-z0-9_.@-]+)\s*:\s*(.*?)\s*$", child)
            if item:
                out[item.group(1)] = yaml_clean_value(item.group(2))
        return {k: v for k, v in out.items() if k and v}
    return {}

def unique_values(values):
    out = []
    seen = set()
    for value in values or []:
        text = str(value or "").strip()
        if text and text not in seen:
            out.append(text)
            seen.add(text)
    return out

def yaml_policy_list(text, outputs, key):
    return unique_values([*yaml_list(text, key), *yaml_list(outputs, key)])

def yaml_policy_map(text, outputs, key):
    out = {}
    out.update(yaml_map(text, key))
    out.update(yaml_map(outputs, key))
    return out

def normalize_result_candidate(value):
    key = value if isinstance(value, str) else None
    if key is not None:
        cached = RESULT_CANDIDATE_CACHE.get(key)
        if cached is not None:
            return cached
    normalized = compute_result_candidate(value)
    if key is not None:
        if len(RESULT_CANDIDATE_CACHE) >= MAX_RESULT_CANDIDATE_CACHE_RECORDS:
            RESULT_CANDIDATE_CACHE.clear()
        RESULT_CANDIDATE_CACHE[key] = normalized
    return normalized

def compute_result_candidate(value):
    text = str(value or "").strip().strip("'\"").replace("\\", "/").lstrip("/")
    if not text or text.lower() in ("none", "null", "false"):
        return ""
    if re.match(r"^(?:https?|s3|gs|oss):", text, re.I) or re.match(r"^(?:[A-Za-z]:)?/", text):
        return ""
    # Placeholder tokens become wildcards for plan evidence / candidate matching.
    text = re.sub(r"\{[^}]+\}", "*", text)
    text = re.sub(r"\*+", "*", text)
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        return ""
    joined = "/".join(parts)
    if re.search(r"\.(csv|json|txt|log|out)$", joined, re.I) and not allowed_result_candidate(joined):
        return ""
    return joined

def expand_result_candidates(root, candidates, limit=240):
    out = []
    for raw in candidates or []:
        pattern = normalize_result_candidate(raw)
        if not pattern:
            continue
        matches = []
        if any(ch in pattern for ch in "*?[]"):
            matches = [relpath(root, path) for path in glob.glob(os.path.join(root, *pattern.split("/")), recursive=True)]
        else:
            matches = [pattern]
        for rel in matches:
            rel = normalize_result_candidate(rel)
            if not rel:
                continue
            lower = rel.lower()
            if lower in IGNORED_RESULT_FILES or os.path.basename(lower) == "jobs.csv":
                continue
            try:
                path = safe_project_path(root, rel)
            except Exception:
                continue
            if parseable_result_candidate(rel) and safe_small_file(path):
                out.append(rel)
            if len(out) >= limit:
                return sorted(dict.fromkeys(out))
    return sorted(dict.fromkeys(out))

def discover_result_files_under(root, relative, limit=80, max_dirs=400, max_depth=5):
    rel = normalize_result_candidate(relative)
    if not rel:
        return []
    try:
        base = safe_project_path(root, rel)
    except Exception:
        return []
    if safe_small_file(base) and parseable_result_candidate(rel):
        return [rel]
    if not os.path.isdir(base):
        return []
    out = []
    visited_dirs = 0
    for current, dirs, files in os.walk(base):
        visited_dirs += 1
        if visited_dirs >= max_dirs:
            dirs[:] = []
            break
        depth = len(os.path.relpath(current, base).split(os.sep)) if os.path.relpath(current, base) != "." else 0
        if depth >= max_depth:
            dirs[:] = []
        else:
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features") and not d.startswith(".")]
        for name in files:
            if name.lower() in STRUCTURED_RESULT_DIAGNOSTIC_LOGS:
                continue
            path = os.path.join(current, name)
            candidate = relpath(root, path)
            if candidate.replace("\\", "/").lstrip("/").startswith("simple_cluster/debug_runs/"):
                continue
            if parseable_result_candidate(candidate) and safe_small_file(path):
                out.append(candidate)
            if len(out) >= limit:
                return sorted(dict.fromkeys(out))
    return sorted(dict.fromkeys(out))

def selected_result_candidates(root, selected, limit=240):
    selected = [str(item or "").strip().replace("\\", "/").lstrip("/") for item in (selected or []) if str(item or "").strip()]
    if not selected:
        return []
    out = []
    out.extend(expand_result_candidates(root, selected, limit))
    for item in selected:
        if len(out) >= limit:
            break
        out.extend(discover_result_files_under(root, item, max(0, limit - len(out))))
    if len(out) < limit:
        out.extend(expand_result_candidates(root, job_result_candidates_for_keys(root, selected, max(0, limit - len(out))), max(0, limit - len(out))))
    return sorted(dict.fromkeys(out))[:limit]

def policy_result_candidates(policy):
    return unique_values(filter(None, (parseable_result_candidate(item) for item in [
        policy.get("summaryCsv"),
        policy.get("caseCsv"),
        *(policy.get("candidateCsv") or []),
        *(policy.get("candidateJson") or []),
        *(policy.get("consoleLogs") or []),
        *(policy.get("textLogs") or []),
    ])))

def policy_explicit_result_candidates(policy):
    return unique_values(filter(None, (parseable_result_candidate(item) for item in [
        *(policy.get("explicitResultCandidates") or []),
        *(policy.get("candidateCsv") or []),
        *(policy.get("candidateJson") or []),
        *(policy.get("consoleLogs") or []),
        *(policy.get("textLogs") or []),
    ])))

def uncommented_yaml_text(text):
    lines = []
    for raw in str(text or "").splitlines():
        stripped = raw.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(raw.split("#", 1)[0].rstrip())
    return "\n".join(lines)

def yaml_command_values(text, keys):
    key_set = set(keys or [])
    lines = str(text or "").splitlines()
    out = []
    for index, raw in enumerate(lines):
        match = re.match(r"^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$", raw)
        if not match or match.group(2) not in key_set:
            continue
        base_indent = len(match.group(1))
        rest = match.group(3).strip()
        if re.match(r"^[|>][+-]?\d*$", rest):
            block = []
            block_indent = None
            for child in lines[index + 1:]:
                if not child.strip():
                    if block_indent is not None:
                        block.append("")
                    continue
                indent = len(child) - len(child.lstrip(" "))
                if indent <= base_indent:
                    break
                if block_indent is None:
                    block_indent = indent
                block.append(child[min(indent, block_indent):])
            value = " ".join(item.strip() for item in block if item.strip()) if rest.startswith(">") else "\n".join(block)
            if value.strip():
                out.append(value.strip())
            continue
        if rest:
            out.append(yaml_clean_value(rest))
    return unique_values(out)

def split_yaml_flow_items(text):
    items = []
    current = []
    quote = ""
    escape = False
    depth = 0
    for ch in str(text or ""):
        if quote:
            current.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                quote = ""
            continue
        if ch in ("'", '"'):
            quote = ch
            current.append(ch)
            continue
        if ch in ("{", "["):
            depth += 1
        elif ch in ("}", "]"):
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            item = "".join(current).strip()
            if item:
                items.append(item)
            current = []
            continue
        current.append(ch)
    item = "".join(current).strip()
    if item:
        items.append(item)
    return items

def yaml_flow_map_bodies(text):
    bodies = []
    quote = ""
    escape = False
    depth = 0
    start = -1
    for index, ch in enumerate(str(text or "")):
        if quote:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                quote = ""
            continue
        if ch in ("'", '"'):
            quote = ch
            continue
        if ch == "{":
            if depth == 0:
                start = index + 1
            depth += 1
            continue
        if ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                body = str(text or "")[start:index]
                bodies.append(body)
                bodies.extend(yaml_flow_map_bodies(body))
                start = -1
    return bodies

def yaml_flow_map_pairs(text):
    out = []
    for body in yaml_flow_map_bodies(text):
        for part in split_yaml_flow_items(body):
            match = re.match(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$", part, re.S)
            if match:
                out.append((match.group(1), match.group(2).strip()))
    return out

def yaml_flow_map_values(text, keys):
    key_set = set(keys or [])
    return unique_values([yaml_clean_value(value) for key, value in yaml_flow_map_pairs(text) if key in key_set])

def plan_expected_result_candidates(text):
    cleaned = uncommented_yaml_text(text)
    out = []
    for key in ("expectedResults", "expected_results", "resultFiles", "result_files", "outputFiles", "output_files"):
        inline = re.search(r"^\s*" + re.escape(key) + r"\s*:\s*\[(.*?)\]", cleaned, re.M | re.S)
        if inline:
            out.extend(plan_result_candidate_values(inline.group(1)))
        block = re.search(r"^\s*" + re.escape(key) + r"\s*:\s*\n((?:\s+[-A-Za-z0-9_\"'{].*(?:\n|$))+)", cleaned, re.M)
        if block:
            out.extend(plan_result_candidate_values(block.group(1)))
        for value in yaml_flow_map_values(cleaned, (key,)):
            out.extend(plan_result_candidate_values(value))
    return unique_values(filter(None, (parseable_result_candidate(item) for item in out)))

def plan_output_rule_signals(text):
    out = []
    candidate_count = 0
    for key in ("candidateCsv", "candidateJson", "consoleLogs", "textLogs"):
        values = [*yaml_list(text, key), *yaml_flow_map_values(text, (key,))]
        valid = [parseable_result_candidate(value) for value in values if parseable_result_candidate(value)]
        candidate_count += len(valid)
        if valid:
            out.append(key)
    metric_values = [yaml_scalar(text, "metricRegex", ""), *yaml_flow_map_values(text, ("metricRegex",))]
    if candidate_count and any(str(value or "").strip().strip("'\"") not in ("", "[]", "{}", "null", "None", "none", "false", "False") for value in metric_values):
        out.append("metricRegex")
    return unique_values(out)

def plan_result_candidate_values(value):
    text = str(value or "")
    out = []
    result_keys = r"(?:path|file|result|resultFile|result_file|result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output|outputFile|output_file|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log|log_file|logFile)"
    for match in re.findall(result_keys + r"\s*:\s*['\"]?([^,'\"\]\}\n]+)", text):
        candidate = normalize_result_candidate(match)
        if candidate:
            out.append(candidate)
    for raw in re.findall(r"^\s*-\s*['\"]?([^,'\"\]\}\n:]+?\.(?:csv|json|txt|log|out))['\"]?\s*$", text, re.I | re.M):
        candidate = normalize_result_candidate(raw)
        if candidate:
            out.append(candidate)
    if not re.search(r":", text):
        for raw in re.findall(r"['\"]?([A-Za-z0-9_./{}@+-]+\.(?:csv|json|txt|log|out))['\"]?", text, re.I):
            candidate = normalize_result_candidate(raw)
            if candidate:
                out.append(candidate)
    return unique_values(filter(None, (parseable_result_candidate(item) for item in out)))

def plan_command_result_candidates(command_text):
    text = str(command_text or "").replace("\\\n", " ").replace("\r\n", "\n").replace("\r", "\n").replace("\n", " ")
    if not text.strip():
        return []
    try:
        parts = shlex.split(text, posix=True)
    except Exception:
        parts = text.split()
    flags = {
        "result-csv", "result_csv", "results-csv", "results_csv",
        "metrics-csv", "metrics_csv", "summary-csv", "summary_csv",
        "output-csv", "output_csv", "result-json", "result_json",
        "metrics-json", "metrics_json", "summary-txt", "summary_txt",
        "log-file", "log_file", "stdout", "stderr",
    }
    dir_flags = {
        "output", "out", "output-dir", "output_dir", "out-dir", "out_dir",
        "result-dir", "result_dir", "results-dir", "results_dir",
        "work-dir", "work_dir", "workdir", "save-dir", "save_dir",
        "log-dir", "log_dir", "logging-dir", "logging_dir", "loggingdir",
        "tensorboard-log-dir", "tensorboard_log_dir", "tensorboardlogdir",
        "tb-log-dir", "tb_log_dir", "tblogdir", "run-dir", "run_dir", "rundir",
        "default-root-dir", "default_root_dir",
        "defaultrootdir", "dirpath", "hydra.run.dir", "hydra.sweep.dir",
        "logger.save_dir", "logger.save-dir", "trainer.default_root_dir",
        "trainer.default-root-dir",
    }
    dir_flag_aliases = {item.replace("_", "-").lower() for item in dir_flags}
    out = []
    for index, token in enumerate(parts):
        token = str(token or "")
        if token.startswith("--"):
            body = token[2:]
            value = ""
            if "=" in body:
                flag, value = body.split("=", 1)
            else:
                flag = body
                if index + 1 < len(parts) and not str(parts[index + 1]).startswith("-"):
                    value = str(parts[index + 1])
            normalized_flag = flag.replace("_", "-").lower()
            if normalized_flag in {item.replace("_", "-") for item in flags}:
                candidate = normalize_result_candidate(value)
                if candidate:
                    out.append(candidate)
            elif normalized_flag in {item.replace("_", "-") for item in dir_flags}:
                out.extend(default_result_candidates_for_dir(value))
            continue
        if "=" in token:
            key, value = token.split("=", 1)
            normalized_key = key.replace("_", "-").lower()
            if normalized_key in dir_flag_aliases or re.search(r"(?:output_dir|output-dir|outputDir|out_dir|out-dir|work_dir|work-dir|workDir|workdir|save_dir|save-dir|saveDir|log_dir|log-dir|logDir|logging_dir|logging-dir|loggingDir|tensorboard_log_dir|tensorboard-log-dir|tensorboardLogDir|tb_log_dir|tb-log-dir|tbLogDir|run_dir|run-dir|runDir|rundir|result_dir|result-dir|resultDir|results_dir|results-dir|resultsDir|default_root_dir|default-root-dir|defaultRootDir|dirpath|hydra\.run\.dir|hydra\.sweep\.dir|logger\.save_dir|logger\.save-dir|trainer\.default_root_dir|trainer\.default-root-dir)$", key):
                out.extend(default_result_candidates_for_dir(value))
    return unique_values(filter(None, (parseable_result_candidate(item) for item in out)))

def default_result_candidates_for_dir(value):
    raw = normalize_result_candidate(value)
    if not raw or re.search(r"/?[^/]+\.[A-Za-z0-9]{1,8}$", raw):
        return []
    prefix = "" if raw == "." else raw.strip("/") + "/"
    # output_dir 只推导结构化指标文件；stdout/stderr 仍保留为诊断证据。
    candidates = [
        prefix + "metrics_summary.csv",
        prefix + "metrics_case.csv",
    ]
    return [candidate for candidate in (normalize_result_candidate(item) for item in candidates) if candidate and allowed_result_candidate(candidate)]

def plan_mode_command_keys(text):
    mode = normalized_experiment_mode(yaml_scalar(text, "mode", "train_test"))
    if mode == "train":
        return ("command", "train_command", "trainCommand")
    if mode == "test":
        return ("test_command", "testCommand")
    return ("command", "train_command", "trainCommand", "test_command", "testCommand")

def plan_command_result_candidate_values(text):
    command_keys = plan_mode_command_keys(text)
    command_lines = [*yaml_command_values(text, command_keys), *yaml_flow_map_values(text, command_keys)]
    return unique_values([candidate for command in command_lines for candidate in plan_command_result_candidates(command)])

def discover_plan_files(root, plan_dir=None, limit=500):
    base = normalize_result_candidate(plan_dir) if plan_dir else "experiments/plans"
    if not base:
        base = "experiments/plans"
    base_path = safe_project_path(root, base)
    out = []
    if not os.path.isdir(base_path):
        return out
    for dirpath, dirnames, filenames in os.walk(base_path):
        # Skip heavy / archive dirs while still allowing nested plan folders.
        dirnames[:] = [name for name in sorted(dirnames) if name not in {"_archived", ".git", "__pycache__", "node_modules", ".venv", "venv"} and not str(name).startswith(".")]
        for name in sorted(filenames):
            if not re.search(r"\.(ya?ml)$", name, re.I):
                continue
            full = os.path.join(dirpath, name)
            rel = relpath(root, full)
            if not rel or rel.startswith("../"):
                continue
            out.append(normalize_result_candidate(rel))
            if len(out) >= max(1, int(limit or 500)):
                return out
    return out

def plan_declared_result_candidates(root, plan=None, limit=240):
    plans = []
    if plan:
        plans.append(plan)
    else:
        plans.extend(discover_plan_files(root, "experiments/plans", limit=max(1, int(limit or 240))))
    out = []
    for item in plans:
        try:
            plan_path = safe_project_path(root, item)
            text = open(plan_path, "r", encoding="utf-8", errors="replace").read()
            cleaned = uncommented_yaml_text(text)
        except Exception:
            continue
        suite = str(yaml_scalar(cleaned, "suite", "") or "").strip()
        resolved = cleaned.replace("{suite}", suite) if suite else cleaned
        out.extend(plan_expected_result_candidates(resolved))
        out.extend(plan_command_result_candidate_values(resolved))
        for key in ("result_csv", "resultCsv", "results_csv", "resultsCsv", "metrics_csv", "metricsCsv", "summary_csv", "summaryCsv", "output_csv", "outputCsv", "result_json", "resultJson", "metrics_json", "metricsJson", "summary_txt", "summaryTxt", "log_file", "logFile"):
            out.extend(plan_result_candidate_values(yaml_scalar(resolved, key, "")))
            out.extend(plan_result_candidate_values("\n".join(yaml_flow_map_values(resolved, (key,)))))
        if len(out) >= limit:
            break
    return unique_values(filter(None, (parseable_result_candidate(item) for item in out)))[:limit]

def plan_declared_runner_outputs(root, text):
    runner = yaml_section_text(text, "runner")
    raw = [*yaml_list(runner, "outputs"), *yaml_flow_map_values(runner, ("outputs",)), *yaml_flow_map_values(text, ("outputs",))]
    candidates = []
    def add(value):
        item = yaml_clean_value(value)
        if not item:
            return
        if item.startswith("[") and item.endswith("]"):
            for part in split_yaml_flow_items(item[1:-1]):
                add(part)
            return
        if item.startswith("{") and item.endswith("}"):
            paths = yaml_flow_map_values(item, ("path",))
            if paths:
                for part in paths:
                    add(part)
                return
        if re.match(r"^path\s*:", item, re.I):
            item = yaml_clean_value(yaml_scalar(item, "path", ""))
        if item and item not in candidates:
            candidates.append(item)
    for item in raw:
        add(item)
    valid, invalid = [], []
    for item in candidates[:32]:
        normalized = item.replace("\\", "/").strip()
        parts = [part for part in normalized.split("/") if part not in ("", ".")]
        if not normalized or os.path.isabs(normalized) or normalized.startswith("/") or any(part == ".." for part in parts):
            invalid.append(item)
            continue
        try:
            safe_project_path(root, normalized)
        except Exception:
            invalid.append(item)
            continue
        valid.append("/".join(parts))
    if len(candidates) > 32:
        invalid.append("runner.outputs 超过 32 项限制")
    return valid, invalid

def plan_output_capture_evidence(root, plan):
    try:
        plan_path = safe_project_path(root, plan)
        text = open(plan_path, "r", encoding="utf-8", errors="replace").read()
    except Exception as exc:
        return {"ok": False, "missing": ["计划文件"], "signals": [], "message": str(exc)}
    cleaned = uncommented_yaml_text(text)
    signals = []
    declared_outputs, invalid_outputs = plan_declared_runner_outputs(root, cleaned)
    if declared_outputs:
        signals.append("runner.outputs")
    expected = plan_expected_result_candidates(cleaned)
    command_candidates = plan_command_result_candidate_values(cleaned)
    declared_candidates = plan_declared_result_candidates(root, plan)
    if expected:
        signals.append("expectedResults")
    direct_keys = ("result_csv", "resultCsv", "results_csv", "resultsCsv", "metrics_csv", "metricsCsv", "summary_csv", "summaryCsv", "output_csv", "outputCsv", "result_json", "resultJson", "metrics_json", "metricsJson", "summary_txt", "summaryTxt", "log_file", "logFile")
    direct_candidates = []
    for key in direct_keys:
        direct_candidates.extend(plan_result_candidate_values(yaml_scalar(cleaned, key, "")))
        direct_candidates.extend(plan_result_candidate_values("\n".join(yaml_flow_map_values(cleaned, (key,)))))
    if direct_candidates:
        signals.append("result_csv")
    if plan_output_rule_signals(cleaned):
        signals.append("plan_output_rules")
    command_keys = plan_mode_command_keys(cleaned)
    command_lines = "\n".join([*yaml_command_values(cleaned, command_keys), *yaml_flow_map_values(cleaned, command_keys)])
    if re.search(r"(\{(?:result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log_file|logFile)\}|--result[-_]csv|--results[-_]csv|--metrics[-_]csv|--summary[-_]csv|--result[-_]json|--metrics[-_]json|metrics_summary\.csv|classification_report|scores\.csv|summary\.txt|stdout\.log|stderr\.log)", command_lines, re.I):
        signals.append("runner_command")
    if command_candidates:
        signals.append("runner_command_paths")
    if any(re.search(r"(^|/)(metrics_summary\.csv|metrics_case\.csv|classification_report\.csv|scores\.csv|results?\.csv|summary\.txt|stdout\.log|stderr\.log|output\.out)$", candidate, re.I) for candidate in [*expected, *direct_candidates, *command_candidates]):
        signals.append("standard_result_file")
    policy = read_project_metric_policy(root)
    if policy_explicit_result_candidates(policy):
        signals.append("plugin_or_project_adapter")
    ok = bool(signals) and not invalid_outputs
    return {
        "ok": ok,
        "signals": unique_values(signals),
        "expectedResults": unique_values([*declared_candidates, *expected, *command_candidates])[:20],
        "declaredOutputs": declared_outputs,
        "invalidDeclaredOutputs": invalid_outputs,
        "missing": [] if ok else (["runner.outputs 路径无效：" + ", ".join(invalid_outputs[:8])] if invalid_outputs else ["接入配置", "计划输出", "候选结果规则"]),
        "message": "" if ok else ("runner.outputs 声明包含越界或不安全路径，已阻止运行。" if invalid_outputs else "未识别到可用的结果捕获规则，已阻止运行实验。请在 Plan 中声明 runner.outputs，或为需要指标的任务配置 paper.result_csv、执行命令的结果参数、expectedResults 或 stdout/stderr 捕获。"),
    }

def read_project_metric_policy(root):
    policy = {
        "taskType": "classification",
        "primaryMetric": "AUC",
        "secondaryMetrics": ["accuracy", "F1", "AUPRC"],
        "classificationMetrics": CLASSIFICATION_METRIC_PRIORITY,
        "segmentationMetrics": SEGMENTATION_METRIC_PRIORITY,
        "candidateCsv": [],
        "candidateJson": [],
        "consoleLogs": [],
        "textLogs": [],
        "metricRegex": "",
        "csvColumnMapping": {},
        "derivedMetric": {},
        "metricAliases": {},
        "summaryCsv": "metrics_summary.csv",
        "caseCsv": "metrics_case.csv",
        "explicitResultCandidates": [],
    }
    config = os.path.join(root, "experiments", "simple_project.yaml")
    if os.path.isfile(config):
        try:
            text = open(config, "r", encoding="utf-8", errors="replace").read()
            outputs = yaml_section_text(text, "outputs")
            policy["taskType"] = yaml_scalar(text, "taskType", policy["taskType"]) or policy["taskType"]
            policy["primaryMetric"] = metric_name(yaml_scalar(text, "primaryMetric", policy["primaryMetric"]) or policy["primaryMetric"])
            secondary = unique_metric_names(yaml_list(text, "secondaryMetrics"))
            classification = unique_metric_names(yaml_list(text, "classificationMetrics"))
            segmentation = unique_metric_names(yaml_list(text, "segmentationMetrics"))
            if secondary:
                policy["secondaryMetrics"] = secondary
            if classification:
                policy["classificationMetrics"] = classification
            if segmentation:
                policy["segmentationMetrics"] = segmentation
            policy["candidateCsv"] = yaml_policy_list(text, outputs, "candidateCsv")
            policy["candidateJson"] = yaml_policy_list(text, outputs, "candidateJson")
            policy["consoleLogs"] = yaml_policy_list(text, outputs, "consoleLogs")
            policy["textLogs"] = yaml_policy_list(text, outputs, "textLogs")
            policy["metricRegex"] = yaml_scalar(outputs, "metricRegex", yaml_scalar(text, "metricRegex", "")) or ""
            explicit = []
            if yaml_has_scalar(outputs, "summaryCsv") or yaml_has_scalar(text, "summaryCsv"):
                explicit.append(yaml_scalar(outputs, "summaryCsv", yaml_scalar(text, "summaryCsv", "")))
            if yaml_has_scalar(outputs, "caseCsv") or yaml_has_scalar(text, "caseCsv"):
                explicit.append(yaml_scalar(outputs, "caseCsv", yaml_scalar(text, "caseCsv", "")))
            policy["summaryCsv"] = yaml_scalar(outputs, "summaryCsv", yaml_scalar(text, "summaryCsv", policy["summaryCsv"])) or policy["summaryCsv"]
            policy["caseCsv"] = yaml_scalar(outputs, "caseCsv", yaml_scalar(text, "caseCsv", policy["caseCsv"])) or policy["caseCsv"]
            policy["explicitResultCandidates"] = unique_values([*explicit, *policy["candidateCsv"], *policy["candidateJson"], *policy["consoleLogs"], *policy["textLogs"]])
            policy["csvColumnMapping"] = yaml_policy_map(text, outputs, "csvColumnMapping")
            aliases = yaml_policy_map(text, outputs, "metricAliases")
            policy["metricAliases"] = {str(k): metric_name(v) for k, v in aliases.items()}
            for key, value in list(policy["metricAliases"].items()):
                policy["metricAliases"][str(key).lower()] = value
        except Exception:
            pass
    plugin_policy = read_json(path_for(root, "result_policy.json"), {})
    if isinstance(plugin_policy, dict):
        for key in ("taskType", "primaryMetric", "metricRegex", "summaryCsv", "caseCsv"):
            value = plugin_policy.get(key)
            if isinstance(value, str) and value.strip():
                policy[key] = value.strip()
        for key in ("secondaryMetrics", "classificationMetrics", "segmentationMetrics", "candidateCsv", "candidateJson", "consoleLogs", "textLogs"):
            values = plugin_policy.get(key)
            if isinstance(values, list):
                policy[key] = [value.strip() for value in values if isinstance(value, str) and value.strip()][:100]
        mapping = plugin_policy.get("csvColumnMapping")
        if isinstance(mapping, dict):
            policy["csvColumnMapping"] = {key: value.strip() for key, value in mapping.items() if key in ("case", "seed", "split", "dataset", "method", "eval_protocol", "rate_percent", "train_rate", "metric", "value") and isinstance(value, str) and value.strip()}
        derived = plugin_policy.get("derivedMetric")
        if isinstance(derived, dict) and all(derived.get(key) for key in ("metric", "leftEndpoint", "rightEndpoint", "outputName")) and derived.get("scale") in (1, 100):
            policy["derivedMetric"] = derived
        aliases = plugin_policy.get("metricAliases")
        if isinstance(aliases, dict):
            policy["metricAliases"] = {str(key): metric_name(value) for key, value in aliases.items() if isinstance(value, str) and value.strip()}
        policy["explicitResultCandidates"] = unique_values([*(policy.get("explicitResultCandidates") or []), *(policy.get("candidateCsv") or []), *(policy.get("candidateJson") or []), *(policy.get("consoleLogs") or []), *(policy.get("textLogs") or [])])
    policy["primaryMetric"] = metric_name(policy.get("primaryMetric") or "AUC")
    policy["secondaryMetrics"] = unique_metric_names(policy.get("secondaryMetrics") or [])
    policy["classificationMetrics"] = unique_metric_names([policy["primaryMetric"], *(policy.get("secondaryMetrics") or []), *(policy.get("classificationMetrics") or [])])
    policy["segmentationMetrics"] = unique_metric_names(policy.get("segmentationMetrics") or SEGMENTATION_METRIC_PRIORITY)
    policy["metricPriority"] = unique_metric_names([policy["primaryMetric"], *(policy.get("secondaryMetrics") or []), *(policy.get("classificationMetrics") or []), *(policy.get("segmentationMetrics") or []), "loss"])
    return policy

def ordered_metric_list(metrics, policy):
    priority = policy.get("metricPriority") or []
    seen = set()
    ordered = []
    for metric in priority:
        if metric in metrics and metric not in seen:
            ordered.append(metric)
            seen.add(metric)
    for metric in sorted(metrics):
        if metric not in seen:
            ordered.append(metric)
            seen.add(metric)
    return ordered

def apply_result_ownership(summary, ownership=None):
    fields = ownership if isinstance(ownership, dict) else {}
    topology_mode = str(fields.get("topologyMode") or os.environ.get("SIMPLE_EXPERIMENT_TOPOLOGY_MODE") or "").strip()
    owner = str(fields.get("resultOwnerWorkerId") or fields.get("schedulerOwnerWorkerId") or (os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") if topology_mode in ("single_worker", "worker_pool") else "") or "").strip()
    worker_set_revision = str(fields.get("workerSetRevision") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_SET_REVISION") or "").strip()
    if topology_mode:
        summary["topologyMode"] = topology_mode
    if worker_set_revision:
        summary["workerSetRevision"] = worker_set_revision
    if owner:
        summary["resultOwnerWorkerId"] = owner
        summary["workerId"] = owner
        for record in summary.get("results") or []:
            if not isinstance(record, dict):
                continue
            provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
            record["workerId"] = owner
            record["resultOwnerWorkerId"] = owner
            record["provenance"] = {**provenance, "workerId": owner, "resultOwnerWorkerId": owner}
    return summary

def parse_results_action(root, selected=None, plan=None, plan_revision="", ownership=None):
    policy = read_project_metric_policy(root)
    selected_files = selected_result_candidates(root, selected)
    policy_only_files = set()
    if selected_files:
        files = selected_files
    elif plan:
        plan_files = sorted(dict.fromkeys([
            *expand_result_candidates(root, plan_declared_result_candidates(root, plan)),
            *expand_result_candidates(root, job_result_candidates(root, plan=plan)),
            *expand_result_candidates(root, plan_scoped_discover_candidates(root, plan)),
        ]))
        policy_files = expand_result_candidates(root, policy_result_candidates(policy))
        policy_only_files = set(policy_files).difference(plan_files)
        files = sorted(dict.fromkeys([*plan_files, *policy_files]))
    else:
        files = sorted(dict.fromkeys([*expand_result_candidates(root, policy_result_candidates(policy)), *expand_result_candidates(root, plan_declared_result_candidates(root, plan)), *expand_result_candidates(root, job_result_candidates(root)), *discover_result_files(root)]))
    files = [item for item in files if structured_result_candidate(item)]
    records, failures, used_files = [], [], []
    plan_norm = normalize_result_candidate(plan) if plan else ""
    plan_suite = plan_suite_value(root, plan_norm) if plan_norm else ""
    for source_rel in files:
        try:
            parsed = parse_result_file(root, source_rel, policy)
            if source_rel in policy_only_files and plan_norm:
                parsed = [record for record in parsed if result_record_matches_plan(record, plan_norm, plan_suite)]
            if parsed or source_rel not in policy_only_files:
                used_files.append(source_rel)
            if plan_norm:
                for record in parsed:
                    if not isinstance(record, dict):
                        continue
                    provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
                    if not provenance.get("planFile"):
                        provenance = {**provenance, "planFile": plan_norm}
                        record["provenance"] = provenance
                    if not record.get("planFile"):
                        record["planFile"] = plan_norm
            records.extend(parsed)
        except Exception as exc:
            failures.append({"path": source_rel, "error": str(exc)})
    metrics = ordered_metric_list({metric for record in records for metric in (record.get("metrics") or {}).keys()}, policy)
    summary = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "lastParsedAt": now_iso(),
        "taskType": policy.get("taskType"),
        "primaryMetric": policy.get("primaryMetric"),
        "secondaryMetrics": policy.get("secondaryMetrics"),
        "classificationMetrics": policy.get("classificationMetrics"),
        "segmentationMetrics": policy.get("segmentationMetrics"),
        "metricPriority": policy.get("metricPriority"),
        "resultCount": len(records),
        "parsedResults": len(records),
        "parseFailed": len(failures),
        "results": records,
        "sources": used_files,
        "metrics": metrics,
        "failures": failures,
        "qualityWarnings": 0,
        "planFile": plan_norm or "",
        "planRevision": str(plan_revision or "").strip(),
    }
    apply_result_ownership(summary, ownership)
    apply_final_evidence_summary(root, summary)
    write_plan_seed_aggregate(root, summary, policy)
    claim_report = evaluate_claim_evidence(root, summary)
    apply_claim_evidence_summary(summary, claim_report)
    target = write_results_summary_v2(root, summary)
    append_event(root, {"type": "result_parsed", "payload": {"resultCount": len(records), "parseFailed": len(failures), "summaryPath": relpath(root, target), "planFile": plan_norm or summary.get("planFile") or ""}})
    return summary


def result_record_matches_plan(record, plan, suite=""):
    if not isinstance(record, dict):
        return False
    provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
    record_plan = normalize_result_candidate(record.get("planFile") or record.get("plan_file") or provenance.get("planFile") or provenance.get("plan_file") or "")
    plan_norm = normalize_result_candidate(plan)
    if record_plan:
        return record_plan == plan_norm
    dimensions = record.get("dimensions") if isinstance(record.get("dimensions"), dict) else {}
    record_suite = str(record.get("suite") or dimensions.get("suite") or "").strip()
    if record_suite and suite:
        return record_suite == str(suite).strip()
    return True

def project_primary_metric(root):
    return read_project_metric_policy(root).get("primaryMetric") or "AUC"

def run_quality_gate_action(root, plan=None, plan_revision=""):
    summary = read_current_results_summary(root, plan, plan_revision)
    apply_final_evidence_summary(root, summary)
    policy = read_project_metric_policy(root)
    primary = policy.get("primaryMetric") or "AUC"
    issues = []
    records = final_analysis_results(root, summary)
    if not records:
        issues.append({"severity": "critical", "message": "没有已归档结果；请先从完整预览中选择有效记录并归档。"})
    for record in records:
        metrics = record.get("metrics") if isinstance(record.get("metrics"), dict) else {}
        if primary and primary not in metrics:
            issues.append({"severity": "warning", "resultId": record.get("resultId"), "metric": primary, "message": f"缺少主指标 {primary}"})
        if str(policy.get("taskType") or "classification").lower() == "classification":
            present = [metric for metric in metrics.keys() if metric in set(policy.get("classificationMetrics") or [])]
            if not present:
                issues.append({"severity": "warning", "resultId": record.get("resultId"), "message": "分类任务未识别到分类指标，请确认 metric alias 或输出接入模板。"})
        for metric, data in metrics.items():
            value = coerce_metric_value((data or {}).get("value") if isinstance(data, dict) else data)
            if not is_number(value):
                issues.append({"severity": "critical", "resultId": record.get("resultId"), "metric": metric, "message": f"{metric} 不是有效数字"})
                continue
            if metric in ("AUC", "AUPRC", "accuracy", "top1_accuracy", "top5_accuracy", "F1", "precision", "recall", "specificity", "balanced_accuracy", "NPV", "PPV", "DSC", "Dice", "IoU") and (value < 0 or value > 1):
                issues.append({"severity": "warning", "resultId": record.get("resultId"), "metric": metric, "message": f"{metric} 超出 [0,1]"})
            if metric in ("loss", "HD95", "ASD", "ECE", "brier", "MAE", "MSE", "RMSE") and value < 0:
                issues.append({"severity": "warning", "resultId": record.get("resultId"), "metric": metric, "message": f"{metric} 应为非负"})
    severity_counts = {level: len([item for item in issues if item.get("severity") == level]) for level in ("critical", "warning")}
    plan_norm = normalize_result_candidate(plan) if plan else normalize_result_candidate(summary.get("planFile") or "")
    report = {"schemaVersion": 1, "status": "failed" if severity_counts["critical"] else "warning" if issues else "passed", "taskType": policy.get("taskType"), "primaryMetric": primary, "classificationMetrics": policy.get("classificationMetrics"), "segmentationMetrics": policy.get("segmentationMetrics"), "source": "archived_only", "resultCount": len(records), "parsedResultCount": len(summary.get("results") or []), "pendingReviewCount": summary.get("pendingReviewCount", 0), "issues": issues, "checkedAt": now_iso(), "planFile": plan_norm or ""}
    rel_target = plan_results_artifact_relpath(plan_norm, "quality_gate.json")
    target = safe_project_path(root, rel_target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, report)
    atomic_write(safe_project_path(root, "simple_cluster/results/quality_gate.json"), report)
    summary["qualityWarnings"] = len(issues)
    summary["qualityGateStatus"] = report["status"]
    summary["qualityGatePath"] = relpath(root, target)
    summary["qualityGateResultCount"] = report["resultCount"]
    report["path"] = summary["qualityGatePath"]
    if plan_norm and not summary.get("planFile"):
        summary["planFile"] = plan_norm
    write_results_summary_v2(root, summary)
    append_event(root, {"type": "quality_gate_updated", "payload": {"status": report["status"], "issues": len(issues), "path": report["path"], "planFile": plan_norm or ""}})
    return report

STATISTICS_GROUP_BY = ["suite", "method", "dataset", "split"]
STATISTICS_AGGREGATE_OVER = ["seed", "fold", "case"]

def statistics_group_dimensions(record):
    dims = record.get("dimensions") if isinstance(record.get("dimensions"), dict) else {}
    suite = str(record.get("suite") or "default")
    method = str(dims.get("method") or record.get("method") or record.get("runKey") or record.get("experimentId") or "unknown")
    dataset = str(dims.get("dataset") or record.get("dataset") or "")
    split = str(dims.get("split") or record.get("split") or "")
    return {"suite": suite, "method": method, "dataset": dataset, "split": split}

def statistics_group_label(dimensions):
    return str(dimensions.get("method") or "unknown")

def numeric_metric_groups(records):
    groups = {}
    for record in records:
        dimensions = statistics_group_dimensions(record)
        key = tuple(dimensions.get(item, "") for item in STATISTICS_GROUP_BY)
        label = statistics_group_label(dimensions)
        item = groups.setdefault(key, {"suite": dimensions["suite"], "group": label, "groupKey": "|".join(key), "method": dimensions.get("method") or label, "dataset": dimensions.get("dataset") or "", "split": dimensions.get("split") or "", "dimensions": dimensions, "groupBy": STATISTICS_GROUP_BY, "aggregateOver": STATISTICS_AGGREGATE_OVER, "metrics": {}})
        for metric, data in (record.get("metrics") or {}).items():
            value = coerce_metric_value((data or {}).get("value") if isinstance(data, dict) else data)
            if is_number(value):
                item["metrics"].setdefault(metric, []).append(float(value))
    return groups

def sorted_values(values):
    return sorted(float(value) for value in values)

def metric_distribution(values, metric):
    values = sorted_values(values)
    n = len(values)
    mean = sum(values) / n
    variance = sum((value - mean) ** 2 for value in values) / max(1, n - 1)
    std = variance ** 0.5
    se = std / (n ** 0.5) if n else 0.0
    median = statistics.median(values)
    ci95 = [mean - 1.96 * se, mean + 1.96 * se] if n > 1 else [mean, mean]
    return {
        "n": n,
        "value": mean,
        "mean": mean,
        "std": std,
        "median": median,
        "ci": ci95,
        "ci95": ci95,
        "best": min(values) if metric_direction(metric) == "lower" else max(values),
        "direction": metric_direction(metric),
        "aggregation": "mean_over_seed_fold_case",
    }

def comparison_sample_key(record):
    dims = record.get("dimensions") if isinstance(record.get("dimensions"), dict) else {}
    sample = [dims.get(key) or record.get(key) or "" for key in ("fold", "seed", "case")]
    if not any(str(value).strip() for value in sample):
        return ""
    context = [dims.get(key) or record.get(key) or "" for key in ("dataset", "split")]
    return "|".join(str(value) for value in [*context, *sample])

def paired_t_approx(diffs):
    if len(diffs) < 2:
        return {"pairedN": len(diffs), "meanDelta": diffs[0] if diffs else None, "pValueApprox": None, "method": "paired_t_normal_approx", "note": "至少需要 2 个配对样本。"}
    mean = sum(diffs) / len(diffs)
    variance = sum((value - mean) ** 2 for value in diffs) / max(1, len(diffs) - 1)
    std = variance ** 0.5
    if std == 0:
        p_value = 0.0 if mean != 0 else 1.0
    else:
        t_value = abs(mean / (std / (len(diffs) ** 0.5)))
        p_value = math.erfc(t_value / math.sqrt(2.0))
    return {"pairedN": len(diffs), "meanDelta": mean, "stdDelta": std, "pValueApprox": p_value, "method": "paired_t_normal_approx", "note": "无 scipy 时使用正态近似；正式论文建议复核统计检验。"}

def paired_metric_comparisons(records, primary):
    primary = metric_name(primary)
    values = {}
    duplicate_keys = set()
    for record in records:
        metrics = record.get("metrics") if isinstance(record.get("metrics"), dict) else {}
        data = metrics.get(primary)
        value = coerce_metric_value((data or {}).get("value") if isinstance(data, dict) else data)
        if not is_number(value):
            continue
        dims = record.get("dimensions") if isinstance(record.get("dimensions"), dict) else {}
        group = str(dims.get("method") or record.get("runKey") or record.get("experimentId") or "unknown")
        key = comparison_sample_key(record)
        if not key:
            continue
        marker = (group, key)
        if marker in duplicate_keys:
            continue
        group_values = values.setdefault(group, {})
        if key in group_values:
            duplicate_keys.add(marker)
            group_values.pop(key, None)
            continue
        group_values[key] = float(value)
    groups = sorted(values.keys())
    if len(groups) < 2:
        return []
    baseline = groups[0]
    out = []
    for group in groups[1:]:
        shared = sorted(set(values[baseline]).intersection(values[group]))
        raw_diffs = [values[group][key] - values[baseline][key] for key in shared]
        improvement_diffs = [-d for d in raw_diffs] if metric_direction(primary) == "lower" else raw_diffs
        stats = paired_t_approx(improvement_diffs)
        duplicates = sorted({key for method, key in duplicate_keys if method in (baseline, group)})
        if duplicates:
            stats["duplicateKeys"] = duplicates[:50]
            stats["note"] = (str(stats.get("note") or "") + f" 重复配对键已排除：{len(duplicates)} 个。 ").strip()
        wins = len([d for d in improvement_diffs if d > 0])
        losses = len([d for d in improvement_diffs if d < 0])
        stats.update({"metric": primary, "baseline": baseline, "candidate": group, "sharedKeys": shared[:50], "wins": wins, "losses": losses, "ties": len(improvement_diffs) - wins - losses, "direction": metric_direction(primary)})
        out.append(stats)
    return out

def compute_statistics_action(root, plan=None, plan_revision=""):
    summary = read_current_results_summary(root, plan, plan_revision)
    apply_final_evidence_summary(root, summary)
    policy = read_project_metric_policy(root)
    final_records = final_analysis_results(root, summary)
    if not final_records:
        raise ValueError("没有已归档结果；请先从完整预览中选择有效记录并归档。")
    rows = []
    for item in numeric_metric_groups(final_records).values():
        metrics = {}
        for metric, values in item["metrics"].items():
            metrics[metric] = metric_distribution(values, metric)
        rows.append({"suite": item["suite"], "group": item["group"], "groupKey": item.get("groupKey"), "method": item.get("method") or item["group"], "dataset": item.get("dataset") or "", "split": item.get("split") or "", "dimensions": item.get("dimensions") or {}, "groupBy": item.get("groupBy") or STATISTICS_GROUP_BY, "aggregateOver": item.get("aggregateOver") or STATISTICS_AGGREGATE_OVER, "metrics": metrics})
    comparisons = paired_metric_comparisons(final_records, policy.get("primaryMetric") or "AUC")
    report = {"schemaVersion": 1, "generatedAt": now_iso(), "taskType": policy.get("taskType"), "primaryMetric": policy.get("primaryMetric"), "metricPriority": policy.get("metricPriority"), "aggregationPolicy": {"source": "archived_only", "groupBy": STATISTICS_GROUP_BY, "aggregateOver": STATISTICS_AGGREGATE_OVER, "valueField": "mean", "message": "SCI 绘图只使用已归档结果的 mean/std/ci，不使用临时预览或单个 seed 原始值。"}, "rows": rows, "pairedComparisons": comparisons, "resultCount": len(final_records), "parsedResultCount": len(summary.get("results") or []), "pendingReviewCount": summary.get("pendingReviewCount", 0), "inclusionPolicy": summary.get("inclusionPolicy"), "message": "统计仅包含已归档结果，绘图默认使用 mean/std/ci。" if final_records else "没有已归档结果，统计不会使用临时预览记录。"}
    plan_norm = normalize_result_candidate(plan) if plan else normalize_result_candidate(summary.get("planFile") or "")
    if plan_norm:
        report = {**report, "planFile": plan_norm}
    rel_target = plan_results_artifact_relpath(plan_norm, "statistics.json")
    target = safe_project_path(root, rel_target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, report)
    atomic_write(safe_project_path(root, "simple_cluster/results/statistics.json"), report)
    summary["statisticsUpdatedAt"] = report["generatedAt"]
    summary["statisticsPath"] = relpath(root, target)
    summary["statisticsResultCount"] = report["resultCount"]
    report["path"] = summary["statisticsPath"]
    if plan_norm and not summary.get("planFile"):
        summary["planFile"] = plan_norm
    summary["significanceStatus"] = "available" if comparisons else "需要至少两个方法和共享 seed/case"
    summary["pairedComparisons"] = comparisons[:10]
    write_results_summary_v2(root, summary)
    append_event(root, {"type": "statistics_updated", "payload": {"rows": len(rows), "path": relpath(root, target), "planFile": plan_norm or summary.get("planFile") or ""}})
    return report

def auto_completion_state_path(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    if plan_norm:
        return safe_project_path(root, plan_results_artifact_relpath(plan_norm, "run_completion_automation.json"))
    return safe_project_path(root, "simple_cluster/results/run_completion_automation.json")

def read_auto_completion_state(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    state = read_json(auto_completion_state_path(root, plan_norm or None), {})
    if not isinstance(state, dict) or not state:
        # Fall back to legacy project-global automation state only when reading unscoped or migrating.
        if plan_norm:
            legacy = read_json(safe_project_path(root, "simple_cluster/results/run_completion_automation.json"), {})
            legacy_plan = normalize_result_candidate(legacy.get("planFile") or "") if isinstance(legacy, dict) else ""
            if isinstance(legacy, dict) and legacy and legacy_plan in ("", plan_norm):
                state = legacy
    if not isinstance(state, dict):
        state = {}
    processed = state.get("processedKeys")
    if not isinstance(processed, dict):
        processed = {}
    history = state.get("history")
    if not isinstance(history, list):
        history = []
    return {"schemaVersion": 1, "planFile": plan_norm or state.get("planFile") or "", "processedKeys": processed, "history": history[-60:], "updatedAt": state.get("updatedAt") or ""}

def write_auto_completion_state(root, state, plan=None):
    plan_norm = normalize_result_candidate(plan or (state or {}).get("planFile") or "") if (plan or (state or {}).get("planFile")) else ""
    state = dict(state or {})
    state["schemaVersion"] = 1
    state["updatedAt"] = now_iso()
    state["planFile"] = plan_norm or state.get("planFile") or ""
    state["history"] = (state.get("history") or [])[-60:]
    atomic_write(auto_completion_state_path(root, plan_norm or None), state)
    # Keep latest alias for unscoped diagnostics.
    if plan_norm:
        atomic_write(safe_project_path(root, "simple_cluster/results/run_completion_automation.json"), state)

def policy_result_like_path(root, path):
    text = str(path or "").replace("\\", "/").strip().lstrip("/")
    if not text:
        return False
    lower = text.lower()
    try:
        candidates = policy_result_candidates(read_project_metric_policy(root))
    except Exception:
        candidates = []
    for candidate in candidates:
        pattern = normalize_result_candidate(candidate).replace("\\", "/").strip().lstrip("/")
        if not pattern:
            continue
        pat_lower = pattern.lower()
        if any(ch in pat_lower for ch in "*?[]"):
            if fnmatch.fnmatch(lower, pat_lower):
                return True
        elif lower == pat_lower:
            return True
    return False

def result_like_path(root, path):
    text = str(path or "").replace("\\", "/").strip().lstrip("/")
    if not text or not parseable_result_candidate(text):
        return False
    if policy_result_like_path(root, text):
        return True
    lower = text.lower()
    base = os.path.basename(lower)
    if base in RESULT_FILE_NAMES or base in TEXT_RESULT_NAMES or base in JSON_RESULT_NAMES:
        return True
    if lower.endswith(".metrics.json"):
        return True
    result_dir = lower.startswith("experiments/results/") or lower.startswith("results/") or lower.startswith("outputs/") or lower.startswith("runs/") or lower.startswith("logs/") or lower.startswith("test_results/") or lower.startswith("lightning_logs/") or lower.startswith("custom_results/") or lower.startswith("reports/") or lower.startswith("artifacts/") or "/test_results/" in lower or "/logs/" in lower or "/lightning_logs/" in lower or "/custom_results/" in lower or "/reports/" in lower or "/artifacts/" in lower
    return result_dir and lower.endswith((".csv", ".json", ".txt", ".log", ".out"))

def completion_row_key(row, plan="", scheduler_session=""):
    if not isinstance(row, dict):
        return ""
    plan_text = str(plan or row.get("plan") or row.get("planFile") or row.get("plan_file") or "")
    direct = scheduler_row_run_key(row)
    if direct:
        return "|".join(["row", plan_text, str(scheduler_session or row.get("scheduler_session") or ""), direct])
    parts = [
        plan_text,
        str(scheduler_session or row.get("scheduler_session") or ""),
        str(row.get("experiment_index") if row.get("experiment_index") is not None else row.get("index") or ""),
        str(row.get("worker_id") or row.get("workerId") or ""),
        str(row.get("finished_at") or row.get("completed_at") or row.get("updated_at") or ""),
    ]
    if not any(part.strip() for part in parts):
        return ""
    return "rowhash|" + sha256_text(json.dumps(parts, ensure_ascii=False, sort_keys=True))[:24]

def auto_completion_plan(event, root=None):
    plans = auto_completion_plans(event, root=root)
    return plans[0] if plans else ""

def auto_completion_plan_revision(event, plan=None):
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    direct = str(payload.get("planRevision") or payload.get("plan_revision") or event.get("planRevision") or event.get("plan_revision") or "").strip()
    if direct:
        return direct
    target = normalize_result_candidate(plan) if plan else ""
    states = payload.get("schedulerStates") or payload.get("scheduler_states") or payload.get("scheduler") or []
    if isinstance(states, dict):
        states = [states]
    for state in states if isinstance(states, list) else []:
        if not isinstance(state, dict):
            continue
        state_plan = normalize_result_candidate(state.get("plan") or state.get("planFile") or state.get("plan_file") or "")
        if target and state_plan and state_plan != target:
            continue
        revision = str(state.get("planRevision") or state.get("plan_revision") or "").strip()
        if revision:
            return revision
    return ""

def auto_completion_plans(event, root=None):
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    plans = []
    direct = str(payload.get("plan") or payload.get("planFile") or payload.get("selectedPlanId") or "").strip()
    if direct:
        plans.append(normalize_result_candidate(direct))
    typ = str(event.get("type") or "")
    if typ == "scheduler_snapshot":
        states = payload.get("schedulerStates") or payload.get("scheduler_states") or payload.get("scheduler") or []
        if isinstance(states, dict):
            states = [states]
        if isinstance(states, list):
            for state in states:
                if not isinstance(state, dict):
                    continue
                candidate = str(state.get("plan") or state.get("planFile") or state.get("plan_file") or "").strip()
                if candidate:
                    plans.append(normalize_result_candidate(candidate))
    if typ == "file_changed":
        path_text = str(payload.get("path") or payload.get("relPath") or payload.get("remotePath") or payload.get("file") or payload.get("relativePath") or "")
        candidate = plan_from_result_path(path_text, root=root)
        if candidate:
            plans.append(candidate)
    if typ == "worker_task_completed":
        candidate = str(payload.get("plan") or payload.get("planFile") or payload.get("plan_file") or "").strip()
        if candidate:
            plans.append(normalize_result_candidate(candidate))
    if typ in ("operation_completed", "operation_failed"):
        candidate = str(payload.get("plan") or payload.get("planFile") or payload.get("selectedPlanId") or "").strip()
        if candidate:
            plans.append(normalize_result_candidate(candidate))
    out = []
    seen = set()
    for item in plans:
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out

def plan_from_result_path(path, root=None):
    text = normalize_result_candidate(path)
    if not text:
        return ""
    marker = "simple_cluster/results/by_plan/"
    lower = text.lower()
    idx = lower.find(marker)
    if idx < 0:
        return ""
    rest = text[idx + len(marker):]
    slug = rest.split("/", 1)[0].strip()
    if not slug:
        return ""
    summary_rel = f"simple_cluster/results/by_plan/{slug}/summary.json"
    try:
        base = root or os.getcwd()
        data = read_json(safe_project_path(base, summary_rel), {})
        if isinstance(data, dict):
            plan = normalize_result_candidate(data.get("planFile") or data.get("plan") or "")
            if plan:
                return plan
    except Exception:
        pass
    candidate = slug.replace("___", "/").replace("__", "/").replace("_", "/")
    if candidate.endswith((".yaml", ".yml", ".json")):
        return normalize_result_candidate(candidate)
    return ""

def auto_completion_candidates(root, event, plan=None):
    typ = str(event.get("type") or "")
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    plan_norm = normalize_result_candidate(plan) if plan else ""
    keys = []
    if typ == "worker_task_completed":
        row_plan = payload.get("plan") or payload.get("planFile") or plan_norm or ""
        if plan_norm and normalize_result_candidate(row_plan) not in ("", plan_norm):
            return []
        key = completion_row_key(payload, row_plan, payload.get("scheduler_session") or "")
        if key:
            keys.append("worker:" + key)
    elif typ == "scheduler_snapshot":
        states = payload.get("schedulerStates") or payload.get("scheduler_states") or payload.get("scheduler") or []
        if isinstance(states, dict):
            states = [states]
        if isinstance(states, list):
            for state in states:
                if not isinstance(state, dict):
                    continue
                state_plan = str(state.get("plan") or state.get("planFile") or state.get("plan_file") or "")
                if plan_norm and normalize_result_candidate(state_plan) not in ("", plan_norm):
                    continue
                plan_text = plan_norm or state_plan
                session = str(state.get("scheduler_session") or "")
                for row in state.get("completed_experiments") or []:
                    row_plan = plan_text or row.get("plan") or row.get("planFile") or ""
                    if plan_norm and normalize_result_candidate(row_plan) not in ("", plan_norm):
                        continue
                    key = completion_row_key(row, row_plan, session)
                    if key:
                        keys.append("scheduler:" + key)
    elif typ == "file_changed":
        path_text = str(payload.get("path") or payload.get("relPath") or payload.get("remotePath") or payload.get("file") or payload.get("relativePath") or "")
        if result_like_path(root, path_text):
            path_plan = plan_from_result_path(path_text, root=root)
            if plan_norm and path_plan and path_plan != plan_norm:
                return []
            target = safe_project_path(root, path_text)
            try:
                marker = str(os.path.getmtime(target)) if os.path.exists(target) else str(event.get("seq") or "")
            except Exception:
                marker = str(event.get("seq") or "")
            keys.append("file:" + path_text.replace("\\", "/").lstrip("/") + ":" + marker)
    elif typ in ("operation_completed", "operation_failed"):
        action = str(payload.get("action") or event.get("action") or "").strip()
        if action in ("run-plan", "reproduce-plan"):
            operation_id = str(event.get("operationId") or payload.get("operationId") or payload.get("opId") or "").strip()
            op_plan = str(payload.get("plan") or payload.get("planFile") or payload.get("selectedPlanId") or plan_norm or "").strip()
            if plan_norm and normalize_result_candidate(op_plan) not in ("", plan_norm):
                return []
            marker = operation_id or sha256_text(json.dumps([op_plan, payload.get("completedCount"), payload.get("failedCount"), event.get("generatedAt")], ensure_ascii=False, sort_keys=True))[:24]
            if marker:
                keys.append("operation:" + action + ":" + marker)
    return sorted(dict.fromkeys(keys))

def auto_completion_should_run(previous, trigger_type):
    if not isinstance(previous, dict):
        return True
    status = str(previous.get("status") or "").strip().lower()
    if status == "completed":
        return False
    if trigger_type in ("operation_completed", "operation_failed"):
        return not status
    return True


def draft_config_reference_values(text):
    values = []
    for line in str(text or "").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        scalar = re.match(r"^\s*-?\s*(?:base_config|base-config|config_file|config-file|config_path|config-path|cfg|config)\s*:\s*(.+?)\s*(?:#.*)?$", line, re.I)
        if scalar and not str(scalar.group(1)).lstrip().startswith("{"):
            values.append((line.strip(), str(scalar.group(1)).strip()))
        for match in re.finditer(r"(?:^|[\s;&|(])(?:--)?(?:base[-_]config|config[-_]file|config[-_]path|cfg|config)(?:=|\s*=\s*|\s+)(\"[^\"]+\"|'[^']+'|[^\s;&|]+)", line, re.I):
            values.append((line.strip(), match.group(1)))
    out = []
    seen = set()
    for _, raw in values:
        value = str(raw or "").strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        value = value.split()[0] if value else ""
        value = value.replace("\\", "/").lstrip("/")
        if value.startswith("tmp/config/") and re.search(r"\.ya?ml$", value, re.I) and value not in seen:
            out.append(value)
            seen.add(value)
    return out


def atomic_write_draft_text(path, text):
    atomic_write_file(path, lambda stream: stream.write(text))


def materialize_draft_snapshot(root, plan):
    plan_text = open(safe_project_path(root, plan), "r", encoding="utf-8").read()
    refs = draft_config_reference_values(plan_text)
    if not refs:
        raise RuntimeError("草稿 Plan 必须引用 tmp/config/ 下的配置。")
    copied = []
    hash_parts = []
    for ref in refs:
        source = safe_project_path(root, ref)
        text = open(source, "r", encoding="utf-8").read()
        rel = os.path.relpath(source, safe_project_path(root, "tmp/config")).replace("\\", "/")
        _digest_input = ref + "\n" + text
        target_rel = f"simple_cluster/drafts/snapshots/{sha256_text(_digest_input)[:24]}/configs/{rel}"
        target = safe_project_path(root, target_rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if not os.path.exists(target):
            atomic_write_draft_text(target, text)
        copied.append({"source": ref, "snapshot": target_rel})
        hash_parts.append(f"{ref}\n{sha256_text(text)}")
    snapshot_id = sha256_text("\n".join([f"{plan}\n{sha256_text(plan_text)}", *hash_parts]))[:24]
    rewritten = plan_text
    for ref in reversed(refs):
        matching = next((item for item in copied if item["source"] == ref), None)
        if matching:
            rewritten = rewritten.replace(ref, matching["snapshot"])
    execution_plan_rel = f"simple_cluster/drafts/snapshots/{snapshot_id}/plan.yaml"
    execution_plan = safe_project_path(root, execution_plan_rel)
    os.makedirs(os.path.dirname(execution_plan), exist_ok=True)
    atomic_write_draft_text(execution_plan, rewritten)
    atomic_write(safe_project_path(root, f"simple_cluster/drafts/snapshots/{snapshot_id}/snapshot.json"), {
        "schemaVersion": 1,
        "draftPlanPath": plan.replace("\\", "/"),
        "configRefs": refs,
        "copiedConfigs": copied,
        "executionPlanPath": execution_plan_rel,
        "contentHash": sha256_text("\n".join([f"{plan}\n{sha256_text(plan_text)}", *hash_parts])),
        "createdAt": now_iso(),
    })
    return {"executionPlan": execution_plan_rel, "snapshotId": snapshot_id, "refs": refs}


def prepare_draft_run_plan(root, plan, debug_mode):
    normalized = str(plan or "").replace("\\", "/").lstrip("/")
    if normalized.startswith("tmp/plan/"):
        if not debug_mode:
            raise RuntimeError("tmp/plan 只能使用 Debug 隔离运行；正式 PLAN 必须位于 experiments/plans/。")
        return materialize_draft_snapshot(root, plan)["executionPlan"]
    return plan


def event_is_debug_run(event):
    body = event if isinstance(event, dict) else {}
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    paths = action_values(payload, "path", "relPath", "remotePath", "file", "relativePath")
    return bool(any(action_bool(value) for value in (body.get("debugMode"), body.get("debug_mode"), payload.get("debugMode"), payload.get("debug_mode"))) or any(str(item).replace("\\", "/").lstrip("/").startswith("simple_cluster/debug_runs/") for item in paths))

def maybe_auto_run_completion_pipeline(root, event):
    # Result aggregation belongs to the local Host. Keep this compatibility hook inert:
    # terminal/progress events must not create remote previews, statistics or parse caches.
    return None

def format_metric_cell(stat):
    if not stat:
        return "-"
    mean = stat.get("mean")
    std = stat.get("std")
    if is_number(mean) and is_number(std):
        return f"{mean:.4g} ± {std:.3g}"
    return str(mean if mean is not None else "-")

def paper_dataset_output(root, stats, policy, dataset, plan):
    metrics = []
    for row in stats.get("rows") or []:
        for metric in (row.get("metrics") or {}).keys():
            if metric not in metrics:
                metrics.append(metric)
    preferred = [m for m in (policy.get("metricPriority") or []) if m in metrics]
    metrics = (preferred or metrics)[:8]
    header = ["Group", "N"] + [metric + ("↓" if metric_direction(metric) == "lower" else "↑") for metric in metrics]
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join(["---"] * len(header)) + " |"]
    csv_rows = [["method", "dataset", "split", "suite", "group", "metric", "mean", "std", "ci", "n", "direction", "significant", "pValue", "adjustedPValue"]]
    for row in stats.get("rows") or []:
        metric_map = row.get("metrics") or {}
        n = max([int(v.get("n") or 0) for v in metric_map.values()] or [0])
        values = [str(row.get("group") or "-"), str(n)] + [format_metric_cell(metric_map.get(metric)) for metric in metrics]
        lines.append("| " + " | ".join(values) + " |")
        dims = row.get("dimensions") if isinstance(row.get("dimensions"), dict) else {}
        for metric in metrics:
            stat = metric_map.get(metric) if isinstance(metric_map.get(metric), dict) else {}
            ci = stat.get("ci") if stat.get("ci") is not None else stat.get("ci95")
            csv_rows.append([
                dims.get("method") or row.get("group") or "",
                dims.get("dataset") or "",
                dims.get("split") or "",
                row.get("suite") or "",
                row.get("group") or "",
                metric,
                stat.get("mean") if stat.get("mean") is not None else "",
                stat.get("std") if stat.get("std") is not None else "",
                json.dumps(ci, ensure_ascii=False) if ci is not None else "",
                stat.get("n") if stat.get("n") is not None else "",
                stat.get("direction") or metric_direction(metric),
                "",
                "",
                "",
            ])
    plan_norm = normalize_result_candidate(plan) if plan else ""
    slug = result_plan_directory_key(plan_norm) if plan_norm else "project"
    md = "# SimpleExperiment results\n\n" + "\n".join(lines) + "\n"
    out_dir = safe_project_path(root, "paper/tables/" + dataset_path_key(dataset))
    md_name = f"simple_results_table__{slug}.md" if slug else "simple_results_table.md"
    csv_name = f"simple_results_table__{slug}.csv" if slug else "simple_results_table.csv"
    md_path = os.path.join(out_dir, md_name)
    csv_path = os.path.join(out_dir, csv_name)
    csv_buffer = io.StringIO(newline="")
    csv.writer(csv_buffer).writerows(csv_rows)
    return {"dataset": dataset, "datasetKey": dataset_path_key(dataset), "paperTablePath": relpath(root, md_path), "paperTableCsvPath": relpath(root, csv_path), "rowCount": len(csv_rows) - 1}, [("text", relpath(root, md_path), md), ("text", relpath(root, csv_path), csv_buffer.getvalue())]

def export_paper_table_action(root, plan=None, plan_revision=""):
    stats = compute_statistics_action(root, plan, plan_revision)
    policy = read_project_metric_policy(root)
    partitions = dataset_partitions([(row.get("dimensions") or {}).get("dataset") for row in stats.get("rows") or []])
    tables, outputs = [], []
    for partition in partitions:
        dataset = partition["dataset"]
        child = {**stats, "rows": [row for row in stats.get("rows") or [] if str((row.get("dimensions") or {}).get("dataset") or "").strip() == dataset]}
        table, files = paper_dataset_output(root, child, policy, dataset, plan)
        tables.append(table)
        outputs.extend(files)
    publish_dataset_outputs(root, outputs)
    summary = read_current_results_summary(root, plan, plan_revision)
    summary["paperDatasetTables"] = tables
    for field in ("paperTablePath", "paperTableCsvPath", "exportPath"):
        summary.pop(field, None)
    if len(tables) == 1:
        summary["paperTablePath"] = tables[0]["paperTablePath"]
        summary["paperTableCsvPath"] = tables[0]["paperTableCsvPath"]
        summary["exportPath"] = tables[0]["paperTablePath"]
    summary["paperTableResultCount"] = stats.get("resultCount", 0)
    claim_report = evaluate_claim_evidence(root, summary)
    apply_claim_evidence_summary(summary, claim_report)
    write_results_summary_v2(root, summary)
    append_event(root, {"type": "paper_table_updated", "payload": {"datasetTables": tables, "planFile": plan or ""}})
    return {"schemaVersion": 1, "path": summary.get("paperTablePath", ""), "csvPath": summary.get("paperTableCsvPath", ""), "paperDatasetTables": tables, "rows": sum(table["rowCount"] for table in tables), "resultCount": stats.get("resultCount", 0), "claimEvidence": summary.get("claimEvidence")}

def case_like_csv_path(path):
    lower = str(path or "").replace("\\", "/").lower()
    name = lower.rsplit("/", 1)[-1]
    return bool(name.endswith(".csv") and ("case" in name or "detail" in name or "prediction" in name or name in ("metrics_case.csv", "case_metrics.csv", "case_results.csv")))

def discover_case_files(root, plan=None, limit=120):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    out = []
    if plan_norm:
        candidates = sorted(dict.fromkeys([
            *expand_result_candidates(root, plan_declared_result_candidates(root, plan_norm)),
            *expand_result_candidates(root, job_result_candidates(root, plan=plan_norm)),
            *expand_result_candidates(root, plan_scoped_discover_candidates(root, plan_norm)),
        ]))
        for item in candidates:
            text = normalize_result_candidate(item)
            if not text:
                continue
            if case_like_csv_path(text):
                try:
                    if safe_small_file(safe_project_path(root, text)):
                        out.append(text)
                except Exception:
                    pass
                continue
            parent = text if not re.search(r"\.[A-Za-z0-9]+$", text) else "/".join(text.split("/")[:-1])
            if not parent:
                continue
            try:
                base = safe_project_path(root, parent)
            except Exception:
                continue
            if not os.path.isdir(base):
                continue
            for current, dirs, names in os.walk(base):
                dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features")]
                try:
                    rel_cur = relpath(root, current).replace("\\", "/")
                    depth = max(0, rel_cur.count("/") - parent.replace("\\", "/").count("/"))
                except Exception:
                    depth = 0
                if depth > 2:
                    dirs[:] = []
                    continue
                for name in names:
                    if case_like_csv_path(name) and safe_small_file(os.path.join(current, name)):
                        out.append(relpath(root, os.path.join(current, name)))
                        if len(out) >= limit:
                            return sorted(dict.fromkeys(out))
        return sorted(dict.fromkeys(out))[:limit]
    for top in ("experiments", "work_dirs", "results", "simple_cluster"):
        base = os.path.join(root, top)
        if not os.path.isdir(base):
            continue
        for current, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features")]
            for name in names:
                if case_like_csv_path(name) and safe_small_file(os.path.join(current, name)):
                    out.append(relpath(root, os.path.join(current, name)))
                    if len(out) >= limit:
                        return sorted(dict.fromkeys(out))
    return sorted(dict.fromkeys(out))

def parse_case_level_action(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    rows = []
    failures = []
    for source_rel in discover_case_files(root, plan_norm or None):
        try:
            text = open(safe_project_path(root, source_rel), "r", encoding="utf-8", errors="replace").read()
            for i, row in enumerate(read_csv_dicts(text)):
                case_id = str(row.get("case_id") or row.get("caseId") or row.get("id") or i)
                metric = metric_name(row.get("metric") or "")
                metrics = {}
                if metric:
                    metrics[metric] = coerce_metric_value(row.get("value"))
                for key, value in row.items():
                    m = metric_name(key)
                    if m in KNOWN_METRICS and value not in (None, ""):
                        metrics[m] = coerce_metric_value(value)
                rows.append({
                    "schemaVersion": 1,
                    "caseResultId": sha256_text(source_rel + ":" + case_id + ":" + str(i) + ":" + plan_norm)[:16],
                    "experimentId": str(row.get("experiment_id") or row.get("experimentId") or ""),
                    "caseId": case_id,
                    "patientId": str(row.get("patient_id") or row.get("patientId") or ""),
                    "dataset": str(row.get("dataset") or ""),
                    "split": str(row.get("split") or ""),
                    "method": str(row.get("method") or ""),
                    "metrics": metrics,
                    "subgroup": {k: row.get(k) for k in ("subgroup", "sex", "age_group", "class_name", "site") if row.get(k)},
                    "sourceFile": source_rel,
                    "parsedAt": now_iso(),
                    **({"planFile": plan_norm} if plan_norm else {}),
                })
        except Exception as exc:
            failures.append({"path": source_rel, "error": str(exc)})
    index = {"schemaVersion": 1, "generatedAt": now_iso(), "cases": rows, "caseCount": len(rows), "failures": failures, "planFile": plan_norm or ""}
    rel_target = plan_results_artifact_relpath(plan_norm, "case_level_index.json")
    target = safe_project_path(root, rel_target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, index)
    atomic_write(safe_project_path(root, "simple_cluster/results/case_level_index.json"), index)
    index = {**index, "path": relpath(root, target)}
    return index

def run_leakage_check_action(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    index = {}
    if plan_norm:
        index = read_json(safe_project_path(root, plan_results_artifact_relpath(plan_norm, "case_level_index.json")), {})
    if not index.get("cases"):
        index = read_json(safe_project_path(root, "simple_cluster/results/case_level_index.json"), {})
    if (not index.get("cases")) or (plan_norm and normalize_result_candidate(index.get("planFile") or "") != plan_norm):
        index = parse_case_level_action(root, plan_norm or None)
    issues = []
    patients = {}
    for row in index.get("cases") or []:
        patient = str(row.get("patientId") or "")
        split = str(row.get("split") or "")
        if patient and split:
            patients.setdefault(patient, set()).add(split)
    for patient, splits in patients.items():
        if len(splits) > 1:
            issues.append({"severity": "critical", "type": "patient_overlap", "patientId": patient, "splits": sorted(splits), "message": "同一 patient_id 出现在多个 split"})
    if not patients and (index.get("cases") or []):
        issues.append({"severity": "warning", "type": "patient_id_missing", "message": "缺少 patient_id，无法做病人级泄漏检查"})
    report = {"schemaVersion": 1, "status": "failed" if any(i["severity"] == "critical" for i in issues) else "warning" if issues else "ok", "issues": issues, "checkedAt": now_iso(), "planFile": plan_norm or ""}
    rel_target = plan_results_artifact_relpath(plan_norm, "leakage_check.json")
    target = safe_project_path(root, rel_target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, report)
    atomic_write(safe_project_path(root, "simple_cluster/results/leakage_check.json"), report)
    report = {**report, "path": relpath(root, target)}
    return report

def run_subgroup_analysis_action(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    index = {}
    if plan_norm:
        index = read_json(safe_project_path(root, plan_results_artifact_relpath(plan_norm, "case_level_index.json")), {})
    if not index.get("cases"):
        index = read_json(safe_project_path(root, "simple_cluster/results/case_level_index.json"), {})
    if (not index.get("cases")) or (plan_norm and normalize_result_candidate(index.get("planFile") or "") != plan_norm):
        index = parse_case_level_action(root, plan_norm or None)
    groups = {}
    for row in index.get("cases") or []:
        subgroup = row.get("subgroup") if isinstance(row.get("subgroup"), dict) else {}
        key = str(subgroup.get("subgroup") or subgroup.get("sex") or subgroup.get("age_group") or subgroup.get("class_name") or "all")
        item = groups.setdefault(key, {"group": key, "count": 0, "metrics": {}})
        item["count"] += 1
        for metric, value in (row.get("metrics") or {}).items():
            if is_number(value):
                item["metrics"].setdefault(metric, []).append(float(value))
    rows = []
    for item in groups.values():
        metrics = {}
        for metric, values in item["metrics"].items():
            metrics[metric] = {"mean": sum(values) / len(values), "n": len(values)}
        rows.append({"group": item["group"], "count": item["count"], "metrics": metrics})
    report = {"schemaVersion": 1, "generatedAt": now_iso(), "rows": rows, "planFile": plan_norm or ""}
    rel_target = plan_results_artifact_relpath(plan_norm, "subgroup_analysis.json")
    target = safe_project_path(root, rel_target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, report)
    atomic_write(safe_project_path(root, "simple_cluster/results/subgroup_analysis.json"), report)
    report = {**report, "path": relpath(root, target)}
    return report

def export_case_analysis_action(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    subgroup = run_subgroup_analysis_action(root, plan_norm or None)
    out_dir = safe_project_path(root, "paper/tables")
    os.makedirs(out_dir, exist_ok=True)
    slug = plan_summary_slug(plan_norm)
    csv_name = f"simple_case_analysis__{slug}.csv" if slug else "simple_case_analysis.csv"
    csv_path = os.path.join(out_dir, csv_name)
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["group", "count", "metrics"])
        for row in subgroup.get("rows") or []:
            writer.writerow([row.get("group"), row.get("count"), json.dumps(row.get("metrics") or {}, ensure_ascii=False)])
    # Keep stable latest alias for unscoped consumers.
    latest = os.path.join(out_dir, "simple_case_analysis.csv")
    if os.path.abspath(csv_path) != os.path.abspath(latest):
        open(latest, "w", encoding="utf-8", newline="").write(open(csv_path, "r", encoding="utf-8").read())
    return {"schemaVersion": 1, "path": relpath(root, csv_path), "rows": len(subgroup.get("rows") or []), "planFile": plan_norm or ""}

def checkpoint_manifest_files(root):
    candidates = []
    for rel in ("checkpoint_manifest.json", "artifact_manifest.json", "simple_cluster/checkpoints/checkpoint_manifest.json", "simple_cluster/checkpoints/artifact_manifest.json"):
        path = os.path.join(root, rel)
        if safe_small_file(path, 20 * 1024 * 1024):
            candidates.append(rel)
    for top in ("work_dirs", "experiments/runs", "simple_cluster/archive_manifests", "results", "outputs"):
        base = os.path.join(root, top)
        if not os.path.isdir(base):
            continue
        scanned = 0
        for current, dirs, files in os.walk(base):
            scanned += 1
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "datasets", "features") and not d.startswith(".")]
            for name in files:
                if name in ("checkpoint_manifest.json", "artifact_manifest.json"):
                    rel = relpath(root, os.path.join(current, name))
                    candidates.append(rel)
                    if len(candidates) >= 80:
                        return sorted(dict.fromkeys(candidates))
            if scanned > 3000:
                break
    return sorted(dict.fromkeys(candidates))

def checkpoint_records_from_value(value, inherited=None):
    inherited = inherited or {}
    rows = []
    if isinstance(value, list):
        for item in value:
            rows.extend(checkpoint_records_from_value(item, inherited))
        return rows
    if not isinstance(value, dict):
        return rows
    next_inherited = dict(inherited)
    for src, dst in (("runId", "runId"), ("run_id", "runId"), ("runKey", "runId"), ("run_key", "runId"), ("resultId", "resultId"), ("result_id", "resultId"), ("experimentId", "resultId"), ("experiment_id", "resultId"), ("status", "status"), ("state", "status")):
        if value.get(src):
            next_inherited[dst] = str(value.get(src))
    path_value = ""
    for key in ("path", "file", "checkpoint", "checkpointPath", "checkpoint_path", "relativePath", "relative_path"):
        if value.get(key):
            path_value = str(value.get(key))
            break
    if path_value:
        row = dict(next_inherited)
        row.update({
            "path": path_value.replace("\\", "/"),
            "type": str(value.get("type") or value.get("kind") or value.get("checkpointType") or value.get("checkpoint_type") or "regular"),
            "score": value.get("score", value.get("metric", value.get("value"))),
            "epoch": value.get("epoch", value.get("step")),
            "createdAt": str(value.get("createdAt") or value.get("created_at") or value.get("mtime") or ""),
            "updatedAt": str(value.get("updatedAt") or value.get("updated_at") or value.get("mtime") or ""),
            "paperReady": bool(value.get("paperReady") or value.get("paper_ready")),
            "frozen": bool(value.get("frozen")),
            "size": value.get("size"),
        })
        rows.append(row)
    for key in ("checkpoints", "files", "artifacts", "targets", "runs", "items"):
        rows.extend(checkpoint_records_from_value(value.get(key), next_inherited))
    return rows

def normalize_checkpoint_path(value):
    rel = str(value or "").replace("\\", "/").lstrip("/")
    if re.match(r"^[A-Za-z]:/", rel):
        rel = rel[3:]
    parts = [p for p in rel.split("/") if p and p != "."]
    if not parts or ".." in parts:
        return ""
    lowered = [p.lower() for p in parts]
    if any(p in (".git", ".ssh", "node_modules", ".venv", "venv") for p in lowered):
        return ""
    if lowered[0] not in ("work_dirs", "experiments", "simple_cluster", "outputs", "runs", "checkpoints", "weights", "results"):
        return ""
    if not re.search(r"\.(pt|pth|ckpt|bin|safetensors|onnx|pkl|pickle)$", parts[-1], re.I):
        return ""
    target = os.path.realpath(os.path.join(root_for_checkpoint_normalize, *parts)) if root_for_checkpoint_normalize else ""
    if target:
        real_root = os.path.realpath(root_for_checkpoint_normalize)
        if not target.startswith(real_root + os.sep) and target != real_root:
            return ""
    return "/".join(parts)

root_for_checkpoint_normalize = ""

def checkpoint_retention_action(root, payload=None):
    global root_for_checkpoint_normalize
    root_for_checkpoint_normalize = os.path.abspath(root)
    options = action_options(payload or {})
    policy = {
        "keepBest": bool(options.get("keepBest", True)),
        "keepLatest": bool(options.get("keepLatest", True)),
        "topK": max(0, int(options.get("topK") or 1)),
        "minAgeDays": max(0.0, float(options.get("minAgeDays") or 0)),
        "protectPaperReady": bool(options.get("protectPaperReady", True)),
        "protectRunning": bool(options.get("protectRunning", True)),
        "protectFrozen": bool(options.get("protectFrozen", True)),
    }
    records = []
    for rel in checkpoint_manifest_files(root):
        try:
            records.extend(checkpoint_records_from_value(read_json(safe_project_path(root, rel), {})))
        except Exception:
            pass
    seen = {}
    for row in records:
        path = str(row.get("path") or "").replace("\\", "/")
        if path:
            seen[path] = row
    records = list(seen.values())
    running = {str(row.get("runId") or "") for row in records if re.search(r"running|queued|testing", str(row.get("status") or ""), re.I)}
    scored = [row for row in records if is_number(coerce_metric_value(row.get("score")))]
    top_paths = {str(row.get("path")) for row in sorted(scored, key=lambda r: float(coerce_metric_value(r.get("score")) or 0), reverse=True)[:policy["topK"]]}
    latest = sorted(records, key=lambda r: float(coerce_metric_value(r.get("epoch")) or 0), reverse=True)[:1]
    latest_path = str(latest[0].get("path")) if latest else ""
    best = sorted([r for r in records if str(r.get("type") or "").lower() == "best" or r.get("paperReady")], key=lambda r: float(coerce_metric_value(r.get("epoch")) or 0), reverse=True)[:1]
    best_path = str(best[0].get("path")) if best else ""
    items = []
    now_ts = time.time()
    for row in records:
        norm = normalize_checkpoint_path(row.get("path"))
        reasons = []
        if not norm:
            reasons.append("路径不在项目安全范围内")
        if policy["keepBest"] and (str(row.get("path")) == best_path or str(row.get("type") or "").lower() == "best"):
            reasons.append("保留 best")
        if policy["keepLatest"] and str(row.get("path")) == latest_path:
            reasons.append("保留 latest")
        if str(row.get("path")) in top_paths:
            reasons.append(f"保留 top{policy['topK']}")
        stamp = parse_iso_epoch(row.get("updatedAt") or row.get("createdAt"))
        if policy["minAgeDays"] and stamp and (now_ts - stamp) / 86400.0 < policy["minAgeDays"]:
            reasons.append(f"未超过 {policy['minAgeDays']} 天")
        if policy["protectPaperReady"] and row.get("paperReady"):
            reasons.append("paper ready 保护")
        if policy["protectRunning"] and (str(row.get("runId") or "") in running or re.search(r"running|queued|testing", str(row.get("status") or ""), re.I)):
            reasons.append("运行中保护")
        if policy["protectFrozen"] and row.get("frozen"):
            reasons.append("paper freeze 保护")
        action = "skip" if not norm else "keep" if reasons else "delete"
        item = dict(row)
        item.update({"normalizedPath": norm, "action": action, "safe": bool(norm), "reasons": reasons or ["可 dry-run 删除"]})
        items.append(item)
    plan_file = action_plan_file(payload or {})
    plan_norm = normalize_result_candidate(plan_file) if plan_file else ""
    delete_rel = plan_checkpoints_artifact_relpath(plan_norm, "delete_plan.json")
    report_rel = plan_checkpoints_artifact_relpath(plan_norm, "retention_report.md")
    plan = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "dryRun": True,
        "policy": policy,
        "planFile": plan_norm or "",
        "deletePlanPath": delete_rel,
        "retentionReportPath": report_rel,
        "total": len(items),
        "keepCount": len([i for i in items if i["action"] == "keep"]),
        "deleteCount": len([i for i in items if i["action"] == "delete"]),
        "skipCount": len([i for i in items if i["action"] == "skip"]),
        "items": items,
    }
    out = safe_project_path(root, delete_rel)
    atomic_write(out, plan)
    if plan_norm:
        atomic_write(safe_project_path(root, "simple_cluster/checkpoints/delete_plan.json"), plan)
    report = ["# Checkpoint 保留报告", "", f"生成时间：{plan['generatedAt']}", "模式：dry-run，不会删除文件。", "", f"总数：{plan['total']}，保留：{plan['keepCount']}，计划删除：{plan['deleteCount']}，跳过：{plan['skipCount']}", "", "## 删除候选"]
    report.extend([f"- {i.get('normalizedPath')}: {'；'.join(i.get('reasons') or [])}" for i in items if i.get("action") == "delete"] or ["- 无"])
    report.extend(["", "## 保留或跳过"])
    report.extend([f"- [{i.get('action')}] {i.get('normalizedPath') or i.get('path')}: {'；'.join(i.get('reasons') or [])}" for i in items if i.get("action") != "delete"] or ["- 无"])
    report_path = safe_project_path(root, report_rel)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    open(report_path, "w", encoding="utf-8").write("\n".join(report) + "\n")
    if plan_norm:
        latest_report = safe_project_path(root, "simple_cluster/checkpoints/retention_report.md")
        os.makedirs(os.path.dirname(latest_report), exist_ok=True)
        open(latest_report, "w", encoding="utf-8").write("\n".join(report) + "\n")
    return plan

def safe_dataset_path(root, value):
    rel = str(value or "").replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p and p != "."]
    if not parts or ".." in parts or parts[0].lower() in (".git", ".ssh", "node_modules"):
        raise ValueError("unsafe dataset path")
    if parts[0] not in ("datasets", "dataset", "data", "splits", "experiments", "configs", "simple_cluster"):
        raise ValueError("dataset inspector only reads dataset/split/config paths")
    target = os.path.realpath(os.path.join(root, *parts))
    real_root = os.path.realpath(root)
    if not target.startswith(real_root + os.sep) and target != real_root:
        raise ValueError("path outside project")
    return target

def discover_dataset_csv_files(root, selected=None):
    selected = [str(x).replace("\\", "/").lstrip("/") for x in (selected or []) if str(x or "").lower().endswith(".csv")]
    if selected:
        return selected[:40]
    out = []
    for top in ("datasets", "data", "splits", "experiments"):
        base = os.path.join(root, top)
        if not os.path.isdir(base):
            continue
        scanned = 0
        for current, dirs, files in os.walk(base):
            scanned += 1
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights") and not d.startswith(".")]
            for name in files:
                lower = name.lower()
                rel = relpath(root, os.path.join(current, name))
                if lower.endswith(".csv") and any(token in rel.lower() for token in ("split", "train", "val", "test", "label", "dataset", "metadata")) and safe_small_file(os.path.join(current, name), 20 * 1024 * 1024):
                    out.append(rel)
                    if len(out) >= 80:
                        return sorted(dict.fromkeys(out))
            if scanned > 2000:
                break
    return sorted(dict.fromkeys(out))

def dataset_pick(row, keys, default=""):
    lowered = {str(k).lower(): v for k, v in row.items()}
    for key in keys:
        if row.get(key) not in (None, ""):
            return str(row.get(key)).strip()
        if lowered.get(str(key).lower()) not in (None, ""):
            return str(lowered.get(str(key).lower())).strip()
    return default

def inspect_dataset_action(root, payload=None):
    selected = action_values(payload or {}, "selectedFiles", "datasetFiles", "path", "remotePath")
    files = discover_dataset_csv_files(root, selected)
    class_dist, split_dist, split_class, missing_fields, missing_refs = {}, {}, {}, [], []
    file_reports = []
    cases = []
    checked_refs = 0
    for rel in files:
        try:
            path = safe_dataset_path(root, rel)
            rows = read_csv_dicts(open(path, "r", encoding="utf-8-sig", errors="replace").read())
        except Exception as exc:
            file_reports.append({"path": rel, "rows": 0, "columns": [], "missingColumns": [], "error": str(exc)})
            continue
        columns = list(rows[0].keys()) if rows else []
        required = ["split", "case_id"]
        missing = [col for col in required if not any(c.lower() == col.lower() or c.lower() == col.replace("_", "").lower() for c in columns)]
        file_reports.append({"path": rel, "rows": len(rows), "columns": columns, "missingColumns": missing})
        for col in missing:
            missing_fields.append({"file": rel, "column": col, "rows": len(rows)})
        for i, row in enumerate(rows):
            cls = dataset_pick(row, ("class", "label", "class_name", "target", "category"), "unknown")
            split = dataset_pick(row, ("split", "phase", "subset"), "train" if "train" in rel.lower() else "val" if "val" in rel.lower() else "test" if "test" in rel.lower() else "unknown")
            class_dist[cls] = class_dist.get(cls, 0) + 1
            split_dist[split] = split_dist.get(split, 0) + 1
            split_class.setdefault(split, {})[cls] = split_class.setdefault(split, {}).get(cls, 0) + 1
            ref = dataset_pick(row, ("file", "path", "image_path", "filepath", "filename"), "")
            if ref:
                checked_refs += 1
                ref_path = os.path.join(root, ref)
                if not os.path.exists(ref_path):
                    missing_refs.append(ref)
            case_id = dataset_pick(row, ("case_id", "caseId", "id", "sample_id", "image_id"), f"{rel}:{i}")
            patient_id = dataset_pick(row, ("patient_id", "patientId", "subject_id", "pid"), "")
            cases.append({"caseId": case_id, "patientId": patient_id, "split": split, "dataset": dataset_pick(row, ("dataset", "dataset_id", "source"), "dataset")})
    issues = []
    if cases and all(not c.get("patientId") for c in cases):
        issues.append({"severity": "warning", "type": "patient_id_missing", "message": "缺少 patient_id，无法做病人级泄漏检查"})
    by_patient = {}
    for c in cases:
        if c.get("patientId"):
            by_patient.setdefault(c["patientId"], set()).add(c.get("split") or "")
    for patient, splits in by_patient.items():
        if len(splits) > 1:
            issues.append({"severity": "critical", "type": "patient_overlap", "message": f"同一 patient_id 出现在多个 split: {patient}", "affectedIds": [patient], "splits": sorted(splits)})
    by_case = {}
    for c in cases:
        by_case.setdefault(c.get("caseId"), set()).add(c.get("split") or "")
    for case_id, splits in by_case.items():
        if case_id and len(splits) > 1:
            issues.append({"severity": "critical", "type": "case_overlap", "message": f"同一 case_id 出现在多个 split: {case_id}", "affectedIds": [case_id], "splits": sorted(splits)})
    leakage = {"schemaVersion": 1, "status": "failed" if any(i["severity"] == "critical" for i in issues) else "warning" if issues else "ok", "issues": issues, "checkedAt": now_iso()}
    plan_file = action_plan_file(payload or {})
    plan_norm = normalize_result_candidate(plan_file) if plan_file else ""
    profile_rel = plan_datasets_artifact_relpath(plan_norm, "profile.json")
    profile_md_rel = plan_datasets_artifact_relpath(plan_norm, "profile.md")
    leak_rel = plan_datasets_artifact_relpath(plan_norm, "leakage_report.csv")
    profile = {"schemaVersion": 1, "generatedAt": now_iso(), "files": file_reports, "totalRows": len(cases), "classDistribution": class_dist, "splitDistribution": split_dist, "splitClassDistribution": split_class, "missingFields": missing_fields, "fileExistence": {"checked": checked_refs, "missing": sorted(dict.fromkeys(missing_refs))}, "leakage": leakage, "planFile": plan_norm or "", "outputFiles": {"profileJson": profile_rel, "profileMarkdown": profile_md_rel, "leakageReportCsv": leak_rel}}
    profile_path = safe_project_path(root, profile_rel)
    atomic_write(profile_path, profile)
    if plan_norm:
        atomic_write(safe_project_path(root, "simple_cluster/datasets/profile.json"), profile)
    md = ["# Dataset Inspector", "", f"生成时间：{profile['generatedAt']}", f"样本数：{profile['totalRows']}", f"泄漏状态：{leakage['status']}", "", "## Split 分布"]
    md.extend([f"- {k}: {v}" for k, v in split_dist.items()] or ["- 无"])
    md.extend(["", "## Class 分布"])
    md.extend([f"- {k}: {v}" for k, v in class_dist.items()] or ["- 无"])
    md.extend(["", "## 缺失字段"])
    md.extend([f"- {x['file']}: {x['column']} ({x['rows']})" for x in missing_fields[:80]] or ["- 无"])
    md_path = safe_project_path(root, profile_md_rel)
    os.makedirs(os.path.dirname(md_path), exist_ok=True)
    open(md_path, "w", encoding="utf-8").write("\n".join(md) + "\n")
    if plan_norm:
        latest_md = safe_project_path(root, "simple_cluster/datasets/profile.md")
        os.makedirs(os.path.dirname(latest_md), exist_ok=True)
        open(latest_md, "w", encoding="utf-8").write("\n".join(md) + "\n")
    leak_path = safe_project_path(root, leak_rel)
    def _write_leak_csv(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["severity", "type", "message", "affectedIds"])
            for issue in issues:
                writer.writerow([issue.get("severity"), issue.get("type"), issue.get("message"), ";".join(issue.get("affectedIds") or [])])
    _write_leak_csv(leak_path)
    if plan_norm:
        _write_leak_csv(safe_project_path(root, "simple_cluster/datasets/leakage_report.csv"))
    return profile

PLOTTING_REQUIRED_FIELDS = ["method", "dataset", "split", "fold", "seed", "metric", "value", "mean", "std", "ci", "pValue", "adjustedPValue", "significant", "case_id", "patient_id", "subgroup", "error_type"]

def plotting_contract_payload(plan=None, tables=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    registry_path = plan_results_registry_relpath(plan_norm) if plan_norm else "simple_cluster/results/result_registry.json"
    statistics_path = plan_results_artifact_relpath(plan_norm, "statistics.json") if plan_norm else "simple_cluster/results/statistics.json"
    case_path = plan_results_artifact_relpath(plan_norm, "case_level_index.json") if plan_norm else "simple_cluster/results/case_level_index.json"
    paper_paths = [table["paperTableCsvPath"] for table in (tables or []) if table.get("paperTableCsvPath")]
    paper_path = paper_paths[0] if len(paper_paths) == 1 else ""
    return {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "consumer": "D:/GitRepo/my_ppt_app",
        "planFile": plan_norm or "",
        "requiredFields": PLOTTING_REQUIRED_FIELDS,
        "files": {
            "resultRegistry": {"path": registry_path, "fields": ["resultId", "experimentId", "suite", "method", "dataset", "split", "fold", "seed", "metrics", "dimensions", "sourceFiles"]},
            "statistics": {"path": statistics_path, "fields": ["suite", "group", "method", "dataset", "split", "metric", "value", "mean", "std", "ci", "n", "pValue", "adjustedPValue", "significant", "aggregationPolicy"]},
            "paperTable": {"path": paper_path, "paths": paper_paths, "fields": ["method", "dataset", "split", "suite", "group", "metric", "mean", "std", "ci", "n", "direction", "pValue", "adjustedPValue", "significant"]},
            "caseLevel": {"path": case_path, "fields": ["case_id", "patient_id", "method", "dataset", "split", "metric", "value", "subgroup", "error_type"]},
            "datasetProfile": {"path": plan_datasets_artifact_relpath(plan_norm, "profile.json") if plan_norm else "simple_cluster/datasets/profile.json", "fields": ["dataset", "split", "class", "case_id", "patient_id", "classDistribution", "splitDistribution"]},
        },
        "notes": [
            "不传输原始数据集、权重或 checkpoint 大文件。",
            "集群插件只做结果文件发现、轻量请求和审计落盘；不在 VS Code 内绘图，不连接 Zotero，不读取 Zotero DB。",
            "PPT automation discovery 固定为 %LOCALAPPDATA%/RoughPptAddin/automation.json 和 automation.token；调用顺序固定为 GET /health 后 POST /api/simple-experiment/plot。",
            "automation endpoint 固定归一化为根地址后访问 /health 和 /api/simple-experiment/plot；不得把 discovery 中的其它 path 拼进协议路由。",
            "绘图请求字段冻结为 schemaVersion/requestId/projectRoot/sourcePaths/plottingContractPath/selectedResultId/runKey/archiveKey/chartType/target/styleMode/sourceLabel/markdownSummary；新增字段只能 additive，优先放 optional extensions。",
            "sourcePaths 只能指向已存在的轻量 JSON、CSV、Markdown 或 TeX 文件；不得传目录、raw dataset、checkpoint 或大文件。",
            "SCI 数值绘图默认以 statistics.json 或 paper table 的 mean/std/ci 为准；result_registry.json 和单个结果 CSV 只用于发现、追踪和审计，不作为默认图表数值源。",
            "pValue/adjustedPValue 可为空；significant 必须是布尔值或可解析布尔文本。",
        ],
    }

def export_plotting_contract_action(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    current_summary = read_results_summary(root, plan_norm or None) or {}
    payload = plotting_contract_payload(plan_norm or None, current_summary.get("paperDatasetTables", []))
    rel = plan_results_artifact_relpath(plan_norm, "plotting_contract.json") if plan_norm else "simple_cluster/results/plotting_contract.json"
    target = safe_project_path(root, rel)
    atomic_write(target, payload)
    if plan_norm:
        atomic_write(safe_project_path(root, "simple_cluster/results/plotting_contract.json"), payload)
    try:
        summary = read_results_summary(root, plan_norm or None)
        if isinstance(summary, dict) and summary:
            summary["plottingContractPath"] = rel
            if plan_norm and not summary.get("planFile"):
                summary["planFile"] = plan_norm
            write_results_summary_v2(root, summary)
    except Exception:
        pass
    doc = ["# SimpleExperiment 输出到 PPT 绘图插件的稳定契约", "", "目标消费端：D:/GitRepo/my_ppt_app", "", "## 必备语义字段", ""]
    doc.extend([f"- {field}" for field in PLOTTING_REQUIRED_FIELDS])
    doc.extend(["", "## 文件契约"])
    for key, item in payload["files"].items():
        doc.extend(["", f"### {key}", "", f"路径：{', '.join(item.get('paths') or [item['path']])}", "", "字段："])
        doc.extend([f"- {field}" for field in item["fields"]])
    doc.extend(["", "## 兼容说明", ""])
    doc.extend([f"- {note}" for note in payload.get("notes") or []])
    md_rel = plan_results_artifact_relpath(plan_norm, "output_contract_for_plotting.md") if plan_norm else "simple_cluster/results/output_contract_for_plotting.md"
    md_path = safe_project_path(root, md_rel)
    os.makedirs(os.path.dirname(md_path), exist_ok=True)
    open(md_path, "w", encoding="utf-8").write("\n".join(doc) + "\n")
    return {"planFile": plan_norm or "", "schemaVersion": 1, "contract": payload, "path": relpath(root, target), "markdownPath": relpath(root, md_path)}

def safe_name(value):
    text = str(value or "item")
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")[:120]
    return text or "item"

def read_text_if_exists(path):
    try:
        if path and os.path.isfile(path):
            return open(path, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return ""
    return ""

def read_json_if_exists(path):
    try:
        if path and os.path.isfile(path):
            return json.load(open(path, "r", encoding="utf-8"))
    except Exception:
        return {}
    return {}

def yamlish_scalar(text, *keys):
    for key in keys:
        leaf = str(key).split(".")[-1]
        pattern = r"(?im)^\s*" + re.escape(leaf) + r"\s*:\s*['\"]?([^'\"\n#]+)"
        match = re.search(pattern, text or "")
        if match:
            return match.group(1).strip()
    return ""

def jsonish_scalar(value, *keys):
    for key in keys:
        cur = value
        ok = True
        for part in str(key).split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur.get(part)
            else:
                ok = False
                break
        if ok and cur not in (None, ""):
            if isinstance(cur, list):
                return ",".join(str(item) for item in cur)
            if not isinstance(cur, (dict, tuple)):
                return str(cur)
    return ""

def regex_scalar(text, pattern):
    match = re.search(pattern, text or "", re.I | re.M)
    return match.group(1).strip() if match else ""

def find_run_dir(root, run_id="", result=None, payload=None):
    payload = payload or {}
    direct = str(payload.get("runDir") or payload.get("run_dir") or "").strip()
    if direct:
        try:
            target = safe_project_path(root, direct)
            if os.path.isdir(target):
                return target
        except Exception:
            pass
    result = result if isinstance(result, dict) else {}
    for item in result.get("sourceFiles") or []:
        rel = str((item or {}).get("path") or "").replace("\\", "/")
        if not rel:
            continue
        try:
            full = safe_project_path(root, rel)
            parent = os.path.dirname(full)
            if os.path.isdir(parent):
                return parent
        except Exception:
            pass
    tokens = [str(run_id or ""), str(result.get("runKey") or ""), str(result.get("experimentId") or "")]
    roots = ["experiments/runs", "work_dirs", "outputs", "runs", "logs", "results"]
    for token in [safe_name(t) for t in tokens if t]:
        for base_rel in roots:
            try:
                base = safe_project_path(root, base_rel)
            except Exception:
                continue
            if not os.path.isdir(base):
                continue
            exact = os.path.join(base, token)
            if os.path.isdir(exact):
                return exact
    return ""

def run_file_map(run_dir):
    files = {}
    if not run_dir or not os.path.isdir(run_dir):
        return files
    for name in ("artifact_manifest.json", "checkpoint_manifest.json", "config_snapshot.yaml", "config_snapshot.yml", "config_snapshot.json", "env_snapshot.json", "command.txt", "stdout.log", "stderr.log", "train.log", "test.log", "metrics_summary.csv", "results.csv", "metrics.csv"):
        path = os.path.join(run_dir, name)
        text = read_text_if_exists(path)
        if text:
            files[name] = text
    return files

def recovered_field(name, value="", status="observed", source="", message=""):
    if value not in (None, ""):
        return {"value": str(value), "status": status, "source": source or "run evidence"}
    suggestions = {
        "seed": "缺少 seed，建议从 log 或 config_snapshot.yaml 补齐。",
        "baseConfig": "缺少 config 路径，建议从 command.txt、artifact_manifest.json 或 config_snapshot.yaml 补齐。",
        "trainCommand": "缺少训练命令，建议从 command.txt 或 stdout.log 补齐。",
    }
    return {"status": "needs_user_input", "message": message or suggestions.get(name, f"{name} 缺少明确证据，需要人工确认。")}

def infer_config_payload(root, payload=None):
    payload = payload or {}
    plan = action_plan_file(payload) if isinstance(payload, dict) else ""
    plan_revision = action_operation_fields(payload).get("planRevision") if isinstance(payload, dict) else ""
    summary = read_current_results_summary(root, plan or None, plan_revision)
    result = select_result_record(summary.get("results") or [], payload)
    run_id = str(payload.get("runId") or payload.get("run_id") or (result or {}).get("runKey") or (result or {}).get("experimentId") or (result or {}).get("resultId") or "manual")
    run_dir = find_run_dir(root, run_id, result, payload)
    files = run_file_map(run_dir)
    artifact = {}
    env = {}
    try:
        artifact = json.loads(files.get("artifact_manifest.json") or "{}")
    except Exception:
        artifact = {}
    try:
        env = json.loads(files.get("env_snapshot.json") or "{}")
    except Exception:
        env = {}
    config_text = files.get("config_snapshot.yaml") or files.get("config_snapshot.yml") or files.get("config_snapshot.json") or ""
    command = files.get("command.txt", "").strip() or jsonish_scalar(env, "command") or jsonish_scalar(artifact, "command") or regex_scalar(files.get("stdout.log", "") + "\n" + files.get("stderr.log", ""), r"(?:command|cmd|运行命令)\s*[:=]\s*(.+)$")
    dims = result.get("dimensions") if isinstance(result, dict) and isinstance(result.get("dimensions"), dict) else {}
    result_csv = next((name for name in ("metrics_summary.csv", "results.csv", "metrics.csv") if files.get(name)), "") or jsonish_scalar(artifact, "result_csv", "metrics_csv")
    seed = str(dims.get("seed") or jsonish_scalar(env, "seed") or yamlish_scalar(config_text, "seed", "random_seed") or regex_scalar(command, r"(?:--seed|seed=)\s*=?\s*([A-Za-z0-9_.-]+)"))
    base_config = jsonish_scalar(env, "config") or jsonish_scalar(artifact, "config") or regex_scalar(command, r"(?:--config|--cfg)\s+([^\s]+)") or yamlish_scalar(config_text, "base_config", "config")
    output_dir = regex_scalar(command, r"(?:--output-dir|--output_dir|--out|--work-dir|--work_dir)\s+([^\s]+)") or jsonish_scalar(artifact, "output_dir") or (os.path.relpath(run_dir, root).replace("\\", "/") if run_dir else "")
    suite = str((result or {}).get("suite") or yamlish_scalar(config_text, "suite") or "manual")
    case_name = str(dims.get("case") or (result or {}).get("experimentName") or (result or {}).get("runKey") or safe_name(run_id))
    method = str(dims.get("method") or yamlish_scalar(config_text, "method", "model") or case_name or "unknown")
    dataset = str(dims.get("dataset") or yamlish_scalar(config_text, "dataset") or "unknown")
    split = str(dims.get("split") or yamlish_scalar(config_text, "split") or "test")
    fold = str(dims.get("fold") or yamlish_scalar(config_text, "fold") or regex_scalar(command, r"(?:--fold|fold=)\s*=?\s*([A-Za-z0-9_.-]+)"))
    fields = {
        "runId": recovered_field("runId", run_id, "observed", "result/run_dir"),
        "suite": recovered_field("suite", suite, "observed" if suite != "manual" else "inferred", "result/config"),
        "case": recovered_field("case", case_name, "observed", "result"),
        "method": recovered_field("method", method, "observed" if method != "unknown" else "inferred", "result/config"),
        "dataset": recovered_field("dataset", dataset, "observed" if dataset != "unknown" else "inferred", "result/config"),
        "split": recovered_field("split", split, "observed" if split != "test" else "inferred", "result/config"),
        "fold": recovered_field("fold", fold),
        "seed": recovered_field("seed", seed),
        "baseConfig": recovered_field("baseConfig", base_config),
        "outputDir": recovered_field("outputDir", output_dir or f"work_dirs/recovered/{safe_name(run_id)}", "observed" if output_dir else "inferred", "command/run_dir"),
        "trainCommand": recovered_field("trainCommand", command, "observed" if command else "needs_user_input", "command.txt"),
        "testCommand": recovered_field("testCommand", command if re.search(r"test|eval", command or "", re.I) else "", "low_confidence", "command.txt", "命令无法明确区分 train/test，请人工确认。"),
        "resultCsv": recovered_field("resultCsv", result_csv or "metrics_summary.csv", "observed" if result_csv else "inferred", "run_dir"),
    }
    warnings = [v.get("message") for v in fields.values() if v.get("message")]
    if not seed:
        warnings.append("缺少 seed，建议从 log 或 config_snapshot.yaml 补齐。")
    if not config_text:
        warnings.append("缺少 config_snapshot.yaml，建议使用 recovered plan 后人工补齐关键配置。")
    if not (jsonish_scalar(env, "git_commit", "gitCommit") or jsonish_scalar(artifact, "gitCommit", "codeFingerprint")):
        warnings.append("缺少 git commit 或代码 fingerprint，复现需谨慎。")
    recovered = {
        "schemaVersion": 1,
        "runId": run_id,
        "runDir": os.path.relpath(run_dir, root).replace("\\", "/") if run_dir else "",
        "fields": fields,
        "plan": {
            "suite": suite,
            "caseName": case_name,
            "method": method,
            "dataset": dataset,
            "split": split,
            "fold": fold,
            "seed": seed,
            "baseConfig": base_config or "configs/base.yaml",
            "outputDir": output_dir or f"work_dirs/recovered/{safe_name(run_id)}",
            "trainCommand": command or "python train.py --config {config} --seed {seed} --output-dir {output_dir}",
            "testCommand": command if re.search(r"test|eval", command or "", re.I) else "",
            "resultFiles": [result_csv or "metrics_summary.csv"],
        },
        "worker": {"workerId": jsonish_scalar(env, "worker_id", "workerId") or jsonish_scalar((result or {}).get("provenance") or {}, "workerId"), "gpuIds": str(jsonish_scalar(env, "gpu_ids", "gpuIds")).split(",") if jsonish_scalar(env, "gpu_ids", "gpuIds") else []},
        "provenance": {"gitCommit": jsonish_scalar(env, "git_commit", "gitCommit"), "codeFingerprint": jsonish_scalar(env, "code_fingerprint", "codeFingerprint") or jsonish_scalar(artifact, "codeFingerprint"), "command": command},
        "warnings": sorted(set([w for w in warnings if w])),
        "evidenceFiles": sorted(files.keys()),
        "generatedAt": now_iso(),
        "planFile": normalize_result_candidate(plan) if plan else "",
    }
    return recovered

def render_recovered_plan_yaml(recovered):
    plan = recovered.get("plan") or {}
    result_files = plan.get("resultFiles") if isinstance(plan.get("resultFiles"), list) else []
    seed = str(plan.get("seed") or "needs_user_input")
    output_dir = str(plan.get("outputDir") or f"work_dirs/recovered/{safe_name(recovered.get('runId'))}")
    lines = [
        f"suite: {json.dumps(str(plan.get('suite') or 'manual'), ensure_ascii=False)}",
        "mode: train_test",
        f"base_config: {json.dumps(str(plan.get('baseConfig') or 'configs/base.yaml'), ensure_ascii=False)}",
        "paper:",
        f"  result_csv: {json.dumps(str(result_files[0] if result_files else 'metrics_summary.csv'), ensure_ascii=False)}",
        "runner:",
        f"  train_command: {json.dumps(str(plan.get('trainCommand') or 'python train.py --config {config} --seed {seed} --output-dir {output_dir}'), ensure_ascii=False)}",
    ]
    if plan.get("testCommand"):
        lines.append(f"  test_command: {json.dumps(str(plan.get('testCommand')), ensure_ascii=False)}")
    lines += [
        "naming:",
        f"  sweep_dir: {json.dumps(os.path.dirname(output_dir).replace(os.sep, '/') or 'work_dirs/recovered', ensure_ascii=False)}",
        f"  job_name: {json.dumps(os.path.basename(output_dir) or '{case}_seed{seed}', ensure_ascii=False)}",
        "seeds:",
        f"  - {json.dumps(seed, ensure_ascii=False)}",
        "cases:",
        f"  - case: {json.dumps(str(plan.get('caseName') or 'baseline'), ensure_ascii=False)}",
        f"    method: {json.dumps(str(plan.get('method') or 'unknown'), ensure_ascii=False)}",
        f"    dataset: {json.dumps(str(plan.get('dataset') or 'unknown'), ensure_ascii=False)}",
        f"    split: {json.dumps(str(plan.get('split') or 'test'), ensure_ascii=False)}",
        f"    outputDir: {json.dumps(output_dir, ensure_ascii=False)}",
        "    expectedResults:",
    ]
    for item in result_files or ["metrics_summary.csv"]:
        lines.append(f"      - {json.dumps(str(item), ensure_ascii=False)}")
    lines += ["    overrides:", f"      recovered_from_run: {json.dumps(str(recovered.get('runId') or ''), ensure_ascii=False)}"]
    if plan.get("fold"):
        lines.append(f"      fold: {json.dumps(str(plan.get('fold')), ensure_ascii=False)}")
    return "\n".join(lines) + "\n"

def render_recovered_report(recovered):
    lines = ["# 实验配置反推报告", "", f"run_id: {recovered.get('runId')}", f"generated_at: {recovered.get('generatedAt')}", "", "## 字段置信度", "", "| 字段 | 状态 | 值 | 来源 | 建议 |", "| --- | --- | --- | --- | --- |"]
    for key, value in (recovered.get("fields") or {}).items():
        lines.append(f"| {key} | {value.get('status')} | {value.get('value', '')} | {value.get('source', '')} | {value.get('message', '')} |")
    lines += ["", "## 中文建议", ""]
    lines += [f"- {item}" for item in recovered.get("warnings") or ["暂无关键缺失。"]]
    return "\n".join(lines) + "\n"

def recover_plan_from_run_action(root, payload=None):
    recovered = infer_config_payload(root, payload)
    plan_file = action_plan_file(payload or {}) if isinstance(payload, dict) else ""
    plan_norm = normalize_result_candidate(plan_file) if plan_file else normalize_result_candidate((recovered or {}).get("planFile") or "")
    if plan_norm and isinstance(recovered, dict) and not recovered.get("planFile"):
        recovered = {**recovered, "planFile": plan_norm}
    run_name = safe_name((recovered or {}).get("runId") or "manual")
    slug = plan_summary_slug(plan_norm)
    rel_base = f"simple_cluster/plans/recovered/by_plan/{slug}/{run_name}" if slug else f"simple_cluster/plans/recovered/{run_name}"
    base = safe_project_path(root, rel_base)
    yaml_path = base + ".yaml"
    json_path = base + ".json"
    report_path = base + ".report.md"
    os.makedirs(os.path.dirname(base), exist_ok=True)
    yaml_text = render_recovered_plan_yaml(recovered)
    report_text = render_recovered_report(recovered)
    open(yaml_path, "w", encoding="utf-8").write(yaml_text)
    atomic_write(json_path, recovered)
    open(report_path, "w", encoding="utf-8").write(report_text)
    # Keep unscoped latest aliases for unscoped consumers.
    if slug:
        latest_base = safe_project_path(root, f"simple_cluster/plans/recovered/{run_name}")
        os.makedirs(os.path.dirname(latest_base), exist_ok=True)
        open(latest_base + ".yaml", "w", encoding="utf-8").write(yaml_text)
        atomic_write(latest_base + ".json", recovered)
        open(latest_base + ".report.md", "w", encoding="utf-8").write(report_text)
    return {
        "schemaVersion": 1,
        "recovered": recovered,
        "planFile": plan_norm or "",
        "yamlPath": relpath(root, yaml_path),
        "jsonPath": relpath(root, json_path),
        "reportPath": relpath(root, report_path),
        "status": "warning" if recovered.get("warnings") else "ok",
    }

def select_result_record(records, payload):
    payload = payload or {}
    wanted = [str(payload.get(k) or "").strip() for k in ("resultId", "result_id", "runKey", "run_key", "experimentId", "experiment_id", "archiveKey", "archive_key") if str(payload.get(k) or "").strip()]
    for key in wanted:
        for record in records:
            if key in (str(record.get("resultId") or ""), str(record.get("runKey") or ""), str(record.get("experimentId") or "")):
                return record
    return records[0] if records else {}

def metric_float(record, metric):
    data = (record.get("metrics") or {}).get(metric) if isinstance(record, dict) else None
    value = data.get("value") if isinstance(data, dict) else data
    try:
        return float(value)
    except Exception:
        return None

def primary_metric_for_record(record, fallback="AUC"):
    if isinstance(record, dict) and record.get("primaryMetric") and record.get("primaryMetric") in (record.get("metrics") or {}):
        return str(record.get("primaryMetric"))
    for metric in ("AUC", "accuracy", "F1", "DSC", "IoU", "loss", "HD95", "ASD"):
        if metric in (record.get("metrics") or {}):
            return metric
    metrics = list((record.get("metrics") or {}).keys()) if isinstance(record, dict) else []
    return metrics[0] if metrics else fallback

def comparable_result(a, b):
    ad = a.get("dimensions") if isinstance(a.get("dimensions"), dict) else {}
    bd = b.get("dimensions") if isinstance(b.get("dimensions"), dict) else {}
    for key in ("suite", "dataset", "split"):
        av = a.get(key) if key == "suite" else ad.get(key)
        bv = b.get(key) if key == "suite" else bd.get(key)
        if str(av or "") != str(bv or ""):
            return False
    return True

def best_comparable_result(current, records, metric):
    direction = metric_direction(metric)
    candidates = [r for r in records if r is not current and comparable_result(current, r) and metric_float(r, metric) is not None]
    if not candidates:
        return {}
    return sorted(candidates, key=lambda r: metric_float(r, metric), reverse=(direction != "lower"))[0]

def parse_config_snapshot(text):
    out = {}
    for raw in (text or "").splitlines():
        match = re.match(r"^\s*([A-Za-z0-9_.-]+)\s*:\s*['\"]?([^'\"\n#]+)", raw)
        if match:
            out[match.group(1)] = match.group(2).strip()
    return out

def config_value(config, key):
    if key in config:
        return config.get(key)
    leaf = key.split(".")[-1]
    return config.get(leaf)

def compare_config_dicts(current, best):
    keys = ["model.name", "model", "learning_rate", "lr", "optimizer.lr", "batch_size", "batchSize", "epochs", "epoch", "loss", "criterion", "augmentation", "seed", "fold", "dataset", "split"]
    for key in sorted(set(list(current.keys()) + list(best.keys()))):
        if re.search(r"lr|learning|batch|epoch|loss|augment|model|seed|fold|dataset|split", key, re.I) and key not in keys:
            keys.append(key)
    diffs = []
    for key in keys:
        a = config_value(current, key)
        b = config_value(best, key)
        if a in (None, "") and b in (None, ""):
            continue
        if str(a) == str(b):
            continue
        severity = "info"
        try:
            ratio = float(a) / float(b)
            if ratio >= 10 or ratio <= 0.1:
                severity = "warning"
                message = f"{key} 与最优 run 差异 {ratio:.1f}x。"
            else:
                message = f"{key} 与最优 run 不同。"
        except Exception:
            message = f"{key} 与最优 run 不同。"
        diffs.append({"key": key, "current": a, "best": b, "severity": severity, "message": message})
    return diffs

def anomaly_log_causes(text):
    rules = [
        (r"out of memory|oom", "critical", "oom", "当前 run 出现 OOM，结果可能不可信"),
        (r"\bnan\b|inf\b", "critical", "nan", "日志出现 NaN/Inf，训练可能已经发散"),
        (r"traceback|exception|error:", "critical", "traceback", "日志出现 Traceback/异常"),
        (r"cuda error|cudnn|device-side assert", "critical", "cuda_error", "日志出现 CUDA 相关错误"),
        (r"missing file|file not found|no such file", "warning", "missing_file", "日志出现缺失文件"),
        (r"shape mismatch|size mismatch|dimension mismatch", "warning", "shape_mismatch", "日志出现 shape/size 不匹配"),
    ]
    out = []
    for pattern, severity, code, message in rules:
        if re.search(pattern, text or "", re.I):
            out.append({"severity": severity, "category": "log", "code": code, "message": message, "suggestion": "先处理日志错误，再比较指标。"})
    return out

def diagnose_result_anomaly_action(root, payload=None):
    payload = payload or {}
    plan = action_plan_file(payload) if isinstance(payload, dict) else ""
    plan_revision = action_operation_fields(payload).get("planRevision") if isinstance(payload, dict) else ""
    summary = read_current_results_summary(root, plan or None, plan_revision)
    records = summary.get("results") or []
    current = select_result_record(records, payload)
    if not current:
        raise ValueError("没有可诊断的结果记录。")
    metric = str(payload.get("metric") or primary_metric_for_record(current, project_primary_metric(root)))
    best = best_comparable_result(current, records, metric)
    values = [metric_float(r, metric) for r in records if comparable_result(current, r) and metric_float(r, metric) is not None]
    current_value = metric_float(current, metric)
    best_value = metric_float(best, metric) if best else None
    mean = sum(values) / len(values) if values else None
    std = (sum((v - mean) ** 2 for v in values) / max(1, len(values) - 1)) ** 0.5 if values and mean is not None else None
    z = (current_value - mean) / std if current_value is not None and mean is not None and std else None
    causes = []
    if str(current.get("status") or "").lower() in ("parse_failed", "failed", "quality_failed"):
        causes.append({"severity": "critical", "category": "output_contract", "code": "bad_status", "message": f"当前结果状态为 {current.get('status')}，结果可能不可用于比较。", "suggestion": "先修复解析或质量门禁。"})
    if not best:
        causes.append({"severity": "warning", "category": "comparison", "code": "no_comparable_best", "message": "未找到同 suite/dataset/split/metric 的最优结果，不可直接比较。", "suggestion": "先解析同组结果或选择明确对照。"})
    if current_value is None:
        causes.append({"severity": "critical", "category": "metric", "code": "missing_metric", "message": f"主指标 {metric} 缺失或不可解析。", "suggestion": "先修复结果解析。"})
    if current_value is not None and best_value is not None:
        delta = current_value - best_value
        bad = delta < -0.05 if metric_direction(metric) != "lower" else delta > 0.05
        if bad:
            causes.append({"severity": "warning", "category": "metric", "code": "behind_best", "message": f"当前 {metric}={current_value} 与最优 {best_value} 差距超过阈值。", "suggestion": "查看配置差异和日志异常。", "evidence": {"delta": delta}})
    if z is not None:
        bad_z = z < -2 if metric_direction(metric) != "lower" else z > 2
        if bad_z:
            causes.append({"severity": "warning", "category": "metric", "code": "group_outlier", "message": f"当前 {metric} 相对同组均值 z-score={z:.2f}，属于异常波动。", "suggestion": "优先检查 seed/fold、数据 split 和环境差异。"})
    current_dir = find_run_dir(root, str(current.get("runKey") or ""), current, payload)
    best_dir = find_run_dir(root, str(best.get("runKey") or ""), best, {}) if best else ""
    current_files = run_file_map(current_dir)
    best_files = run_file_map(best_dir)
    causes.extend(anomaly_log_causes("\n".join(current_files.get(name, "") for name in ("stdout.log", "stderr.log", "train.log", "test.log"))))
    current_config = parse_config_snapshot(current_files.get("config_snapshot.yaml") or current_files.get("config_snapshot.yml") or current_files.get("config_snapshot.json") or "")
    best_config = parse_config_snapshot(best_files.get("config_snapshot.yaml") or best_files.get("config_snapshot.yml") or best_files.get("config_snapshot.json") or "")
    config_diffs = compare_config_dicts(current_config, best_config)
    if not current_config:
        causes.append({"severity": "warning", "category": "config", "code": "needs_config_snapshot", "message": "当前 run 缺少 config_snapshot，无法完整比较配置。", "suggestion": "先运行反推配置或补齐 config_snapshot.yaml。"})
    if best and not best_config:
        causes.append({"severity": "warning", "category": "config", "code": "needs_recovered_config", "message": "最优 run 缺少 config_snapshot，需要使用反推配置结果。", "suggestion": "先对最优 run 执行“反推配置”。"})
    for diff in config_diffs:
        causes.append({"severity": diff.get("severity"), "category": "config", "code": "config_" + str(diff.get("key")), "message": diff.get("message"), "evidence": {"current": diff.get("current"), "best": diff.get("best")}, "suggestion": "复现前确认当前配置是否应改为最优 run 对应值。"})
    severity_order = {"critical": 0, "warning": 1, "info": 2}
    causes = sorted(causes, key=lambda item: (severity_order.get(item.get("severity"), 9), str(item.get("category")), str(item.get("code"))))
    safe = safe_name(str(current.get("resultId") or current.get("experimentId") or "result"))
    plan_norm = normalize_result_candidate(plan) if plan else ""
    anomaly_rel = plan_results_artifact_relpath(plan_norm, f"anomaly/{safe}") if plan_norm else f"simple_cluster/results/anomaly/{safe}"
    out_dir = safe_project_path(root, "/".join(anomaly_rel.split("/")[:-1]))
    os.makedirs(out_dir, exist_ok=True)
    metric_summary = {"metric": metric, "currentValue": current_value, "bestValue": best_value, "delta": (current_value - best_value) if current_value is not None and best_value is not None else None, "relativeDelta": ((current_value - best_value) / abs(best_value)) if current_value is not None and best_value not in (None, 0) else None, "mean": mean, "std": std, "zScore": z, "higherIsBetter": metric_direction(metric) != "lower"}
    report = {"schemaVersion": 1, "planFile": plan_norm or "", "resultId": current.get("resultId"), "comparableResultId": best.get("resultId") if best else "", "comparable": bool(best), "metric": metric_summary, "configDiffs": config_diffs, "causes": causes, "generatedAt": now_iso(), "outputFiles": {"jsonPath": f"{anomaly_rel}.json", "markdownPath": f"{anomaly_rel}.md", "configDiffPath": f"{anomaly_rel}.config_diff.json"}}
    atomic_write(os.path.join(out_dir, safe + ".json"), report)
    atomic_write(os.path.join(out_dir, safe + ".config_diff.json"), {"schemaVersion": 1, "planFile": plan_norm or "", "resultId": current.get("resultId"), "bestResultId": best.get("resultId") if best else "", "diffs": config_diffs})
    md = ["# 结果异常诊断报告", "", f"result_id: {current.get('resultId')}", f"best_result_id: {best.get('resultId') if best else '不可直接比较'}", "", "## 原因排序", ""]
    md.extend([f"- [{c.get('severity')}] {c.get('category')}/{c.get('code')}: {c.get('message')}" for c in causes])
    open(os.path.join(out_dir, safe + ".md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    return report

OUTPUT_CONTRACT_SNAPSHOT_FILES = ("env_snapshot.json", "config_snapshot.yaml")

def output_contract_result_candidate(value):
    return parseable_result_candidate(value)

def output_contract_search_roots(values):
    roots = []
    for item in values or []:
        text = normalize_result_candidate(item)
        if not text:
            continue
        if re.search(r"\.(?:csv|json|txt|log|out)$", text, re.I):
            parent = "/".join(text.split("/")[:-1]) or "."
        else:
            parent = text
        if any(ch in parent for ch in "*?[]"):
            continue
        roots.append(parent)
    return unique_values(roots)[:32]

def output_contract_unparseable_error(value):
    lower = str(value or "").lower()
    if lower.endswith(".csv"):
        return "未解析到数值指标；请检查 CSV 列名、metric/value 映射或数值格式。"
    if lower.endswith(".json"):
        return "未解析到数值指标；请检查 JSON 指标结构、指标名称或数值格式。"
    return "未解析到数值指标；请检查 metricRegex、指标名称或文本数值格式。"

def check_output_contract_action(root, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    required = list(OUTPUT_CONTRACT_SNAPSHOT_FILES)
    if plan_norm:
        declared = plan_declared_result_candidates(root, plan_norm)
        jobs = job_result_candidates(root, plan=plan_norm)
        files = sorted(dict.fromkeys([
            *expand_result_candidates(root, declared),
            *expand_result_candidates(root, jobs),
            *expand_result_candidates(root, plan_scoped_discover_candidates(root, plan_norm)),
        ]))
        search_roots = output_contract_search_roots([*declared, *jobs, *files])
    else:
        files = discover_result_files(root)
        search_roots = [".", "experiments", "work_dirs", "results", "simple_cluster"]
    present = {os.path.basename(path).lower() for path in files if os.path.basename(path).lower() in required}
    for top in search_roots:
        base = root if top == "." else (safe_project_path(root, top) if plan_norm else os.path.join(root, top))
        if not os.path.isdir(base):
            continue
        if plan_norm:
            for name in os.listdir(base):
                lower_name = name.lower()
                path = os.path.join(base, name)
                if lower_name in required and os.path.isfile(path):
                    present.add(lower_name)
                    files.append(relpath(root, path))
            if required and all(name in present for name in required):
                break
            continue
        for current, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features")]
            if plan_norm:
                try:
                    rel_cur = relpath(root, current).replace("\\", "/")
                    depth = max(0, rel_cur.count("/") - str(top).replace("\\", "/").count("/"))
                except Exception:
                    depth = 0
                if depth > 2:
                    dirs[:] = []
                    continue
            for name in names:
                lower_name = name.lower()
                if lower_name in required:
                    present.add(lower_name)
                    files.append(relpath(root, os.path.join(current, name)))
            if required and all(name in present for name in required):
                break
        if required and all(name in present for name in required):
            break
    files = sorted(dict.fromkeys(files))
    missing = [name for name in required if name not in present]
    result_files = sorted(dict.fromkeys(filter(None, (output_contract_result_candidate(item) for item in files))))
    metric_files = [item for item in result_files if os.path.basename(str(item)).lower() == "metrics_summary.csv"]
    if not result_files:
        missing.append("parseable_result_file")
    policy = read_project_metric_policy(root)
    parseable_files = []
    unparseable = []
    parseable_result_count = 0
    for item in result_files:
        try:
            parsed = parse_result_file(root, item, policy)
            if parsed:
                parseable_files.append(item)
                parseable_result_count += len(parsed)
            else:
                unparseable.append({"path": item, "error": output_contract_unparseable_error(item)})
        except Exception as exc:
            unparseable.append({"path": item, "error": str(exc)})
    unparseable_files = [item.get("path") for item in unparseable if item.get("path")]
    issue_type = "missing_files" if missing else "unparseable_result" if parseable_result_count <= 0 else ""
    if missing:
        labels = ["可解析结果文件（CSV、JSON、TXT、LOG 或 OUT）" if item == "parseable_result_file" else item for item in missing]
        message = f"输出契约缺失：{'、'.join(labels)}"
        if result_files and parseable_result_count <= 0:
            message += "；候选结果均未解析到数值指标"
    elif parseable_result_count <= 0:
        message = "候选结果文件存在，但未解析到数值指标：" + ("、".join(unparseable_files) or "未找到可解析文件")
    else:
        message = f"输出契约完整：已确认 {len(required)} 个快照文件，并从 {len(parseable_files)} 个结果文件解析到 {parseable_result_count} 条结果"
    report = {"schemaVersion": 1, "status": "failed" if issue_type else "ok", "issueType": issue_type, "files": files, "missing": missing, "missingCount": len(missing), "requiredSnapshots": required, "resultFiles": result_files, "metricFiles": metric_files, "parseableResultFiles": parseable_files, "parseableResultCount": parseable_result_count, "unparseable": unparseable, "unparseableFiles": unparseable_files, "unparseableCount": len(unparseable_files), "checkedAt": now_iso(), "planFile": plan_norm or "", "message": message}
    report_rel = f"simple_cluster/contracts/contract_check_reports/by_plan/{plan_summary_slug(plan_norm)}/latest.json" if plan_norm else "simple_cluster/contracts/contract_check_reports/latest.json"
    report["path"] = report_rel
    target = safe_project_path(root, report_rel)
    atomic_write(target, report)
    if plan_norm:
        atomic_write(safe_project_path(root, "simple_cluster/contracts/contract_check_reports/latest.json"), report)
    return report

def redact_text(text):
    import re
    text = re.sub(r"(?i)(token|password|secret|passwd)\s*[:=]\s*['\"]?[^'\"\s,}]+", "\\1=<redacted>", text)
    text = re.sub(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+", "\\1<redacted>", text)
    text = re.sub(r"[A-Za-z]:\\\\Users\\\\[^\\\\\\s]+\\\\[^\\s\"']+", "<local-user-path>", text)
    return text

def create_debug_bundle_action(root, include_results=False, plan=None):
    plan_norm = normalize_result_candidate(plan) if plan else ""
    slug = plan_summary_slug(plan_norm)
    rel_dir = f"simple_cluster/debug/by_plan/{slug}" if slug else "simple_cluster/debug"
    out_dir = safe_project_path(root, rel_dir)
    os.makedirs(out_dir, exist_ok=True)
    stamp = int(time.time())
    bundle = os.path.join(out_dir, f"debug_bundle_{stamp}.zip")
    summary = read_results_summary(root, plan_norm or None)
    claim_path = plan_results_artifact_relpath(plan_norm, "claim_evidence.json") if plan_norm else "simple_cluster/results/claim_evidence.json"
    registry_path = plan_results_registry_relpath(plan_norm) if plan_norm else "simple_cluster/results/result_registry.json"
    quality_path = plan_results_artifact_relpath(plan_norm, "quality_gate.json") if plan_norm else "simple_cluster/results/quality_gate.json"
    statistics_path = plan_results_artifact_relpath(plan_norm, "statistics.json") if plan_norm else "simple_cluster/results/statistics.json"
    items = {
        "diagnostics.json": api_diagnostics(root),
        "capabilities.json": api_capabilities(root, False, "hub_control"),
        "health.json": api_health(root, "hub_control"),
        "results_summary.json": summary,
        "claim_evidence.json": read_json(safe_project_path(root, claim_path), {}),
        "quality_gate.json": read_json(safe_project_path(root, quality_path), {}),
        "statistics.json": read_json(safe_project_path(root, statistics_path), {}),
        "scheduler_snapshot.json": read_json(path_for(root, "cluster_snapshot.json"), {}),
        "traces_snapshot.json": read_json(path_for(root, "experiment_traces_snapshot.json"), {}),
        "availability.json": read_availability_cache(root),
        "bundle_scope.json": {"planFile": plan_norm or "", "summaryPath": summary.get("summaryPath") if isinstance(summary, dict) else "", "claimEvidencePath": claim_path, "resultRegistryPath": registry_path},
    }
    with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, payload in items.items():
            zf.writestr(name, redact_text(json.dumps(payload, ensure_ascii=False, indent=2)))
        events = read_events_since(root, 0, 300)
        zf.writestr("events_tail.json", redact_text(json.dumps(events, ensure_ascii=False, indent=2)))
        zf.writestr("audit_tail.txt", redact_text(read_audit_tail(root, 200)))
        if include_results:
            zf.writestr("result_registry.json", redact_text(json.dumps(read_json(safe_project_path(root, registry_path), {}), ensure_ascii=False, indent=2)))
    rel_bundle = relpath(root, bundle)
    # Keep a latest alias under simple_cluster/debug for unscoped consumers.
    if slug:
        latest_dir = safe_project_path(root, "simple_cluster/debug")
        os.makedirs(latest_dir, exist_ok=True)
        latest = os.path.join(latest_dir, "debug_bundle_latest.zip")
        try:
            import shutil
            shutil.copy2(bundle, latest)
        except Exception:
            latest = ""
    else:
        latest = ""
    return {
        "schemaVersion": 1,
        "bundlePath": rel_bundle,
        "path": rel_bundle,
        "latestPath": relpath(root, latest) if latest else "",
        "bundleDir": rel_dir,
        "size": os.path.getsize(bundle),
        "createdAt": now_iso(),
        "planFile": plan_norm or "",
        "includeResults": bool(include_results),
    }

INACTIVITY_ACTIONS = {}
INACTIVITY_ACTIONS_LOCK = threading.Lock()
INACTIVITY_ACTION_CONTEXT = threading.local()

def cancel_inactivity_action(root, wanted, plan=""):
    with INACTIVITY_ACTIONS_LOCK:
        entry = INACTIVITY_ACTIONS.get((os.path.abspath(root), str(wanted)))
        if not entry or (plan and action_plan_file(entry["payload"]) != plan):
            return False
        entry["cancel"].set()
        processes = list(entry["processes"])
    for process in processes:
        try:
            if hasattr(os, "killpg"):
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except (OSError, ProcessLookupError):
            pass
    return True

def subprocess_file_io(process, proc_root="/proc"):
    # Owned direct child only. rchar includes cached file reads; pipe output/CPU do not count.
    # Linux write_bytes excludes stdout/stderr pipe heartbeats.
    try:
        with open(os.path.join(proc_root, str(int(process.pid)), "io"), "r", encoding="ascii") as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            return None
        values = {}
        for line in raw.splitlines():
            key, separator, value = line.partition(":")
            if separator and key in ("rchar", "write_bytes"):
                number = int(value.strip())
                if number < 0 or number > (1 << 64) - 1 or key in values:
                    return None
                values[key] = number
        if set(values) != {"rchar", "write_bytes"}:
            return None
        return values["rchar"], values["write_bytes"]
    except (OSError, ValueError, TypeError, AttributeError):
        return None

def subprocess_inactivity_run(command, cwd=None, env=None, input=None, file_step=False):
    entry = getattr(INACTIVITY_ACTION_CONTEXT, "entry", None)
    if entry and entry["cancel"].is_set():
        raise RuntimeError("操作已取消")
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", start_new_session=True)
    if entry:
        with INACTIVITY_ACTIONS_LOCK:
            entry["processes"].add(process)
    last_progress = [time.monotonic()]
    progress_lock = threading.Lock()
    counters = {}
    streams = {"stdout": io.StringIO(), "stderr": deque()}
    stream_bytes = {"stdout": 0, "stderr": 0}
    output_overflow = [False]
    last_io = [0, 0]
    io_observable = False
    next_io_sample = 0
    input_bytes = len(str(input).encode("utf-8")) if input is not None else 0
    def consume(name, stream):
        for line in iter(lambda: stream.readline(65536), ""):
            # Drain both pipes even after the output limit; never block the child's writer.
            text = line[-8192:] if name == "stderr" else line
            size = len(text.encode("utf-8"))
            with progress_lock:
                if name == "stdout" and stream_bytes[name] + size > 4 * 1024 * 1024:
                    output_overflow[0] = True
                else:
                    if name == "stdout":
                        streams[name].write(text)
                    else:
                        streams[name].append(text)
                    stream_bytes[name] += size
                    while name == "stderr" and stream_bytes[name] > 32768:
                        stream_bytes[name] -= len(streams[name].popleft().encode("utf-8"))
            if not line.startswith("SIMPLE_PROGRESS "):
                continue
            try:
                item = json.loads(line[len("SIMPLE_PROGRESS "):])
                if not isinstance(item, dict):
                    continue
                phase = str(item.get("phase") or "processing")[:64]
                counts = (int(item.get("processedBytes") or 0), int(item.get("processedFiles") or 0))
                if any(value < 0 or value > (1 << 64) - 1 for value in counts):
                    continue
                with progress_lock:
                    if phase not in counters and len(counters) >= 32:
                        continue
                    previous = counters.get(phase, (0, 0))
                    current = (max(previous[0], counts[0]), max(previous[1], counts[1]))
                    changed = phase not in counters or current != previous
                    counters[phase] = current
                    if changed:
                        last_progress[0] = time.monotonic()
                if changed and entry:
                    progress_action(entry["root"], entry["action"], entry["operationId"], entry["opId"], "running", "处理进展", {
                        "phase": phase, "processedBytes": current[0], "processedFiles": current[1], "lastProgressAt": now_iso()}, request=entry["payload"])
            except (ValueError, TypeError, OverflowError):
                pass
    readers = [threading.Thread(target=consume, args=(name, stream), daemon=True) for name, stream in (("stdout", process.stdout), ("stderr", process.stderr))]
    for reader in readers:
        reader.start()
    if input is not None:
        def send_input():
            try:
                process.stdin.write(input); process.stdin.close()
            except (OSError, BrokenPipeError):
                pass
        threading.Thread(target=send_input, daemon=True).start()
    try:
        while process.poll() is None:
            cancelled = bool(entry and entry["cancel"].is_set())
            observed_at = time.monotonic()
            if file_step and not cancelled and observed_at >= next_io_sample:
                next_io_sample = observed_at + 1
                observed = subprocess_file_io(process)
                io_observable = observed is not None
                if observed is not None:
                    read_bytes = max(0, observed[0] - input_bytes)
                    write_bytes = observed[1]
                    with progress_lock:
                        advanced = read_bytes > last_io[0] or write_bytes > last_io[1]
                        last_io[:] = [max(last_io[0], read_bytes), max(last_io[1], write_bytes)]
                        if advanced:
                            last_progress[0] = observed_at
                            counters["local-file-io"] = (sum(last_io), 0)
                    if advanced and entry:
                        progress_action(entry["root"], entry["action"], entry["operationId"], entry["opId"], "running", "本地文件处理", {
                            "phase": "local-file-io", "processedBytes": sum(last_io), "readBytes": last_io[0],
                            "writeBytes": last_io[1], "lastProgressAt": now_iso()}, request=entry["payload"])
            with progress_lock:
                stalled = time.monotonic() - last_progress[0] >= (120 if file_step else 30)
            if cancelled or stalled:
                try:
                    if hasattr(os, "killpg"):
                        os.killpg(process.pid, signal.SIGTERM)
                    else:
                        process.terminate()
                    process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        if hasattr(os, "killpg"):
                            os.killpg(process.pid, signal.SIGKILL)
                        else:
                            process.kill()
                    except OSError:
                        pass
                if cancelled:
                    raise RuntimeError("操作已取消")
                for reader in readers:
                    reader.join(timeout=1)
                step = str(entry.get("action") if entry else os.path.basename(str(command[0])))
                if not entry and len(command) > 2 and command[1] == "-m":
                    step += " -m " + str(command[2])
                phase = next(reversed(counters), "starting")
                tail = redact_text("".join(streams["stderr"])[-2000:]).strip()
                io_detail = (f"最近读取 {last_io[0]} 字节，写入 {last_io[1]} 字节" if io_observable else "文件 I/O 不可观测") if file_step else "控制请求不使用文件 I/O 续期"
                detail = f"步骤 {step}，阶段 {phase}，{120 if file_step else 30} 秒；{io_detail}"
                raise RuntimeError(f"无真实进展（{detail}），已停止子进程；请检查日志后重试" + ("；子进程日志：" + tail if tail else ""))
            time.sleep(0.05)
        for reader in readers:
            reader.join(timeout=1)
        if entry and entry["cancel"].is_set():
            raise RuntimeError("操作已取消")
        if output_overflow[0]:
            raise RuntimeError("子进程标准输出超过 4 MiB，未采用截断的结果")
        return subprocess.CompletedProcess(command, process.returncode, streams["stdout"].getvalue(), "".join(streams["stderr"]))
    finally:
        if entry:
            with INACTIVITY_ACTIONS_LOCK:
                entry["processes"].discard(process)

def start_inactivity_action(root, action, payload, operation_id, op_id, worker_id=""):
    key = (os.path.abspath(root), str(operation_id))
    with INACTIVITY_ACTIONS_LOCK:
        existing = INACTIVITY_ACTIONS.get(key)
        if existing:
            return existing.get("result") or {"operationId": operation_id, "opId": op_id, "status": "accepted"}
        entry = {"root": root, "action": action, "payload": payload, "operationId": operation_id, "opId": op_id,
                 "cancel": threading.Event(), "processes": set()}
        INACTIVITY_ACTIONS[key] = entry
    def execute():
        release = None
        INACTIVITY_ACTION_CONTEXT.entry = entry
        try:
            if entry["cancel"].is_set():
                raise RuntimeError("操作已取消")
            if worker_id:
                release = acquire_worker_action_slot(root, worker_id, payload)
            progress_action(root, action, operation_id, op_id, "running", "开始处理", {"phase": action}, request=payload)
            entry["result"] = handle_action(root, action, payload, operation_id, op_id)
        except Exception as exc:
            entry["result"] = terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
        finally:
            if release:
                release()
            INACTIVITY_ACTION_CONTEXT.entry = None
            with INACTIVITY_ACTIONS_LOCK:
                completed = [record_key for record_key, value in INACTIVITY_ACTIONS.items() if value.get("result")]
                for record_key in completed[:-200]:
                    INACTIVITY_ACTIONS.pop(record_key, None)
    append_event(root, {"type": "operation_started", "operationId": operation_id, "payload": {"action": action, "opId": op_id, **action_operation_fields(payload)}})
    threading.Thread(target=execute, name="simple-action-" + str(operation_id), daemon=True).start()
    return {"schemaVersion": SCHEMA_VERSION, "operationId": operation_id, "opId": op_id, "status": "accepted", "action": action}

def scheduler_capture(root, scheduler, scheduler_args, timeout=60, env=None):
    runtime_env = simple_runtime_env(os.environ.copy() if env is None else env)
    command = [simple_runtime_python(runtime_env), scheduler, *scheduler_args]
    # health check does not need conda activate - use direct python to avoid CommandNotFoundError in non-interactive shell
    if "--check-dependencies-json" in scheduler_args:
        try:
            return subprocess_inactivity_run(command, cwd=root, env=runtime_env)
        except Exception:
            pass
    result = subprocess_inactivity_run(simple_conda_wrapped_args(command, runtime_env), cwd=root, env=runtime_env)
    # fallback on Broken pipe / CommandNotFoundError (non-interactive shell without conda init)
    if result.returncode != 0 and ("CommandNotFoundError" in (result.stderr or "") or "Broken pipe" in (result.stderr or "") or "Broken pipe" in (result.stdout or "")):
        try:
            return subprocess_inactivity_run(command, cwd=root, env=runtime_env)
        except Exception:
            pass
    return result

def scheduler_dependency_status(root, scheduler, env=None):
    result = scheduler_capture(root, scheduler, ["--check-dependencies-json"], env=env)
    raw = (result.stdout or "").strip()
    try:
        status = json.loads(raw or "{}")
    except Exception:
        detail = (result.stderr or result.stdout or "Scheduler 依赖预检没有返回有效结果").strip()[-1200:]
        return {"ok": False, "message": detail, "missingModules": [], "installCommand": ""}
    if not isinstance(status, dict):
        return {"ok": False, "message": "Scheduler 依赖预检返回格式错误。", "missingModules": [], "installCommand": ""}
    if result.returncode != 0 and status.get("ok") is not False:
        status["ok"] = False
        status["message"] = (result.stderr or result.stdout or "Scheduler 依赖预检失败").strip()[-1200:]
    return status

def scheduler_dependency_health_key(root, scheduler, env):
    interpreter = simple_runtime_python(env)
    def signature(file):
        try:
            info = os.stat(file)
            return [os.path.abspath(file), info.st_size, info.st_mtime_ns]
        except OSError:
            return [os.path.abspath(file), None, None]
    return json.dumps([os.path.abspath(root), signature(scheduler), signature(interpreter),
                       *[str(env.get(name) or "") for name in ("SIMPLE_EXPERIMENT_CONDA_ENV", "SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV", "CONDA_PREFIX", "PYTHONPATH")]], sort_keys=True)

def scheduler_dependency_health(root, max_age_seconds=30):
    scheduler = cluster_scheduler_path(root)
    if not scheduler:
        return {"ok": False, "missingRuntime": True, "missingModules": [], "installCommand": "", "message": "缺少 cluster_scheduler.py，请先部署最新版 Agent。", "checkedAt": now_iso()}
    env = simple_runtime_env(os.environ.copy())
    try:
        key = scheduler_dependency_health_key(root, scheduler, env)
    except Exception as exc:
        return {"ok": False, "missingModules": [], "installCommand": "", "message": str(exc), "checkedAt": now_iso()}
    checked_at = time.time()
    marker = None
    with SCHEDULER_DEPENDENCY_CACHE_LOCK:
        prune_scheduler_dependency_cache(checked_at, key)
        cached = SCHEDULER_DEPENDENCY_CACHE.get(key)
        if isinstance(cached, dict) and checked_at - float(cached.get("_checkedAtEpoch") or 0) < max(1, int(max_age_seconds or 30)):
            return {k: v for k, v in cached.items() if not str(k).startswith("_")}
        if key not in SCHEDULER_DEPENDENCY_IN_FLIGHT and len(SCHEDULER_DEPENDENCY_IN_FLIGHT) < MAX_SCHEDULER_DEPENDENCY_CACHE_RECORDS:
            marker = object()
            SCHEDULER_DEPENDENCY_IN_FLIGHT[key] = marker
    def refresh():
        try:
            try:
                status = scheduler_dependency_status(root, scheduler, env)
            except Exception as exc:
                status = {"ok": False, "missingModules": [], "installCommand": "", "message": str(exc)}
            status = {**status, "checkedAt": now_iso(), "schedulerPath": relpath(root, scheduler) if os.path.abspath(scheduler).startswith(os.path.abspath(root) + os.sep) else scheduler}
            with SCHEDULER_DEPENDENCY_CACHE_LOCK:
                SCHEDULER_DEPENDENCY_CACHE[key] = {**status, "_checkedAtEpoch": time.time()}
                prune_scheduler_dependency_cache(time.time(), key)
        finally:
            with SCHEDULER_DEPENDENCY_CACHE_LOCK:
                if SCHEDULER_DEPENDENCY_IN_FLIGHT.get(key) is marker:
                    SCHEDULER_DEPENDENCY_IN_FLIGHT.pop(key, None)
    if marker is not None:
        try:
            threading.Thread(target=refresh, name="scheduler-dependency-health", daemon=True).start()
        except Exception:
            with SCHEDULER_DEPENDENCY_CACHE_LOCK:
                SCHEDULER_DEPENDENCY_IN_FLIGHT.pop(key, None)
    # Health never waits for an interpreter/subprocess. Pending is not successful readiness.
    return {**({k: v for k, v in cached.items() if not str(k).startswith("_")} if isinstance(cached, dict) else {"ok": None, "missingModules": [], "installCommand": ""}),
            "pending": True, "message": "Scheduler 依赖正在后台检查，请稍后刷新状态。"}

def require_scheduler_dependencies(root, scheduler, env=None):
    status = scheduler_dependency_status(root, scheduler, env)
    if not status.get("ok"):
        raise RuntimeError(str(status.get("message") or "Scheduler 依赖缺失，请检查当前 Python 环境。"))
    return status

def plan_structural_validation_key(root, scheduler, plan, default_result_csv_dir, options=None, env=None):
    options = options if isinstance(options, dict) else {}
    request_key = str(options.get("structuralValidationKey") or "")
    identity = options.get("validationCodeProof")
    if not re.fullmatch(r"[a-f0-9]{64}", request_key) or not isinstance(identity, dict):
        return ""
    try:
        proof_id = str(identity.get("codeSyncProofId") or "")
        proof = code_sync_proof_document(root).get("proofs", {}).get(proof_id)
        verify_code_sync_proof_record(root, proof, identity)
        relative_plan = os.path.relpath(safe_project_path(root, plan), os.path.abspath(root)).replace(os.sep, "/")
        if relative_plan not in {str(item.get("path") or "") for item in proof["files"]}:
            return ""
        runtime_env = simple_runtime_env(os.environ.copy() if env is None else env)
        python = simple_runtime_python(runtime_env)
        executable_stats = []
        for executable in (scheduler, python):
            current = os.stat(executable)
            executable_stats.append([os.path.realpath(executable), int(current.st_size),
                int(getattr(current, "st_mtime_ns", current.st_mtime * 1_000_000_000))])
        # No TTL: content/proof, execution options, runtime and environment select the generation.
        identity_parts = [os.path.realpath(root), os.path.realpath(scheduler), relative_plan,
                          default_result_csv_dir, request_key, proof_id, code_sync_proof_runtime_generation(),
                          executable_stats, sorted(runtime_env.items())]
        return hashlib.sha256(json.dumps(identity_parts, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    except (OSError, ValueError, TypeError, KeyError):
        return ""  # Missing/stale proof falls back to the complete validation, never an assumed success.

def plan_preflight_project_path(root, value):
    if not str(value or "").strip():
        raise ValueError("empty preflight path")
    real_root = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root, str(value)))
    if target == real_root or os.path.commonpath([real_root, target]) != real_root:
        raise ValueError("preflight path outside project")
    return target

def plan_validation_with_current_outputs(root, structural):
    validation = json.loads(json.dumps(structural))
    existing = []
    for job in validation.get("jobs") or []:
        for relative in job.get("inputs") or []:
            if not os.path.exists(plan_preflight_project_path(root, relative)):
                raise ValueError("声明的输入不存在：" + str(relative))
        output_dir = str(job.get("output_dir") or "").strip()
        output_path = plan_preflight_project_path(root, output_dir)
        info = has_existing_artifacts(output_path)
        if info["exists"]:
            existing.append({"index": job["index"], "case": job.get("case"), "seed": job.get("seed"),
                             "output_dir": output_dir, "markers": info["markers"], "totalFiles": info["totalFiles"]})
    validation.update({"existing": existing, "existingCount": len(existing), "structuralValidationReused": True})
    return validation

def plan_validation_cache_covers_inputs(root, validation, options):
    if not isinstance(validation.get("structuralInputPaths"), list) or not validation["structuralInputPaths"]:
        return False
    identity = options.get("validationCodeProof") if isinstance(options, dict) else {}
    proof = code_sync_proof_document(root).get("proofs", {}).get(str((identity or {}).get("codeSyncProofId") or "")) or {}
    covered = {str(item.get("path") or "") for item in proof.get("files") or []}
    required = list(validation["structuralInputPaths"])
    for row in (validation.get("outputInterface") or {}).get("rows") or []:
        required.extend(row.get("sourceFiles") or [])
        for channel in row.get("channels") or []:
            if channel.get("type") == "run_wrapper":
                required.append(channel.get("path") or "")
    try:
        return all(os.path.relpath(plan_preflight_project_path(root, value), os.path.abspath(root)).replace(os.sep, "/") in covered
                   for value in required)
    except (OSError, ValueError, TypeError):
        return False

def cached_scheduler_validation(root, scheduler, plan, default_result_csv_dir="experiments/results", options=None, env=None):
    key = plan_structural_validation_key(root, scheduler, plan, default_result_csv_dir, options, env)
    if not key:
        return None
    with PLAN_STRUCTURAL_VALIDATION_CACHE_LOCK:
        structural = PLAN_STRUCTURAL_VALIDATION_CACHE.pop(key, None)
        if structural is None:
            return None
        PLAN_STRUCTURAL_VALIDATION_CACHE[key] = structural
    validation = plan_validation_with_current_outputs(root, structural)
    if key != plan_structural_validation_key(root, scheduler, plan, default_result_csv_dir, options, env):
        return None
    return validation

def scheduler_validate_json(root, scheduler, plan, default_result_csv_dir="experiments/results", env=None, options=None):
    cached = cached_scheduler_validation(root, scheduler, plan, default_result_csv_dir, options, env)
    if cached is not None:
        return cached
    base_key = plan_structural_validation_key(root, scheduler, plan, default_result_csv_dir, options, env)
    require_scheduler_dependencies(root, scheduler, env)
    result = scheduler_capture(root, scheduler, ["--validate-plan", "--plan", plan, "--default-result-csv-dir", default_result_csv_dir], env=env)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "计划校验失败").strip()[-1000:])
    try:
        validation = json.loads((result.stdout or "{}").strip())
    except Exception:
        return {"ok": True, "plan": plan, "jobs": [], "raw": result.stdout}
    key = plan_structural_validation_key(root, scheduler, plan, default_result_csv_dir, options, env)
    if (key and key == base_key and validation.get("ok") is True and validation.get("jobs")
            and plan_validation_cache_covers_inputs(root, validation, options)):
        structural = {k: v for k, v in validation.items() if k not in ("existing", "existingCount", "structuralValidationReused")}
        with PLAN_STRUCTURAL_VALIDATION_CACHE_LOCK:
            PLAN_STRUCTURAL_VALIDATION_CACHE.pop(key, None)
            PLAN_STRUCTURAL_VALIDATION_CACHE[key] = structural
            while len(PLAN_STRUCTURAL_VALIDATION_CACHE) > 32:
                PLAN_STRUCTURAL_VALIDATION_CACHE.pop(next(iter(PLAN_STRUCTURAL_VALIDATION_CACHE)))
    return validation

def dry_run_preview_action(root, plan, workers, assigned_indices=None, default_result_csv_dir="experiments/results", operation_id=""):
    scheduler = cluster_scheduler_path(root)
    if not scheduler:
        raise RuntimeError("Hub 上缺少 cluster_scheduler.py，请先部署最新版 Agent。")
    require_scheduler_dependencies(root, scheduler)
    owner = str(operation_id or "").strip()
    if not owner:
        raise ValueError("Dry-run 缺少稳定 operationId，拒绝创建无归属暂存文件。")
    owner_key = hashlib.sha256(owner.encode("utf-8")).hexdigest()[:24]
    workers_path = state_child_path(root, "actions", f"dry-run-workers-{owner_key}.json")
    atomic_write(workers_path, workers if isinstance(workers, list) else [])
    scheduler_args = [
        "--dry-run-plan",
        "--plan", plan,
        "--workers-json", workers_path,
        "--availability-path", availability_cache_path(root),
        "--worker-status-ttl-seconds", "180",
        "--agent-state-dir", agent_dir(root),
        "--default-result-csv-dir", default_result_csv_dir,
    ]
    indices = normalized_experiment_indices(assigned_indices)
    if indices:
        scheduler_args.extend(["--only-indices", ",".join(str(index) for index in indices)])
    result = scheduler_capture(root, scheduler, scheduler_args)
    text = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        raise RuntimeError(text[-1200:] or "Dry-run 预演失败")
    preview = json.loads(text or "{}")
    preview["dispatchableCount"] = int(preview.get("assignableNow") or preview.get("dispatchableCount") or 0)
    preview["queuedCount"] = int(preview.get("queued") if isinstance(preview.get("queued"), int) else preview.get("queuedCount") or 0)
    return preview


def cleanup_dry_run_worker_temp_files(root, max_age_seconds=24 * 60 * 60):
    # 自动删除不能提供完整路径的双重确认。旧 dry-run 文件由缓存审核入口统一处理。
    return {"removedCount": 0, "removed": []}

def selected_worker_id(payload):
    worker_id = action_payload_text(payload, "workerId")
    options = action_options(payload)
    if not worker_id:
        ids = payload.get("selectedWorkerIds") or options.get("selectedWorkerIds")
        if isinstance(ids, list) and ids:
            worker_id = str(ids[0] or "").strip()
    if not worker_id:
        workers = options.get("workers")
        if isinstance(workers, list) and workers:
            worker_id = str((workers[0] or {}).get("id") or (workers[0] or {}).get("worker_id") or "").strip()
    return worker_id

def acquire_worker_action_slot(root, worker_id, payload):
    worker_id = str(worker_id or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
    key = worker_id
    # Retain accounting, but never sleep or reject unrelated control requests.
    # Action identity and exact-target validation remain in the action handlers.
    with WORKER_ACTION_LOCK:
        WORKER_ACTION_INFLIGHT[key] = int(WORKER_ACTION_INFLIGHT.get(key) or 0) + 1
        WORKER_ACTION_LAST_AT[key] = int(time.time() * 1000)
        prune_runtime_memory_state()
    released = False
    def release():
        nonlocal released
        with WORKER_ACTION_LOCK:
            if released:
                return
            released = True
            current = int(WORKER_ACTION_INFLIGHT.get(key) or 0)
            if current <= 1:
                WORKER_ACTION_INFLIGHT.pop(key, None)
            else:
                WORKER_ACTION_INFLIGHT[key] = current - 1
            WORKER_ACTION_LAST_AT[key] = int(time.time() * 1000)
            prune_runtime_memory_state()
    return release

def action_target_keys(payload):
    return action_values(payload, "selectedArchiveKeys", "selectedRunKeys", "selectedExperimentIds", "archiveKey", "runKey", "experimentId", "remotePath", "path")

def action_delete_target_paths(payload):
    body = payload if isinstance(payload, dict) else {}
    options = action_options(body)
    keys = ("confirmationPath", "confirmationPaths", "path", "artifactPath", "resultPath", "outputDir", "logPath")
    out = action_values(body, *keys)
    for source in (body, options):
        targets = source.get("selectedTaskTargets") if isinstance(source, dict) else None
        if not isinstance(targets, list):
            continue
        for target in targets:
            if not isinstance(target, dict):
                continue
            for key in ("confirmationPath", "confirmation_path", "remotePath", "remote_path", "path", "artifactPath", "artifact_path", "resultPath", "result_path", "outputDir", "output_dir", "logPath", "log_path"):
                value = str(target.get(key) or "").strip()
                if value and value != "-":
                    out.append(value)
    return list(dict.fromkeys(out))

def action_operation_fields(payload):
    body = payload if isinstance(payload, dict) else {}
    options = body.get("options") if isinstance(body.get("options"), dict) else {}
    plan_file = action_plan_file(body)
    selected_plan_id = str(body.get("selectedPlanId") or options.get("selectedPlanId") or plan_file or "").strip()
    plan_revision = str(body.get("planRevision") or body.get("plan_revision") or options.get("planRevision") or options.get("plan_revision") or "").strip()
    topology_mode = str(body.get("topologyMode") or options.get("topologyMode") or "").strip()
    worker_pool_dispatch_policy = str(body.get("workerPoolDispatchPolicy") or options.get("workerPoolDispatchPolicy") or "").strip()
    worker_set_revision = str(body.get("workerSetRevision") or options.get("workerSetRevision") or "").strip()
    scheduler_owner_worker_id = str(body.get("schedulerOwnerWorkerId") or options.get("schedulerOwnerWorkerId") or "").strip()
    result_owner_worker_id = str(body.get("resultOwnerWorkerId") or options.get("resultOwnerWorkerId") or scheduler_owner_worker_id).strip()
    assigned_experiment_indices = normalized_experiment_indices(body.get("assignedExperimentIndices") or options.get("assignedExperimentIndices") or [])
    git_provenance = body.get("gitProvenance") or body.get("git_provenance") or options.get("gitProvenance") or options.get("git_provenance")
    return {
        **({"planFile": plan_file} if plan_file else {}),
        **({"selectedPlanId": selected_plan_id} if selected_plan_id else {}),
        **({"planRevision": plan_revision} if plan_revision else {}),
        **({"topologyMode": topology_mode} if topology_mode else {}),
        **({"workerPoolDispatchPolicy": worker_pool_dispatch_policy} if worker_pool_dispatch_policy else {}),
        **({"workerSetRevision": worker_set_revision} if worker_set_revision else {}),
        **({"schedulerOwnerWorkerId": scheduler_owner_worker_id, "workerId": scheduler_owner_worker_id} if scheduler_owner_worker_id else {}),
        **({"resultOwnerWorkerId": result_owner_worker_id, "workerId": result_owner_worker_id} if result_owner_worker_id else {}),
        **({"assignedExperimentIndices": assigned_experiment_indices} if assigned_experiment_indices else {}),
        "debugMode": action_debug_mode(body),
        **({"gitProvenance": git_provenance} if isinstance(git_provenance, dict) else {}),
        **({"debugRunId": action_debug_run_id(body)} if action_debug_run_id(body) else {}),
    }

def normalized_experiment_indices(values):
    if not isinstance(values, list):
        return []
    out = set()
    for value in values:
        try:
            index = int(value)
        except Exception:
            continue
        if index >= 0:
            out.add(index)
    return sorted(out)

def action_event_fields(extra=None, request=None):
    fields = action_operation_fields(request)
    if isinstance(extra, dict):
        fields.update(extra)
    return fields

def terminal_action(root, action, operation_id, op_id, status, message, extra=None, request=None):
    entry = getattr(INACTIVITY_ACTION_CONTEXT, "entry", None)
    if entry and entry["cancel"].is_set():
        status, message = "cancelled", "操作已取消；晚到完成回执已忽略"
    event_type = "operation_cancelled" if status == "cancelled" else "operation_completed" if status == "completed" else "operation_failed"
    body = {"action": action, "opId": op_id, "status": status, "message": message}
    details = action_event_fields(extra, request)
    body.update(details)
    append_event(root, {"type": event_type, "operationId": operation_id, "payload": body})
    return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "operationId": operation_id, "action": action, "status": status, "message": message, **details}

def progress_action(root, action, operation_id, op_id, status, message, extra=None, request=None):
    entry = getattr(INACTIVITY_ACTION_CONTEXT, "entry", None)
    if entry and entry["cancel"].is_set():
        return {"operationId": operation_id, "opId": op_id, "status": "cancelled", "message": "操作已取消"}
    body = {"action": action, "opId": op_id, "status": status, "message": message}
    details = action_event_fields(extra, request)
    body.update(details)
    append_event(root, {"type": "operation_progress", "operationId": operation_id, "payload": body})
    return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "operationId": operation_id, "action": action, "status": status, "message": message, **details}

def tb_tmux_session_name(prefix):
    # Mirror the extension-side normalizeRemoteTmuxSessionPrefix so the session name is
    # derived from configuration and never hardcoded; prefix 优先显式传入，否则走 _resolve
    raw = str(prefix).strip() if prefix and str(prefix).strip() else _resolve_tmux_prefix(None, None, None)
    p = re.sub(r"[^a-z0-9._-]+", "-", str(raw).strip().lower()).strip("-")[:32]
    if not p or not re.match(r"^[a-z0-9]", p):
        p = "simple"
    return p + "_tb"


def tb_port_listening(port, timeout=2):
    # Cheap server-side check: first ss(1), then a direct HTTP probe to 127.0.0.1.
    try:
        out = subprocess.run(["ss", "-ltn"], text=True, capture_output=True, timeout=3).stdout or ""
        if re.search(r":" + str(int(port)) + r"\b", out):
            return True
    except Exception:
        pass
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:%d/" % int(port), timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def tb_find_events_dir(root, max_depth=5):
    # Bounded search for a TensorBoard event file so we can auto-point tensorboard at the right
    # logdir without any user-supplied path. Projects change; this stays correct as long as the
    # SummaryWriter output is under the project tree.
    skip = {".git", "node_modules", ".venv", "venv", "__pycache__", ".idea", ".vscode", "simple_cluster"}
    stack = [(os.path.abspath(root), 0)]
    while stack:
        cur, depth = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except Exception:
            continue
        has_events = False
        subdirs = []
        for e in entries:
            try:
                if e.is_file() and e.name.startswith("events.out.tfevents."):
                    has_events = True
                elif e.is_dir() and e.name not in skip:
                    subdirs.append(e.path)
            except Exception:
                continue
        if has_events:
            return cur
        if depth < max_depth:
            stack.extend((d, depth + 1) for d in subdirs)
    return None


TENSORBOARD_BROWSER_PREFIX = "/api/tensorboard/ui"

# Scalar reader belongs to the Agent runtime, not to the project's TensorBoard
# installation. Only the two documented scalar encodings are accepted.
SCALAR_FILE_CACHE = {}
SCALAR_CATALOG_CACHE = {}
SCALAR_CACHE_LOCK = threading.RLock()

def scalar_child(root, relative):
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, str(relative)))
    if os.path.commonpath((base, target)) != base or target == base:
        raise ValueError("scalar path escapes project root")
    return target

def scalar_fields(data):
    pos = 0
    while pos < len(data):
        key, pos = scalar_varint(data, pos)
        field, wire = key >> 3, key & 7
        if field == 0:
            raise ValueError("invalid protobuf field")
        if wire == 0:
            value, pos = scalar_varint(data, pos)
        elif wire == 1:
            value = data[pos:pos + 8]
            pos += 8
        elif wire == 2:
            size, pos = scalar_varint(data, pos)
            if size > len(data) - pos:
                raise ValueError("truncated protobuf field")
            value = data[pos:pos + size]
            pos += size
        elif wire == 5:
            value = data[pos:pos + 4]
            pos += 4
        else:
            raise ValueError("unsupported protobuf wire type")
        if pos > len(data):
            raise ValueError("truncated protobuf field")
        yield field, wire, value

def scalar_varint(data, pos):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise ValueError("truncated protobuf varint")
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, pos
    raise ValueError("protobuf varint too long")

def scalar_tensor(data):
    dtype, content, number, shape = 0, b"", None, []
    for field, wire, value in scalar_fields(data):
        if field == 1 and wire == 0:
            dtype = value
        elif field == 2 and wire == 2:
            for shape_field, shape_wire, dimension in scalar_fields(value):
                if shape_field == 2 and shape_wire == 2:
                    for dim_field, dim_wire, size in scalar_fields(dimension):
                        if dim_field == 1 and dim_wire == 0:
                            shape.append(size)
        elif field == 4 and wire == 2:
            content = value
        elif field == 5 and wire == 5 and number is None:
            number = struct.unpack("<f", value)[0]
        elif field == 5 and wire == 2 and len(value) >= 4 and number is None:
            number = struct.unpack("<f", value[:4])[0]
        elif field == 6 and wire == 1 and number is None:
            number = struct.unpack("<d", value)[0]
        elif field == 6 and wire == 2 and len(value) >= 8 and number is None:
            number = struct.unpack("<d", value[:8])[0]
        elif field in (7, 10) and wire == 0 and number is None:
            number = int(value)
        elif field in (7, 10) and wire == 2 and number is None:
            number, _ = scalar_varint(value, 0)
    if any(size != 1 for size in shape):
        return None
    if content:
        if dtype == 1 and len(content) >= 4:
            number = struct.unpack("<f", content[:4])[0]
        elif dtype == 2 and len(content) >= 8:
            number = struct.unpack("<d", content[:8])[0]
        elif dtype == 3 and len(content) >= 4:
            number = struct.unpack("<i", content[:4])[0]
        elif dtype == 9 and len(content) >= 8:
            number = struct.unpack("<q", content[:8])[0]
    return float(number) if number is not None and math.isfinite(float(number)) else None

def scalar_event(data):
    step, summaries = 0, []
    for field, wire, value in scalar_fields(data):
        if field == 2 and wire == 0:
            step = int(value)
        elif field == 5 and wire == 2:
            summaries.append(value)
    out = []
    for summary in summaries:
        for field, wire, value in scalar_fields(summary):
            if field != 1 or wire != 2:
                continue
            tag, number = "", None
            for item_field, item_wire, item in scalar_fields(value):
                if item_field == 1 and item_wire == 2:
                    tag = item.decode("utf-8", errors="replace")
                elif item_field == 2 and item_wire == 5:
                    number = struct.unpack("<f", item)[0]
                elif item_field == 8 and item_wire == 2:
                    number = scalar_tensor(item)
            if tag and number is not None and math.isfinite(number):
                out.append((tag, step, number))
    return out

def scalar_crc32c(data):
    crc = 0xffffffff
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82f63b78 if crc & 1 else 0)
    return (~crc) & 0xffffffff

def scalar_masked_crc(data):
    crc = scalar_crc32c(data)
    return (((crc >> 15) | (crc << 17)) + 0xa282ead8) & 0xffffffff

def scalar_file_points(file_path):
    stat = os.stat(file_path)
    with SCALAR_CACHE_LOCK:
        entry = SCALAR_FILE_CACHE.get(file_path)
        identity = (stat.st_dev, stat.st_ino)
        if entry is None or entry["identity"] != identity or stat.st_size < entry["offset"] or (stat.st_size == entry["size"] and stat.st_mtime_ns != entry["mtime"]):
            entry = {"identity": identity, "offset": 0, "size": 0, "mtime": 0, "points": {}, "unsupported": False, "prefix": b""}
        with open(file_path, "rb") as stream:
            prefix = entry.get("prefix", b"")
            if prefix and stream.read(len(prefix)) != prefix:
                entry = {"identity": identity, "offset": 0, "size": 0, "mtime": 0, "points": {}, "unsupported": False, "prefix": b""}
            stream.seek(entry["offset"])
            start_offset = stream.tell()
            while stream.tell() + 16 <= stat.st_size and stream.tell() - start_offset < 16 * 1024 * 1024:
                start = stream.tell()
                header = stream.read(12)
                length = struct.unpack("<Q", header[:8])[0]
                if length > 16 * 1024 * 1024:
                    entry["unsupported"] = True
                    break
                if start + 16 + length > stat.st_size:
                    break  # writer has not finished this record
                data = stream.read(length)
                checksum = stream.read(4)
                if scalar_masked_crc(header[:8]) != struct.unpack("<I", header[8:])[0] or scalar_masked_crc(data) != struct.unpack("<I", checksum)[0]:
                    entry["unsupported"] = True
                    break
                try:
                    for tag, step, value in scalar_event(data):
                        entry["points"].setdefault(tag, {})[step] = value
                except ValueError:
                    entry["unsupported"] = True
                    break
                entry["offset"] = stream.tell()
            stream.seek(0)
            entry["prefix"] = stream.read(min(4096, stat.st_size))
        for tag, points in list(entry["points"].items()):
            if len(points) > 20000:
                entry["points"][tag] = dict(sorted(points.items())[-20000:])
        entry["size"], entry["mtime"] = stat.st_size, stat.st_mtime_ns
        SCALAR_FILE_CACHE[file_path] = entry
        if len(SCALAR_FILE_CACHE) > 64:
            for old in list(SCALAR_FILE_CACHE)[:16]:
                SCALAR_FILE_CACHE.pop(old, None)
        return entry

def scalar_scheduler_module():
    file_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), "cluster_scheduler.py")
    spec = importlib.util.spec_from_file_location("simple_scalar_scheduler", file_path)
    if spec is None or spec.loader is None:
        raise ValueError("scheduler runtime unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

def scalar_catalog(root, logdir="work_dirs"):
    if pathlib.Path(logdir).is_absolute():
        raise ValueError("scalar logdir must be project-relative")
    log_root = scalar_child(root, logdir)
    plan_dir = scalar_child(root, "experiments/plans")
    plan_files = sorted(pathlib.Path(plan_dir).rglob("*.yaml"))[:500] if os.path.isdir(plan_dir) else []
    signature = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in plan_files)
    with SCALAR_CACHE_LOCK:
        cached = SCALAR_CATALOG_CACHE.get((root, logdir))
        if cached and cached[0] == signature and time.time() - cached[1] < 15:
            return cached[2]
    try:
        scheduler = scalar_scheduler_module()
        # build_jobs computes output_dir before reading model configs. Catalog needs
        # only its Plan naming metadata, so skip config I/O and avoid changing cwd.
        scheduler.load_config = lambda path, inheritance_stack=(): {}
    except Exception:
        scheduler = None
    plans, known = [], set()
    for plan_path in plan_files:
        try:
            if scheduler is None:
                continue
            relative = plan_path.relative_to(root).as_posix()
            plan = scheduler.load_plan(plan_path)
            jobs = scheduler.jobs_for_args(plan, argparse.Namespace())
            cases = {}
            for job in jobs:
                output = str(job.output_dir).replace("\\", "/").strip("/")
                event_root = scalar_child(root, output + "/tb_logs")
                if os.path.commonpath((log_root, event_root)) != log_root:
                    continue
                known.add(output + "/tb_logs")
                cases.setdefault(str(job.case), []).append({"seed": str(job.seed), "outputDir": output})
            if cases:
                plans.append({"planFile": relative, "suite": str(plan.get("suite") or plan_path.stem), "cases": [{"case": name, "expectedSeeds": len({item["seed"] for item in outputs}), "outputs": outputs} for name, outputs in cases.items()]})
        except Exception:
            continue
    unassigned = {}
    visited = 0
    for directory in (logdir,):
        base = scalar_child(root, directory)
        if not os.path.isdir(base):
            continue
        for current, dirs, files in os.walk(base, followlinks=False):
            visited += 1
            dirs[:] = [name for name in dirs if not name.startswith(".") and not os.path.islink(os.path.join(current, name)) and len(pathlib.Path(current).relative_to(base).parts) < 6]
            if visited > 5000:
                break
            if not any(name.startswith("events.out.tfevents.") for name in files):
                continue
            relative = pathlib.Path(current).relative_to(root).as_posix()
            if relative in known:
                continue
            parent = pathlib.Path(current).parent
            run = parent if pathlib.Path(current).name == "tb_logs" else pathlib.Path(current)
            # A case-level tb_logs written by project mean scripts is already aggregated.
            # It must never become an additional seed in this viewer.
            if run != pathlib.Path(current) and not re.search(r"(?:^|[_-])seed[_-]?\d+$", run.name, re.I):
                try:
                    if any(re.search(r"(?:^|[_-])seed[_-]?\d+$", child.name, re.I) for child in run.iterdir() if child.is_dir()):
                        continue
                except OSError:
                    pass
            match = re.search(r"(?:^|[_-])seed[_-]?(\d+)$", run.name, re.I)
            seed = match.group(1) if match else ""
            case = (run.parent / re.sub(r"[_-]?seed[_-]?\d+$", "", run.name, flags=re.I)).relative_to(root).as_posix() if seed else run.relative_to(root).as_posix()
            unassigned.setdefault(case, []).append({"seed": seed, "outputDir": run.relative_to(root).as_posix(), "eventDir": relative})
    if unassigned:
        plans.append({"planFile": "__unassigned__", "suite": "未归属", "cases": [{"case": name, "expectedSeeds": 0, "outputs": outputs} for name, outputs in sorted(unassigned.items())]})
    result = {"schemaVersion": 1, "plans": plans, "truncated": visited > 5000 or len(plan_files) == 500}
    with SCALAR_CACHE_LOCK:
        SCALAR_CATALOG_CACHE[(root, logdir)] = (signature, time.time(), result)
    return result

def scalar_query(root, payload):
    if isinstance(payload.get("groups"), list):
        groups = []
        for group in payload["groups"][:20]:
            if not isinstance(group, dict):
                continue
            query = {"planFile": group.get("planFile"), "case": group.get("case"), "tag": payload.get("tag"), "tags": payload.get("tags"), "logdir": payload.get("logdir")}
            groups.append({"planFile": query["planFile"], "case": query["case"], **scalar_query(root, query)})
        return {"schemaVersion": 1, "groups": groups}
    plan_file = str(payload.get("planFile") or "")
    case_name = str(payload.get("case") or "")
    tag_filter = str(payload.get("tag") or "")
    tag_values = payload.get("tags") if isinstance(payload.get("tags"), list) else []
    tag_filters = list(dict.fromkeys(str(tag) for tag in tag_values if isinstance(tag, str) and tag))[:32]
    if tag_filter and tag_filter not in tag_filters:
        tag_filters.append(tag_filter)
    catalog = scalar_catalog(root, str(payload.get("logdir") or "work_dirs"))
    group = next((case for plan in catalog["plans"] if plan["planFile"] == plan_file for case in plan["cases"] if case["case"] == case_name), None)
    if group is None:
        return {"schemaVersion": 1, "tags": [], "series": [], "seriesByTag": {}, "unsupportedFiles": [], "expectedSeeds": 0}
    series_by_tag, tags, unsupported = {tag: [] for tag in tag_filters}, set(), []
    for output in group["outputs"]:
        event_dir = scalar_child(root, output.get("eventDir") or (output["outputDir"] + "/tb_logs"))
        if not os.path.isdir(event_dir):
            continue
        merged = {}
        files = sorted((p for p in pathlib.Path(event_dir).glob("events.out.tfevents.*") if p.is_file() and not p.is_symlink()), key=lambda p: (p.stat().st_mtime_ns, p.name))
        updated = 0
        # A fresh event file is a new run for this seed. Never blend unique
        # steps left in an older file with the replacement run.
        for file_path in files[-1:]:
            entry = scalar_file_points(str(file_path))
            if entry["unsupported"]:
                unsupported.append(file_path.name)
            updated = max(updated, entry["mtime"])
            for name, points in entry["points"].items():
                merged.setdefault(name, {}).update(points)
        tags.update(merged)
        for tag in tag_filters:
            if tag in merged:
                series_by_tag[tag].append({"seed": output["seed"], "updatedAt": updated, "points": [[step, value] for step, value in sorted(merged[tag].items())][-20000:]})
    return {"schemaVersion": 1, "tags": sorted(tags), "series": series_by_tag.get(tag_filter, []), "seriesByTag": series_by_tag, "unsupportedFiles": unsupported[:10], "expectedSeeds": group["expectedSeeds"]}


def tb_discover_launch(root, logdir_hint, port, explicit_script):
    # Adaptive launcher owned by the agent (ships with the runtime, not a user setting):
    #   1) explicit override if provided (relative to root or absolute),
    #   2) project-local start_tb.sh discovered relative to the project root,
    #   3) fallback: launch 'tensorboard' directly against the discovered/declared logdir.
    if explicit_script:
        try:
            script = explicit_script if os.path.isabs(explicit_script) else safe_project_path(root, explicit_script)
            if os.path.isfile(script):
                if TENSORBOARD_BROWSER_PREFIX not in pathlib.Path(script).read_text(encoding="utf-8", errors="replace"):
                    raise RuntimeError(f"TensorBoard 脚本需设置 --path_prefix {TENSORBOARD_BROWSER_PREFIX}: {script}")
                return ["bash", script], script, None
        except RuntimeError:
            raise
        except Exception:
            pass
    for rel in ("tmp/start_tb.sh", "start_tb.sh", "scripts/start_tb.sh", "simple_cluster/tmp/start_tb.sh"):
        try:
            script = safe_project_path(root, rel)
            if os.path.isfile(script) and TENSORBOARD_BROWSER_PREFIX in pathlib.Path(script).read_text(encoding="utf-8", errors="replace"):
                return ["bash", script], script, None
        except Exception:
            pass
    hint = (logdir_hint or "work_dirs").strip() or "work_dirs"
    try:
        hint_path = hint if os.path.isabs(hint) else safe_project_path(root, hint)
    except Exception:
        hint_path = ""
    if hint_path and os.path.isdir(hint_path):
        return ["tensorboard", "--logdir", hint_path, "--port", str(port), "--host", "127.0.0.1", "--path_prefix", TENSORBOARD_BROWSER_PREFIX, "--load_fast=false"], "tensorboard", hint_path
    events_dir = tb_find_events_dir(root)
    logdir = events_dir or root
    return ["tensorboard", "--logdir", logdir, "--port", str(port), "--host", "127.0.0.1", "--path_prefix", TENSORBOARD_BROWSER_PREFIX, "--load_fast=false"], "tensorboard", logdir


def tensorboard_action(root, action, payload, operation_id, op_id):
    # Restart (or report status of) the standalone TensorBoard tmux session. The launch command is
    # discovered adaptively by the agent (see tb_discover_launch) so it survives project changes and
    # needs no server-specific path in settings. Session named <prefix>_tb; it is NOT managed by the
    # agent control loop. Each open kills the old session and recreates a fresh one (low cost).
    prefix = str(payload.get("sessionPrefix") or payload.get("session_prefix")
                or _resolve_tmux_prefix(None, None, None))
    # 统一归一：不再信任 payload tmuxSession 原值（避免 ZLK_tb 与 zlk_tb 快照不一致），与 write_snapshots 完全一致
    tb_session = tb_tmux_session_name(prefix)
    port = int(payload.get("port") or 6006)
    logdir_hint = str(payload.get("logdir") or "work_dirs").strip() or "work_dirs"
    explicit_script = str(payload.get("startTbScript") or payload.get("startTb") or "").strip()
    conda_env = str(payload.get("condaEnv") or payload.get("conda_env") or "").strip()
    log_rel = f"simple_cluster/tmux_logs/{tb_session}.log"
    log_path = safe_project_path(root, log_rel)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    if action == "get-tensorboard-status":
        alive = tmux_session_alive(tb_session, root, None)
        listening = tb_port_listening(port) if alive else False
        if listening:
            TENSORBOARD_PROXY_PORTS[tb_session] = port
        else:
            TENSORBOARD_PROXY_PORTS.pop(tb_session, None)
        return terminal_action(
            root, action, operation_id, op_id, "completed",
            ("运行中" if listening else ("会话存在但未监听端口" if alive else "未运行")),
            {"tmuxSession": tb_session, "port": port, "running": alive, "listening": listening, "logPath": log_rel},
        )

    if action == "stop-tensorboard":
        TENSORBOARD_PROXY_PORTS.pop(tb_session, None)
        if tmux_session_alive(tb_session, root, None):
            stopped = subprocess.run(["tmux", "kill-session", "-t", tb_session], cwd=root,
                                     capture_output=True, text=True, timeout=5)
            if stopped.returncode != 0:
                return terminal_action(root, action, operation_id, op_id, "failed",
                                       f"关闭 TensorBoard 会话失败：{stopped.stderr.strip()}",
                                       {"tmuxSession": tb_session, "running": True, "listening": False})
        return terminal_action(root, action, operation_id, op_id, "completed",
                               f"TensorBoard 会话 {tb_session} 已关闭",
                               {"tmuxSession": tb_session, "running": False, "listening": False})

    # start-tensorboard: kill any previous session (cost ~0) then recreate a fresh one.
    try:
        subprocess.run(["tmux", "kill-session", "-t", tb_session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass
    launch_args, launch_source, resolved_logdir = tb_discover_launch(root, logdir_hint, port, explicit_script)
    env = simple_runtime_env(os.environ.copy())
    if conda_env:
        env["SIMPLE_EXPERIMENT_CONDA_ENV"] = conda_env
        env["SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV"] = "1"
    try:
        start_simple_tmux_command(tb_session, launch_args, root, log_path, env)
    except Exception as exc:
        return terminal_action(
            root, action, operation_id, op_id, "failed",
            f"TensorBoard 会话启动失败：{exc}",
            {"tmuxSession": tb_session, "port": port, "logPath": log_rel, "launchSource": launch_source, "resolvedLogdir": resolved_logdir},
        )
    TENSORBOARD_PROXY_PORTS.clear()
    TENSORBOARD_PROXY_PORTS[tb_session] = port
    return terminal_action(
        root, action, operation_id, op_id, "completed",
        f"已重启 TensorBoard 会话 {tb_session}（{launch_source}），端口 {port}，等待就绪",
        {"tmuxSession": tb_session, "port": port, "logPath": log_rel, "launchSource": launch_source, "resolvedLogdir": resolved_logdir, "running": True, "listening": False},
    )


def install_rich_action(root, payload, operation_id, op_id):
    conda_env = str(payload.get("condaEnv") or "").strip()
    if not conda_env.startswith("/"):
        return terminal_action(root, "install-rich", operation_id, op_id, "failed", "需要训练环境的绝对路径")
    env = simple_runtime_env(os.environ.copy())
    env["SIMPLE_EXPERIMENT_CONDA_ENV"] = conda_env
    env["SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV"] = "1"
    python = simple_runtime_python(env)
    if not os.path.isfile(python) or not os.access(python, os.X_OK):
        return terminal_action(root, "install-rich", operation_id, op_id, "failed", f"训练环境 Python 不可执行：{python}")
    try:
        installed = subprocess.run([python, "-m", "pip", "install", "rich>=14.3,<15"], cwd=root,
                                   capture_output=True, text=True, timeout=240, env=env)
        if installed.returncode != 0:
            return terminal_action(root, "install-rich", operation_id, op_id, "failed",
                                   f"rich 安装失败，pip 退出码 {installed.returncode}",
                                   {"python": python, "pipOutputTail": (installed.stdout + installed.stderr)[-1500:]})
        checked = subprocess.run([python, "-c", "import importlib.metadata; print(importlib.metadata.version('rich'))"],
                                 cwd=root, capture_output=True, text=True, timeout=15, env=env)
        version = checked.stdout.strip()
        parts = [int(value) for value in re.findall(r"\d+", version)[:2]]
        if checked.returncode != 0 or len(parts) < 2 or parts[0] != 14 or parts[1] < 3:
            return terminal_action(root, "install-rich", operation_id, op_id, "failed",
                                   f"pip 已执行，但 rich 版本验证失败：{version or checked.stderr[-300:]}")
        return terminal_action(root, "install-rich", operation_id, op_id, "completed",
                               f"训练环境已安装 rich {version}", {"python": python, "version": version})
    except (OSError, subprocess.TimeoutExpired) as exc:
        return terminal_action(root, "install-rich", operation_id, op_id, "failed", f"rich 安装失败：{exc}")


def _resolve_tmux_prefix(options=None, command=None, env=None):
    # 按优先级：options.tmuxSessionPrefix -> command.tmuxSessionPrefix -> os.environ.get("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX") -> 读 $WORK_DIR/.vscode/settings.json 的 tunnel.remoteTmuxSessionPrefix -> 回退 "simple"
    def _extract_prefix(obj):
        if obj is None:
            return ""
        if isinstance(obj, dict):
            for k in ("tmuxSessionPrefix", "tmux_session_prefix", "sessionPrefix", "session_prefix", "remoteTmuxSessionPrefix", "remote_tmux_session_prefix"):
                try:
                    v = obj.get(k)
                    if v is not None and str(v).strip() != "":
                        return str(v).strip()
                except Exception:
                    pass
            return ""
        # attribute access fallback
        for k in ("tmuxSessionPrefix", "tmux_session_prefix", "sessionPrefix", "session_prefix", "remoteTmuxSessionPrefix"):
            try:
                v = getattr(obj, k, None)
                if v is not None and str(v).strip() != "":
                    return str(v).strip()
            except Exception:
                pass
        try:
            # dict-like via __getitem__
            for k in ("tmuxSessionPrefix", "tmux_session_prefix"):
                try:
                    if hasattr(obj, "__contains__") and k in obj:
                        v = obj[k]
                        if v is not None and str(v).strip() != "":
                            return str(v).strip()
                except Exception:
                    pass
        except Exception:
            pass
        return ""
    # 1) options
    for src in (options, command):
        if src is not None:
            raw = _extract_prefix(src)
            if raw:
                norm = re.sub(r"[^a-z0-9._-]+", "-", str(raw).strip().lower()).strip("-")[:32]
                if norm and re.match(r"^[a-z0-9]", norm):
                    return norm
                # raw present but invalid -> fallback to simple immediately (保持与 normalizeRemoteTmuxSessionPrefix 一致)
                return "simple"
    # 3) env
    env_candidates = []
    if isinstance(env, dict):
        env_candidates.append(env)
    env_candidates.append(os.environ)
    for em in env_candidates:
        try:
            v = em.get("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX") if hasattr(em, "get") else None
            if v is not None and str(v).strip() != "":
                norm = re.sub(r"[^a-z0-9._-]+", "-", str(v).strip().lower()).strip("-")[:32]
                if norm and re.match(r"^[a-z0-9]", norm):
                    return norm
                return "simple"
        except Exception:
            pass
    # 4) read $WORK_DIR/.vscode/settings.json -> tunnel.remoteTmuxSessionPrefix
    try:
        work_dir = ""
        if isinstance(env, dict):
            work_dir = str(env.get("WORK_DIR") or env.get("WORKDIR") or env.get("SIMPLE_EXPERIMENT_WORK_DIR") or "").strip()
        if not work_dir:
            work_dir = str(os.environ.get("WORK_DIR") or os.environ.get("SIMPLE_EXPERIMENT_WORK_DIR") or "").strip()
        candidates = []
        if work_dir:
            candidates.append(os.path.join(str(work_dir), ".vscode", "settings.json"))
        try:
            candidates.append(os.path.join(os.getcwd(), ".vscode", "settings.json"))
        except Exception:
            pass
        for cand in candidates:
            try:
                if cand and os.path.isfile(cand):
                    with open(cand, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    val = None
                    if isinstance(data, dict):
                        if "tunnel.remoteTmuxSessionPrefix" in data:
                            val = data.get("tunnel.remoteTmuxSessionPrefix")
                        tunnel = data.get("tunnel")
                        if (val is None or str(val).strip() == "") and isinstance(tunnel, dict):
                            val = tunnel.get("remoteTmuxSessionPrefix") or tunnel.get("remote_tmux_session_prefix")
                        if (val is None or str(val).strip() == "") and "remoteTmuxSessionPrefix" in data:
                            val = data.get("remoteTmuxSessionPrefix")
                    if val is not None and str(val).strip() != "":
                        norm = re.sub(r"[^a-z0-9._-]+", "-", str(val).strip().lower()).strip("-")[:32]
                        if norm and re.match(r"^[a-z0-9]", norm):
                            return norm
                        return "simple"
            except Exception:
                continue
    except Exception:
        pass
    # 5) 回退 "simple"
    return "simple"


def _tmux_prefix():
    # 仅当 settings 缺失时回退到 "simple"（与 _resolve_tmux_prefix 统一），_resolve 内部已处理 env/settings 优先级
    return _resolve_tmux_prefix(None, None, None)


def _run_plan_registry_path(root):
    return state_child_path(root, "cluster_scheduler", "active_run_plans.json")


RUN_PLAN_SUBMISSION_LOCK = threading.RLock()


def _read_run_plan_registry(root):
    try:
        data = read_json(_run_plan_registry_path(root), [])
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def _write_run_plan_registry(root, entries):
    try:
        atomic_write(_run_plan_registry_path(root), list(entries))
    except Exception:
        pass


def _is_pid_alive(pid):
    return pid_is_alive(pid)


def parse_linux_process_start_identity(stat_line):
    # /proc/<pid>/stat field 2 is parenthesized and may contain spaces. Field 22
    # (starttime) is index 19 after splitting fields starting at field 3.
    text = str(stat_line or "")
    end = text.rfind(")")
    if end < 0:
        return ""
    fields = text[end + 1:].split()
    if len(fields) <= 19 or not fields[19].isdigit():
        return ""
    return fields[19]


def process_start_identity(pid):
    try:
        pid_value = int(pid or 0)
        if pid_value <= 0:
            return ""
        with open(f"/proc/{pid_value}/stat", "r", encoding="utf-8") as stream:
            return parse_linux_process_start_identity(stream.read())
    except Exception:
        return ""


def _reap_zombie_scheduler_sessions(root, known_op_ids, target_session=""):
    # Reap only the exact scheduler session already validated for this stop request.
    # Scanning every unregistered prefix session races a scheduler between tmux
    # creation and registry publication, and can kill a different live operation.
    if not tmux_available():
        return []
    name = str(target_session or "").strip()
    prefix = _tmux_prefix() + "-sch-"
    if not name.startswith(prefix):
        return []
    op = name[len(prefix):]
    if not op or op in set(str(value) for value in (known_op_ids or [])):
        return []
    try:
        present = subprocess.run(["tmux", "has-session", "-t", name], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, timeout=5, cwd=root)
        if present.returncode != 0 or _tmux_pane_python_running(name, None):
            return []
        killed = subprocess.run(["tmux", "kill-session", "-t", name], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=5, cwd=root)
        return [name] if killed.returncode == 0 else []
    except Exception:
        return []

def _reap_orphan_gpu_sessions(root, force_all=False):
    # GPU 窗口与调度窗口同生命周期：调度销毁时回收关联 GPU 窗口，避免孤儿 long-lived 会话
    if not tmux_available():
        return []
    prefix = _tmux_prefix()
    reaped = []
    try:
        out = subprocess.run(["tmux", "ls"], text=True, capture_output=True, timeout=5).stdout or ""
        for line in out.splitlines():
            name = line.split(":", 1)[0].strip()
            # 匹配 prefix-gpu-<id> 或兼容历史 simple-gpu-*/zlk-gpu-*
            is_gpu = False
            if name.startswith(prefix + "-gpu-"):
                is_gpu = True
            elif name.startswith("simple-gpu-"):
                is_gpu = True
            elif name.startswith("zlk-gpu-"):
                is_gpu = True
            elif re.match(r"^gpu-\d+$", name):
                is_gpu = True
            if not is_gpu:
                continue
            # 若 force_all 或无活跃 scheduler，则直接回收
            try:
                subprocess.run(["tmux", "kill-session", "-t", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                reaped.append(name)
            except Exception:
                pass
    except Exception:
        pass
    return reaped


def fence_stale_run_plans(root, new_op_id, new_worker_ids, new_owner):
    # Never replace a live scheduler implicitly: its dispatched training tasks outlive its tmux.
    entries = _read_run_plan_registry(root)
    new_ids = set(str(w) for w in (new_worker_ids or []))
    owner = str(new_owner or "").strip()
    blocked = []
    kept = []
    for entry in entries:
        if not isinstance(entry, dict):
            kept.append(entry)
            continue
        op = str(entry.get("opId") or "")
        if op == str(new_op_id):
            kept.append(entry)
            continue
        entry_workers = set(str(w) for w in (entry.get("workerIds") or []))
        entry_owner = str(entry.get("ownerWorkerId") or "")
        overlap = bool(new_ids & entry_workers) or (owner and owner == entry_owner)
        if not overlap:
            kept.append(entry)
            continue
        session = str(entry.get("tmuxSession") or simple_tmux_name(f"sch-{op}"))
        evidence = scheduler_process_evidence(root, entry.get("pid"), session)
        # The registered pid can be the pane's shell. A surviving tmux window is
        # deliberately kept for diagnosis, but must not reserve the Worker.
        alive = bool(evidence.get("tmuxSessionAlive")) if entry.get("tmuxSession") else bool(evidence.get("pidAlive"))
        if not alive and entry.get("status") == "queued" and time.time() - float(entry.get("reservedAt") or 0) < 120:
            alive = True  # A concurrent submission reserved its queue position before launch.
        if not alive:
            continue  # stale entry: drop from registry, reaped below
        blocked.append(op)
        kept.append(entry)
    # Preserve completed/failed scheduler windows and their logs. Only an explicit
    # user stop may destroy them.
    reaped = []
    _write_run_plan_registry(root, kept)
    return {"blocked": blocked, "reapedZombies": reaped}


def register_active_run_plan(root, op_id, pid, tmux_session, worker_ids, owner, status="running"):
    with RUN_PLAN_SUBMISSION_LOCK:
        entries = _read_run_plan_registry(root)
        previous = next((e for e in entries if isinstance(e, dict) and str(e.get("opId") or "") == str(op_id)), None)
        entry = {
            "opId": str(op_id),
            "pid": int(pid or 0),
            "pidStartIdentity": process_start_identity(pid),
            "tmuxSession": str(tmux_session or ""),
            "workerIds": [str(w) for w in (worker_ids or [])],
            "ownerWorkerId": str(owner or ""),
            "startedAt": previous.get("startedAt") if previous else now_iso(),
            "reservedAt": previous.get("reservedAt") if previous else time.time(),
            "status": status,
        }
        if previous is None:
            entries.append(entry)
        else:
            entries[entries.index(previous)] = entry
        _write_run_plan_registry(root, entries)


def deregister_active_run_plan(root, op_id):
    with RUN_PLAN_SUBMISSION_LOCK:
        entries = [e for e in _read_run_plan_registry(root) if isinstance(e, dict) and str(e.get("opId") or "") != str(op_id)]
        _write_run_plan_registry(root, entries)


def inspect_plan_output_retirement(root, relative):
    """Read-only proof for one exact attempt. Never follow links or mounted descendants."""
    import stat
    relative = str(relative or "")
    parts = relative.split("/")
    if len(parts) < 4 or parts[-2] != "attempts" or parts[0] not in ("work_dirs", "experiments") or (parts[0] == "experiments" and parts[1] != "runs"):
        raise ValueError("only an exact attempt directory can be retired")
    if any(part in ("", ".", "..", ".git", "clean_dir", "simple_cluster", ".runtime") or not re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
        raise ValueError("unsafe attempt path")
    root_abs = os.path.abspath(root)
    root_real = os.path.realpath(root_abs)
    if root_real != root_abs or root_real in (os.path.abspath(os.sep), os.path.expanduser("~")) or not os.path.isdir(root_real):
        raise ValueError("unsafe project root")
    target = os.path.join(root_real, *parts)
    proof = {"relativePath": relative, "remoteRoot": root_real, "absolutePath": target, "parent": os.path.dirname(target),
             "child": "./" + parts[-1], "type": "directory", "bytes": 0, "fileCount": 0, "safeForDeletion": True}
    for i in range(1, len(parts) + 1):
        current = os.path.join(root_real, *parts[:i])
        if os.path.islink(current) or os.path.ismount(current):
            raise ValueError("attempt path contains a link or mount")
        if os.path.lexists(current) and not os.path.isdir(current):
            raise ValueError("attempt path is not a directory")
    if not os.path.lexists(target):
        return {**proof, "exists": False, "fingerprint": hashlib.sha256((target + ":absent").encode("utf-8")).hexdigest()}
    tasks = api_worker_tasks(root).get("tasks") or []
    for task in tasks:
        output = str(task.get("outputDir") or "").replace("\\", "/").rstrip("/")
        if os.path.isabs(output):
            output = os.path.relpath(os.path.realpath(output), root_real).replace("\\", "/")
        if str(task.get("status") or "").lower() not in ("completed", "failed", "cancelled", "canceled", "stopped") and output and (output == relative or output.startswith(relative + "/") or relative.startswith(output + "/")):
            raise ValueError("attempt is still active on this Worker")
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    rows = []
    for current, directories, files in os.walk(target, followlinks=False):
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or os.path.ismount(current):
            raise ValueError("unsafe attempt directory")
        rows.append((os.path.relpath(current, root_real), "directory", identity(info)))
        for name in directories:
            child = os.path.join(current, name)
            if os.path.islink(child) or os.path.ismount(child) or name in (".git", "clean_dir", ".runtime"):
                raise ValueError("attempt contains a protected directory, link or mount")
        for name in files:
            child = os.path.join(current, name)
            before = os.lstat(child)
            if not stat.S_ISREG(before.st_mode) or os.path.ismount(child):
                raise ValueError("attempt contains a link or special file")
            descriptor = os.open(child, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream:
                if identity(os.fstat(stream.fileno())) != identity(before):
                    raise ValueError("attempt file changed before inspection")
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                if identity(os.fstat(stream.fileno())) != identity(before):
                    raise ValueError("attempt file changed during inspection")
            if identity(os.lstat(child)) != identity(before):
                raise ValueError("attempt file changed after inspection")
            rows.append((os.path.relpath(child, root_real), "file", identity(before), digest.hexdigest()))
            proof["bytes"] += before.st_size
            proof["fileCount"] += 1
        if len(rows) > 200000:
            raise ValueError("attempt inventory exceeds review limit")
        if identity(os.lstat(current)) != identity(info):
            raise ValueError("attempt directory changed during inspection")
    encoded = json.dumps(sorted(rows), ensure_ascii=False, separators=(",", ":"))
    for row in rows:
        if row[1] == "directory" and identity(os.lstat(os.path.join(root_real, row[0]))) != row[2]:
            raise ValueError("attempt directory changed after inspection")
    return {**proof, "exists": True, "fingerprint": hashlib.sha256(encoded.encode("utf-8")).hexdigest()}


def scheduler_state_cleanup_owner_matches(root, file_path, state):
    try:
        root_real = os.path.realpath(root)
        state_dir = os.path.join(root_real, "simple_cluster", "tmp", "cluster_scheduler")
        owner = state.get("cleanupOwner") if isinstance(state, dict) else None
        if not isinstance(owner, dict) or owner.get("schemaVersion") != 1 or owner.get("purpose") != "scheduler-state":
            return False
        if not os.path.isdir(state_dir) or os.path.islink(state_dir) or os.path.realpath(state_dir) != state_dir:
            return False
        full_path = os.path.abspath(file_path)
        if os.path.dirname(full_path) != state_dir or os.path.islink(full_path) or not os.path.isfile(full_path):
            return False
        if not re.fullmatch(r"[A-Za-z0-9._-]+_state\.json", os.path.basename(full_path)):
            return False
        if os.path.normcase(os.path.realpath(str(owner.get("projectRoot") or ""))) != os.path.normcase(root_real):
            return False
        recorded_path = os.path.normcase(os.path.realpath(str(owner.get("statePath") or "")))
        if recorded_path != os.path.normcase(full_path):
            return False
        normalize_plan = lambda value: re.sub(r"^\./", "", str(value or "").replace("\\", "/")).strip()
        plan_file = normalize_plan(state.get("plan"))
        if not plan_file or normalize_plan(owner.get("planFile")) != plan_file:
            return False
        operation_id = str(owner.get("operationId") or "").strip()
        run_id = str(owner.get("runId") or "").strip()
        attempt_id = str(owner.get("attemptId") or "").strip()
        if not operation_id or not run_id or not attempt_id or operation_id != run_id:
            return False
        if state.get("schedulerTerminal") is not True:
            return False
        if state.get("running_experiments") or state.get("testing_experiments"):
            return False
        return True
    except Exception:
        return False


def cache_cleanup_candidates(root):
    """Only aged project temp files; never remove runtime state or experiment data."""
    root_real = os.path.realpath(root)
    if not os.path.isdir(root_real):
        raise ValueError("项目根目录不可用")
    tasks = api_worker_tasks(root).get("tasks") or []
    if any(str(task.get("status") or "").lower() in ("running", "queued", "pending") for task in tasks if isinstance(task, dict)):
        raise ValueError("仍有运行中或待派发的任务，当前 Worker 暂停缓存回收")
    for state in collect_scheduler(root):
        scheduler_pid = state.get("pid") or state.get("schedulerPid") or state.get("processId")
        if scheduler_pid and is_pid_running(scheduler_pid) and (str(state.get("status") or "").lower() in ("running", "queued", "pending") or any(state.get(bucket) for bucket in ("running_experiments", "testing_experiments"))):
            raise ValueError("调度器仍在运行，当前 Worker 暂停缓存回收")
    cutoff = time.time() - 7 * 24 * 60 * 60
    candidates = []
    protected_markers = ("tensorboard", "tb_log", "checkpoint", "weight", "model_cache", "dataset")
    allowed_extensions = {".log", ".tmp", ".bak", ".part"}
    groups = ("simple_cluster/tmp", "tmp")
    for relative_base in groups:
        base = os.path.join(root_real, *relative_base.split("/"))
        if not os.path.isdir(base) or os.path.islink(base) or os.path.realpath(base) != base or os.stat(base).st_dev != os.stat(root_real).st_dev:
            continue
        for parent, dirs, files in os.walk(base, followlinks=False):
            if os.path.realpath(parent) != parent or os.stat(parent).st_dev != os.stat(root_real).st_dev:
                dirs[:] = []
                continue
            dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(parent, name)) and not any(marker in name.lower() for marker in protected_markers)]
            for name in files:
                path = os.path.join(parent, name)
                dry_run_temp = bool(re.fullmatch(r"dry-run-workers-[0-9a-f]{24}\.json", name))
                relative_path = os.path.relpath(path, root_real).replace(os.sep, "/")
                scheduler_state_temp = relative_path.startswith("simple_cluster/tmp/cluster_scheduler/") and relative_path.endswith("_state.json")
                if os.path.islink(path) or any(marker in name.lower() for marker in protected_markers) or (os.path.splitext(name)[1].lower() not in allowed_extensions and not dry_run_temp and not scheduler_state_temp):
                    continue
                try:
                    stat = os.stat(path, follow_symlinks=False)
                    if not os.path.isfile(path) or stat.st_dev != os.stat(root_real).st_dev or stat.st_mtime > cutoff:
                        continue
                    if scheduler_state_temp and stat.st_size > 2 * 1024 * 1024:
                        continue
                    rel = relative_path
                    if os.path.commonpath((root_real, os.path.realpath(path))) != root_real:
                        continue
                    if scheduler_state_temp:
                        try:
                            with open(path, "r", encoding="utf-8") as stream:
                                state = json.load(stream)
                        except Exception:
                            continue
                        if not scheduler_state_cleanup_owner_matches(root_real, path, state):
                            continue
                    purpose = ("单个 Job 的训练或测试输出日志，旧内容用于历史排错" if "/cluster_scheduler/logs/" in rel else
                               "Plan 调度过程日志" if "/cluster_scheduler/" in rel and rel.endswith(".log") else
                               "已终止 Plan 的专属调度状态，保留期已满 7 天" if scheduler_state_temp else
                               "Plan 预演的 Worker 分配快照" if dry_run_temp else
                               "tmux 会话输出副本" if "/tmux_logs/" in rel else "插件临时工作文件")
                    token = hashlib.sha256(f"{rel}|{stat.st_dev}|{stat.st_ino}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")).hexdigest()
                    candidates.append({"path": rel, "fullPath": path, "type": "file", "bytes": stat.st_size, "modifiedAt": stat.st_mtime, "purpose": purpose, "token": token})
                    if len(candidates) > 20000:
                        raise ValueError("候选文件过多，请分批审核")
                except OSError:
                    continue
    return sorted(candidates, key=lambda item: item["path"])

def cache_delete_exact_file(root, relative_path, expected_token):
    root_real = os.path.realpath(root)
    parts = str(relative_path or "").split("/")
    if not parts or any(part in ("", ".", "..") for part in parts) or not (parts[:2] == ["simple_cluster", "tmp"] or parts[0] == "tmp"):
        raise ValueError("缓存路径超出允许范围")
    full_path = os.path.join(root_real, *parts)
    parent = os.path.dirname(full_path)
    leaf = os.path.basename(full_path)
    if not leaf or leaf in (".", "..") or "/" in leaf or "\\" in leaf or os.path.realpath(parent) != parent or os.path.commonpath((root_real, parent)) != root_real or parent == root_real:
        raise ValueError("PARENT_CD_FAILED: 父目录校验失败")
    if os.path.islink(full_path) or not os.path.isfile(full_path):
        raise ValueError(f"候选已变化：{relative_path}")
    file_stat = os.stat(full_path, follow_symlinks=False)
    current_token = hashlib.sha256(f"{relative_path}|{file_stat.st_dev}|{file_stat.st_ino}|{file_stat.st_size}|{file_stat.st_mtime_ns}".encode("utf-8")).hexdigest()
    if current_token != expected_token or file_stat.st_mtime > time.time() - 7 * 24 * 60 * 60:
        raise ValueError(f"候选已变化：{relative_path}")
    if relative_path.startswith("simple_cluster/tmp/cluster_scheduler/") and relative_path.endswith("_state.json"):
        try:
            with open(full_path, "r", encoding="utf-8") as stream:
                state = json.load(stream)
        except Exception as exc:
            raise ValueError(f"调度状态无法验证：{relative_path}: {exc}")
        if not scheduler_state_cleanup_owner_matches(root_real, full_path, state):
            raise ValueError(f"调度状态所有权已变化：{relative_path}")
    if os.name != "posix":
        raise ValueError("PARENT_CD_FAILED: 当前平台不支持安全的目录内删除")
    script = 'cd -- "$1" || exit 41; [ "$(pwd -P)" = "$1" ] || exit 42; [ -f "./$2" ] && [ ! -L "./$2" ] || exit 43; rm -- "./$2"'
    completed = subprocess.run(["/bin/sh", "-c", script, "cache-delete", parent, leaf], cwd=parent, capture_output=True, text=True, timeout=30)
    if completed.returncode != 0:
        raise ValueError("PARENT_CD_FAILED" if completed.returncode in (41, 42) else f"删除失败：{relative_path}: {completed.stderr.strip()[:200]}")
    if os.path.lexists(full_path):
        raise ValueError(f"删除后仍存在：{relative_path}")

def handle_action(root, action, payload, operation_id, op_id):
    if action == "rebuild-distributed-results":
        try:
            manifest = payload.get("manifest")
            if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("plans"), list):
                raise ValueError("分布式结果清单无效")
            encoded = json.dumps(manifest, ensure_ascii=False)
            if len(encoded) > 4_000_000:
                raise ValueError("分布式结果清单过大")
            env = simple_runtime_env(os.environ.copy())
            conda_env = str(payload.get("condaEnv") or "").strip()
            if conda_env:
                env["SIMPLE_EXPERIMENT_CONDA_ENV"] = conda_env
                env["SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV"] = "1"
            merge_module = str(payload.get("mergeModule") or "experiments.simple_adapter.distributed_results").strip()
            if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+", merge_module):
                raise ValueError("分布式汇总模块名无效")
            command = [simple_runtime_python(env), "-m", merge_module,
                       "--manifest", "-", "--project-root", root]
            if payload.get("publish") is True:
                command.append("--publish")
            result = subprocess_inactivity_run(command, input=encoded, cwd=root, env=env, file_step=True)
            if result.returncode != 0:
                raise RuntimeError((result.stderr or result.stdout or "结果重建失败")[-2000:])
            details = json.loads(result.stdout.strip().splitlines()[-1])
            return terminal_action(root, action, operation_id, op_id, "completed", "分布式结果重建完成", details)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc))
    if action == "preview-cache-cleanup":
        try:
            if "planOutputPaths" in payload:
                paths = payload["planOutputPaths"]
                if not isinstance(paths, list) or not paths or len(paths) > 100:
                    raise ValueError("invalid attempt inspection batch")
                return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "status": "completed",
                        "planOutputs": [inspect_plan_output_retirement(root, value) for value in paths]}
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "status": "completed", "candidates": cache_cleanup_candidates(root), "retentionDays": 7}
        except Exception as exc:
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "status": "failed", "message": str(exc)}
    if action == "delete-cache-candidates":
        try:
            selected = payload.get("candidates")
            if payload.get("confirm") is not True or payload.get("pathConfirmed") is not True or not isinstance(selected, list) or not selected:
                raise ValueError("CONFIRM_REQUIRED: 必须逐项确认完整路径并二次确认")
            if len(selected) > 2000:
                raise ValueError("缓存删除数量超过单次上限")
            current = {row["path"]: row for row in cache_cleanup_candidates(root)}
            if len({str(row.get("path")) for row in selected if isinstance(row, dict)}) != len(selected):
                raise ValueError("缓存候选包含重复或无效路径")
            for row in selected:
                path = str(row.get("path") or "")
                found = current.get(path)
                if not found or found["token"] != row.get("token") or found["type"] != "file":
                    raise ValueError(f"缓存候选已变化，请刷新后重新审核：{path}")
            deleted = []
            for row in selected:
                path = row["path"]
                cache_delete_exact_file(root, path, row["token"])
                deleted.append(path)
            append_event(root, {"type": "cache_cleanup_completed", "operationId": operation_id, "payload": {"deletedCount": len(deleted)}})
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "status": "completed", "deletedCount": len(deleted)}
        except Exception as exc:
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "status": "failed", "message": str(exc)}
    if action in DEBUG_BLOCKED_ACTIONS and (action_debug_mode(payload) or action_targets_debug_run(payload)):
        return terminal_action(root, action, operation_id, op_id, "failed", "Debug 模式产物与正式实验隔离，禁止执行归档、删除、有效结果、统计、论文或 PPT 操作。", request=payload)
    if action in ("start-worker-task", "retry-worker-task", "stop-worker-task"):
        command = dict(payload)
        command["action"] = action
        command["commandId"] = op_id
        result = execute_worker_command(root, command, str((payload.get("options") or {}).get("workerId") or payload.get("workerId") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker"))
        if action == "stop-worker-task" and payload.get("requeueRequested") is True:
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "operationId": operation_id,
                    "action": action, **result}
        if action == "start-worker-task" and result.get("admissionRejected") is True:
            details = action_event_fields(result, payload)
            append_event(root, {"type": "operation_progress", "operationId": operation_id,
                                "payload": {"action": action, "opId": op_id, "status": "pending",
                                            "message": str(result.get("message") or "GPU is busy"),
                                            "reason": "gpu_busy", **details}})
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "operationId": operation_id,
                    "action": action, **result}
        if action == "start-worker-task" and result.get("durableAccepted") is True:
            accepted_status = str(result.get("status") or "queued")
            accepted_message = str(result.get("message") or "Agent 已持久接收该 job")
            details = action_event_fields(result, payload)
            append_event(root, {"type": "operation_progress", "operationId": operation_id,
                                "payload": {"action": action, "opId": op_id, "status": accepted_status,
                                            "message": accepted_message, **details}})
            return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "operationId": operation_id,
                    "action": action, "status": accepted_status, "message": accepted_message, **details}
        status = "completed" if result.get("status") in ("running", "completed") else "failed"
        return terminal_action(root, action, operation_id, op_id, status, str(result.get("message") or result.get("status") or ""), result)
    if action == "self-check":
        return terminal_action(root, action, operation_id, op_id, "completed", "自检完成", {"diagnostics": api_diagnostics(root)})
    if action == "save-result-policy":
        try:
            options = payload.get("options") or {}
            rules = options.get("projectAdapterRules")
            if not isinstance(rules, dict):
                raise ValueError("projectAdapterRules must be an object")
            mapping = rules.get("csvColumnMapping") or {}
            if not isinstance(mapping, dict):
                raise ValueError("csvColumnMapping must be an object")
            allowed = ("case", "seed", "split", "dataset", "method", "eval_protocol", "rate_percent", "train_rate", "metric", "value")
            if any(key not in allowed or not isinstance(value, str) or len(value) > 120 or any(ch in value for ch in (chr(13), chr(10), chr(0))) for key, value in mapping.items()):
                raise ValueError("invalid csvColumnMapping field")
            allowed_lists = ("secondaryMetrics", "classificationMetrics", "segmentationMetrics", "candidateCsv", "candidateJson", "consoleLogs", "textLogs")
            allowed_text = ("taskType", "primaryMetric", "metricRegex", "summaryCsv", "caseCsv")
            allowed_maps = ("metricAliases",)
            if any(key not in (*allowed_lists, *allowed_text, *allowed_maps, "csvColumnMapping", "derivedMetric") for key in rules):
                raise ValueError("invalid projectAdapterRules field")
            if any(not isinstance(rules.get(key), list) or len(rules[key]) > 100 or any(not isinstance(item, str) or len(item) > 240 for item in rules[key]) for key in allowed_lists if key in rules):
                raise ValueError("invalid result policy list")
            if any(not isinstance(rules.get(key), str) or len(rules[key]) > 1000 for key in allowed_text if key in rules):
                raise ValueError("invalid result policy text")
            aliases = rules.get("metricAliases") or {}
            if not isinstance(aliases, dict) or len(aliases) > 200 or any(not isinstance(key, str) or not isinstance(value, str) or len(key) > 120 or len(value) > 120 for key, value in aliases.items()):
                raise ValueError("invalid metric aliases")
            derived = rules.get("derivedMetric") or {}
            if not isinstance(derived, dict) or (derived and (set(derived) != {"metric", "leftEndpoint", "rightEndpoint", "scale", "outputName"} or derived.get("scale") not in (1, 100) or any(not isinstance(derived.get(key), str) or not derived[key].strip() or len(derived[key]) > 120 or any(ch in derived[key] for ch in (chr(13), chr(10), chr(0))) for key in ("metric", "leftEndpoint", "rightEndpoint", "outputName")) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", derived["outputName"]))):
                raise ValueError("invalid derivedMetric configuration")
            target = path_for(root, "result_policy.json")
            saved = {key: rules[key] for key in (*allowed_lists, *allowed_text, *allowed_maps) if key in rules}
            saved["schemaVersion"] = 1
            saved["csvColumnMapping"] = {key: mapping[key].strip() for key in allowed if mapping.get(key, "").strip()}
            saved["derivedMetric"] = derived
            atomic_write(target, saved)
            return terminal_action(root, action, operation_id, op_id, "completed", "结果接入规则已保存到 Agent 配置", {"csvColumnMapping": saved["csvColumnMapping"]}, request=payload)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
    if action == "archive-plan-copy":
        try:
            result = archive_plan_copy_action(root, action_plan_file(payload), payload.get("snapshotName"))
            return terminal_action(root, action, operation_id, op_id, "completed", f"当前 Plan 轻量副本已写入 {result['archivePath']}", result, request=payload)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
    if action in ("refresh-results", "rescan-results", "parse-results"):
        selected = action_values(payload, "selectedRunKeys", "selectedArchiveKeys", "selectedExperimentIds", "runKey", "archiveKey", "experimentId", "remotePath", "path") + action_task_target_values(payload)
        operation_fields = action_operation_fields(payload)
        summary = parse_results_action(root, selected, action_plan_file(payload), operation_fields.get("planRevision") or "", operation_fields)
        return terminal_action(root, action, operation_id, op_id, "completed", f"解析完成：{summary.get('resultCount', 0)} 条结果，最终纳入 {summary.get('finalResultCount', 0)} 条，待审核 {summary.get('pendingReviewCount', 0)} 条，失败 {summary.get('parseFailed', 0)} 个文件", {"summaryPath": summary.get("summaryPath") or plan_results_summary_relpath(action_plan_file(payload) or summary.get("planFile") or ""), "resultCount": summary.get("resultCount", 0), "finalResultCount": summary.get("finalResultCount", 0), "pendingReviewCount": summary.get("pendingReviewCount", 0), "inclusionPolicy": summary.get("inclusionPolicy"), "parseFailed": summary.get("parseFailed", 0), "planFile": action_plan_file(payload) or summary.get("planFile") or ""}, request=payload)
    if action == "validate-plan":
        plan = action_plan_file(payload)
        default_result_csv_dir = str(action_options(payload).get("defaultResultCsvDir") or action_options(payload).get("default_result_csv_dir") or "experiments/results")
        if not plan:
            return terminal_action(root, action, operation_id, op_id, "failed", "缺少 planFile，无法校验计划。", request=payload)
        try:
            safe_project_path(root, plan)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
        debug_mode = action_debug_mode(payload)
        try:
            plan = prepare_draft_run_plan(root, plan, debug_mode)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
        scheduler = cluster_scheduler_path(root)
        if not scheduler:
            return terminal_action(root, action, operation_id, op_id, "failed", "调度节点缺少 cluster_scheduler.py，请先部署最新版 Agent。", request=payload)
        try:
            validation = scheduler_validate_json(root, scheduler, plan, default_result_csv_dir, options=action_options(payload))
            job_count = int(validation.get("job_count") or len(validation.get("jobs") or []))
            execution_mode = str(validation.get("execution_mode") or "train_test")
            return terminal_action(root, action, operation_id, op_id, "completed", f"计划校验通过：模式 {execution_mode}，任务 {job_count}", {"validation": validation, "jobCount": job_count, "executionMode": execution_mode}, request=payload)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
    if action == "dry-run-plan":
        plan = action_plan_file(payload)
        default_result_csv_dir = str(action_options(payload).get("defaultResultCsvDir") or action_options(payload).get("default_result_csv_dir") or "experiments/results")
        if not plan:
            return terminal_action(root, action, operation_id, op_id, "failed", "缺少 planFile，无法执行 Dry-run。", request=payload)
        try:
            safe_project_path(root, plan)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
        try:
            temp_cleanup = cleanup_dry_run_worker_temp_files(root)
            preview = dry_run_preview_action(root, plan, action_options(payload).get("workers") if isinstance(action_options(payload).get("workers"), list) else [], action_operation_fields(payload).get("assignedExperimentIndices") or [], default_result_csv_dir, operation_id)
            if preview.get("ok") is False:
                interface = preview.get("outputInterface") or {}
                return terminal_action(root, action, operation_id, op_id, "failed", str(interface.get("message") or "输出接口预检失败，已阻止 Dry-run。"), {"preview": preview, "outputInterface": interface, "tempCleanup": temp_cleanup}, request=payload)
            return terminal_action(root, action, operation_id, op_id, "completed", f"Dry-run 完成：可立即调度 {preview.get('dispatchableCount', 0)}，排队 {preview.get('queuedCount', 0)}", {"preview": preview, "tempCleanup": temp_cleanup}, request=payload)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
    if action == "stop-scheduler-operation":
        return stop_scheduler_operation(root, payload)
    if action in ("run-plan", "reproduce-plan"):
        plan = action_plan_file(payload)
        options = action_options(payload)
        debug_mode = action_debug_mode(payload)
        if debug_mode:
            return terminal_action(root, action, operation_id, op_id, "failed", "Debug 运行模式已移除，请使用正式 Plan 运行。", request=payload)
        default_result_csv_dir = str(options.get("defaultResultCsvDir") or options.get("default_result_csv_dir") or "experiments/results")
        if not plan:
            return terminal_action(root, action, operation_id, op_id, "failed", "缺少 planFile，无法启动计划。", request=payload)
        try:
            safe_project_path(root, plan)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
        scheduler = cluster_scheduler_path(root)
        if not scheduler:
            return terminal_action(root, action, operation_id, op_id, "failed", "调度节点缺少 cluster_scheduler.py，请先部署最新版 Agent。", request=payload)
        output_gate = plan_output_capture_evidence(root, plan)
        if not output_gate.get("ok"):
            return terminal_action(root, action, operation_id, op_id, "failed", output_gate.get("message") or "未识别到可用的结果捕获规则，已阻止运行实验。", {"outputGate": output_gate}, request=payload)
        workers = action_options(payload).get("workers")
        if not isinstance(workers, list) or not workers:
            return terminal_action(root, action, operation_id, op_id, "failed", "缺少 Worker 配置，无法启动计划。", request=payload)
        if len(workers) != 1 or not str(workers[0].get("id") or "").strip():
            return terminal_action(root, action, operation_id, op_id, "failed", "每个 Plan 必须且只能指定一个 Worker。", request=payload)
        try:
            validation = scheduler_validate_json(root, scheduler, plan, default_result_csv_dir)
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", "计划校验失败，已阻止启动调度：" + str(exc), request=payload)
        # Guard: fence any older live run-plan scheduler that targets an overlapping worker so two
        # schedulers never over-allocate the same worker's GPUs (root cause of the 6-job overflow).
        worker_ids = [str(w.get("id") or "").strip() for w in workers if isinstance(w, dict)]
        scheduler_owner_w = str(action_operation_fields(payload).get("schedulerOwnerWorkerId") or "").strip()
        with RUN_PLAN_SUBMISSION_LOCK:
            fence_result = fence_stale_run_plans(root, op_id, worker_ids, scheduler_owner_w)
            register_active_run_plan(root, op_id, 0, "", worker_ids, scheduler_owner_w, "queued")
        if fence_result.get("reapedZombies"):
            try:
                append_event(root, {"type": "scheduler_zombies_reaped", "operationId": operation_id, "payload": {"reapedZombies": fence_result.get("reapedZombies") or [], "newOpId": op_id}})
            except Exception:
                pass
        workers_path = state_child_path(root, "actions", f"{op_id}-workers.json")
        atomic_write(workers_path, workers)
        log_path = safe_project_path(root, f"simple_cluster/tmp/cluster_scheduler/{op_id}.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        log_rel = os.path.relpath(log_path, root).replace("\\", "/")
        debug_run_id = action_debug_run_id(payload) or op_id
        debug_output_dir = f"simple_cluster/debug_runs/{plan_summary_slug(plan)}/{safe_name(debug_run_id)}" if debug_mode else ""
        if debug_mode:
            log_path = safe_project_path(root, f"{debug_output_dir}/hub_scheduler.log")
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            log_rel = os.path.relpath(log_path, root).replace("\\", "/")
        poll_seconds = max(5, int(options.get("pollSeconds") or options.get("poll_seconds") or 60))
        jitter_seconds = max(0, int(options.get("jitterSeconds") or options.get("jitter_seconds") or 30))
        ttl_seconds = max(60, int(options.get("workerStatusTtlSeconds") or options.get("worker_status_ttl_seconds") or 180))
        gpu_idle_util = max(0, min(100, int(options.get("gpuIdleUtilThreshold") or options.get("gpu_idle_util_threshold") or 5)))
        gpu_idle_mem = max(0, min(8192, int(options.get("gpuIdleMemThresholdMb") or options.get("gpu_idle_mem_threshold") or 200)))
        session_check_min = max(1, min(60, int(options.get("sessionCheckMinSeconds") or options.get("session_check_min_seconds") or 5)))
        env = simple_runtime_env(os.environ.copy())
        env["SIMPLE_GPU_IDLE_UTIL_THRESHOLD"] = str(gpu_idle_util)
        env["SIMPLE_GPU_IDLE_MEM_THRESHOLD"] = str(gpu_idle_mem)
        scheduler_args = [
            simple_runtime_python(env),
            scheduler,
            "--plan", plan,
            "--workers-json", workers_path,
            "--poll-seconds", str(poll_seconds),
            "--poll-jitter-seconds", str(jitter_seconds),
            "--worker-status-ttl-seconds", str(ttl_seconds),
            "--gpu-idle-util-threshold", str(gpu_idle_util),
            "--gpu-idle-mem-threshold", str(gpu_idle_mem),
            "--session-check-min-seconds", str(session_check_min),
            "--availability-path", availability_cache_path(root),
            "--agent-state-dir", agent_dir(root),
            "--operation-id", operation_id,
            "--op-id", op_id,
            "--operation-action", action,
            "--plan-revision", str(action_operation_fields(payload).get("planRevision") or ""),
            "--scheduler-log", log_rel,
            "--plan-queue-registry", _run_plan_registry_path(root),
            "--plan-queue-project-dir", root,
            "--wait-for-operations", ",".join(fence_result.get("blocked") or []),
            "--default-result-csv-dir", default_result_csv_dir,
        ]
        operation_fields = action_operation_fields(payload)
        assigned_indices = operation_fields.get("assignedExperimentIndices") or []
        if assigned_indices:
            scheduler_args.extend(["--only-indices", ",".join(str(index) for index in assigned_indices)])
        if operation_fields.get("workerSetRevision"):
            scheduler_args.extend(["--worker-set-revision", str(operation_fields.get("workerSetRevision"))])
        if operation_fields.get("schedulerOwnerWorkerId"):
            scheduler_args.extend(["--scheduler-owner-worker-id", str(operation_fields.get("schedulerOwnerWorkerId"))])
        if operation_fields.get("topologyMode"):
            env["SIMPLE_EXPERIMENT_TOPOLOGY_MODE"] = str(operation_fields.get("topologyMode"))
        if operation_fields.get("workerSetRevision"):
            env["SIMPLE_EXPERIMENT_WORKER_SET_REVISION"] = str(operation_fields.get("workerSetRevision"))
        if debug_mode:
            scheduler_args.extend(["--debug-mode", "--debug-run-id", debug_run_id, "--debug-output-dir", debug_output_dir])
        overwrite_existing = any(action_bool(value) for value in (payload.get("overwriteExisting"), payload.get("overwrite_existing"), payload.get("overwrite"), options.get("overwriteExisting"), options.get("overwrite_existing"), options.get("overwrite"), action_operation_fields(payload).get("overwriteExisting"), action_operation_fields(payload).get("overwrite")))
        if overwrite_existing:
            scheduler_args.append("--overwrite")
        tmux_session = simple_tmux_name(f"sch-{op_id}")
        pid = 0
        used_tmux = False
        scheduler_exit_code_path = ""
        scheduler_launch_error = ""
        if tmux_available():
            try:
                scheduler_exit_code_path = safe_project_path(root, f"simple_cluster/tmp/cluster_scheduler/{op_id}.exit_code")
                pid = start_simple_tmux_command(tmux_session, scheduler_args, root, log_path, env, scheduler_exit_code_path)
                used_tmux = True
            except Exception as exc:
                scheduler_launch_error = f"scheduler tmux launch failed: {exc}; attempting fallback (main shell bootstrap + Popen)"
                print(f"[warn] {scheduler_launch_error}", file=sys.stderr, flush=True)
                try:
                    os.makedirs(os.path.dirname(log_path), exist_ok=True)
                    with open(log_path, "a", encoding="utf-8") as _lf:
                        _lf.write(f"[{now_iso()}] SCHEDULER LAUNCH FAILED: {exc}\n")
                        _lf.write(f"session={tmux_session!r} op_id={op_id!r} cwd={str(root)!r}\n")
                        _lf.write(f"scheduler_args={_truncate_text(' '.join(str(x) for x in scheduler_args), 2000)}\n")
                        _lf.write(f"[fallback] attempting bootstrap via zlk1:0.0 and Popen fallback\n")
                        try:
                            _lf.write(f"tmux_ls={_tmux_ls_snapshot(env)}\n")
                        except Exception:
                            pass
                except Exception:
                    pass
                # 宽松建窗：tmux 建窗失败不直接阻断，尝试 Popen 兜底（同时记录 fallback 路径）
                try:
                    if not scheduler_exit_code_path:
                        scheduler_exit_code_path = safe_project_path(root, f"simple_cluster/tmp/cluster_scheduler/{op_id}.exit_code")
                    _popen_pid = _popen_fallback_launch(scheduler_args, root, env, log_path, scheduler_exit_code_path)
                    if _popen_pid:
                        pid = _popen_pid
                        used_tmux = False
                        scheduler_launch_error = ""
                        print(f"[info] scheduler Popen fallback succeeded pid={pid} for {tmux_session!r}", file=sys.stderr, flush=True)
                        try:
                            with open(log_path, "a", encoding="utf-8") as _lf:
                                _lf.write(f"[{now_iso()}] FALLBACK Popen scheduler launch pid={pid} (tmux failed, non-blocking)\n")
                        except Exception:
                            pass
                    else:
                        raise exc
                except Exception as _fb_exc:
                    deregister_active_run_plan(root, op_id)
                    return terminal_action(root, action, operation_id, op_id, "failed", f"scheduler tmux launch failed: {exc}; Popen fallback also failed: {_fb_exc}", {"schedulerStarted": False, "tmuxSession": tmux_session, "logPath": log_rel, "planFile": plan, "failureSource": "scheduler_tmux_launch", "error": str(exc), "logTail": _truncate_text(str(exc), 4000)}, request=payload)
        if not used_tmux and not pid:
            msg = scheduler_launch_error or "tmux available but scheduler launch failed and Popen fallback attempted"
            # 最后再尝试一次 Popen 兜底（tmux 不可用场景）
            try:
                if not scheduler_exit_code_path:
                    scheduler_exit_code_path = safe_project_path(root, f"simple_cluster/tmp/cluster_scheduler/{op_id}.exit_code")
                _popen_pid2 = _popen_fallback_launch(scheduler_args, root, env, log_path, scheduler_exit_code_path)
                if _popen_pid2:
                    pid = _popen_pid2
                    print(f"[info] scheduler Popen fallback (no tmux) succeeded pid={pid} for {tmux_session!r}", file=sys.stderr, flush=True)
                    try:
                        with open(log_path, "a", encoding="utf-8") as _lf2:
                            _lf2.write(f"[{now_iso()}] FALLBACK Popen scheduler launch pid={pid} (no tmux, non-blocking)\n")
                    except Exception:
                        pass
                else:
                    try:
                        os.makedirs(os.path.dirname(log_path), exist_ok=True)
                        with open(log_path, "a", encoding="utf-8") as _lf2:
                            _lf2.write(f"[{now_iso()}] SCHEDULER LAUNCH FAILED: {msg}\n")
                            _lf2.write(f"session={tmux_session!r} op_id={op_id!r} cwd={str(root)!r}\n")
                    except Exception:
                        pass
                    deregister_active_run_plan(root, op_id)
                    return terminal_action(root, action, operation_id, op_id, "failed", msg, {"schedulerStarted": False, "tmuxSession": tmux_session, "logPath": log_rel, "planFile": plan, "failureSource": "scheduler_tmux_launch_no_fallback", "error": msg, "logTail": _truncate_text(msg, 4000)}, request=payload)
            except Exception as _exc2:
                try:
                    os.makedirs(os.path.dirname(log_path), exist_ok=True)
                    with open(log_path, "a", encoding="utf-8") as _lf2:
                        _lf2.write(f"[{now_iso()}] SCHEDULER LAUNCH FAILED: {msg} fallback_exc={_exc2!r}\n")
                except Exception:
                    pass
                deregister_active_run_plan(root, op_id)
                return terminal_action(root, action, operation_id, op_id, "failed", msg, {"schedulerStarted": False, "tmuxSession": tmux_session, "logPath": log_rel, "planFile": plan, "failureSource": "scheduler_tmux_launch_no_fallback", "error": msg, "logTail": _truncate_text(str(_exc2), 4000)}, request=payload)
        # Register the scheduler as a tracked task so it shows up in the task cards and can be
        # stopped from the panel even though it is launched by run-plan (not a worker task). This
        # closes the gap where a stuck scheduler process was invisible to the task UI.
        scheduler_owner = str(operation_fields.get("schedulerOwnerWorkerId") or "").strip()
        scheduler_task = {
            "schemaVersion": SCHEMA_VERSION,
            "commandId": op_id,
            "operationId": operation_id,
            "runKey": op_id,
            "workerId": scheduler_owner,
            "resultOwnerWorkerId": scheduler_owner,
            "kind": "scheduler",
            "action": action,
            "status": "running",
            "pid": pid,
            "session": op_id,
            "tmuxSession": tmux_session if used_tmux else "",
            "exitCodePath": os.path.relpath(scheduler_exit_code_path, root).replace("\\", "/") if used_tmux else "",
            "logPath": log_rel,
            "plan": plan,
            "planFile": plan,
            "startedAt": now_iso(),
        }
        try:
            append_worker_task(root, scheduler_task)
        except Exception:
            pass
        try:
            register_active_run_plan(root, op_id, pid, tmux_session if used_tmux else "", worker_ids, scheduler_owner_w, "queued" if fence_result.get("blocked") else "running")
        except Exception:
            pass

        def wait_scheduler():
            try:
                _no_progress = float(env.get("SIMPLE_SCHEDULER_NO_PROGRESS") or 45)
                _launch_grace = float(env.get("SIMPLE_SCHEDULER_LAUNCH_GRACE") or 45)
                _hard_max = float(env.get("SIMPLE_SCHEDULER_WAIT_MAX") or 600)
                if used_tmux and scheduler_exit_code_path:
                    _start = time.time()
                    _last_size = _tmux_log_size(log_path)
                    _last_progress = _start
                    _last_pane_tail = ""
                    _rc = None
                    _launch_failed = False
                    while True:
                        if exit_code_ready(scheduler_exit_code_path):
                            _rc = read_task_exit_code(scheduler_exit_code_path)
                            break
                        if not tmux_session_alive(tmux_session, root, env):
                            _rc = 255
                            break
                        _now = time.time()
                        _elapsed = _now - _start
                        _size = _tmux_log_size(log_path)
                        _size_grew = (_size != _last_size)
                        if _size_grew:
                            _last_size = _size
                            _last_progress = _now
                        _python_running = _tmux_pane_python_running(tmux_session, env)
                        if _python_running:
                            # Do NOT uncritically refresh _last_progress: a "running" python
                            # process can be hung, or the pane check can be a false positive
                            # (e.g. a leftover shell). Only count it as live activity when the
                            # log actually grew (above) OR the pane produced fresh output.
                            # Otherwise the no_progress fuse below is free to fire so we never
                            # get stuck on a fake "执行中".
                            if not _size_grew:
                                _pane_tail_raw = _tmux_capture_tail(tmux_session, env) if used_tmux else ""
                                if _pane_tail_raw:
                                    _pane_tail_raw = re.sub(r"\n\s*", " ", _pane_tail_raw)
                                _pane_filtered = [_l for _l in _pane_tail_raw.splitlines() if _l.strip() and not _is_noise_line(_l)] if _pane_tail_raw else []
                                _pane_tail = "\n".join(_pane_filtered) + ("\n" if _pane_filtered else "")
                                if _pane_tail and _pane_tail != _last_pane_tail:
                                    _last_progress = _now
                                    _last_pane_tail = _pane_tail
                        # --- Busy-waiting guard: dispatch_probe "目前无空卡" + running>0 为 GPU 忙正常等待，passive_interrupt_requeue 为主动重入队，均视为有效进展，禁止 90s 误判 ---
                        _busy_or_passive_progress = False
                        try:
                            _tail_probe = ""
                            with open(log_path, "rb") as _pf:
                                _sz_probe = os.path.getsize(log_path)
                                _pf.seek(max(0, _sz_probe - 8192))
                                _tail_probe = _pf.read().decode("utf-8", errors="replace")
                            if "passive_interrupt_requeue" in _tail_probe:
                                _busy_or_passive_progress = True
                            else:
                                _running_vals_probe = re.findall(r"running=(\d+)", _tail_probe)
                                _last_running_probe = int(_running_vals_probe[-1]) if _running_vals_probe else 0
                                if _last_running_probe > 0:
                                    if re.search(r"wait\s+pending", _tail_probe, re.I):
                                        _busy_or_passive_progress = True
                                    if "dispatch_probe" in _tail_probe and "目前无空卡" in _tail_probe:
                                        _busy_or_passive_progress = True
                                    # done/dispatch 在 running>0 时亦为有效进展（但通常已由 _size_grew 覆盖，此处兜底）
                                    if re.search(r"\bdispatch\b", _tail_probe, re.I) or re.search(r"\bdone\b", _tail_probe, re.I):
                                        _busy_or_passive_progress = True
                        except Exception:
                            pass
                        if _busy_or_passive_progress:
                            _last_progress = _now
                            _last_size = _size
                        # A Plan may legitimately run for hours. Startup is already guarded by
                        # the no-progress checks below; elapsed runtime alone is not failure.
                        # Fast-fail: launch window passed, python is dead (no exit code yet)
                        # and the pane has shown no activity for _no_progress seconds. Surface
                        # the failure now instead of waiting up to hard_max (600s), so the panel
                        # is never stuck on "等待 scheduler 终态". This also catches the
                        # _send_tmux_line drop case: if the scheduler command was never sent, no
                        # exit code is ever written, but python is already dead -> immediate 255.
                        if _elapsed > _launch_grace and (not _python_running) and (_now - _last_progress) > _no_progress:
                            _rc = 255
                            _launch_failed = True
                            break
                        # python 存活但长时间无任何真实活动（日志/pane 均无增长）：视为挂死，
                        # 收口落 failed，不再无限“假执行中”。用 3x no_progress 的更宽窗口，
                        # 避免误杀启动慢或日志稀疏的真实调度（正常调度器会频繁刷新日志）。
                        if _python_running and _elapsed > _launch_grace and (_now - _last_progress) > (_no_progress * 3):
                            _rc = 255
                            _launch_failed = True
                            break
                        time.sleep(5)
                    rc = _rc
                    launch_failed = _launch_failed
                elif used_tmux:
                    while tmux_session_alive(tmux_session, root, env):
                        time.sleep(5)
                    rc = 255
                    launch_failed = False
                else:
                    rc = proc.wait() if proc is not None else 255
                    launch_failed = False
                if worker_task_was_stopped(root, scheduler_task):
                    return
                finished = {**scheduler_task, "status": "completed" if rc == 0 else "failed", "exitCode": rc, "finishedAt": now_iso()}
                append_worker_task(root, finished)
                if rc != 0:
                    # The scheduler process exited with a non-zero code but no
                    # terminal operation event reached the journal (it died during
                    # startup, was killed externally, or crashed before writing
                    # its own terminal event). Close the loop so the Operations
                    # panel never hangs on "等待 scheduler 终态".
                    try:
                        if not operation_already_terminal(root, operation_id):
                            log_tail = ""
                            try:
                                lp = safe_project_path(root, log_rel)
                                if os.path.isfile(lp):
                                    _eff_log_tail, _eff_cnt, _ = _read_effective_tail(lp, max_bytes=8000)
                                    log_tail = _eff_log_tail[-8000:] if _eff_log_tail else ""
                            except Exception:
                                log_tail = ""
                            evidence = scheduler_process_evidence(root, pid if pid else finished.get("pid"), tmux_session if used_tmux else "")
                            message = f"调度器进程退出码 {rc}，未收到调度器终态事件。"
                            if launch_failed:
                                pane_tail_raw = _tmux_capture_tail(tmux_session, env) if used_tmux else ""
                                if pane_tail_raw:
                                    pane_tail_raw = re.sub(r"\n\s*", " ", pane_tail_raw)
                                _pane_filtered_msg = [_l for _l in pane_tail_raw.splitlines() if _l.strip() and not _is_noise_line(_l)] if pane_tail_raw else []
                                pane_tail = "\n".join(_pane_filtered_msg) + ("\n" if _pane_filtered_msg else "")
                                python_running = _tmux_pane_python_running(tmux_session, env) if used_tmux else False
                                _total_wait = _launch_grace + _no_progress
                                message = ("调度器启动失败：tmux 会话存活但合计 %.0fs 内无有效日志增长且未生成 exit_code（pane 内 python 进程：%s）。%s"
                                           % (_total_wait, "存在" if python_running else "不存在", f"调度器进程退出码 {rc}，未收到调度器终态事件。"))
                                if pane_tail:
                                    _pt_slice = pane_tail[-600:]
                                    if not _pt_slice.endswith("\n"):
                                        _pt_slice += "\n"
                                    message += " pane 尾部：\n" + _pt_slice
                            if log_tail:
                                if not log_tail.endswith("\n"):
                                    log_tail += "\n"
                                _lt_slice = log_tail[-2000:]
                                if not _lt_slice.endswith("\n"):
                                    _lt_slice += "\n"
                                message += " 日志尾部：\n" + _lt_slice
                                if not message.endswith("\n"):
                                    message += "\n"
                            terminal_action(root, action, operation_id, op_id, "failed", message, {
                                "pid": pid,
                                "tmuxSession": tmux_session if used_tmux else "",
                                "exitCode": rc,
                                "logPath": log_rel,
                                "logTail": log_tail[-8000:],
                                "planFile": plan,
                                "schedulerStarted": True,
                                "launchFailed": launch_failed,
                                "failureSource": "agent_scheduler_wait" if not launch_failed else "agent_scheduler_launch_failure",
                                "evidence": evidence,
                            }, request=payload)
                    except Exception:
                        pass
            except Exception:
                # Thread-level exception (e.g. Popen crashed, environment issue).
                # Still terminate the operation so it is never stuck running.
                try:
                    if not worker_task_was_stopped(root, scheduler_task) and not operation_already_terminal(root, operation_id):
                        err = traceback.format_exc()
                        last_err = err.splitlines()[-1] if err.splitlines() else "unknown"
                        _exc_log_tail = ""
                        try:
                            _lp = safe_project_path(root, log_rel)
                            if os.path.isfile(_lp):
                                _eff_exc_tail, _, _ = _read_effective_tail(_lp, max_bytes=8000)
                                _exc_log_tail = _eff_exc_tail[-8000:] if _eff_exc_tail else ""
                        except Exception:
                            _exc_log_tail = ""
                        terminal_action(root, action, operation_id, op_id, "failed", "调度器监视线程异常：" + last_err, {
                            "pid": pid,
                            "tmuxSession": tmux_session if used_tmux else "",
                            "logPath": log_rel,
                            "logTail": _exc_log_tail,
                            "planFile": plan,
                            "schedulerStarted": True,
                            "failureSource": "agent_scheduler_wait_exception",
                            "error": err,
                        }, request=payload)
                except Exception:
                    pass
            finally:
                deregister_active_run_plan(root, op_id)
        threading.Thread(target=wait_scheduler, daemon=True, name=f"scheduler-{op_id}").start()
        label = "scheduler reproduced" if action == "reproduce-plan" else "scheduler started"
        extra = {"pid": pid, "tmuxSession": tmux_session if used_tmux else "", "logPath": log_rel, "planFile": plan, "submissionAccepted": True, "schedulerStarted": True, "debugMode": debug_mode, "debugRunId": debug_run_id if debug_mode else "", "debugOutputDir": debug_output_dir, "validation": {"ok": True, "jobCount": len(validation.get("jobs") or []) if isinstance(validation, dict) else 0}, "fenced": fence_result.get("fenced") or [], "reapedZombies": fence_result.get("reapedZombies") or []}
        # Log fence for manual verification: same worker second run-plan should fence first, visible as fenced opId
        if fence_result.get("fenced"):
            msg_suffix = f" 已 fence 旧调度器 {', '.join(fence_result['fenced'])}"
        elif fence_result.get("reapedZombies"):
            msg_suffix = f" 已清理僵尸会话 {', '.join(fence_result['reapedZombies'])}"
        else:
            msg_suffix = ""
        queue_wait = fence_result.get("blocked") or []
        return progress_action(root, action, operation_id, op_id, "queued" if queue_wait else "running", (f"Plan 已排队，等待同一 Worker 的 {len(queue_wait)} 个前序 Plan 完成。" if queue_wait else f"{label} pid={pid}，等待 scheduler 终态。{msg_suffix}"), extra, request=payload)
    if action == "retry-experiment":
        worker_id = selected_worker_id(payload)
        if not worker_id:
            return terminal_action(root, action, operation_id, op_id, "failed", "缺少 workerId，无法定位要重试的 Worker")
        command = dict(payload)
        command["action"] = "retry-worker-task"
        command["commandId"] = op_id
        item = enqueue_worker_command(root, worker_id, command)
        return terminal_action(root, action, operation_id, op_id, "completed", f"已向 Worker {worker_id} 下发重试命令", {"workerId": worker_id, "command": item})
    if action == "stop-experiment":
        plan = action_plan_file(payload)
        manual_type = str(payload.get("manualStopType") or payload.get("stopReason") or "manual_stop_bad_code_or_no_effect").strip()
        paths = write_scheduler_control(root, "abort_cleanup", plan, action, {"manualStopType": manual_type, "stopReason": manual_type, "stopSource": "user"})
        return terminal_action(root, action, operation_id, op_id, "completed", f"已写入 {len(paths)} 个调度控制文件用于手动中断任务", {"controlFiles": [os.path.relpath(p, root).replace("\\", "/") for p in paths if p.startswith(os.path.abspath(root))], "manualStopType": manual_type, "requiresManualReview": True})
    if action == "complete-three-way":
        keys = action_target_keys(payload)
        if not keys:
            return terminal_action(root, action, operation_id, op_id, "failed", "没有选择可校验目标。")
        report, report_path = complete_three_way_report(root, keys, op_id, action_plan_file(payload), action_operation_fields(payload))
        status = "completed" if report.get("status") == "passed" else "failed"
        message = f"三方一致校验：{report.get('status')}，缺失 {report.get('missingCount', 0)} 项，未归档 {report.get('unarchivedCount', 0)} 项"
        return terminal_action(root, action, operation_id, op_id, status, message, {"threeWay": report, "threeWayPath": report_path, "planFile": report.get("planFile") or action_plan_file(payload) or ""}, request=payload)
    if action == "sync-artifacts":
        keys = action_target_keys(payload)
        if not keys:
            return terminal_action(root, action, operation_id, op_id, "failed", "没有选择可检查的同步清单目标。")
        manifest, manifest_path, resolved_keys = prepare_archive_manifest(root, keys, action, op_id, action_plan_file(payload), action_operation_fields(payload))
        missing = int(manifest.get("missingCount") or 0)
        status = "failed" if missing else "completed"
        message = f"同步清单检查完成（未传输文件）：{len(resolved_keys)} 个目标，{manifest.get('fileCount', 0)} 个文件，缺失 {missing} 个"
        return terminal_action(root, action, operation_id, op_id, status, message, {"archiveKeys": resolved_keys, "requestedArchiveKeys": keys, "syncManifest": manifest, "syncManifestPath": manifest_path, "manifestPath": manifest_path, "planFile": action_plan_file(payload) or ""}, request=payload)
    if action == "exclude-results":
        keys = list(dict.fromkeys(action_target_keys(payload) + action_values(payload, "artifactPath", "resultPath", "confirmationPath") + action_task_target_values(payload)))
        plan = action_plan_file(payload)
        revision = action_operation_fields(payload).get("planRevision") or ""
        if not keys:
            return terminal_action(root, action, operation_id, op_id, "failed", "没有选择要排除的结果记录。", request=payload)
        if not plan or not revision:
            return terminal_action(root, action, operation_id, op_id, "failed", "缺少当前 Plan 或 revision，不能修改旧任务的结果状态。", request=payload)
        try:
            mark_result_review_state(root, keys, "excluded", plan, revision, action_operation_fields(payload))
        except Exception as exc:
            return terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload)
        return terminal_action(root, action, operation_id, op_id, "completed", f"已排除 {len(keys)} 条结果；完整预览保留，未删除任务或产物。", {"excludedKeys": keys, "planFile": plan, "planRevision": revision}, request=payload)
    if action in ("archive-artifacts", "archive-worker-artifacts"):
        keys = action_target_keys(payload)
        if not keys:
            return terminal_action(root, action, operation_id, op_id, "failed", "没有选择可归档目标。")
        operation_fields = action_operation_fields(payload)
        manifest, manifest_path, resolved_keys = prepare_archive_manifest(root, keys, action, op_id, action_plan_file(payload), operation_fields)
        missing = int(manifest.get("missingCount") or 0)
        if missing:
            return terminal_action(root, action, operation_id, op_id, "failed", f"归档准备失败：{missing} 个目标缺失", {"archiveKeys": resolved_keys, "requestedArchiveKeys": keys, "archiveManifest": manifest, "archiveManifestPath": manifest_path, "manifestPath": manifest_path, "planFile": action_plan_file(payload) or ""})
        mark_archive_state(root, resolved_keys, action, action_plan_file(payload), operation_fields.get("planRevision") or "", operation_fields)
        message = f"归档准备完成：{len(resolved_keys)} 个目标，{manifest.get('fileCount', 0)} 个文件，缺失 {manifest.get('missingCount', 0)} 个目标"
        return terminal_action(root, action, operation_id, op_id, "completed", message, {"archiveKeys": resolved_keys, "requestedArchiveKeys": keys, "archiveManifest": manifest, "archiveManifestPath": manifest_path, "manifestPath": manifest_path, "planFile": action_plan_file(payload) or ""}, request=payload)
    if action in ("delete-artifacts", "reconcile-deletions", "delete-worker-artifacts"):
        if payload.get("confirm") is not True or payload.get("pathConfirmed") is not True:
            return terminal_action(root, action, operation_id, op_id, "failed", "CONFIRM_REQUIRED: 必须分别确认删除操作和完整路径。", request=payload)
        keys = action_delete_target_paths(payload)
        if not keys:
            return terminal_action(root, action, operation_id, op_id, "failed", "没有选择可删除的精确绝对路径；不支持按任务标识搜索删除。", request=payload)
        invalid_paths = [value for value in keys if not os.path.isabs(str(value).replace("\\", os.sep))]
        if invalid_paths:
            return terminal_action(root, action, operation_id, op_id, "failed", "删除要求每个目标都是绝对路径；已拒绝不完整或相对路径。", {"invalidPathCount": len(invalid_paths)}, request=payload)
        if len(keys) > 2000:
            return terminal_action(root, action, operation_id, op_id, "failed", "单次删除目标超过 2000 个上限。", request=payload)
        deleted, residues, skipped = remove_project_targets(root, keys, payload.get("confirm"), payload.get("pathConfirmed"))
        status = "failed" if residues or skipped else "completed"
        summary = {
            "targetCount": len(keys),
            "deletedCount": len(deleted),
            "skippedCount": len(skipped),
            "residueCount": len(residues),
            "deleted": deleted,
            "skipped": skipped,
            "residues": residues,
            "planFile": normalize_result_candidate(action_plan_file(payload)) if action_plan_file(payload) else "",
        }
        append_event(root, {"type": "delete_progress", "operationId": operation_id, "payload": {"action": action, "opId": op_id, **summary}})
        message = f"删除完成：成功 {len(deleted)} 项，跳过 {len(skipped)} 项，残留 {len(residues)} 项"
        if status == "failed":
            message = f"删除未完全完成：成功 {len(deleted)} 项，跳过 {len(skipped)} 项，残留 {len(residues)} 项"
        return terminal_action(root, action, operation_id, op_id, status, message, summary)
    if action == "finalize-worker-operation":
        return terminal_action(root, action, operation_id, op_id, "completed", "Worker 操作终态已确认")
    if action == "run-quality-gate":
        report = run_quality_gate_action(root, action_plan_file(payload), action_operation_fields(payload).get("planRevision") or "")
        return terminal_action(root, action, operation_id, op_id, "completed", f"质量门禁完成：{report.get('status')}，问题 {len(report.get('issues') or [])} 个", {"qualityGate": report, "qualityGatePath": report.get("path") or report.get("qualityGatePath") or "simple_cluster/results/quality_gate.json", "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "run-statistics":
        report = compute_statistics_action(root, action_plan_file(payload), action_operation_fields(payload).get("planRevision") or "")
        return terminal_action(root, action, operation_id, op_id, "completed", f"统计完成：{len(report.get('rows') or [])} 组", {"statistics": report, "statisticsPath": report.get("path") or report.get("statisticsPath") or "simple_cluster/results/statistics.json", "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "export-paper-table":
        report = export_paper_table_action(root, action_plan_file(payload), action_operation_fields(payload).get("planRevision") or "")
        return terminal_action(root, action, operation_id, op_id, "completed", f"论文表格已导出：{report.get('path')}", {"paperTable": report, "paperTablePath": report.get("path"), "exportPath": report.get("path")}, request=payload)
    if action == "check-claim-evidence":
        plan = action_plan_file(payload)
        plan_revision = action_operation_fields(payload).get("planRevision") or ""
        summary = read_current_results_summary(root, plan or None, plan_revision)
        apply_final_evidence_summary(root, summary)
        report = evaluate_claim_evidence(root, summary)
        apply_claim_evidence_summary(summary, report)
        write_results_summary_v2(root, summary)
        status = "completed" if report.get("status") == "passed" else "failed"
        return terminal_action(root, action, operation_id, op_id, status, f"论文证据检查：{report.get('status')}，unsupported {report.get('unsupportedCount', 0)}，needs experiment {report.get('needsExperimentCount', 0)}", {"claimEvidence": report, "claimEvidencePath": report.get("path") or "simple_cluster/results/claim_evidence.json", "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "create-debug-bundle":
        plan = action_plan_file(payload)
        bundle = create_debug_bundle_action(root, False, plan)
        return terminal_action(root, action, operation_id, op_id, "completed", f"调试包已生成：{bundle.get('path')}", {"bundlePath": bundle.get("path"), "debugBundlePath": bundle.get("path"), "path": bundle.get("path"), "latestPath": bundle.get("latestPath") or "", "bundleDir": bundle.get("bundleDir") or "", "size": bundle.get("size"), "planFile": bundle.get("planFile") or plan or "", "includeResults": False})
    if action == "create-offline-bundle":
        plan = action_plan_file(payload)
        bundle = create_debug_bundle_action(root, True, plan)
        return terminal_action(root, action, operation_id, op_id, "completed", f"离线包已生成：{bundle.get('path')}", {"bundlePath": bundle.get("path"), "offlineBundlePath": bundle.get("path"), "path": bundle.get("path"), "latestPath": bundle.get("latestPath") or "", "bundleDir": bundle.get("bundleDir") or "", "size": bundle.get("size"), "planFile": bundle.get("planFile") or plan or "", "includeResults": True})
    if action == "check-output-contract":
        report = check_output_contract_action(root, action_plan_file(payload))
        status = "failed" if report.get("status") == "failed" else "completed"
        return terminal_action(root, action, operation_id, op_id, status, report.get("message") or report.get("status"), {"contractReport": report, "contractReportPath": report.get("path") or "simple_cluster/contracts/contract_check_reports/latest.json", "contractIssueType": report.get("issueType") or "", "missingCount": len(report.get("missing") or []), "missingFiles": report.get("missing") or [], "unparseableCount": len(report.get("unparseableFiles") or []), "unparseableFiles": report.get("unparseableFiles") or [], "unparseable": report.get("unparseable") or [], "parseableResultCount": int(report.get("parseableResultCount") or 0), "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "parse-case-level":
        report = parse_case_level_action(root, action_plan_file(payload))
        return terminal_action(root, action, operation_id, op_id, "completed", f"Case-level 解析完成：{report.get('caseCount', 0)} 条", {"caseLevel": report, "caseLevelPath": report.get("path") or "simple_cluster/results/case_level_index.json", "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "run-leakage-check":
        report = run_leakage_check_action(root, action_plan_file(payload))
        status = "failed" if report.get("status") == "failed" else "completed"
        return terminal_action(root, action, operation_id, op_id, status, f"泄漏检查：{report.get('status')}，问题 {len(report.get('issues') or [])} 个", {"leakageCheck": report, "leakageCheckPath": report.get("path") or "simple_cluster/results/leakage_check.json", "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "run-subgroup-analysis":
        report = run_subgroup_analysis_action(root, action_plan_file(payload))
        return terminal_action(root, action, operation_id, op_id, "completed", f"亚组分析完成：{len(report.get('rows') or [])} 组", {"subgroupAnalysis": report, "subgroupAnalysisPath": report.get("path") or "simple_cluster/results/subgroup_analysis.json", "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "export-case-analysis":
        report = export_case_analysis_action(root, action_plan_file(payload))
        return terminal_action(root, action, operation_id, op_id, "completed", f"Case 分析已导出：{report.get('path')}", {"caseAnalysis": report, "caseAnalysisPath": report.get("path"), "planFile": report.get("planFile") or action_plan_file(payload)}, request=payload)
    if action == "plan-checkpoint-retention":
        report = checkpoint_retention_action(root, payload)
        return terminal_action(root, action, operation_id, op_id, "completed", f"Checkpoint dry-run 完成：计划删除 {report.get('deleteCount', 0)}，保留 {report.get('keepCount', 0)}，跳过 {report.get('skipCount', 0)}", {"checkpointPlan": report, "planFile": report.get("planFile") or action_plan_file(payload) or "", "deletePlanPath": report.get("deletePlanPath") or "simple_cluster/checkpoints/delete_plan.json", "retentionReportPath": report.get("retentionReportPath") or "simple_cluster/checkpoints/retention_report.md"}, request=payload)
    if action == "inspect-dataset":
        report = inspect_dataset_action(root, payload)
        status = "failed" if (report.get("leakage") or {}).get("status") == "failed" else "completed"
        outputs = (report.get("outputFiles") or {}) if isinstance(report, dict) else {}
        return terminal_action(root, action, operation_id, op_id, status, f"Dataset 画像完成：{report.get('totalRows', 0)} 行，泄漏状态 {(report.get('leakage') or {}).get('status')}", {"datasetProfile": report, "planFile": report.get("planFile") or action_plan_file(payload) or "", "datasetProfilePath": outputs.get("profileJson") or "simple_cluster/datasets/profile.json", "datasetProfileMarkdownPath": outputs.get("profileMarkdown") or "simple_cluster/datasets/profile.md", "leakageReportCsvPath": outputs.get("leakageReportCsv") or "simple_cluster/datasets/leakage_report.csv"}, request=payload)
    if action == "export-plotting-contract":
        report = export_plotting_contract_action(root, action_plan_file(payload))
        return terminal_action(root, action, operation_id, op_id, "completed", f"PPT 绘图契约已导出：{report.get('path')}", {"plottingContract": report.get("contract"), "plottingContractPath": report.get("path"), "plottingContractMarkdownPath": report.get("markdownPath")}, request=payload)
    if action == "infer-config-from-run":
        recovered = infer_config_payload(root, payload)
        status = "failed" if any((item.get("status") == "needs_user_input") for item in (recovered.get("fields") or {}).values() if isinstance(item, dict) and item.get("message")) else "completed"
        return terminal_action(root, action, operation_id, op_id, status, f"实验配置反推完成：{len(recovered.get('warnings') or [])} 条警告", {"recoveredConfig": recovered, "planFile": recovered.get("planFile") or action_plan_file(payload) or ""}, request=payload)
    if action == "recover-plan-from-run":
        report = recover_plan_from_run_action(root, payload)
        status = "failed" if report.get("status") == "failed" else "completed"
        return terminal_action(root, action, operation_id, op_id, status, f"Recovered plan 已生成：{report.get('yamlPath')}", {"recoveredPlan": report.get("recovered"), "recoveredPlanYamlPath": report.get("yamlPath"), "recoveredPlanJsonPath": report.get("jsonPath"), "recoveredPlanReportPath": report.get("reportPath"), "planFile": report.get("planFile") or action_plan_file(payload) or ""}, request=payload)
    if action in ("diagnose-result-anomaly", "compare-with-best-config"):
        report = diagnose_result_anomaly_action(root, payload)
        status = "failed" if any(item.get("severity") == "critical" for item in report.get("causes") or []) else "completed"
        label = "配置对比" if action == "compare-with-best-config" else "异常诊断"
        return terminal_action(root, action, operation_id, op_id, status, f"{label}完成：{len(report.get('causes') or [])} 条原因", {"anomalyDiagnosis": report, "anomalyPath": report.get("outputFiles", {}).get("jsonPath"), "configDiffPath": report.get("outputFiles", {}).get("configDiffPath")}, request=payload)
    if action in ("start-tensorboard", "stop-tensorboard", "get-tensorboard-status"):
        return tensorboard_action(root, action, payload, operation_id, op_id)
    if action == "install-rich":
        return install_rich_action(root, payload, operation_id, op_id)
    if action == "cancel-operation":
        cancel_inactivity_action(root, str(payload.get("targetOperationId") or payload.get("remoteOperationId") or ""), action_plan_file(payload))
        return terminal_action(root, action, operation_id, op_id, "cancelled", "操作已取消")
    if action in ("deploy-runtime", "restart-agent"):
        return terminal_action(root, action, operation_id, op_id, "failed", f"{action} 必须由 VS Code 本地插件通过 Xshell 会话或 SimpleSFTP 执行，Hub Agent 不直接自修改")
    unsupported = {
    }
    if action in unsupported:
        return terminal_action(root, action, operation_id, op_id, "failed", unsupported[action])
    return terminal_action(root, action, operation_id, op_id, "failed", f"不支持的操作：{action}")

WORKER_LAUNCH_CONTEXT_CACHE = {}
WORKER_LAUNCH_CONTEXT_CACHE_LOCK = threading.Lock()
MAX_WORKER_LAUNCH_CONTEXT_CACHE_RECORDS = 200


def read_worker_task_launch_prefix(root, task, max_bytes=256 * 1024):
    log_rel = str(task.get("logPath") or task.get("log_path") or "").strip()
    if not log_rel:
        return ""
    try:
        path = safe_project_path(root, log_rel)
        with open(path, "rb") as stream:
            data = stream.read(max_bytes)
        return data.decode("utf-8", errors="replace")
    except Exception:
        return ""


def worker_launch_path_values(text):
    source = str(text or "")
    config_values = re.findall(r"""["'](?:config_path|config)["']\s*:\s*["']([^"'\r\n]+)["']""", source)
    output_values = re.findall(r"""["'](?:output_dir|outputDir)["']\s*:\s*["']([^"'\r\n]+)["']""", source)
    for pattern, target in (
        (r"""(?<!\S)--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))""", config_values),
        (r"""(?<!\S)--(?:output-dir|output_dir)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))""", output_values),
    ):
        for groups in re.findall(pattern, source):
            target.append(next((value for value in groups if value), ""))
    normalize = lambda value: str(value or "").replace("\\", "/").strip().strip("'\"")
    configs = {normalize(value) for value in config_values if normalize(value)}
    outputs = {normalize(value) for value in output_values if normalize(value)}
    if len(configs) > 1 or len(outputs) > 1:
        return {"config_path": "", "output_dir": "", "ambiguous": True}
    return {
        "config_path": next(iter(configs), ""),
        "output_dir": next(iter(outputs), ""),
        "ambiguous": False,
    }


def cached_worker_launch_path_values(root, task):
    log_rel = str(task.get("logPath") or task.get("log_path") or "").strip()
    if not log_rel:
        return {"config_path": "", "output_dir": "", "ambiguous": False}
    try:
        path = safe_project_path(root, log_rel)
        stat = os.stat(path)
        signature = (path, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
    except Exception:
        return {"config_path": "", "output_dir": "", "ambiguous": False}
    with WORKER_LAUNCH_CONTEXT_CACHE_LOCK:
        cached = WORKER_LAUNCH_CONTEXT_CACHE.get(path)
        if cached and cached["signature"] == signature:
            cached["lastUsedAt"] = time.monotonic()
            return dict(cached["values"])
    values = worker_launch_path_values(read_worker_task_launch_prefix(root, task))
    with WORKER_LAUNCH_CONTEXT_CACHE_LOCK:
        WORKER_LAUNCH_CONTEXT_CACHE[path] = {
            "signature": signature, "values": values, "lastUsedAt": time.monotonic(),
        }
        if len(WORKER_LAUNCH_CONTEXT_CACHE) > MAX_WORKER_LAUNCH_CONTEXT_CACHE_RECORDS:
            oldest = min(WORKER_LAUNCH_CONTEXT_CACHE, key=lambda key: WORKER_LAUNCH_CONTEXT_CACHE[key]["lastUsedAt"])
            WORKER_LAUNCH_CONTEXT_CACHE.pop(oldest, None)
    return values


def recover_worker_task_launch_paths(root, task):
    row = dict(task)
    config_path = str(row.get("configPath") or row.get("config_path") or "").replace("\\", "/").strip()
    output_dir = str(row.get("outputDir") or row.get("output_dir") or "").replace("\\", "/").strip()
    if config_path and output_dir:
        return row
    if config_path:
        try:
            if os.path.isfile(safe_project_path(root, config_path)):
                row["outputDir"] = os.path.dirname(config_path).replace("\\", "/")
        except Exception:
            pass
        return row
    if output_dir:
        candidate = output_dir.rstrip("/") + "/job_config.yaml"
        try:
            if os.path.isfile(safe_project_path(root, candidate)):
                row["configPath"] = candidate
        except Exception:
            pass
        return row
    values = cached_worker_launch_path_values(root, task)
    if values["ambiguous"]:
        return row
    recovered_config = values["config_path"]
    recovered_output = values["output_dir"]
    if recovered_config:
        try:
            if os.path.isfile(safe_project_path(root, recovered_config)):
                row["configPath"] = recovered_config
        except Exception:
            pass
    if recovered_output:
        try:
            safe_project_path(root, recovered_output)
            row["outputDir"] = recovered_output
        except Exception:
            pass
    elif row.get("configPath"):
        row["outputDir"] = os.path.dirname(row["configPath"]).replace("\\", "/")
    if row.get("outputDir") and not row.get("configPath"):
        candidate = str(row["outputDir"]).rstrip("/") + "/job_config.yaml"
        try:
            if os.path.isfile(safe_project_path(root, candidate)):
                row["configPath"] = candidate
        except Exception:
            pass
    return row


WORKER_TASK_FAILURE_CACHE = {}

def worker_task_failure_message(root, task, use_cache=True):
    output_dir = str(task.get("outputDir") or "").strip().replace("\\", "/").rstrip("/")
    if not output_dir:
        return ""
    try:
        stderr_path = safe_project_path(root, output_dir + "/stderr.log")
        stat = os.stat(stderr_path)
        cache_key = (stderr_path, stat.st_mtime_ns, stat.st_size)
        if use_cache and cache_key in WORKER_TASK_FAILURE_CACHE:
            return WORKER_TASK_FAILURE_CACHE[cache_key]
        with open(stderr_path, "rb") as stream:
            stream.seek(max(0, stat.st_size - 8192))
            tail = stream.read(8192).decode("utf-8", errors="replace")
        lines = [line.strip() for line in tail.splitlines() if line.strip()]
        message = next((line for line in reversed(lines) if "Error:" in line or "Exception:" in line), lines[-1] if lines else "")[:600]
        if use_cache:
            if len(WORKER_TASK_FAILURE_CACHE) >= 512:
                WORKER_TASK_FAILURE_CACHE.clear()
            WORKER_TASK_FAILURE_CACHE[cache_key] = message
        return message
    except (OSError, ValueError):
        return ""

def api_worker_tasks(root):
    try:
        reconcile_worker_task_exit_codes(root)
        sync_durable_plan_task_rows(root)
    except Exception:
        pass
    data = read_runtime_json_cached(path_for(root, "worker_task_snapshot.json"), None)
    if isinstance(data, dict):
        tasks = data.get("tasks") if isinstance(data.get("tasks"), list) else []
        enriched = []
        for _item in tasks:
            if not isinstance(_item, dict):
                continue
            _row = recover_worker_task_launch_paths(root, _item)
            if str(_row.get("status") or "").lower() == "failed" and not _row.get("error"):
                failure_message = worker_task_failure_message(root, _row)
                if failure_message:
                    _row["error"] = failure_message
            _target = str(_row.get("tmuxTarget") or _row.get("tmuxSession") or "").strip()
            if not _target:
                _gid_tmp = str(_row.get("gpuId") or _row.get("gpu_id") or _row.get("gpu") or _row.get("targetGpuId") or "").strip()
                if _gid_tmp:
                    try:
                        _prefix_tmp = _resolve_tmux_prefix(None, None, None)
                        _target = fixed_gpu_window_name(_prefix_tmp, _gid_tmp)
                    except Exception:
                        _target = ""
                else:
                    _sess_tmp = str(_row.get("session") or "").strip()
                    if _sess_tmp:
                        _target = simple_tmux_name(_sess_tmp) if "gpu-" not in _sess_tmp else _sess_tmp
            if _target:
                _row["tmuxTarget"] = _target
                if not str(_row.get("tmuxSession") or "").strip():
                    _row["tmuxSession"] = _target
                _row.setdefault("window", _target)
            enriched.append(_row)
        _out = dict(data)
        positions = {str(item.get("commandId") or ""): index for index, item in enumerate(enriched) if isinstance(item, dict) and item.get("commandId")}
        for row in read_durable_plan_queue(root).get("jobs", []):
            if not isinstance(row, dict):
                continue
            status = str(row.get("status") or "unknown").lower()
            if status in ("queued", "dispatching", "running", "unknown", "completed", "failed", "cancelled"):
                entry = durable_plan_public_task(row)
                index = positions.get(str(row.get("commandId") or ""))
                if index is None:
                    positions[str(row.get("commandId") or "")] = len(enriched)
                    enriched.append(entry)
                elif durable_plan_same_identity(row, enriched[index]):
                    enriched[index] = {**enriched[index], **entry}
                else:
                    entry["identityConflict"] = True
                    entry["error"] = "worker task snapshot identity conflicts with durable Plan queue"
                    if status not in ("completed", "failed", "cancelled"):
                        entry["status"] = "unknown"
                    enriched[index] = entry
        _out["tasks"] = enriched
        _out["generatedAt"] = now_iso()
        _out["capabilities"] = {"durablePlanQueue": True, "codeSyncProof": True, "idleGpuAdmission": True, "queuedJobRecall": True, "schemaVersion": 1}
        return _out
    tasks = []
    for row in read_durable_plan_queue(root).get("jobs", []):
        if not isinstance(row, dict):
            continue
        status = str(row.get("status") or "unknown").lower()
        if status in ("queued", "dispatching", "running", "unknown", "completed", "failed", "cancelled"):
            tasks.append(durable_plan_public_task(row))
    return {"schemaVersion": SCHEMA_VERSION, "tasks": tasks,
            "capabilities": {"durablePlanQueue": True, "codeSyncProof": True, "idleGpuAdmission": True, "queuedJobRecall": True, "schemaVersion": 1}, "generatedAt": now_iso()}

def api_openapi(root, token_required=False, mode="hub_control"):
    if mode == "worker_telemetry":
        paths = [
            "/api/health",
            "/api/version",
            "/api/capabilities",
            "/api/gpu",
            "/api/gpu/history",
            "/api/worker/availability",
            "/api/worker/tasks",
            "/api/worker/commands",
            "/api/workers/uplink/commands/sse",
            "/api/live-output",
            "/api/diagnostics",
            "/api/code-sync/inspect",
            "/api/events",
            "/api/events/sse",
            "/api/operations/{id}",
            "/api/actions/start-worker-task",
            "/api/actions/register-code-sync-proof",
            "/api/actions/rebuild-distributed-results",
            "/api/actions/retry-worker-task",
            "/api/actions/stop-worker-task",
            "/api/actions/delete-worker-artifacts",
            "/api/actions/archive-worker-artifacts",
            "/api/actions/validate-plan",
            "/api/actions/dry-run-plan",
            "/api/actions/run-plan",
            "/api/actions/reproduce-plan",
            "/api/actions/start-tensorboard",
            "/api/actions/stop-tensorboard",
            "/api/actions/get-tensorboard-status",
            "/api/actions/install-rich",
            "/api/tensorboard/proxy",
            "/api/tensorboard/ui/{path}",
        ]
        return {
            "openapi": "3.0.0",
            "info": {"title": "SimpleExperiment Worker Telemetry API", "version": API_VERSION},
            "paths": {path: {} for path in paths},
            "x-simple-capabilities": api_capabilities(root, token_required, mode),
        }
    return {
        "openapi": "3.0.0",
        "info": {"title": "SimpleExperiment Hub Agent Realtime Gateway", "version": API_VERSION},
        "paths": {path: {} for path in [
            "/api/health",
            "/api/version",
            "/api/capabilities",
            "/api/files/capabilities",
            "/api/code-sync/inspect",
            "/api/openapi.json",
            "/api/snapshot",
            "/api/gpu",
            "/api/gpu/history",
            "/api/scheduler",
            "/api/traces",
            "/api/live-output",
            "/api/results/summary",
            "/api/diagnostics",
            "/api/audit/tail",
            "/api/events",
            "/api/events/sse",
            "/api/operations/{id}",
            "/api/logs/tail",
            "/api/logs/stream",
            "/api/files/list",
            "/api/files/stat",
            "/api/files/download",
            "/api/files/download-range",
            "/api/files/upload-init",
            "/api/files/upload-chunk",
            "/api/files/upload-complete",
            "/api/files/upload-cancel",
            "/api/files/transfer-status",
            "/api/workers/uplink/events",
            "/api/tensorboard/proxy",
            "/api/tensorboard/ui/{path}",
        ] + ACTION_PATHS},
        "x-simple-capabilities": api_capabilities(root, token_required, mode),
    }

def api_diagnostics(root, include_token=False):
    health = inspect_agent(root)
    result = {
        "agentVersion": health.get("agentVersion") or AGENT_VERSION,
        "running": health.get("running"),
        "serverTime": now_iso(),
        "directPluginAccessDisabled": True,
        "agentInstallDir": agent_install_dir(root),
        "agentStateDir": agent_dir(root),
        "stateRetentionSeconds": STATE_RETENTION_SECONDS,
        "tmpRetentionSeconds": TMP_RETENTION_SECONDS,
        "journalMaxEvents": MAX_EVENTS,
        "journalMaxBytes": MAX_JOURNAL_BYTES,
        "maxAgentStateBytes": MAX_AGENT_STATE_BYTES,
        "agentStatePrune": dict(AGENT_STATE_PRUNE_DIAGNOSTICS),
        "tokenConfigured": bool((read_runtime_json_cached(path_for(root, "agent.session.json"), {}) or {}).get("tokenConfigured")),
        "schedulerDependencies": scheduler_dependency_health(root),
    }
    return result

# L2 审计尾预算：min(1MB, max(64KB, line_limit*4096))，与 L1 实时尾 256KB 协同，避免审计尾过大撑爆前端，需与 _read_effective_tail L3 预算统一文档化
def audit_tail_byte_budget(line_limit):
    return min(AUDIT_TAIL_MAX_BYTES, max(64 * 1024, int(line_limit) * 4096))

def read_audit_tail(root, lines=100):
    line_limit = max(1, int(lines or 100))
    byte_limit = audit_tail_byte_budget(line_limit)
    candidates = [
        os.path.join(root, "simple_cluster", "logs", "operation_audit.jsonl"),
        os.path.join(root, "simple_cluster", "tmp", "operation_audit.jsonl"),
    ]
    for p in candidates:
        if not os.path.isfile(p):
            continue
        with open(p, "rb") as f:
            f.seek(0, os.SEEK_END)
            start = max(0, f.tell() - byte_limit)
            f.seek(start)
            data = f.read(byte_limit)
        if start:
            boundary = data.find(b"\n")
            data = data[boundary + 1:] if boundary >= 0 else b""
        text = data.decode("utf-8", errors="replace")
        return "".join(text.splitlines(keepends=True)[-line_limit:])
    return ""

def read_results_summary(root, plan=None, cached=False):
    read_summary = read_runtime_json_cached if cached else read_json
    plan_norm = normalize_result_candidate(plan) if plan else ""
    if plan_norm:
        plan_path = os.path.join(root, *plan_results_summary_relpath(plan_norm).split("/"))
        data = read_summary(plan_path, None)
        if isinstance(data, dict):
            if not data.get("planFile"):
                data = {**data, "planFile": plan_norm}
            return data
        return {"schemaVersion": SCHEMA_VERSION, "results": [], "planFile": plan_norm}
    candidates = [
        os.path.join(root, "simple_cluster", "results_summary.json"),
        os.path.join(root, "simple_cluster", "results", "summary.json"),
    ]
    existing = [p for p in candidates if os.path.isfile(p)]
    existing.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for p in existing:
        data = read_summary(p, None)
        if data is not None:
            return data
    return {"schemaVersion": SCHEMA_VERSION, "results": []}

def read_current_results_summary(root, plan=None, plan_revision=""):
    summary = read_results_summary(root, plan)
    revision = str(plan_revision or "").strip()
    summary_revision = str(summary.get("planRevision") or summary.get("plan_revision") or "").strip() if isinstance(summary, dict) else ""
    plan_matches = not plan or normalize_result_candidate(summary.get("planFile") or "") == normalize_result_candidate(plan)
    revision_matches = not revision or summary_revision == revision
    if not summary.get("results") or not plan_matches or not revision_matches:
        return parse_results_action(root, None, plan, revision)
    return summary

def parse_event_line(line):
    try:
        item = json.loads(line)
        return item if isinstance(item, dict) else None
    except Exception:
        return None

def event_seq(item):
    try:
        return int((item or {}).get("seq") or 0)
    except Exception:
        return 0

def first_journal_seq(journal):
    try:
        with open(journal, "rb") as f:
            line = f.readline()
        item = parse_event_line(line.decode("utf-8", errors="replace")) if line else None
        return event_seq(item)
    except Exception:
        return 0

def last_journal_seq(root, journal):
    current = read_seq(root)
    if current:
        return current
    try:
        for line in reversed(read_journal_tail_lines(journal, 8 * 1024)):
            item = parse_event_line(line)
            seq = event_seq(item)
            if seq:
                return seq
    except Exception:
        pass
    return 0

def read_journal_tail_lines(journal, max_bytes):
    size = os.path.getsize(journal)
    start = max(0, size - max(4096, int(max_bytes or 0)))
    with open(journal, "rb") as f:
        f.seek(start)
        data = f.read()
    if start > 0:
        newline = data.find(b"\n")
        data = data[newline + 1:] if newline >= 0 else b""
    return data.decode("utf-8", errors="replace").splitlines()

def events_from_lines_after(lines, since):
    events = []
    for line in lines:
        event = parse_event_line(line)
        if event and event_seq(event) > since:
            events.append(event)
    return events

def full_scan_events_after(journal, since, limit=200):
    bounded_limit = max(1, int(limit or 200))
    events = deque(maxlen=bounded_limit)
    omitted_oversized = False
    with open(journal, "rb") as f:
        while True:
            raw = f.readline(MAX_AGENT_EVENT_RECORD_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_AGENT_EVENT_RECORD_BYTES:
                omitted_oversized = True
                while raw and not raw.endswith(b"\n"):
                    raw = f.readline(MAX_AGENT_EVENT_RECORD_BYTES + 1)
                continue
            event = parse_event_line(raw.decode("utf-8", errors="replace"))
            if event and event_seq(event) > since:
                events.append(event)
    if omitted_oversized:
        if len(events) >= bounded_limit:
            events.popleft()
        events.append({"schemaVersion": SCHEMA_VERSION, "seq": 0, "type": "diagnostics_updated", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "reason": "oversized_journal_record", "resetSince": 0}})
    return list(events)

def read_events_since(root, since, limit=200, cursor_id=""):
    journal = path_for(root, "events.jsonl")
    limit = max(1, int(limit or 200))
    effective_since = int(since or 0)
    if not os.path.isfile(journal):
        return [{"schemaVersion": SCHEMA_VERSION, "seq": 0, "type": "diagnostics_updated", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "message": "journal missing; pull snapshot", "resetSince": 0}}] if since else []
    first = first_journal_seq(journal)
    last = last_journal_seq(root, journal)
    if since and first and since < first - 1:
        return [{"schemaVersion": SCHEMA_VERSION, "seq": first, "type": "diagnostics_updated", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "message": "journal gap; pull snapshot"}}]
    if since and last and since > last:
        effective_since = 0
        gap = {"schemaVersion": SCHEMA_VERSION, "seq": 0, "type": "diagnostics_updated", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "message": "journal reset; pull snapshot", "resetSince": 0}}
        return [gap]
    if cursor_id:
        return read_events_after_seq(root, effective_since, limit, cursor_id)
    tail_window = max(1000, limit * 4)
    if not since or (last and since >= max(0, last - tail_window)):
        tail_lines = read_journal_tail_lines(journal, min(MAX_JOURNAL_BYTES, max(64 * 1024, limit * 4096)))
        tail_events = events_from_lines_after(tail_lines, effective_since)
        if not tail_events:
            if last and effective_since < last:
                return full_scan_events_after(journal, effective_since, limit)
            return []
        tail_seqs = [event_seq(item) for item in tail_events if event_seq(item)]
        if not tail_seqs:
            return full_scan_events_after(journal, effective_since, limit)
        min_tail_seq = min(tail_seqs)
        if not since and first and min_tail_seq > first and len(tail_events) < limit:
            return full_scan_events_after(journal, effective_since)[-limit:]
        if not since or min_tail_seq <= effective_since + 1:
            return tail_events[-limit:]
    return full_scan_events_after(journal, effective_since, limit)

def sse_idle_sleep_seconds(idle_rounds):
    # Long connection idle backoff: reduce empty journal scans without creating short reconnects.
    try:
        rounds = max(0, int(idle_rounds or 0))
    except Exception:
        rounds = 0
    return min(5.0, 0.25 + min(rounds, 19) * 0.25)

def event_operation_keys(event):
    keys = []
    if not isinstance(event, dict):
        return keys
    for key in ("operationId", "opId", "commandId", "runKey"):
        value = str(event.get(key) or "").strip()
        if value:
            keys.append(value)
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    for key in ("operationId", "opId", "commandId", "runKey"):
        value = str(payload.get(key) or "").strip()
        if value:
            keys.append(value)
    return list(dict.fromkeys(keys))

def operation_status_from_event(event):
    event_type = str((event or {}).get("type") or "")
    payload = event.get("payload") if isinstance((event or {}).get("payload"), dict) else {}
    status = str(payload.get("status") or (event or {}).get("status") or "").strip().lower()
    if status in ("completed", "failed", "cancelled", "stalled", "running", "accepted", "queued"):
        return status
    if event_type in ("operation_completed", "worker_task_completed", "worker_task_stopped"):
        return "completed"
    if event_type in ("operation_failed", "operation_stalled", "worker_task_failed", "worker_command_failed", "worker_uplink_error"):
        return "stalled" if event_type == "operation_stalled" else "failed"
    if event_type == "operation_cancelled":
        return "cancelled"
    if event_type in ("operation_started", "worker_command_started", "worker_task_started"):
        return "running"
    if event_type == "worker_command_enqueued":
        return "accepted"
    return "running" if event_type else "unknown"

def operation_terminal(status):
    return status in ("completed", "failed", "cancelled", "stalled")


def operation_already_terminal(root, operation_id):
    # Best-effort check used by the run-plan watchdog to avoid emitting a second
    # terminal operation event when the scheduler already wrote its own.
    try:
        events = read_operation_events(root, operation_id, 50)
        if not events:
            return False
        summary = operation_summary_from_events(operation_id, events)
        return bool(summary.get("terminal"))
    except Exception:
        return False

def operation_journal_signature(journal):
    try:
        stat = os.stat(journal)
        return (stat.st_dev, stat.st_ino, stat.st_size, getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1000000000)))
    except Exception:
        return None

def operation_journal_index(root):
    journal = os.path.abspath(path_for(root, "events.jsonl"))
    signature = operation_journal_signature(journal)
    if signature is None:
        return {"groups": {}, "rows": []}
    now_value = time.time()
    with OPERATION_JOURNAL_CACHE_LOCK:
        prune_operation_journal_cache(now_value, journal)
        cached = OPERATION_JOURNAL_CACHE.get(journal)
        if cached and cached.get("signature") == signature:
            cached["lastUsedAt"] = now_value
            return cached
    groups = {}
    with open(journal, "r", encoding="utf-8") as f:
        for line in f:
            event = parse_event_line(line)
            if not event:
                continue
            keys = event_operation_keys(event)
            if keys:
                groups.setdefault(keys[0], []).append(event)
    rows = [operation_summary_from_events(key, events) for key, events in groups.items()]
    rows.sort(key=lambda row: row.get("updatedAt") or "", reverse=True)
    entry = {"signature": signature, "groups": groups, "rows": rows, "lastUsedAt": now_value}
    with OPERATION_JOURNAL_CACHE_LOCK:
        OPERATION_JOURNAL_CACHE[journal] = entry
        prune_operation_journal_cache(now_value, journal)
    return entry

def read_operation_events(root, operation_id, limit=200):
    wanted = str(operation_id or "").strip()
    if not wanted:
        return []
    events = operation_journal_index(root)["groups"].get(wanted, [])
    return events[-max(1, int(limit or 200)):]

def operation_summary_from_events(operation_id, events):
    latest = events[-1] if events else {}
    status = operation_status_from_event(latest) if latest else "unknown"
    payload = latest.get("payload") if isinstance(latest.get("payload"), dict) else {}
    plan_fields = {}
    for event in events:
        event_payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        for key in ("planFile", "selectedPlanId", "planRevision"):
            value = str(event_payload.get(key) or "").strip()
            if value:
                plan_fields[key] = value
    payload = {**plan_fields, **payload}
    message = str(payload.get("message") or payload.get("error") or latest.get("message") or "")
    first = events[0] if events else {}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "operationId": str(operation_id or ""),
        "opId": str(payload.get("opId") or payload.get("commandId") or operation_id or ""),
        "status": status,
        "terminal": operation_terminal(status),
        "message": message,
        "eventCount": len(events),
        "startedAt": first.get("generatedAt") or "",
        "updatedAt": latest.get("generatedAt") or "",
        "latestType": latest.get("type") or "",
        "latestEvent": latest,
        "payload": payload,
        **plan_fields,
    }

def api_operation(root, operation_id):
    events = read_operation_events(root, operation_id, 200)
    result = operation_summary_from_events(operation_id, events)
    result["events"] = events[-50:]
    return result


def process_alive(pid):
    return pid_is_alive(pid)


def scheduler_process_evidence(root, pid=None, tmux_session=None):
    checked_pid = int(pid or 0) if str(pid or "").strip().lstrip("-").isdigit() else 0
    checked_session = str(tmux_session or "").strip()
    session_alive = False
    python_running = False
    try:
        session_alive = tmux_session_alive(checked_session, cwd=root)
    except Exception:
        session_alive = False
    # 仅 has-session 不足以证明调度器存活：启动竞态可能只留下一个空 shell。
    # 结合 pane 内是否真有 python cluster_scheduler 进程，避免“tmux 假存活”把面板卡在 running。
    if session_alive:
        try:
            python_running = _tmux_pane_python_running(checked_session, os.environ)
        except Exception:
            python_running = False
    pid_alive = process_alive(checked_pid)
    # 真实存活 = tmux 会话存在 且 pane 内确有 python cluster_scheduler 进程在跑。
    # 去掉 pid_alive 的掩盖：仅 shell pid 存活（如空壳会话、挂死的登录 shell）不能等同
    # 任务存活，否则会误判“执行中”而把面板卡在 running。pane 内 python 进程才是真证。
    tmux_alive = session_alive and python_running
    return {
        "checkedPid": checked_pid,
        "checkedTmuxSession": checked_session,
        "pidAlive": pid_alive,
        "tmuxSessionAlive": tmux_alive,
        "tmuxShellAlive": session_alive,
        "tmuxPythonRunning": python_running,
    }


def matching_plan_rows(rows, plan_file):
    wanted = normalize_result_candidate(plan_file)
    if not wanted:
        return list(rows or [])
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        candidates = [row.get("planFile"), row.get("plan_file"), row.get("plan")]
        for key in ("running_experiments", "testing_experiments", "queued_experiments", "pending_experiments"):
            if any(isinstance(item, dict) and normalize_result_candidate(item.get("planFile") or item.get("plan") or wanted) == wanted for item in (row.get(key) or [])):
                candidates.append(wanted)
                break
        if any(normalize_result_candidate(item) == wanted for item in candidates):
            out.append(row)
    return out



SCHEDULER_SOURCES = {"scheduler", "tmux", "exit_code", "调度器", "调度器异常", "psutil", "conda", "ModuleNotFoundError", "No such file", "not found"}

def _redact_text(value):
    try:
        t = str(value or "")
        # /data absolute prefix
        t = re.sub(r"/data[^\s\"'\\]*", "[REDACTED]", t)
        # simple_cluster/.../.exit_code
        t = re.sub(r"simple_cluster[^\s\"'\\]*\.exit_code[^\s\"'\\]*", "[REDACTED]", t, flags=re.I)
        t = re.sub(r"simple_cluster[^\s\"'\\]*", "[REDACTED]", t, flags=re.I)
        # exit_code
        t = re.sub(r"exit_code", "[REDACTED]", t, flags=re.I)
        # printf "$?" >
        t = re.sub(r"printf\s*[\"']\$\\\?[\"']\s*>", "[REDACTED]", t)
        t = re.sub(r"printf\s+[^\n]*\$\?[^\n]*>", "[REDACTED]", t, flags=re.I)
        # tmux instruction
        t = re.sub(r"tmux\s+[^\n\r]*", "[REDACTED tmux]", t, flags=re.I)
        return t
    except Exception:
        return str(value or "")

# 脱敏助手别名 redact（任务要求命名）
def redact(value):
    return _redact_text(value)

def _redact_path(value):
    try:
        p = str(value or "")
        p = re.sub(r"/data[^\s\"']*", "[REDACTED]", p)
        p = re.sub(r"simple_cluster[^\s\"']*\.exit_code[^\s\"']*", "[REDACTED]", p, flags=re.I)
        p = re.sub(r"simple_cluster[^\s\"']*", "[REDACTED]", p, flags=re.I)
        p = re.sub(r"exit_code", "[REDACTED]", p, flags=re.I)
        p = re.sub(r"tmux\s+[^\n\r]*", "[REDACTED tmux]", p, flags=re.I)
        return p
    except Exception:
        return str(value or "")

def _is_scheduler_source(text):
    try:
        t = str(text or "")
        # 运行态“scheduler started pid=..., 等待 scheduler 终态”不应视为调度器错误源，仅为 running 状态；但含 all_busy/busy/no_idle/probe/无空闲/无可用/all worker 时视为调度失败需放行
        if re.search(r"scheduler started pid=.*等待 scheduler 终态", t, re.I):
            if not re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code|失败|异常|错误", t):
                if not re.search(r"all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", t, re.I):
                    return False
        if re.search(r"scheduler started pid=", t, re.I) and "等待 scheduler 终态" in t:
            if not re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", t):
                if not re.search(r"all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", t, re.I):
                    return False
        for src in SCHEDULER_SOURCES:
            if src.lower() in t.lower() if src.isascii() else src in t:
                return True
        # 额外规则：调度相关中文也判定
        if re.search(r"调度器", t):
            return True
        return False
    except Exception:
        return False

def _is_program_source(text):
    try:
        t = str(text or "")
        return bool(re.search(r"Traceback|Error|Exception|失败|异常", t, re.I))
    except Exception:
        return False

def _schedulerErrorZh(text_or_payload):
    try:
        # 兼容 payload dict 与纯文本
        if isinstance(text_or_payload, dict):
            raw = str(text_or_payload.get("message") or text_or_payload.get("error") or text_or_payload.get("msg") or "")
        else:
            raw = str(text_or_payload or "")
        # P0-4/P1 前置：若含“目前无空卡/all_busy”直接中文化为“目前无空卡”，避免 3行调度日志被判 none
        if re.search(r"目前无空卡|all_busy|all_busy_or_disallowed", raw, re.I):
            for _l in raw.splitlines():
                if "目前无空卡" in _l or re.search(r"all_busy", _l, re.I):
                    _cand = _l.strip()
                    if _cand:
                        _cand = re.sub(r"all_busy_or_disallowed|all_busy", "目前无空卡", _cand, flags=re.I)
                        return _cand[:200]
            return "目前无空卡"
        # 优先级：payload.message 含“调度器启动失败/无有效日志增长/未生成 exit_code”时取 hub 真因首行200（最高优，覆盖 scheduler started 多行场景）
        if re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", raw):
            for _l in raw.splitlines():
                if re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", _l):
                    _cand = _l.strip()
                    if _cand:
                        return _cand[:200]
            _first_hit = (raw.strip().splitlines()[0].strip() if raw.strip() else "")
            if _first_hit:
                return _first_hit[:200]
        # 运行态“scheduler started pid=..., 等待 scheduler 终态”不应作为调度器报错展示（仅为 running 状态），但含 all_busy/busy/no_idle/probe/无空闲/无可用/all worker 时视为调度失败需放行
        if re.search(r"scheduler started pid=.*等待 scheduler 终态", raw, re.I):
            if not re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code|失败|异常|错误|Traceback|Error|Exception", raw, re.I):
                if not re.search(r"all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", raw, re.I):
                    return ""
        if re.search(r"scheduler started pid=", raw, re.I) and "等待 scheduler 终态" in raw:
            if not re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", raw):
                if not re.search(r"all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", raw, re.I):
                    return ""
        # 取 payload.message 第一行中文截200（任务要求）
        first_line = (raw.splitlines()[0] if raw.strip() else "").strip()
        if first_line:
            # 运行态首行不应直接返回，但含 all_busy/busy/no_idle/probe/无空闲/无可用 时视为调度失败需放行
            if re.search(r"scheduler started pid=.*等待 scheduler 终态", first_line, re.I):
                if not re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", first_line):
                    if re.search(r"all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", first_line, re.I):
                        return first_line[:200]
                    pass
                elif _is_scheduler_source(first_line):
                    return first_line[:200]
            elif _is_scheduler_source(first_line):
                # 仅当首行含失败/异常等错误特征或是 hub 真因时才视为调度器报错，避免 benign scheduler 日志（如 "scheduler started epoch 1"）误报
                if re.search(r"失败|异常|错误|Traceback|Error|Exception|未生成|无有效日志|不存在|not found|No such file", first_line, re.I) or re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", first_line):
                    return first_line[:200]
                # 无错误特征的纯 scheduler 首行不视为调度器错误（满足 failureSourceKind none 且 live_log 无错误时空）
                return ""
        t = raw if raw else str(text_or_payload or "")
        # 运行态二次兜底，但含 all_busy/busy/no_idle/probe/无空闲/无可用/all worker 时视为调度失败需放行
        if re.search(r"scheduler started pid=.*等待 scheduler 终态", t, re.I):
            if not re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code|失败|异常|错误", t):
                if not re.search(r"all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", t, re.I):
                    return ""
        # 兜底：按原有调度器中文映射，保证单测与旧行为兼容
        if re.search(r"tmux", t, re.I) or re.search(r"scheduler", t, re.I) or re.search(r"exit_code", t, re.I) or re.search(r"调度器", t):
            if re.search(r"tmux.*kill|tmux.*attach|tmux.*session", t, re.I):
                return "调度器 tmux 会话异常，请检查 Xshell 会话与 tmux 状态"
            if re.search(r"No such file|not found|不存在", t, re.I):
                return "调度器依赖文件缺失"
            # 仅当含失败/异常等真实错误特征时才返回通用调度器失败，避免 running 态或无错误日志误报
            if re.search(r"失败|异常|错误|Traceback|Error|Exception|未生成|无有效日志", t, re.I):
                return "调度器启动失败，请检查远端调度器日志与环境"
            # 若首行含中文且为调度相关，返回首行截断，否则空（满足 failureSourceKind none 时不误报通用失败）
            if first_line and re.search(r"[\u4e00-\u9fa5]", first_line) and _is_scheduler_source(first_line):
                return first_line[:200]
            return ""
        if re.search(r"psutil|No such file|ModuleNotFoundError.*scheduler|调度器异常", t, re.I):
            return "调度器依赖缺失或异常"
        if re.search(r"conda.*not found|EnvironmentNotFound|CondaValueError", t, re.I):
            return "调度器环境缺失，请检查 conda 环境"
        # 若 first_line 非空且含中文，直接返回截断（满足“取第一行中文截200”），但仅当为调度相关或含失败特征时返回，避免非调度中文/纯英文误报为调度器错误
        if first_line and re.search(r"[\u4e00-\u9fa5]", first_line):
            if _is_scheduler_source(first_line) or re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code|失败|异常", first_line):
                return first_line[:200]
            return ""
        return ""
    except Exception:
        return ""

def _programError(text_or_payload, logTail=None):
    try:
        # 支持 _programError(payload, logTail) 与 _programError(text) 两种调用
        if logTail is not None:
            t = str(logTail or "") + "\n" + str(text_or_payload or "")
            if isinstance(text_or_payload, dict):
                t = str(text_or_payload.get("error") or text_or_payload.get("traceback") or "") + "\n" + str(logTail or "")
        elif isinstance(text_or_payload, dict):
            t = str(text_or_payload.get("error") or text_or_payload.get("traceback") or text_or_payload.get("message") or "")
        else:
            t = str(text_or_payload or "")
        # 调度等待期过滤：若文本仅含 dispatch_probe/idle=0/wait pending 等探测行，则不判为程序错误
        if t.strip():
            # 按行过滤探测文本（类似 re.sub 过滤）
            lines = t.splitlines()
            filtered = []
            for _line in lines:
                if re.search(r"dispatch_probe", _line, re.I):
                    continue
                if re.search(r"idle\s*=\s*0", _line, re.I):
                    continue
                if re.search(r"wait pending", _line, re.I):
                    continue
                if re.search(r"rejected", _line, re.I) and re.search(r"dispatch_probe|idle", t, re.I):
                    continue
                # error= 探测（常见于 dispatch_probe 行）不计入 Error 判定
                if re.search(r"error\s*=", _line, re.I) and re.search(r"dispatch_probe", t, re.I):
                    continue
                filtered.append(_line)
            _filtered_text = "\n".join(filtered).strip()
            # 若过滤后为空，说明原文仅含探测等待日志
            if not _filtered_text:
                return ""
            # 若原文含探测标记且过滤后无真实错误特征，则返回空
            if re.search(r"dispatch_probe|idle\s*=\s*0|wait pending", t, re.I):
                if not re.search(r"Traceback|ModuleNotFoundError|SyntaxError|psutil|CondaValueError|EnvironmentNotFound", _filtered_text, re.I):
                    if not re.search(r"\bError\b\s*:|\bException\b\s*:|Traceback|失败|异常", _filtered_text, re.I):
                        return ""
            t = _filtered_text if _filtered_text else t
        if "Traceback" in t:
            lines = [l.rstrip() for l in t.splitlines() if l.strip()]
            # 取 traceback 段：最后 20 行截 1200
            tail = "\n".join(lines[-20:])
            return tail[-1200:]
        if re.search(r"\bError\b\s*:|\bException\b\s*:|Traceback|失败|异常", t, re.I):
            return t.strip()[-1200:]
        return ""
    except Exception:
        return ""

def _classify(payload, logTail=None):
    try:
        # 兼容旧单参调用 _classify(text)
        if logTail is None and not isinstance(payload, dict):
            t = str(payload or "")
            has_sched = bool(_schedulerErrorZh(t))
            has_prog = bool(_programError(t))
            if has_sched and has_prog:
                return "mixed"
            if has_sched:
                return "scheduler"
            if has_prog:
                return "program"
            if t.strip():
                return "none"
            return "none"
        # 新双参：_classify(payload, logTail)
        p_text = ""
        if isinstance(payload, dict):
            p_text = str(payload.get("message") or payload.get("error") or "")
        elif payload is not None:
            p_text = str(payload)
        l_text = str(logTail or "")
        # 同时检测 payload 与 logTail（log 侧亦用 _schedulerErrorZh 避免仅含 scheduler 关键词无错误时误判为 scheduler）
        has_sched_payload = bool(_schedulerErrorZh(p_text)) if p_text else False
        has_sched_log = bool(_schedulerErrorZh(l_text)) if l_text else False
        # 兼容部分历史逻辑：若 _schedulerErrorZh 对 log 返回空但 _is_scheduler_source 对含 hub 真因的 log 仍应判为 scheduler，则二次校验 hub 关键词
        if not has_sched_log and l_text and re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", l_text):
            has_sched_log = True
        has_prog_payload = bool(_programError(p_text)) if p_text else False
        has_prog_log = bool(_programError(l_text)) if l_text else False
        has_sched = has_sched_payload or has_sched_log
        has_prog = has_prog_payload or has_prog_log
        if has_sched and has_prog:
            return "mixed"
        if has_sched:
            return "scheduler"
        if has_prog:
            return "program"
        if (p_text.strip() or l_text.strip()):
            # 无明确错误时返回 none，与旧 unknown 语义对齐但满足任务要求 none
            # 为兼容旧 unknown 场景，若有文本但未分类，返回 none（任务要求 mixed/none）
            combined = (p_text + "\n" + l_text).strip()
            if combined:
                return "none"
            return "none"
        return "none"
    except Exception:
        return "none"

def api_runtime_operation_evidence(root, operation_id, plan_file="", pid=None, tmux_session=None):
    operation = operation_summary_from_events(operation_id, read_operation_events(root, operation_id, 200))
    payload = operation.get("latestEvent", {}).get("payload") if isinstance(operation.get("latestEvent"), dict) else {}
    if not isinstance(payload, dict):
        payload = {}
    scheduler_snapshot = read_runtime_json_cached(path_for(root, "cluster_snapshot.json"), {})
    trace_snapshot = read_runtime_json_cached(path_for(root, "experiment_traces_snapshot.json"), {})
    task_snapshot = read_runtime_json_cached(path_for(root, "worker_task_snapshot.json"), {})
    scheduler_rows = matching_plan_rows(scheduler_snapshot.get("schedulerStates") or [], plan_file or payload.get("planFile") or payload.get("plan"))
    traces = matching_plan_rows(trace_snapshot.get("experimentTraces") or [], plan_file or payload.get("planFile") or payload.get("plan"))
    worker_tasks = matching_plan_rows(task_snapshot.get("tasks") or [], plan_file or payload.get("planFile") or payload.get("plan"))
    log_rel = str(payload.get("logPath") or payload.get("log_path") or "")
    if not log_rel:
        # 兜底：payload 未提供 logPath 时按 opId 拼接调度日志路径 tmp/cluster_scheduler/<opId>.log（simple_cluster/tmp 仅过渡兼容）
        fallback_rel = f"simple_cluster/tmp/cluster_scheduler/{operation_id}.log" if str(operation_id or "").strip() else ""
        log_rel = fallback_rel
    log_path = ""
    if log_rel:
        try:
            log_path = safe_project_path(root, log_rel)
        except Exception as _e:
            log_path = ""
            _workerResolveErrors.append(f"{log_rel}: {str(_e)[:200]}")
    live_log_count = 0
    live_log_tail = ""
    live_log_updated_at = ""
    _workerResolveErrors = []
    # Helper: read effective tail from a log file (filter shell echoes) - synced with global _is_noise_line
    # L3 调度有效尾（复用 L1/L2 预算思想）：16KB 截断后取末 150 行→噪声过滤→保留 50 行，确保调度错误/程序首错不被截断，需与 LIVE/AUDIT 预算分层一致（嵌套版本，与顶层同预算）
    def _read_effective_tail(path, max_bytes=16*1024):
        try:
            if not path or not os.path.isfile(path):
                return "", 0, ""
            _st = os.stat(path)
            with open(path, "rb") as _h:
                _h.seek(max(0, _st.st_size - max_bytes))
                _raw = _h.read()
            _txt = _raw.decode("utf-8", errors="replace")
            _tail_150 = _txt.splitlines()[-150:]
            _joined = "\n".join(_tail_150)
            _t4000 = _joined[-4000:] if _joined else ""
            _filtered = [_l for _l in _t4000.splitlines() if _l.strip() and not _is_noise_line(_l)]
            _eff_tail = ("\n".join(_filtered[-50:]) + ("\n" if _filtered[-50:] else "")) if _filtered else ""
            _cnt = len([_l for _l in _eff_tail.splitlines() if _l.strip()]) if _eff_tail else 0
            _upd = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_st.st_mtime))
            return _eff_tail, _cnt, _upd
        except Exception:
            return "", 0, ""
    if log_path and os.path.isfile(log_path):
        live_log_tail, live_log_count, live_log_updated_at = _read_effective_tail(log_path, max_bytes=16*1024)
    else:
        live_log_tail = ""
        live_log_count = 0
        live_log_updated_at = ""
    # Fallback: 16KB→150→4000→50 分层联动（P0-1）：若已滤 tail 含 Killed/OOM/Error 等关键词则保留，不因 _raw_size<512 强制覆盖稀释；关键词列表 dispatch|scheduler|experiment|Traceback|Error|调度器|Killed|OOM|out of memory|signal|Segfault|CUDA|NCCL|exit code|exit_code|killed|took too long|timeout
    _has_sched_kw = re.search(r"dispatch|scheduler|experiment|Traceback|Error|调度器|Killed|OOM|out of memory|signal|Segfault|CUDA|NCCL|exit code|exit_code|killed|took too long|timeout|all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker|目前无空卡", live_log_tail or "", re.IGNORECASE)
    _has_critical_kw = re.search(r"Killed|OOM|out of memory|signal|Segfault|CUDA|NCCL|exit code|exit_code|Error|Traceback", live_log_tail or "", re.IGNORECASE)
    _needs_fallback = False
    try:
        _raw_size = os.path.getsize(log_path) if log_path and os.path.isfile(log_path) else 0
        # 空 tail 或 count==0 必须 fallback；小文件 <512 仅在空或无关键错误时 fallback（P0-4：L3有效尾非空时不因 count<=3 无关键词而稀释）
        if live_log_count == 0 or not live_log_tail.strip():
            _needs_fallback = True
        elif _raw_size < 512 and (not live_log_tail.strip() or live_log_count == 0):
            _needs_fallback = True
        elif _raw_size < 512 and not _has_critical_kw and not _has_sched_kw:
            _needs_fallback = True
    except Exception:
        _needs_fallback = not live_log_tail.strip() or live_log_count == 0
    if _needs_fallback:
        _fallback_candidates = []
        # payload.schedulerLog / queue_log
        for _key in ("schedulerLog", "scheduler_log", "queueLog", "queue_log", "schedulerLogPath", "scheduler_log_path"):
            _val = str(payload.get(_key) or "").strip()
            if _val:
                _fallback_candidates.append(_val)
        # derive plan_key log: tmp/cluster_scheduler/<plan_key>.log（simple_cluster/tmp 仅过渡兼容）
        _plan_for_key = str(plan_file or payload.get("planFile") or payload.get("plan") or "").strip()
        if _plan_for_key and not str(operation_id or "").strip():
            try:
                _pk = scheduler_plan_runtime_key(root, _plan_for_key)
                if _pk:
                    _fallback_candidates.append(f"simple_cluster/tmp/cluster_scheduler/{_pk}.log")
            except Exception:
                pass
        # Also try operation_id.log already is primary, but ensure we don't duplicate
        # fallback_candidates 同时尝试：{opId}.log 主 + {planKey}.log 历史 + payload.schedulerLog/queue_log 若存在（P0-1）
        _op_rel = f"simple_cluster/tmp/cluster_scheduler/{operation_id}.log" if str(operation_id or "").strip() else ""
        if _op_rel and _op_rel not in _fallback_candidates and _op_rel != log_rel:
            _fallback_candidates.insert(0, _op_rel)
        for _rel in _fallback_candidates:
            try:
                _cand_path = safe_project_path(root, _rel)
            except Exception as _e:
                _workerResolveErrors.append(f"{_rel}: {str(_e)[:200]}")
                continue
            if _cand_path == log_path:
                continue
            _tail2, _cnt2, _upd2 = _read_effective_tail(_cand_path)
            if _tail2.strip():
                # Merge effective content
                if live_log_tail.strip():
                    live_log_tail = (live_log_tail.rstrip() + "\n" + _tail2).strip()[-4000:]
                    live_log_count = len([_l for _l in live_log_tail.splitlines() if _l.strip()])
                    # keep earliest updatedAt? Use latest
                    if _upd2 and (not live_log_updated_at or _upd2 > live_log_updated_at):
                        live_log_updated_at = _upd2
                else:
                    live_log_tail = _tail2
                    live_log_count = _cnt2
                    live_log_updated_at = _upd2
                    # adopt fallback path as log_rel if primary was empty
                    if not log_path or not os.path.isfile(log_path) or _raw_size < 512:
                        log_rel = _rel
                        log_path = _cand_path
                # Only merge first effective fallback to keep tail bounded
                if live_log_count >= 5:
                    break
    # 确保 pane/log 尾保留 \n（与 wait_scheduler 中 pane_tail 保持一致，覆盖 fallback 与非 fallback 分支）
    if live_log_tail and not live_log_tail.endswith("\n"):
        live_log_tail += "\n"
    process = scheduler_process_evidence(root, pid if pid is not None else payload.get("pid"), tmux_session or payload.get("tmuxSession") or payload.get("session"))
    evidence_counts = {
        "schedulerStatesCount": len(scheduler_rows),
        "experimentTracesCount": len(traces),
        "workerTasksCount": len(worker_tasks),
        "liveLogCount": live_log_count,
    }
    # P1: pidAlive 需同时满足 tmuxShellAlive 才算调度存活，避免空壳 shell pid 误判 running（仅 pane 内 python 才是真调度）
    active_evidence = bool((process["pidAlive"] and process["tmuxShellAlive"]) or process["tmuxSessionAlive"] or any(evidence_counts.values()))
    # 分类与脱敏：failureSourceKind / schedulerErrorZh / programError / failures / logPathRedacted/logTailRedacted（任务要求 payload/logTail 双参 + 脱敏）
    failureSourceKind = _classify(payload, live_log_tail)
    _payload_msg_hub = str(payload.get("message") or payload.get("error") or payload.get("msg") or "") if isinstance(payload, dict) else str(payload or "")
    _hub_sched_hit = bool(re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code|tmux.*会话.*存活", _payload_msg_hub))
    if _hub_sched_hit:
        # 优先级：payload.message 含 hub 真因时取首个含失败关键词的行截200，而非盲取首行（覆盖 scheduler started 多行场景）
        _hit_line = ""
        for _l in _payload_msg_hub.splitlines():
            if re.search(r"调度器启动失败|无有效日志增长|未生成 exit_code", _l):
                _hit_line = _l.strip()
                break
        if not _hit_line:
            _lines = [l for l in _payload_msg_hub.splitlines() if l.strip()]
            _hit_line = (_lines[0].strip() if _lines else (_payload_msg_hub.strip().splitlines()[0].strip() if _payload_msg_hub.strip() else ""))
        _schedZh_raw = _hit_line[:200]
        if failureSourceKind not in ("scheduler", "mixed"):
            if failureSourceKind == "program":
                failureSourceKind = "mixed"
            else:
                failureSourceKind = "scheduler"
        schedulerErrorZh = _redact_text(_schedZh_raw)
        _prog_raw = _programError(live_log_tail) if failureSourceKind in ("program", "mixed") else ""
        if not _prog_raw and failureSourceKind in ("program", "mixed"):
            _prog_raw = _programError(payload)
        programError = _redact_text(_prog_raw)
    else:
        # 调度器报错：取 payload.message 第一行中文截200（兼容 fallback 到 logTail）
        _schedZh_raw = _schedulerErrorZh(payload) if failureSourceKind in ("scheduler", "mixed") else ""
        if not _schedZh_raw and failureSourceKind in ("scheduler", "mixed"):
            _schedZh_raw = _schedulerErrorZh(live_log_tail)
        _prog_raw = _programError(live_log_tail) if failureSourceKind in ("program", "mixed") else ""
        if not _prog_raw and failureSourceKind in ("program", "mixed"):
            _prog_raw = _programError(payload)
        schedulerErrorZh = _redact_text(_schedZh_raw)
        programError = _redact_text(_prog_raw)
    failures = []
    if schedulerErrorZh:
        failures.append({"kind": "scheduler", "messageZh": schedulerErrorZh})
    if programError:
        failures.append({"kind": "program", "message": programError, "traceback": programError})
    logPathRedacted = _redact_path(log_rel)
    liveLogTailRedacted = _redact_text(live_log_tail)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "checkedAt": now_iso(),
        "operation": operation,
        **process,
        **evidence_counts,
        "activeEvidence": active_evidence,
        "liveLogUpdatedAt": live_log_updated_at,
        "liveLogTail": live_log_tail,
        "live_log_tail": live_log_tail,
        "logTail": live_log_tail,
        "log_tail": live_log_tail,
        "logPath": log_rel,
        "log_path": log_rel,
        "failureSourceKind": failureSourceKind,
        "schedulerErrorZh": schedulerErrorZh,
        "programError": programError,
        "failures": failures,
        "logPathRedacted": logPathRedacted,
        "liveLogTailRedacted": liveLogTailRedacted,
        "liveLogCount": live_log_count,
        "live_log_count": live_log_count,
        "fallbackTriggered": _needs_fallback,
        "fallback_triggered": _needs_fallback,
        "_workerResolveError": "; ".join(_workerResolveErrors) if _workerResolveErrors else "",
        "_workerResolveErrors": _workerResolveErrors,
    }


def scheduler_stop_record_identity(wanted, requested_plan, event):
    if not isinstance(event, dict):
        raise ValueError("缺少可验证的调度事件")
    event_operation_id = str(event.get("operationId") or "").strip()
    if event_operation_id and event_operation_id != str(wanted or "").strip():
        raise ValueError("调度事件 operationId 与停止目标不匹配")
    recorded = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    payload_operation_id = str(recorded.get("operationId") or "").strip()
    if payload_operation_id and payload_operation_id != str(wanted or "").strip():
        raise ValueError("调度事件 payload operationId 与停止目标不匹配")
    recorded_plan = re.sub(r"^\./", "", str(recorded.get("planFile") or recorded.get("plan") or "").replace("\\", "/")).strip()
    expected_plan = re.sub(r"^\./", "", str(requested_plan or "").replace("\\", "/")).strip()
    if not wanted or not recorded_plan or not expected_plan or recorded_plan != expected_plan:
        raise ValueError("调度事件缺少匹配的 operationId/Plan 身份")
    return {
        "planFile": recorded_plan,
        "pid": recorded.get("pid"),
        "pidStartIdentity": str(recorded.get("pidStartIdentity") or "").strip(),
        "tmuxSession": str(recorded.get("tmuxSession") or recorded.get("session") or "").strip(),
    }


def stop_scheduler_operation(root, payload):
    wanted = str(payload.get("targetOperationId") or payload.get("remoteOperationId") or payload.get("operationId") or payload.get("opId") or "").strip()
    plan = action_plan_file(payload)
    if wanted and plan and cancel_inactivity_action(root, wanted, plan):
        return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "completed", "已取消处理中操作", {"matchedOperations": [wanted], "planFile": plan}, request=payload)
    if not wanted or not plan:
        return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "failed", "缺少明确的调度记录或 Plan，未执行停止。", {"matchedOperations": [], "planFile": plan}, request=payload)
    events = read_operation_events(root, wanted, 100) if wanted else []
    latest_event = next((event for event in reversed(events) if isinstance(event.get("payload"), dict)), {})
    latest_payload = latest_event.get("payload") if isinstance(latest_event.get("payload"), dict) else {}
    requested_plan = re.sub(r"^\./", "", str(plan).replace("\\", "/"))
    try:
        stop_identity = scheduler_stop_record_identity(wanted, requested_plan, latest_event)
    except ValueError as exc:
        return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "failed", f"{exc}，未执行停止。", {"matchedOperations": [], "planFile": plan}, request=payload)
    recorded_plan = stop_identity["planFile"]
    target_pid = 0
    registry_entry = next((entry for entry in _read_run_plan_registry(root) if isinstance(entry, dict) and str(entry.get("opId") or "") == wanted), None)
    registry_pid = int(registry_entry.get("pid") or 0) if registry_entry else 0
    event_pid = int(stop_identity.get("pid") or 0) if str(stop_identity.get("pid") or "").strip().lstrip("-").isdigit() else 0
    pid_candidate = registry_pid if registry_pid > 0 and (not event_pid or event_pid == registry_pid) else 0
    expected_pid_start = str((registry_entry or {}).get("pidStartIdentity") or stop_identity.get("pidStartIdentity") or "").strip()
    actual_pid_start = process_start_identity(pid_candidate) if pid_candidate else ""
    pid_identity_lost = False
    if pid_candidate > 0 and expected_pid_start and actual_pid_start and expected_pid_start == actual_pid_start:
        target_pid = pid_candidate
    recorded_session = str(stop_identity.get("tmuxSession") or "").strip()
    registry_session = str((registry_entry or {}).get("tmuxSession") or "").strip()
    if recorded_session and registry_session and recorded_session != registry_session:
        return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "failed", "调度事件与运行登记中的 tmux 身份不一致，未执行停止。", {"matchedOperations": [], "planFile": plan}, request=payload)
    target_session = recorded_session or registry_session
    if not target_session and wanted:
        # The run-plan scheduler session is named deterministically from the op id; fall back to
        # deriving it so a stop still works even if the operation events lack the session field.
        target_session = simple_tmux_name(f"sch-{wanted}")
    before = scheduler_process_evidence(root, target_pid, target_session)
    terminated_sessions, terminated_pids = [], []
    errors = []
    # 用原始会话存活（tmuxShellAlive）决定 kill：即便 pane 内只是空 shell（无 python 进程），
    # 也应 kill 掉，避免中止后 tmux 仍残留把面板判活。
    if before["tmuxShellAlive"]:
        result = subprocess.run(["tmux", "kill-session", "-t", str(before["checkedTmuxSession"])], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=5, check=False)
        if result.returncode == 0:
            terminated_sessions.append(before["checkedTmuxSession"])
        else:
            errors.append((result.stderr or b"tmux kill failed").decode("utf-8", errors="replace").strip())
    if before["pidAlive"]:
        if process_start_identity(before["checkedPid"]) != expected_pid_start:
            pid_identity_lost = True
        else:
            try:
                os.kill(int(before["checkedPid"]), signal.SIGTERM)
                terminated_pids.append(before["checkedPid"])
            except Exception as exc:
                errors.append(str(exc))
    time.sleep(0.2)
    after = scheduler_process_evidence(root, target_pid, target_session)
    if after["pidAlive"] and before["pidAlive"] and int(before["checkedPid"]) == int(after["checkedPid"]):
        if process_start_identity(after["checkedPid"]) != expected_pid_start:
            pid_identity_lost = True
        else:
            try:
                os.kill(int(after["checkedPid"]), signal.SIGKILL)
                time.sleep(0.1)
            except Exception:
                pass
            after = scheduler_process_evidence(root, target_pid, target_session)
    remaining_active = []
    if after["pidAlive"]: remaining_active.append({"kind": "pid", "value": after["checkedPid"]})
    if pid_identity_lost:
        remaining_active.append({"kind": "pidIdentityUnknown", "value": pid_candidate})
    unverified_pids = {value for value in (event_pid, registry_pid) if value > 0 and value != target_pid and _is_pid_alive(value)}
    for value in sorted(unverified_pids):
        remaining_active.append({"kind": "pidIdentityUnknown", "value": value})
    # P1: 双活判定需同时检查 shellAlive，避免空壳（has-session 但无 python）被误判为已清理
    if after["tmuxSessionAlive"]: remaining_active.append({"kind": "tmuxSession", "value": after["checkedTmuxSession"]})
    elif after["tmuxShellAlive"]: remaining_active.append({"kind": "tmuxSession", "value": after["checkedTmuxSession"]})
    if unverified_pids or pid_identity_lost:
        return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "failed", "调度器 PID 启动身份无法验证，未终止该 PID、未删除运行登记，也未继续清理 Worker 任务。", {
            "matchedOperations": [], "planFile": plan, "remainingActiveEvidence": remaining_active,
        }, request=payload)
    matched_scheduler = bool(terminated_sessions or terminated_pids or before["pidAlive"] or before["tmuxSessionAlive"] or before["tmuxShellAlive"])
    # A previous stop can have removed the scheduler while leaving its Worker records behind.
    # Repair that Plan only when its journal identifies it and no newer scheduler is live.
    if not matched_scheduler and recorded_plan != requested_plan:
        return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "failed", "未找到目标 Plan 的活动调度进程，未清理 GPU 任务。", {"matchedOperations": [], "planFile": plan, "checkedPid": after["checkedPid"], "checkedTmuxSession": after["checkedTmuxSession"]}, request=payload)
    if not matched_scheduler:
        for entry in _read_run_plan_registry(root):
            if not isinstance(entry, dict) or str(entry.get("opId") or "") == wanted:
                continue
            if _is_pid_alive(entry.get("pid")) or tmux_session_alive(str(entry.get("tmuxSession") or ""), cwd=root):
                return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or ""), str(payload.get("opId") or ""), "failed", "另一个调度器仍在运行，不能按旧记录清理 Worker 任务。", {"matchedOperations": [], "planFile": plan}, request=payload)
    try:
        if wanted:
            deregister_active_run_plan(root, wanted)
        # also reap any leftover zombie sch-* sessions from this stop
        remaining = set(str(e.get("opId") or "") for e in _read_run_plan_registry(root) if isinstance(e, dict) and str(e.get("opId") or "").strip())
        _reap_zombie_scheduler_sessions(root, remaining, target_session)
    except Exception:
        pass
    # A Worker task's pid can be a tmux pane id such as %97. Stop that exact pane;
    # fixed GPU sessions can contain a newer or unrelated task and must be preserved.
    stopped_task_count = 0
    try:
        data = read_json(path_for(root, "worker_task_snapshot.json"), {})
        tasks = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else []
        for task in tasks:
            if not isinstance(task, dict):
                continue
            if str(task.get("status") or "").lower() != "running":
                continue
            task_plan = re.sub(r"^\./", "", str(task.get("planFile") or task.get("plan") or "").replace("\\", "/"))
            if task_plan != requested_plan:
                continue
            task_run_id = str(task.get("workflowId") or task.get("workflow_id") or task.get("runId") or task.get("run_id") or "").strip()
            if task_run_id != wanted:
                # A same-Plan task is not necessarily owned by this scheduler.
                # Never stop it by Plan name alone. Missing identity remains an
                # explicit unresolved outcome so callers cannot assume the whole
                # requested run has settled.
                if not task_run_id:
                    remaining_active.append({"kind": "workerTaskIdentityUnknown",
                                             "commandId": str(task.get("commandId") or task.get("operationId") or "")[:160],
                                             "workerId": str(task.get("workerId") or "")[:120],
                                             "planFile": requested_plan})
                continue
            sess = str(task.get("tmuxSession") or "").strip()
            task_pid = str(task.get("pid") or "").strip()
            pane_id = task_pid if re.fullmatch(r"%[0-9]+", task_pid) else ""
            task_error = False
            if pane_id and sess:
                try:
                    owner = subprocess.run(["tmux", "display-message", "-p", "-t", pane_id, "#{session_name}"], capture_output=True, text=True, timeout=3, cwd=root)
                    if owner.returncode == 0 and owner.stdout.strip() == sess:
                        killed = subprocess.run(["tmux", "kill-pane", "-t", pane_id], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=5, cwd=root)
                        if killed.returncode == 0:
                            terminated_sessions.append(pane_id)
                        else:
                            errors.append((killed.stderr or b"tmux kill-pane failed").decode("utf-8", errors="replace").strip())
                            task_error = True
                except Exception as exc:
                    errors.append(str(exc))
                    task_error = True
            pid = int(task_pid) if task_pid.isdecimal() else 0
            if pid > 0 and _is_pid_alive(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                    if pid not in terminated_pids:
                        terminated_pids.append(pid)
                except Exception as exc:
                    errors.append(str(exc))
                    task_error = True
            if task_error:
                continue
            with WORKER_TASK_SNAPSHOT_LOCK:
                current = current_worker_task(root, task)
                if str(current.get("status") or "").lower() == "running":
                    append_worker_task(root, {**current, "status": "stopped", "finishedAt": now_iso(), "stopReason": "scheduler_aborted", "manualStopType": "scheduler_aborted"})
                    stopped_task_count += 1
        if stopped_task_count:
            try:
                append_event(root, {"type": "worker_task_stopped", "payload": {"reason": "scheduler_aborted", "terminatedSessions": terminated_sessions}})
            except Exception:
                pass
    except Exception as exc:
        errors.append(f"Worker 任务清理失败：{exc}")
    matched = matched_scheduler or stopped_task_count > 0
    message = "已中止调度并清理当前 Plan 任务" if matched_scheduler else ("已清理当前 Plan 的残留任务" if stopped_task_count else "未找到活动调度或 Worker 任务")
    status = "completed" if matched and not remaining_active and not errors else "failed"
    return terminal_action(root, "stop-scheduler-operation", str(payload.get("operationId") or f"stop-{int(time.time() * 1000)}"), str(payload.get("opId") or payload.get("operationId") or f"stop-{int(time.time() * 1000)}"), status, message, {
        "matchedOperations": [wanted] if wanted else [],
        "terminatedSessions": terminated_sessions,
        "terminatedPids": terminated_pids,
        "stoppedTaskCount": stopped_task_count,
        "remainingActiveEvidence": remaining_active,
        "checkedPid": after["checkedPid"],
        "checkedTmuxSession": after["checkedTmuxSession"],
        "planFile": plan,
        **({"errors": errors} if errors else {}),
    }, request=payload)


def recent_operations(root, limit=100):
    rows = operation_journal_index(root)["rows"]
    return rows[:max(1, int(limit or 100))]

def list_files(root, path_value):
    target = safe_project_path(root, path_value)
    entries = []
    if os.path.isdir(target):
        for name in sorted(os.listdir(target)):
            child_rel = str(path_value).replace("\\", "/").rstrip("/") + "/" + name
            try:
                entries.append(file_info(root, child_rel))
            except Exception:
                pass
    else:
        entries.append(file_info(root, path_value))
    return entries

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def worker_task_log_updated_at(root, task):
    item = task if isinstance(task, dict) else {}
    log_rel = str(item.get("logPath") or item.get("log_path") or "").strip()
    if not log_rel:
        return ""
    try:
        target = safe_project_path(root, log_rel)
        if not os.path.isfile(target):
            return ""
        stat = os.stat(target)
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime))
    except Exception:
        return ""

def normalize_overwrite_policy(value):
    text = str(value or "if_same_size").strip().lower()
    if text in ("always", "true", "overwrite", "replace"):
        return "always"
    if text in ("never", "false", "none", "reject"):
        return "never"
    return "if_same_size"

def existing_upload_target_info(path):
    if not os.path.exists(path):
        return None
    info = {"exists": True, "size": os.path.getsize(path)}
    if os.path.isfile(path):
        info["sha256"] = sha256_file(path)
    return info

def upload_target_snapshot(path):
    return existing_upload_target_info(path) or {"exists": False}

def validate_upload_overwrite(target, policy, incoming_size=None, incoming_sha="", original=None):
    existing = existing_upload_target_info(target)
    if policy == "always":
        return
    if original is not None:
        original_exists = bool(original.get("exists"))
        if original_exists and not existing:
            raise ValueError("target changed during upload; retry with overwrite=always")
        if existing and not original_exists:
            raise ValueError("target changed during upload; retry with overwrite=always")
    if not existing:
        return
    if policy == "never":
        raise ValueError("target exists")
    size = int(incoming_size or 0)
    if size and int(existing.get("size") or 0) != size:
        raise ValueError("target exists with different size; use overwrite=always")
    sha = str(incoming_sha or "").strip().lower()
    existing_sha = str(existing.get("sha256") or "").strip().lower()
    if sha and existing_sha and existing_sha != sha:
        raise ValueError("target exists with different content; use overwrite=always")
    if original:
        original_size = int(original.get("size") or -1)
        original_sha = str(original.get("sha256") or "").strip().lower()
        if original_size >= 0 and int(existing.get("size") or 0) != original_size:
            raise ValueError("target changed during upload; retry with overwrite=always")
        if original_sha and existing_sha and existing_sha != original_sha:
            raise ValueError("target changed during upload; retry with overwrite=always")

def require_op_id(handler, payload):
    op_id = str((payload or {}).get("opId") or "").strip()
    if not op_id:
        handler.send_json({"error": "opId required"}, status=400)
        return None
    return op_id

def kill_tmux_window_response(payload, mode, mgmt_env=""):
    target = str((payload or {}).get("target") or (payload or {}).get("window") or "").strip()
    if not target:
        return {"error": "target required"}, 400
    window_match = re.fullmatch(r"([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)", target)
    if not window_match:
        return {"error": "invalid target name", "detail": "kill-window requires session:index"}, 400
    sess_name = window_match.group(1)
    window_index = window_match.group(2)
    declared_session = str((payload or {}).get("session") or "").strip()
    if declared_session and declared_session != sess_name:
        return {"error": "session does not match target"}, 400
    confirmed = (payload or {}).get("confirm") is True or str((payload or {}).get("confirm") or "").strip().lower() in ("true", "1", "yes")
    if sess_name.endswith("-agent") and not confirmed:
        return {"schemaVersion": SCHEMA_VERSION, "ok": False, "target": target, "needConfirm": True, "error": "agent window requires confirm"}, 403
    mgmt_target = str(mgmt_env or os.environ.get("SIMPLE_EXPERIMENT_TMUX_SESSION") or "").strip()
    if not mgmt_target:
        try:
            _pfx = ""
            try:
                _pfx = str(_resolve_tmux_prefix() or "").strip()
            except Exception:
                _pfx = ""
            if not _pfx:
                _pfx = str(os.environ.get("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX") or "simple").strip().lower() or "simple"
            _pfx = re.sub(r"[^a-z0-9._-]+", "-", _pfx.lower()).strip("-")[:32] or "simple"
            if mode == "hub_control":
                mgmt_target = _pfx + "-hub-agent"
            else:
                try:
                    _wid = str(os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip().lower() or "worker"
                except Exception:
                    _wid = "worker"
                _wid = re.sub(r"[^a-z0-9._-]+", "-", _wid).strip("-") or "worker"
                mgmt_target = _pfx + "-worker-" + _wid + "-agent"
        except Exception:
            mgmt_target = ""
    if not mgmt_target:
        return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": "agent mgmt session unknown"}, 500
    if sess_name == mgmt_target:
        if not confirmed:
            return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": "current Agent window requires confirmation"}, 403
        threading.Timer(0.3, lambda: subprocess.run(["tmux", "kill-window", "-t", target], capture_output=True, text=True, timeout=5)).start()
        return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": True, "scheduled": True}, 200
    try:
        expected_id = str((payload or {}).get("windowId") or "").strip()
        expected_name = (payload or {}).get("windowName")
        expected_panes = (payload or {}).get("paneIds")
        if expected_id and not re.fullmatch(r"@\d+", expected_id):
            return {"ok": False, "error": "invalid window identity"}, 400
        if expected_panes is not None and (not isinstance(expected_panes, list) or not expected_panes or any(not isinstance(item, str) or not re.fullmatch(r"%\d+", item) for item in expected_panes)):
            return {"ok": False, "error": "invalid pane identities"}, 400
        before = subprocess.run(["tmux", "list-windows", "-t", "=" + sess_name, "-F", "#{session_name}|#{window_index}|#{window_id}|#{window_name}"], capture_output=True, text=True, timeout=5)
        rows = [line.split("|", 3) for line in (before.stdout or "").splitlines()]
        found = next((row for row in rows if len(row) == 4 and row[0] == sess_name and (row[2] == expected_id if expected_id else row[1] == window_index)), None)
        if before.returncode != 0 or not found:
            err = (before.stderr or "").strip()[-500:]
            return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": err or "target window not found"}, 200
        resolved_id = found[2]
        if not re.fullmatch(r"@\d+", resolved_id) or expected_name is not None and str(expected_name) != found[3]:
            return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": "window identity changed; not closed"}, 200
        if expected_panes is not None:
            pane_list = subprocess.run(["tmux", "list-panes", "-t", resolved_id, "-F", "#{pane_id}"], capture_output=True, text=True, timeout=5)
            if pane_list.returncode != 0 or sorted(set(expected_panes)) != sorted(set((pane_list.stdout or "").splitlines())):
                return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": "pane identities changed; not closed"}, 200
        # Window indexes can be renumbered immediately by tmux after any close.
        # Kill and verify the immutable ID, never a reused session:index.
        r = subprocess.run(["tmux", "kill-window", "-t", resolved_id], capture_output=True, text=True, timeout=5)
        err = (r.stderr or "").strip()[-500:]
        if r.returncode != 0:
            return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": err or f"rc={r.returncode}"}, 200
        after = subprocess.run(["tmux", "list-windows", "-a", "-F", "#{window_id}"], capture_output=True, text=True, timeout=5)
        after_err = (after.stderr or "").strip().lower()
        after_ids = {line.strip() for line in (after.stdout or "").splitlines() if line.strip()}
        gone = after.returncode != 0 and ("no server" in after_err or "no sessions" in after_err or "can't find session" in after_err or "no such session" in after_err)
        if after.returncode == 0:
            gone = resolved_id not in after_ids
        if not gone:
            return {"schemaVersion": SCHEMA_VERSION, "target": target, "ok": False, "error": "target still present after kill-window"}, 200
        return {"schemaVersion": SCHEMA_VERSION, "target": target, "session": sess_name, "index": found[1], "windowId": resolved_id, "ok": True, "verified": True}, 200
    except Exception as exc:
        return {"error": str(exc)}, 500

def serve_http(args):
    bind_host = str(getattr(args, "host", "") or "127.0.0.1").strip()
    if bind_host.startswith("[") and bind_host.endswith("]"):
        bind_host = bind_host[1:-1]
    if not bind_host or not re.fullmatch(r"[A-Za-z0-9._:%-]{1,253}", bind_host):
        raise RuntimeError("Agent --host must be a hostname or IP address without a port or URL path")
    if ":" in bind_host:
        try:
            ipaddress.ip_address(bind_host)
        except ValueError as exc:
            raise RuntimeError("Agent --host IPv6 address is invalid") from exc
    root = args.project_dir
    token = args.token or ""
    mode = args.mode or "hub_control"
    # Keep the worker id used for availability reporting and the worker command queue path
    # consistent with the serve --worker-id. The scheduler dispatches to and matches
    # availability by this id (e.g. "worker-id"); without this the agent would default to the
    # literal "worker", so the scheduler could never find the worker (idle=0, dispatches
    # rejected) and enqueued start-worker-task commands were written to a queue the agent
    # never reads.
    os.environ["SIMPLE_EXPERIMENT_WORKER_ID"] = str(getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker")
    prune_agent_state(root, force=True)
    if mode == "worker_telemetry":
        reconcile_worker_tasks_after_restart(root)
    atomic_write(path_for(root, "agent.session.json"), {"tokenConfigured": bool(token), "startedAt": now_iso(), "agentVersion": AGENT_VERSION, "agentInstallDir": agent_install_dir(root), "agentStateDir": agent_dir(root), "stateRetentionSeconds": STATE_RETENTION_SECONDS, "maxAgentStateBytes": MAX_AGENT_STATE_BYTES})
    if mode == "worker_telemetry":
        start_worker_telemetry_sampler(root, getattr(args, "gpu_poll_seconds", 60), getattr(args, "jitter_seconds", 30))
        # P0: worker_telemetry 与 hub_control 均启动 gpu_log_tail 采样，与 GPU 采样同频 60s，写入 live_output/{gid}.json + append_event log_tail
        try:
            start_gpu_log_tail_sampler(root, getattr(args, "gpu_poll_seconds", 60) or 60, getattr(args, "jitter_seconds", 30))
        except Exception:
            pass
        hub_uplink_url = getattr(args, "hub_uplink_url", "") or os.environ.get("SIMPLE_EXPERIMENT_HUB_UPLINK_URL", "")
        start_worker_hub_uplink(
            root,
            hub_uplink_url,
            getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID", ""),
            getattr(args, "worker_availability_push_seconds", 60),
            getattr(args, "jitter_seconds", 30),
            getattr(args, "operation_event_max_delay_ms", 1000),
        )
        # Single-worker (no hub) mode has no uplink driving command execution, so start a
        # local processor that polls the worker command queue and runs start-worker-task
        # commands (otherwise run-plan tasks would never launch).
        if not hub_uplink_url:
            start_worker_local_command_processor(
                root,
                getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID", ""),
                getattr(args, "worker_command_poll_seconds", 5),
                getattr(args, "jitter_seconds", 2),
            )
        start_durable_plan_queue_processor(
            root,
            getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID", ""),
            getattr(args, "worker_command_poll_seconds", 5),
        )
    elif mode == "hub_control":
        start_hub_control_sampler(root, getattr(args, "poll_seconds", 60), getattr(args, "jitter_seconds", 30))
        try:
            start_gpu_log_tail_sampler(root, getattr(args, "poll_seconds", 60) or 60, getattr(args, "jitter_seconds", 30))
        except Exception:
            pass

    class BoundedThreadingHTTPServer(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
        daemon_threads = True
        request_queue_size = 64
        max_request_threads = 52
        request_class_limits = {
            "probe": 4,
            "control": 8,
            "read": 24,
            "transfer": 2,
            "sse": 8,
            "proxy": 4,
        }
        request_class_timeouts = {
            "probe": 10,
            "control": 60,
            "read": 60,
            "transfer": 180,
            "sse": 10,
            "proxy": 60,
        }

        def __init__(self, server_address, request_handler_class):
            self._request_slots = threading.BoundedSemaphore(self.max_request_threads)
            self._class_slots = {name: threading.BoundedSemaphore(limit) for name, limit in self.request_class_limits.items()}
            self._capacity_lock = threading.Lock()
            self._active_requests = 0
            self._active_by_class = {name: 0 for name in self.request_class_limits}
            self._rejected_requests = 0
            self._rejected_by_class = {name: 0 for name in self.request_class_limits}
            super().__init__(server_address, request_handler_class)

        def process_request(self, request, client_address):
            if not self._request_slots.acquire(blocking=False):
                with self._capacity_lock:
                    self._rejected_requests += 1
                try:
                    request.settimeout(0.5)
                    request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                except OSError:
                    pass
                self.shutdown_request(request)
                return
            with self._capacity_lock:
                self._active_requests += 1
            try:
                # Bound slow request-line/header reads before Handler can classify the route.
                request.settimeout(10)
                super().process_request(request, client_address)
            except Exception:
                with self._capacity_lock:
                    self._active_requests = max(0, self._active_requests - 1)
                self._request_slots.release()
                raise

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                with self._capacity_lock:
                    self._active_requests = max(0, self._active_requests - 1)
                self._request_slots.release()

        def classify_request(self, method, route):
            if method == "GET" and route in (
                "/api/health", "/health", "/api/version", "/version",
                "/api/capabilities", "/api/openapi.json",
                "/api/worker/availability", "/api/availability",
            ):
                return "probe"
            if method == "GET" and route in ("/api/events/sse", "/api/workers/uplink/commands/sse"):
                return "sse"
            if route.startswith("/api/tensorboard/") or route == TENSORBOARD_BROWSER_PREFIX or route.startswith(TENSORBOARD_BROWSER_PREFIX + "/"):
                return "proxy"
            if route == "/api/files/upload-cancel":
                return "control"
            if route.startswith("/api/files/download") or route in (
                "/api/files/upload-init", "/api/files/upload-chunk", "/api/files/upload-complete", "/api/files/upload-cancel",
            ):
                return "transfer"
            if method == "POST":
                return "control"
            return "read"

        def acquire_request_class(self, request_class):
            slot = self._class_slots.get(request_class)
            if slot is None or not slot.acquire(blocking=False):
                with self._capacity_lock:
                    self._rejected_by_class[request_class] = self._rejected_by_class.get(request_class, 0) + 1
                return False
            with self._capacity_lock:
                self._active_by_class[request_class] = self._active_by_class.get(request_class, 0) + 1
            return True

        def release_request_class(self, request_class):
            if not request_class:
                return
            slot = self._class_slots.get(request_class)
            if slot is None:
                return
            with self._capacity_lock:
                self._active_by_class[request_class] = max(0, self._active_by_class.get(request_class, 0) - 1)
            slot.release()

        def request_timeout(self, request_class):
            return self.request_class_timeouts.get(request_class, 60)

        def capacity_snapshot(self):
            with self._capacity_lock:
                return {
                    "schemaVersion": 1,
                    "active": self._active_requests,
                    "maxActive": self.max_request_threads,
                    "rejected": self._rejected_requests + sum(self._rejected_by_class.values()),
                    "classes": {
                        name: {
                            "active": self._active_by_class[name],
                            "limit": self.request_class_limits[name],
                            "rejected": self._rejected_by_class[name],
                        }
                        for name in self.request_class_limits
                    },
                }

    class Handler(BaseHTTPRequestHandler):
        server_version = "SimpleExperimentAgent/" + AGENT_VERSION

        MAX_CONTROL_BODY_BYTES = 8 * 1024 * 1024
        MAX_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024

        def log_message(self, fmt, *items):
            return

        def parse_request(self):
            self._admitted_request_class = None
            if not super().parse_request():
                return False
            request_class = self.server.classify_request(self.command, urlparse(self.path).path)
            if not self.server.acquire_request_class(request_class):
                self.close_connection = True
                self.send_response(503)
                self.send_header("Retry-After", "2")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
            self._admitted_request_class = request_class
            self.connection.settimeout(self.server.request_timeout(request_class))
            return True

        def handle_one_request(self):
            self._admitted_request_class = None
            try:
                return super().handle_one_request()
            finally:
                request_class = self._admitted_request_class
                self._admitted_request_class = None
                self.server.release_request_class(request_class)

        def localhost_only(self):
            host = self.client_address[0]
            return host in ("127.0.0.1", "::1")

        def authorized(self):
            if not token:
                return True
            supplied = self.headers.get("X-Simple-Agent-Token") or ""
            auth = self.headers.get("Authorization") or ""
            if auth.startswith("Bearer "):
                supplied = auth[len("Bearer "):]
            return supplied == token

        def send_json(self, payload, status=200):
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def read_request_body(self, route):
            transfer_encoding = str(self.headers.get("Transfer-Encoding") or "").strip().lower()
            if transfer_encoding:
                self.close_connection = True
                self.send_json({"error": "Transfer-Encoding request bodies are not supported"}, status=400)
                return None
            raw_length = self.headers.get("Content-Length")
            try:
                length = int(raw_length or 0)
            except (TypeError, ValueError):
                self.close_connection = True
                self.send_json({"error": "invalid Content-Length"}, status=400)
                return None
            if length < 0:
                self.close_connection = True
                self.send_json({"error": "invalid Content-Length"}, status=400)
                return None
            is_upload_chunk = route == "/api/files/upload-chunk"
            limit = self.MAX_UPLOAD_CHUNK_BYTES if is_upload_chunk else self.MAX_CONTROL_BODY_BYTES
            if length > limit:
                self.close_connection = True
                self.send_json({"error": "request body too large", "maxBytes": limit}, status=413)
                return None
            if not length:
                return b""
            try:
                body = self.rfile.read(length)
            except (OSError, TimeoutError):
                self.close_connection = True
                self.send_json({"error": "request body read failed"}, status=400)
                return None
            if len(body) != length:
                self.close_connection = True
                self.send_json({"error": "incomplete request body"}, status=400)
                return None
            return body

        def proxy_tensorboard(self, parsed):
            params = parse_qs(parsed.query)
            try:
                browser_route = parsed.path == TENSORBOARD_BROWSER_PREFIX or parsed.path.startswith(TENSORBOARD_BROWSER_PREFIX + "/")
                if browser_route:
                    if len(TENSORBOARD_PROXY_PORTS) != 1:
                        return self.send_json({"error": "TensorBoard 会话未就绪或不唯一"}, status=403)
                    session, port = next(iter(TENSORBOARD_PROXY_PORTS.items()))
                    target = parsed.path + (("?" + parsed.query) if parsed.query else "")
                else:
                    port = int((params.get("port") or ["0"])[0])
                    session = tb_tmux_session_name((params.get("sessionPrefix") or [""])[0])
                    target = str((params.get("path") or ["/"])[0])
                if port < 1024 or port > 65535 or TENSORBOARD_PROXY_PORTS.get(session) != port:
                    return self.send_json({"error": "TensorBoard 会话未授权或未运行"}, status=403)
                if not target.startswith("/") or target.startswith("//") or any(ord(ch) < 32 for ch in target):
                    return self.send_json({"error": "invalid TensorBoard path"}, status=400)
                length = int(self.headers.get("Content-Length") or 0)
                if length < 0 or length > 1024 * 1024:
                    return self.send_json({"error": "TensorBoard request too large"}, status=413)
                body = self.rfile.read(length) if length else None
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
                try:
                    headers = {"Accept": self.headers.get("Accept") or "*/*"}
                    if body:
                        headers["Content-Type"] = self.headers.get("Content-Type") or "application/octet-stream"
                    conn.request(self.command, target, body=body, headers=headers)
                    upstream = conn.getresponse()
                    data = upstream.read(16 * 1024 * 1024 + 1)
                    if len(data) > 16 * 1024 * 1024:
                        return self.send_json({"error": "TensorBoard response too large"}, status=413)
                    self.send_response(upstream.status)
                    for name in ("Content-Type", "Location", "Set-Cookie", "Cache-Control"):
                        value = upstream.getheader(name)
                        if value:
                            self.send_header(name, value)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                finally:
                    conn.close()
            except Exception as exc:
                return self.send_json({"error": f"TensorBoard proxy failed: {exc}"}, status=502)

        def send_bytes(self, data, name="download.bin", status=200, sha256=""):
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f"attachment; filename={json.dumps(name)}")
            self.send_header("Content-Length", str(len(data)))
            if sha256:
                self.send_header("X-Simple-File-Sha256", sha256)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def send_file_stream(self, target, start=0, end=None, partial=False, max_bytes=0):
            size = os.path.getsize(target)
            if int(max_bytes or 0) > 0 and size > int(max_bytes):
                return self.send_json({"error": "file exceeds requested maxBytes", "size": size, "maxBytes": int(max_bytes)}, status=413)
            safe_start = max(0, min(int(start or 0), size))
            safe_end = size - 1 if end is None else max(safe_start, min(int(end), size - 1))
            length = 0 if size == 0 else safe_end - safe_start + 1
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f"attachment; filename={json.dumps(os.path.basename(target))}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("X-Simple-File-Sha256", sha256_file(target))
            if partial:
                self.send_header("Content-Range", f"bytes {safe_start}-{safe_end}/{size}")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(target, "rb") as f:
                f.seek(safe_start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

        def send_sse(self, events):
            body = "".join("data: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n\n" for event in events).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_sse_stream(self, since):
            parsed = urlparse(self.path)
            route = parsed.path
            params = parse_qs(parsed.query)
            worker_id = (params.get("workerId") or [os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker"])[0]
            command_since = int((params.get("commandsSince") or ["0"])[0] or 0)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            last = int(since or 0)
            last_ping = 0.0
            idle_rounds = 0
            try:
                while True:
                    if route.endswith("/commands/sse"):
                        commands = read_worker_commands(root, worker_id, command_since, 6)
                        for command in commands:
                            command_since = max(command_since, int(command.get("queueSeq") or command_since))
                            event = {"schemaVersion": SCHEMA_VERSION, "seq": command_since, "type": "worker_command", "generatedAt": now_iso(), "workerId": worker_id, "payload": command}
                            data = ("data: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode("utf-8")
                            self.wfile.write(data)
                            self.wfile.flush()
                        if commands:
                            idle_rounds = 0
                        elif time.time() - last_ping >= 15:
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                            last_ping = time.time()
                            idle_rounds = 0
                        else:
                            idle_rounds += 1
                        time.sleep(sse_idle_sleep_seconds(idle_rounds))
                        continue
                    events = read_events_since(root, last, 8, f"sse-{threading.get_ident()}")
                    batch_bytes = 0
                    gap_sent = False
                    for event in events:
                        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                        if payload.get("code") == "journal_gap":
                            # The client repairs from a current snapshot. Advance the server-side
                            # cursor so a persisted gap marker is not replayed forever.
                            last = read_seq(root)
                        else:
                            last = max(last, int(event.get("seq") or last))
                        data = ("data: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode("utf-8")
                        if len(data) > MAX_AGENT_SSE_EVENT_BYTES:
                            if not gap_sent:
                                gap = {"schemaVersion": SCHEMA_VERSION, "seq": last, "type": "journal_gap", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "reason": "event_exceeds_sse_limit", "maxBytes": MAX_AGENT_SSE_EVENT_BYTES}}
                                self.wfile.write(("data: " + json.dumps(gap, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode("utf-8"))
                                self.wfile.flush()
                                gap_sent = True
                            continue
                        if batch_bytes + len(data) > MAX_AGENT_SSE_BATCH_BYTES:
                            if not gap_sent:
                                gap = {"schemaVersion": SCHEMA_VERSION, "seq": last, "type": "journal_gap", "generatedAt": now_iso(), "source": "hub_agent", "payload": {"code": "journal_gap", "reason": "sse_batch_limit", "maxBytes": MAX_AGENT_SSE_BATCH_BYTES}}
                                self.wfile.write(("data: " + json.dumps(gap, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode("utf-8"))
                                self.wfile.flush()
                            last = read_seq(root)
                            break
                        self.wfile.write(data)
                        self.wfile.flush()
                        batch_bytes += len(data)
                    if events:
                        idle_rounds = 0
                    elif time.time() - last_ping >= 15:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        last_ping = time.time()
                        idle_rounds = 0
                    else:
                        idle_rounds += 1
                    time.sleep(sse_idle_sleep_seconds(idle_rounds))
            except (BrokenPipeError, ConnectionResetError, OSError):
                return

        def reject_if_needed(self):
            if not self.localhost_only():
                self.send_json({"error": "localhost only"}, status=403)
                return True
            browser_path = urlparse(self.path).path
            if browser_path == TENSORBOARD_BROWSER_PREFIX or browser_path.startswith(TENSORBOARD_BROWSER_PREFIX + "/"):
                return False
            if not self.authorized():
                self.send_json({"error": "unauthorized"}, status=401)
                return True
            return False

        def do_GET(self):
            parsed = urlparse(self.path)
            route = parsed.path
            # Availability is a non-sensitive readiness signal used by the local scheduler.
            # Keep it loopback-only, but do not require the bearer token inside that tunnel.
            if route == "/api/worker/availability":
                if not self.localhost_only():
                    self.send_json({"error": "localhost only"}, status=403)
                    return
            elif self.reject_if_needed():
                return
            if route in ("/api/health", "/health", "/api/version", "/version"):
                # 兼容别名：/health 与 /api/health 均可达，避免前端 worker_telemetry 404 无回调
                if route in ("/health", "/version") or route == "/api/version":
                    return self.send_json(api_version(root, mode) if route.endswith("version") else api_health(root, mode))
                return self.send_json(api_health(root, mode))
            if route == "/api/version":
                return self.send_json(api_version(root, mode))
            if route == "/api/capabilities":
                return self.send_json(api_capabilities(root, bool(token), mode))
            if route == "/api/openapi.json":
                return self.send_json(api_openapi(root, bool(token), mode))
            operation_route = route.startswith("/api/operations/")
            if mode == "worker_telemetry" and route not in ("/api/health", "/health", "/api/version", "/version", "/api/capabilities", "/api/gpu", "/api/gpu/history", "/api/runtime/evidence", "/api/worker/availability", "/api/worker/tasks", "/api/worker/commands", "/api/workers/uplink/commands/sse", "/api/live-output", "/api/results/summary", "/api/diagnostics", "/api/code-sync/inspect", "/api/events", "/api/events/sse", "/api/fs/sha256", "/api/files/capabilities", "/api/files/stat", "/api/files/download", "/api/files/download-range", "/api/tmux/capture", "/api/tmux/list", "/api/tensorboard/proxy", "/api/tensorboard/scalars/catalog") and not route.startswith(TENSORBOARD_BROWSER_PREFIX + "/") and route != TENSORBOARD_BROWSER_PREFIX and not operation_route:
                return self.send_json({"error": "worker telemetry does not expose hub control api"}, status=404)
            if route == "/api/tensorboard/proxy" or route == TENSORBOARD_BROWSER_PREFIX or route.startswith(TENSORBOARD_BROWSER_PREFIX + "/"):
                return self.proxy_tensorboard(parsed)
            if route == "/api/tensorboard/scalars/catalog":
                try:
                    return self.send_json(scalar_catalog(root, (parse_qs(parsed.query).get("logdir") or ["work_dirs"])[0]))
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=500)
            if operation_route:
                operation_id = unquote(route[len("/api/operations/"):]).strip()
                result = api_operation(root, operation_id)
                return self.send_json(result, status=200 if result.get("eventCount") else 404)
            if route == "/api/files/capabilities":
                return self.send_json(api_file_capabilities())
            if route == "/api/fs/sha256":
                params = parse_qs(parsed.query)
                file_path = (params.get("path") or [""])[0].strip()
                return self.send_json(fs_sha256(root, file_path))
            if route == "/api/code-sync/inspect":
                return self.send_json(code_sync_inspect(root, parse_qs(parsed.query).get("path", [])))
            if route == "/api/snapshot":
                return self.send_json(api_snapshot(root))
            if route == "/api/gpu":
                if mode == "worker_telemetry":
                    return self.send_json(api_worker_gpu(root))
                return self.send_json(read_runtime_json_cached(path_for(root, "gpu_snapshot.json"), {}))
            if route == "/api/gpu/history":
                params = parse_qs(parsed.query)
                server_id = (params.get("serverId") or params.get("server_id") or [""])[0]
                gpu_id = (params.get("gpuId") or params.get("gpu_id") or [""])[0]
                start = (params.get("start") or [None])[0]
                end = (params.get("end") or [None])[0]
                max_points = (params.get("maxPoints") or params.get("max_points") or [GPU_HISTORY_MAX_POINTS_PER_SERIES])[0]
                return self.send_json(query_gpu_history(root, server_id, gpu_id, start, end, max_points))
            if route in ("/api/worker/availability", "/api/availability"):
                if mode == "worker_telemetry":
                    return self.send_json(api_worker_availability(root))
                return self.send_json(read_availability_cache(root, True))
            if route == "/api/worker/tasks":
                return self.send_json(api_worker_tasks(root))
            if route == "/api/worker/commands":
                params = parse_qs(parsed.query)
                worker_id = (params.get("workerId") or [os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker"])[0]
                since = int((params.get("since") or ["0"])[0] or 0)
                return self.send_json({"schemaVersion": SCHEMA_VERSION, "commands": read_worker_commands(root, worker_id, since)})
            if route == "/api/scheduler":
                return self.send_json(read_runtime_json_cached(path_for(root, "cluster_snapshot.json"), {}))
            if route == "/api/traces":
                return self.send_json(read_runtime_json_cached(path_for(root, "experiment_traces_snapshot.json"), {}))
            if route == "/api/results/summary":
                params = parse_qs(parsed.query)
                plan = (params.get("planFile") or params.get("plan") or params.get("selectedPlanId") or [""])[0]
                return self.send_json(read_results_summary(root, plan or None, True))
            if route == "/api/runtime/evidence":
                params = parse_qs(parsed.query)
                return self.send_json(api_runtime_operation_evidence(
                    root,
                    (params.get("operationId") or params.get("opId") or [""])[0],
                    (params.get("planFile") or [""])[0],
                    (params.get("pid") or [None])[0],
                    (params.get("tmuxSession") or [""])[0],
                ))
            if route == "/api/diagnostics":
                diagnostics = api_diagnostics(root)
                if isinstance(diagnostics, dict):
                    diagnostics["httpCapacity"] = self.server.capacity_snapshot()
                return self.send_json(diagnostics)
            if route == "/api/audit/tail":
                return self.send_json({"schemaVersion": SCHEMA_VERSION, "tail": read_audit_tail(root)})
            if route == "/api/events":
                params = parse_qs(parsed.query)
                since = int((params.get("since") or ["0"])[0] or 0)
                return self.send_json({"schemaVersion": SCHEMA_VERSION, "events": read_events_since(root, since)})
            if route == "/api/events/sse":
                params = parse_qs(parsed.query)
                since = int((params.get("since") or ["0"])[0] or 0)
                return self.send_sse_stream(since)
            if route == "/api/workers/uplink/commands/sse":
                return self.send_sse_stream(0)
            if route == "/api/logs/tail":
                params = parse_qs(parsed.query)
                run_key = (params.get("runKey") or [""])[0]
                since = int((params.get("since") or ["0"])[0] or 0)
                log_path = safe_project_path(root, run_key) if run_key else ""
                if not log_path or not os.path.isfile(log_path):
                    return self.send_json({"schemaVersion": SCHEMA_VERSION, "runKey": run_key, "offset": since, "text": ""})
                with open(log_path, "rb") as f:
                    f.seek(max(0, since))
                    data = f.read(256 * 1024)
                    offset = f.tell()
                return self.send_json({"schemaVersion": SCHEMA_VERSION, "runKey": run_key, "offset": offset, "text": data.decode("utf-8", errors="replace")})
            if route == "/api/live-output":
                params = parse_qs(parsed.query)
                run_key = (params.get("runKey") or [""])[0]
                since = int((params.get("since") or ["0"])[0] or 0)
                log_path = safe_project_path(root, run_key) if run_key else ""
                if not log_path or not os.path.isfile(log_path):
                    return self.send_json({"schemaVersion": SCHEMA_VERSION, "runKey": run_key, "offset": since, "text": ""})
                size = os.path.getsize(log_path)
                start = max(0, size - 256 * 1024) if since <= 0 or since > size else since
                with open(log_path, "rb") as f:
                    f.seek(start)
                    data = f.read(256 * 1024)
                    offset = f.tell()
                return self.send_json({"schemaVersion": SCHEMA_VERSION, "runKey": run_key, "offset": offset, "text": data.decode("utf-8", errors="replace")})
            if route == "/api/logs/stream":
                params = parse_qs(parsed.query)
                run_key = (params.get("runKey") or [""])[0]
                since = int((params.get("since") or ["0"])[0] or 0)
                payload = {"schemaVersion": SCHEMA_VERSION, "seq": read_seq(root) + 1, "type": "log_tail", "generatedAt": now_iso(), "source": "hub_agent", "runKey": run_key, "payload": {"offset": since, "text": ""}}
                return self.send_sse([payload])
            if route == "/api/files/list":
                try:
                    path_value = (parse_qs(parsed.query).get("path") or ["simple_cluster"])[0]
                    return self.send_json({"schemaVersion": SCHEMA_VERSION, "path": path_value, "entries": list_files(root, path_value)})
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=400)
            if route == "/api/files/stat":
                try:
                    return self.send_json(file_info(root, (parse_qs(parsed.query).get("path") or [""])[0]))
                except Exception as exc:
                    path_value = (parse_qs(parsed.query).get("path") or [""])[0]
                    return self.send_json({"schemaVersion": SCHEMA_VERSION, "path": path_value, "exists": False, "error": str(exc)}, status=404)
            if route == "/api/files/download" or route == "/api/files/download-range":
                try:
                    params = parse_qs(parsed.query)
                    target = safe_project_path(root, (params.get("path") or [""])[0])
                    if not os.path.isfile(target):
                        return self.send_json({"error": "file not found"}, status=404)
                    start = int((params.get("start") or ["0"])[0] or 0)
                    end_raw = (params.get("end") or [""])[0]
                    max_bytes = int((params.get("maxBytes") or ["0"])[0] or 0)
                    return self.send_file_stream(target, start if route == "/api/files/download-range" else 0, int(end_raw) if end_raw else None, route == "/api/files/download-range", max_bytes)
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=400)
            if route == "/api/files/transfer-status":
                transfer_id = (parse_qs(parsed.query).get("id") or [""])[0]
                return self.send_json(read_transfer_status(root, transfer_id))
            if route == "/api/tmux/capture":
                params = parse_qs(parsed.query)
                window = (params.get("window") or params.get("session") or params.get("name") or [""])[0].strip()
                if not window:
                    return self.send_json({"error": "window required"}, status=400)
                # allow alnum, ._-:, %, dot and slash for pane target (pane id like %0, window like session:1, pane like session:1.2)
                if not re.match(r"^[A-Za-z0-9._\-:./%]+$", window):
                    return self.send_json({"error": "invalid window name"}, status=400)
                try:
                    requested_lines = (params.get("lines") or ["all"])[0].strip().lower()
                    if requested_lines == "all":
                        start_line = "-"
                    else:
                        try:
                            history_lines = max(200, min(4000, int(requested_lines)))
                        except (TypeError, ValueError):
                            return self.send_json({"error": "invalid lines"}, status=400)
                        start_line = f"-{history_lines}"
                    r = subprocess.run(["tmux", "capture-pane", "-p", "-S", start_line, "-t", window], capture_output=True, text=True, timeout=5)
                    text = r.stdout or ""
                    if r.returncode != 0:
                        return self.send_json({"schemaVersion": SCHEMA_VERSION, "window": window, "ok": False, "error": (r.stderr or f"rc={r.returncode}").strip()[-500:], "text": text}, status=200)
                    return self.send_json({"schemaVersion": SCHEMA_VERSION, "window": window, "ok": True, "text": text, "historyLineCount": len(text.splitlines()), "lines": text.splitlines()})
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=500)
            if route == "/api/tmux/list":
                try:
                    if not tmux_available():
                        return self.send_json({"schemaVersion": SCHEMA_VERSION, "ok": True, "available": False, "sessions": [], "error": "tmux not found"})
                    # list sessions
                    sess_proc = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"], capture_output=True, text=True, timeout=5)
                    if sess_proc.returncode != 0:
                        err = (sess_proc.stderr or "").strip().lower()
                        if "no server" in err or "no sessions" in err:
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "ok": True, "available": True, "sessions": [], "message": "no tmux server"})
                        # fallback to tmux ls
                        sess_proc2 = subprocess.run(["tmux", "ls"], capture_output=True, text=True, timeout=5)
                        if sess_proc2.returncode != 0 and ("no server" in (sess_proc2.stderr or "").lower() or "no sessions" in (sess_proc2.stderr or "").lower()):
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "ok": True, "available": True, "sessions": [], "message": "no tmux server"})
                        return self.send_json({"schemaVersion": SCHEMA_VERSION, "ok": False, "available": True, "sessions": [], "error": (sess_proc.stderr or sess_proc2.stderr or "list-sessions failed").strip()[-500:]}, status=200)
                    task_snapshot = read_runtime_json_cached(path_for(root, "worker_task_snapshot.json"), {})
                    task_rows = task_snapshot.get("tasks") if isinstance(task_snapshot, dict) and isinstance(task_snapshot.get("tasks"), list) else []
                    tasks_by_pane = {}
                    for task_row in task_rows:
                        if not isinstance(task_row, dict):
                            continue
                        pane_key = str(task_row.get("tmuxPane") or task_row.get("pid") or "").strip()
                        if pane_key.startswith("%"):
                            tasks_by_pane[pane_key] = task_row
                    gpu_snapshot = read_runtime_json_cached(path_for(root, "gpu_snapshot.json"), {})
                    gpu_rows = (gpu_snapshot.get("gpus") or gpu_snapshot.get("gpu") or []) if isinstance(gpu_snapshot, dict) else []
                    if isinstance(gpu_rows, dict):
                        gpu_rows = next((value for value in gpu_rows.values() if isinstance(value, list)), [])
                    gpu_ids = []
                    for gpu_row in gpu_rows if isinstance(gpu_rows, list) else []:
                        if not isinstance(gpu_row, dict):
                            continue
                        gpu_value = gpu_row_id(gpu_row)
                        if gpu_value and gpu_value not in gpu_ids:
                            gpu_ids.append(gpu_value)
                    sessions = []
                    list_errors = []
                    for line in (sess_proc.stdout or "").splitlines():
                        if not line.strip():
                            continue
                        parts = line.split("|")
                        sess_name = (parts[0] if len(parts)>0 else "").strip()
                        if not sess_name:
                            continue
                        try:
                            sess_windows = int((parts[1] if len(parts)>1 else "0").strip() or 0)
                        except Exception:
                            sess_windows = 0
                        # list windows for this session
                        windows = []
                        try:
                            win_proc = subprocess.run(["tmux", "list-windows", "-t", "=" + sess_name, "-F", "#{window_index}|#{window_name}|#{window_active}|#{window_panes}|#{window_id}"], capture_output=True, text=True, timeout=5)
                            if win_proc.returncode == 0:
                                for wline in (win_proc.stdout or "").splitlines():
                                    if not wline.strip():
                                        continue
                                    wparts = wline.split("|")
                                    widx = (wparts[0] if len(wparts)>0 else "").strip()
                                    wname = (wparts[1] if len(wparts)>1 else "").strip()
                                    wactive = (wparts[2] if len(wparts)>2 else "0").strip() == "1"
                                    wid = (wparts[4] if len(wparts)>4 else "").strip()
                                    if not re.fullmatch(r"@\d+", wid):
                                        list_errors.append(sess_name + ": invalid window identity")
                                    try:
                                        wpanes = int((wparts[3] if len(wparts)>3 else "1").strip() or 1)
                                    except Exception:
                                        wpanes = 1
                                    panes = []
                                    try:
                                        pane_proc = subprocess.run(["tmux", "list-panes", "-t", f"{sess_name}:{widx}", "-F", "#{pane_index}|#{pane_active}|#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_id}|#{pane_title}"], capture_output=True, text=True, timeout=5)
                                        if pane_proc.returncode == 0:
                                            for pline in (pane_proc.stdout or "").splitlines():
                                                if not pline.strip():
                                                    continue
                                                pparts = pline.split("|")
                                                pidx = (pparts[0] if len(pparts)>0 else "").strip()
                                                pactive = (pparts[1] if len(pparts)>1 else "0").strip() == "1"
                                                pcmd = (pparts[2] if len(pparts)>2 else "").strip()
                                                try:
                                                    pw = int((pparts[3] if len(pparts)>3 else "0").strip() or 0)
                                                except Exception:
                                                    pw = 0
                                                try:
                                                    ph = int((pparts[4] if len(pparts)>4 else "0").strip() or 0)
                                                except Exception:
                                                    ph = 0
                                                pid = (pparts[5] if len(pparts)>5 else "").strip()
                                                ptitle = (pparts[6] if len(pparts)>6 else "").strip()
                                                target = f"{sess_name}:{widx}.{pidx}" if pidx else f"{sess_name}:{widx}"
                                                panes.append({"index": pidx, "active": pactive, "command": pcmd, "width": pw, "height": ph, "id": pid, "title": ptitle, "target": target})
                                        else:
                                            panes.append({"index": "0", "active": True, "command": "", "width": 0, "height": 0, "id": "", "title": "", "target": f"{sess_name}:{widx}"})
                                    except Exception:
                                        pass
                                    matched_task = next((tasks_by_pane.get(str(pane.get("id") or "")) for pane in panes if tasks_by_pane.get(str(pane.get("id") or ""))), None)
                                    task_meta = None
                                    if isinstance(matched_task, dict):
                                        task_meta = {
                                            "commandId": matched_task.get("commandId") or matched_task.get("operationId") or "",
                                            "case": matched_task.get("case") or "",
                                            "seed": matched_task.get("seed"),
                                            "status": matched_task.get("status") or "",
                                            "gpuId": matched_task.get("gpuId") or matched_task.get("gpu_id") or "",
                                            "experimentIndex": matched_task.get("experimentIndex"),
                                            "planFile": matched_task.get("planFile") or matched_task.get("plan") or "",
                                            "startedAt": matched_task.get("startedAt") or matched_task.get("started_at") or "",
                                            "finishedAt": matched_task.get("finishedAt") or matched_task.get("finished_at") or "",
                                            "logUpdatedAt": worker_task_log_updated_at(root, matched_task),
                                            "outputDir": matched_task.get("outputDir") or matched_task.get("output_dir") or "",
                                            "configPath": matched_task.get("configPath") or matched_task.get("config_path") or "",
                                        }
                                    windows.append({"index": widx, "windowId": wid, "name": wname, "active": wactive, "panes": panes, "target": f"{sess_name}:{widx}", "paneCount": wpanes, "task": task_meta})
                            else:
                                list_errors.append(sess_name + ": " + (win_proc.stderr or "list-windows failed").strip()[-300:])
                        except Exception as exc:
                            list_errors.append(sess_name + ": " + str(exc)[-300:])
                        sessions.append({"name": sess_name, "windowCount": sess_windows, "windows": windows})
                    return self.send_json({"schemaVersion": SCHEMA_VERSION, "ok": not list_errors, "available": True, "workerId": os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker", "gpuIds": gpu_ids, "sessions": sessions, "error": "; ".join(list_errors)})
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=500)
            return self.send_json({"error": "not found"}, status=404)

        def do_POST(self):
            if self.reject_if_needed():
                return
            route = urlparse(self.path).path
            if mode == "worker_telemetry":
                worker_action = route.rsplit("/", 1)[-1] if route.startswith("/api/actions/") else ""
                if route not in ("/api/actions/save-result-policy", "/api/actions/start-worker-task", "/api/actions/register-code-sync-proof", "/api/actions/rebuild-distributed-results", "/api/actions/retry-worker-task", "/api/actions/stop-worker-task", "/api/actions/delete-worker-artifacts", "/api/actions/archive-worker-artifacts", "/api/actions/validate-plan", "/api/actions/dry-run-plan", "/api/actions/run-plan", "/api/actions/reproduce-plan", "/api/actions/stop-scheduler-operation", "/api/actions/clear-cache", "/api/actions/clearCache", "/api/actions/preview-cache-cleanup", "/api/actions/delete-cache-candidates", "/api/tmux/kill-window", "/api/tensorboard/proxy", "/api/tensorboard/scalars/query") and not route.startswith(TENSORBOARD_BROWSER_PREFIX + "/") and route != TENSORBOARD_BROWSER_PREFIX and worker_action not in WORKER_RESULT_ACTIONS and worker_action not in WORKER_TENSORBOARD_ACTIONS and worker_action not in WORKER_ENV_ACTIONS:
                    return self.send_json({"error": "worker telemetry only accepts local worker actions"}, status=404)
            if route == "/api/tensorboard/proxy" or route == TENSORBOARD_BROWSER_PREFIX or route.startswith(TENSORBOARD_BROWSER_PREFIX + "/"):
                return self.proxy_tensorboard(urlparse(self.path))
            allowed = ACTION_ROUTES.union({
                "/api/tmux/kill-window",
                "/api/worker/availability/batch",
                "/api/workers/uplink/events",
                "/api/files/upload-init",
                "/api/files/upload-chunk",
                "/api/files/upload-complete",
                "/api/files/upload-cancel",
                "/api/admin/kill-stale-runtime",
                "/api/admin/exec",
            })
            if route not in allowed:
                return self.send_json({"error": "not found"}, status=404)
            raw_body = self.read_request_body(route)
            if raw_body is None:
                return
            payload = {}
            if route != "/api/files/upload-chunk" or "application/json" in (self.headers.get("Content-Type") or ""):
                try:
                    payload = json.loads(raw_body.decode("utf-8") or "{}")
                except Exception:
                    return self.send_json({"error": "invalid json"}, status=400)
                if not isinstance(payload, dict):
                    return self.send_json({"error": "request JSON must be an object"}, status=400)
            if route == "/api/tensorboard/scalars/query":
                try:
                    if not isinstance(payload, dict):
                        raise ValueError("invalid scalar query")
                    return self.send_json(scalar_query(root, payload))
                except ValueError as exc:
                    return self.send_json({"error": str(exc)}, status=400)
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=500)
            # 直接调用 tmux 客户端；Agent 窗格正运行 Python，send-keys 不会执行 shell 命令。
            if route == "/api/tmux/kill-window":
                if not self.localhost_only():
                    return self.send_json({"error": "localhost only"}, status=403)
                body, status = kill_tmux_window_response(payload, mode)
                return self.send_json(body, status=status)
            # Keep the legacy endpoint name, but require the same exact operation/Plan identity as the normal stop route.
            if route in ("/api/admin/kill-stale-runtime", "/api/admin/exec"):
                if not self.localhost_only():
                    return self.send_json({"error": "localhost only"}, status=403)
                if self.reject_if_needed():
                    return
                if route == "/api/admin/exec":
                    return self.send_json({"ok": False, "error": "arbitrary remote shell execution is disabled; use an exact operation stop action"}, status=403)
                if str(payload.get("command") or payload.get("cmd") or "").strip():
                    return self.send_json({"ok": False, "error": "command is not accepted; provide an exact targetOperationId and planFile"}, status=400)
                target_operation_id = str(payload.get("targetOperationId") or payload.get("remoteOperationId") or payload.get("operationId") or payload.get("opId") or "").strip()
                plan_file = action_plan_file(payload)
                if not target_operation_id or not plan_file:
                    return self.send_json({"ok": False, "error": "targetOperationId and planFile are required; broad runtime cleanup is disabled"}, status=400)
                try:
                    scoped_payload = dict(payload)
                    scoped_payload["targetOperationId"] = target_operation_id
                    scoped_payload["planFile"] = plan_file
                    return self.send_json(stop_scheduler_operation(root, scoped_payload))
                except Exception as exc:
                    return self.send_json({"error": str(exc)}, status=500)
            if route.startswith("/api/files/"):
                if route == "/api/files/upload-cancel":
                    remote_path = str(payload.get("remotePath") or payload.get("path") or "")
                    client_transfer_id = str(payload.get("clientTransferId") or "").strip()[:160]
                    transfer_id = str(payload.get("transferId") or "").strip()[:160]
                    try:
                        if not transfer_id and remote_path:
                            target = safe_project_path(root, remote_path)
                            remote_path = os.path.relpath(target, os.path.abspath(root)).replace(os.sep, "/")
                            transfer_id = "upload-" + hashlib.sha256(("upload:" + remote_path).encode("utf-8")).hexdigest()[:32]
                        if not transfer_id:
                            return self.send_json({"transferId": "", "status": "unknown", "settled": False}, status=400)
                        item = upload_item_from_status(root, transfer_id)
                        public = read_transfer_status(root, transfer_id)
                        expected_owner = str(public.get("clientTransferId") or "")
                        if expected_owner and client_transfer_id != expected_owner:
                            return self.send_json({"error": "upload slot ownership changed", "transferId": transfer_id,
                                "status": public.get("status") or "unknown", "settled": False}, status=409)
                        status = str(public.get("status") or "unknown").lower()
                        if status in ("completed", "failed", "cancelled"):
                            with UPLOADS_LOCK:
                                current = UPLOADS.get(transfer_id)
                                result = public_transfer_record(current) if isinstance(current, dict) else public
                                owner = str((current or {}).get("clientTransferId") or client_transfer_id)
                                active_requests = int((current or {}).get("_activeRequests") or 0)
                                active_inits = int(UPLOAD_INIT_REQUESTS.get(upload_init_key(transfer_id, owner)) or 0)
                                result["settled"] = active_requests <= 0 and active_inits <= 0
                            return self.send_json(result)
                        if not item:
                            registered, active_inits, cancel_error = request_upload_init_cancellation(transfer_id, client_transfer_id)
                            if not registered:
                                return self.send_json({"error": cancel_error, "schemaVersion": SCHEMA_VERSION,
                                    "transferId": transfer_id, "status": "unknown", "settled": False}, status=429)
                            status = "cancelling" if active_inits else "cancelled"
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id,
                                "status": status, "settled": active_inits == 0})
                        with UPLOADS_LOCK:
                            current = UPLOADS.get(transfer_id)
                            if not isinstance(current, dict):
                                return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id,
                                    "status": "unknown", "settled": False})
                            expected_owner = str(current.get("clientTransferId") or "")
                            if expected_owner and client_transfer_id != expected_owner:
                                return self.send_json({"error": "upload slot ownership changed", "transferId": transfer_id,
                                    "status": str(current.get("status") or "unknown"), "settled": False}, status=409)
                            current_status = str(current.get("status") or "unknown").lower()
                            if current_status in ("completed", "failed", "cancelled"):
                                result = public_transfer_record(current)
                                active_requests = int(current.get("_activeRequests") or 0)
                                active_inits = int(UPLOAD_INIT_REQUESTS.get(upload_init_key(transfer_id, current.get("clientTransferId"))) or 0)
                                result["settled"] = active_requests <= 0 and active_inits <= 0
                                return self.send_json(result)
                            current["_cancelRequested"] = True
                            current["status"] = "cancelling"
                            current["error"] = "upload cancellation requested"
                            active_requests = int(current.get("_activeRequests") or 0)
                            active_inits = int(UPLOAD_INIT_REQUESTS.get(upload_init_key(transfer_id, current.get("clientTransferId"))) or 0)
                            if active_requests <= 0 and active_inits <= 0:
                                current["status"] = "cancelled"
                                current["error"] = "upload cancelled by client"
                                current["finishedAt"] = now_iso()
                            write_transfer_status(root, current)
                            result = public_transfer_record(current)
                            result["settled"] = str(current.get("status") or "").lower() in ("completed", "failed", "cancelled") and active_requests <= 0 and active_inits <= 0
                        return self.send_json(result)
                    except Exception as exc:
                        return self.send_json({"error": str(exc), "transferId": transfer_id, "status": "unknown", "settled": False}, status=500)
                if route == "/api/files/upload-init":
                    remote_path = str(payload.get("remotePath") or payload.get("path") or "")
                    init_registered = False
                    try:
                        target = safe_project_path(root, remote_path)
                        remote_path = os.path.relpath(target, os.path.abspath(root)).replace(os.sep, "/")
                        if remote_path == ".." or remote_path.startswith("../"):
                            raise ValueError("upload path outside project")
                        overwrite = normalize_overwrite_policy(payload.get("overwrite"))
                        incoming_size = int(payload.get("size") or 0)
                        incoming_sha = str(payload.get("sha256") or "")
                        client_transfer_id = str(payload.get("clientTransferId") or "").strip()[:160]
                        # New clients reuse one bounded resumable slot per destination while keeping
                        # their operation identity separate. Legacy callers retain unique IDs.
                        transfer_id = ("upload-" + hashlib.sha256(("upload:" + remote_path).encode("utf-8")).hexdigest()[:32]) if client_transfer_id else ("upload-" + uuid.uuid4().hex)
                        init_state = begin_upload_init_request(transfer_id, client_transfer_id)
                        init_registered = init_state == "started"
                        if not init_registered:
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id,
                                "accepted": False, "status": "cancelled" if init_state == "cancelled" else "running",
                                "settled": init_state == "cancelled", "message": "upload initialization cancelled" if init_state == "cancelled" else "upload initialization is still active"}, status=409)
                        existing_transfer = read_transfer_status(root, transfer_id)
                        if (client_transfer_id
                                and str(existing_transfer.get("clientTransferId") or "") == client_transfer_id
                                and str(existing_transfer.get("status") or "").lower() == "completed"
                                and str(existing_transfer.get("remotePath") or "") == remote_path
                                and str(existing_transfer.get("sha256") or "").lower() == incoming_sha.lower()
                                and int(existing_transfer.get("totalBytes") or 0) == incoming_size):
                            completed_target = upload_target_snapshot(target)
                            if (bool(completed_target.get("exists"))
                                    and int(completed_target.get("size") or 0) == incoming_size
                                    and str(completed_target.get("sha256") or "").lower() == incoming_sha.lower()):
                                return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "accepted": True, "completed": True, "status": "completed", "size": incoming_size, "sha256": incoming_sha})
                        validate_upload_overwrite(target, overwrite, incoming_size, incoming_sha)
                        original_target = upload_target_snapshot(target)
                        tmp = state_child_path(root, "uploads", f"{transfer_id}-{remote_path}")
                        tmp_parent = os.path.dirname(tmp)
                        if os.path.realpath(tmp_parent) != os.path.abspath(tmp_parent):
                            raise ValueError("upload staging parent crosses a symbolic link")
                        conflict = None
                        conflict_status = 409
                        resume_from = 0
                        with UPLOADS_LOCK:
                            current_item = UPLOADS.get(transfer_id)
                            if upload_init_cancelled_locked(transfer_id, client_transfer_id):
                                conflict = {"error": "upload initialization was cancelled", "transferId": transfer_id, "status": "cancelled"}
                            if not conflict and active_upload_count_unlocked(transfer_id) >= MAX_ACTIVE_UPLOADS:
                                conflict_status = 429
                                conflict = {"error": "too many active uploads", "maxActiveUploads": MAX_ACTIVE_UPLOADS}
                            if not conflict:
                                existing_transfer = public_transfer_record(current_item) if isinstance(current_item, dict) else existing_transfer
                                existing_owner = str(existing_transfer.get("clientTransferId") or "")
                                existing_status = str(existing_transfer.get("status") or "").lower()
                                existing_running = existing_status == "running"
                                existing_active_requests = int(current_item.get("_activeRequests") or 0) if isinstance(current_item, dict) else 0
                                same_payload = (
                                    str(existing_transfer.get("remotePath") or "") == remote_path
                                    and str(existing_transfer.get("sha256") or "").lower() == incoming_sha.lower()
                                    and int(existing_transfer.get("totalBytes") or 0) == incoming_size
                                    and existing_running
                                )
                                owner_matches = bool(client_transfer_id and existing_owner == client_transfer_id)
                                stale_recovery = bool(existing_transfer.get("stalled"))
                                if existing_status == "cancelling":
                                    conflict = {"error": "upload cancellation has not settled", "transferId": transfer_id, "status": "cancelling"}
                                elif existing_running and existing_active_requests > 0:
                                    conflict = {"error": "upload already has an active chunk or commit request", "transferId": transfer_id, "status": "running"}
                                elif existing_status == "cancelled" and client_transfer_id and existing_owner == client_transfer_id:
                                    conflict = {"error": "cancelled upload identity cannot be reused", "transferId": transfer_id, "status": "cancelled"}
                                elif client_transfer_id and existing_running and existing_owner and not owner_matches and not stale_recovery:
                                    conflict = {"error": "another upload operation owns this destination slot", "transferId": transfer_id, "status": "running"}
                                else:
                                    resume_allowed = same_payload and (not client_transfer_id or owner_matches or stale_recovery)
                                    try:
                                        tmp_stat = os.lstat(tmp)
                                        if os.path.islink(tmp) or not os.path.isfile(tmp):
                                            raise ValueError("upload staging target must be a regular file")
                                        resume_from = int(tmp_stat.st_size) if resume_allowed and int(tmp_stat.st_size) <= incoming_size else 0
                                    except FileNotFoundError:
                                        resume_from = 0
                                    if resume_from == 0:
                                        flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
                                        descriptor = os.open(tmp, flags, 0o600)
                                        os.close(descriptor)
                                    item = {"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "clientTransferId": client_transfer_id, "status": "running", "direction": "upload", "remotePath": remote_path, "transferredBytes": resume_from, "totalBytes": incoming_size, "tmp": tmp, "sha256": incoming_sha, "overwrite": overwrite, "targetSnapshot": original_target, "startedAt": now_iso()}
                                    UPLOADS[transfer_id] = item
                                    write_transfer_status(root, item)
                        if conflict:
                            return self.send_json(conflict, status=conflict_status)
                        prune_runtime_memory_state()
                        return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "chunkSize": 1024 * 1024, "accepted": True, "resumeFromByte": resume_from})
                    except Exception as exc:
                        return self.send_json({"error": str(exc)}, status=400)
                    finally:
                        if init_registered:
                            finish_upload_init_request(root, transfer_id, client_transfer_id)
                if route == "/api/files/upload-chunk":
                    params = parse_qs(urlparse(self.path).query)
                    transfer_id = str((params.get("transferId") or [payload.get("transferId") or ""])[0]).strip()
                    requested_owner = str((params.get("clientTransferId") or [payload.get("clientTransferId") or ""])[0]).strip()
                    item, error = begin_upload_request(root, transfer_id, requested_owner)
                    if error:
                        return self.send_json(error, status=404 if error.get("status") == "unknown" else 409)
                    try:
                        offset = int((params.get("offset") or [payload.get("offset") or item.get("transferredBytes") or 0])[0] or 0)
                        if "application/json" in (self.headers.get("Content-Type") or ""):
                            data = base64.b64decode(str(payload.get("data") or ""))
                        else:
                            data = raw_body
                        total_bytes = int(item.get("totalBytes") or 0)
                        if offset < 0 or total_bytes > 0 and offset + len(data) > total_bytes:
                            return self.send_json({"error": "upload chunk is outside declared transfer bounds", "transferId": transfer_id}, status=400)
                        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
                        descriptor = os.open(item["tmp"], flags)
                        try:
                            opened = os.fstat(descriptor)
                            current = os.lstat(item["tmp"])
                            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink > 1
                                    or stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode)
                                    or current.st_nlink > 1 or opened.st_dev != current.st_dev or opened.st_ino != current.st_ino):
                                raise ValueError("upload staging target identity changed")
                            with os.fdopen(descriptor, "r+b") as f:
                                descriptor = None
                                f.seek(offset)
                                f.write(data)
                                f.flush()
                                os.fsync(f.fileno())
                        finally:
                            if descriptor is not None:
                                os.close(descriptor)
                        with UPLOADS_LOCK:
                            item["transferredBytes"] = max(int(item.get("transferredBytes") or 0), offset + len(data))
                            if str(item.get("status") or "").lower() == "running":
                                write_transfer_status(root, item)
                        return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id,
                            "receivedBytes": len(data), "nextOffset": item["transferredBytes"]})
                    finally:
                        finish_upload_request(root, item)
                if route == "/api/files/upload-complete":
                    transfer_id = str(payload.get("transferId") or "").strip()
                    if not transfer_id:
                        return self.send_json({"error": "transferId required"}, status=400)
                    requested_owner = str(payload.get("clientTransferId") or "").strip()
                    item, error = begin_upload_request(root, transfer_id, requested_owner)
                    if error:
                        return self.send_json(error, status=404 if error.get("status") == "unknown" else 409)
                    try:
                        target = safe_project_path(root, str(item.get("remotePath") or payload.get("remotePath") or payload.get("path") or ""))
                        expected = str(payload.get("sha256") or item.get("sha256") or "")
                        actual = sha256_file(item["tmp"])
                        tmp_size = os.path.getsize(item["tmp"])
                        total_bytes = int(item.get("totalBytes") or 0)
                        transferred = int(item.get("transferredBytes") or 0)
                        if total_bytes > 0 and (tmp_size != total_bytes or transferred < total_bytes):
                            item["status"] = "failed"
                            item["error"] = "upload size mismatch"
                            item["finishedAt"] = now_iso()
                            write_transfer_status(root, item)
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "status": "failed", "remotePath": item.get("remotePath"), "size": tmp_size, "expectedSize": total_bytes, "receivedBytes": transferred, "sha256": actual, "message": "upload size mismatch"}, status=409)
                        if expected and actual.lower() != expected.lower():
                            item["status"] = "failed"
                            item["error"] = "sha256 mismatch"
                            item["finishedAt"] = now_iso()
                            write_transfer_status(root, item)
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "status": "failed", "remotePath": item.get("remotePath"), "size": tmp_size, "sha256": actual, "message": "sha256 mismatch"}, status=409)
                        try:
                            validate_upload_overwrite(target, normalize_overwrite_policy(item.get("overwrite")), tmp_size, actual, item.get("targetSnapshot"))
                        except Exception as exc:
                            item["status"] = "failed"
                            item["error"] = str(exc)
                            item["finishedAt"] = now_iso()
                            write_transfer_status(root, item)
                            return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "status": "failed", "remotePath": item.get("remotePath"), "size": tmp_size, "sha256": actual, "message": str(exc)}, status=409)
                        os.makedirs(os.path.dirname(target), exist_ok=True)
                        with UPLOADS_LOCK:
                            if item.get("_cancelRequested") or str(item.get("status") or "").lower() != "running":
                                return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id,
                                    "status": str(item.get("status") or "cancelling"), "settled": False}, status=409)
                            move_file_replace(item["tmp"], target)
                            item["status"] = "completed"
                            item["sha256"] = actual
                            item["size"] = os.path.getsize(target)
                            item["finishedAt"] = now_iso()
                            write_transfer_status(root, item)
                        prune_runtime_memory_state()
                        return self.send_json({"schemaVersion": SCHEMA_VERSION, "transferId": transfer_id, "status": "completed", "remotePath": item.get("remotePath"), "size": os.path.getsize(target), "sha256": actual})
                    finally:
                        finish_upload_request(root, item)
            if route == "/api/actions/register-code-sync-proof":
                try:
                    worker_id = str(getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip()
                    result = register_code_sync_proof(root, payload, worker_id)
                    return self.send_json(result)
                except Exception as exc:
                    return self.send_json({"ok": False, "error": str(exc)}, status=409)
            if route == "/api/worker/availability/batch":
                return self.send_json(write_availability_batch(root, payload))
            if route == "/api/workers/uplink/events":
                return self.send_json(write_worker_uplink_batch(root, payload))
            op_id = require_op_id(self, payload)
            if not op_id:
                return
            action = route.rsplit("/", 1)[-1]
            operation_id = str(payload.get("operationId") or f"{action}-{op_id}")
            if mode == "worker_telemetry" and action in ("validate-plan", "dry-run-plan", "run-plan", "reproduce-plan"):
                options = payload.get("options") or {}
                topology_mode = str(options.get("topologyMode") or payload.get("topologyMode") or "")
                owner = str(options.get("schedulerOwnerWorkerId") or payload.get("schedulerOwnerWorkerId") or "").strip()
                dispatch_policy = str(options.get("workerPoolDispatchPolicy") or payload.get("workerPoolDispatchPolicy") or "").strip()
                current_worker = str(getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip()
                workers = options.get("workers") if isinstance(options.get("workers"), list) else []
                worker_ids = [str((worker or {}).get("id") or (worker or {}).get("worker_id") or "").strip() for worker in workers if isinstance(worker, dict)]
                if (topology_mode != "single_worker" and topology_mode != "worker_pool") or options.get("localWorkerScheduler") is not True or not owner or owner != current_worker or worker_ids != [owner]:
                    return self.send_json({"error": "local worker scheduler identity mismatch"}, status=403)
                if topology_mode == "worker_pool" and dispatch_policy != "manual_plan_target" and action in ("dry-run-plan", "run-plan", "reproduce-plan"):
                    assigned = normalized_experiment_indices(payload.get("assignedExperimentIndices") or options.get("assignedExperimentIndices") or [])
                    worker_set_revision = str(payload.get("workerSetRevision") or options.get("workerSetRevision") or "").strip()
                    if not assigned or not worker_set_revision:
                        return self.send_json({"error": "worker pool shard identity or assigned indices missing"}, status=403)
            if mode == "worker_telemetry" and action in WORKER_RESULT_ACTIONS:
                options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
                topology_mode = str(options.get("topologyMode") or payload.get("topologyMode") or "")
                owner = str(options.get("resultOwnerWorkerId") or payload.get("resultOwnerWorkerId") or options.get("schedulerOwnerWorkerId") or payload.get("schedulerOwnerWorkerId") or "").strip()
                current_worker = str(getattr(args, "worker_id", "") or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip()
                if topology_mode not in ("single_worker", "worker_pool") or not owner or owner != current_worker or options.get("automaticBackup") is not False:
                    return self.send_json({"error": "worker result ownership mismatch"}, status=403)
            if action == "validate-plan" and not action_debug_mode(payload):
                # A warm, verified template only needs fresh artifact stats, so no background action/poll wait.
                try:
                    plan = action_plan_file(payload)
                    scheduler = cluster_scheduler_path(root)
                    options = action_options(payload)
                    result_dir = str(options.get("defaultResultCsvDir") or options.get("default_result_csv_dir") or "experiments/results")
                    validation = cached_scheduler_validation(root, scheduler, plan, result_dir, options) if plan and scheduler else None
                    if validation is not None:
                        return self.send_json(terminal_action(root, action, operation_id, op_id, "completed",
                            f"配置检查已复用，已有产物已刷新：{validation.get('existingCount', 0)}/{len(validation.get('jobs') or [])}",
                            {"validation": validation, "jobCount": len(validation.get("jobs") or []),
                             "executionMode": validation.get("execution_mode") or "train_test"}, request=payload))
                except Exception as exc:
                    return self.send_json(terminal_action(root, action, operation_id, op_id, "failed", str(exc), request=payload))
            if action in ("validate-plan", "dry-run-plan", "rebuild-distributed-results") or (action == "preview-cache-cleanup" and "planOutputPaths" in payload):
                worker = (selected_worker_id(payload) or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker") if mode == "worker_telemetry" and action in ("validate-plan", "dry-run-plan") else ""
                return self.send_json(start_inactivity_action(root, action, payload, operation_id, op_id, worker), status=202)
            if action not in ("preview-cache-cleanup", "delete-cache-candidates"):
                append_event(root, {"type": "operation_started", "operationId": operation_id, "payload": {"action": action, "opId": op_id, **action_operation_fields(payload)}})
            release_worker_action = None
            try:
                if mode == "worker_telemetry" and action in ("retry-worker-task", "stop-worker-task", "delete-worker-artifacts", "archive-worker-artifacts", "validate-plan", "dry-run-plan", "run-plan", "reproduce-plan"):
                    release_worker_action = acquire_worker_action_slot(root, selected_worker_id(payload) or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker", payload)
                return self.send_json(handle_action(root, action, payload, operation_id, op_id))
            except Exception as exc:
                message = f"action failed: {exc}"
                return self.send_json(terminal_action(root, action, operation_id, op_id, "failed", message, request=payload), status=500)
            finally:
                if release_worker_action:
                    release_worker_action()

    server = BoundedThreadingHTTPServer((bind_host, int(args.port)), Handler)
    print(json.dumps({"agentVersion": AGENT_VERSION, "host": args.host, "port": args.port, "startedAt": now_iso()}, ensure_ascii=False), flush=True)
    server.serve_forever()

def add_state_args(parser):
    parser.add_argument("--state-dir", default="")
    parser.add_argument("--journal-max-events", type=int, default=5000)
    parser.add_argument("--journal-max-mb", type=float, default=32.0)
    parser.add_argument("--state-retention-hours", type=float, default=24.0)
    parser.add_argument("--tmp-retention-hours", type=float, default=24.0)
    parser.add_argument("--max-state-mb", type=float, default=128.0)

def main():
    global AGENT_STATE_DIR, MAX_EVENTS, MAX_JOURNAL_BYTES, STATE_RETENTION_SECONDS, TMP_RETENTION_SECONDS, MAX_AGENT_STATE_BYTES
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("run", "snapshot", "health", "inspect", "stop"):
        p = sub.add_parser(name)
        p.add_argument("--project-dir", required=True)
        p.add_argument("--hub-id", default="hub")
        p.add_argument("--workers-json", default="[]")
        p.add_argument("--poll-seconds", type=int, default=60)
        p.add_argument("--ttl-seconds", type=int, default=180)
        p.add_argument("--jitter-seconds", type=float, default=30.0)
        add_state_args(p)
    p = sub.add_parser("stream")
    p.add_argument("--project-dir", required=True)
    p.add_argument("--since", type=int, default=0)
    add_state_args(p)
    p = sub.add_parser("serve")
    p.add_argument("--project-dir", default=os.getcwd())
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=18765)
    p.add_argument("--token", default="")
    p.add_argument("--mode", default="realtime")
    p.add_argument("--gpu-poll-seconds", type=float, default=60.0)
    p.add_argument("--worker-id", default="")
    p.add_argument("--hub-uplink-url", default="")
    p.add_argument("--worker-availability-push-seconds", type=float, default=60.0)
    p.add_argument("--jitter-seconds", type=float, default=30.0)
    p.add_argument("--operation-event-max-delay-ms", type=float, default=1000.0)
    add_state_args(p)
    args = parser.parse_args()
    AGENT_STATE_DIR = os.path.abspath(args.state_dir) if getattr(args, "state_dir", "") else ""
    MAX_EVENTS = max(100, int(getattr(args, "journal_max_events", MAX_EVENTS) or MAX_EVENTS))
    MAX_JOURNAL_BYTES = max(1024 * 1024, int(float(getattr(args, "journal_max_mb", 32.0) or 32.0) * 1024 * 1024))
    STATE_RETENTION_SECONDS = max(3600, int(float(getattr(args, "state_retention_hours", 24.0) or 24.0) * 3600))
    TMP_RETENTION_SECONDS = max(3600, int(float(getattr(args, "tmp_retention_hours", 24.0) or 24.0) * 3600))
    MAX_AGENT_STATE_BYTES = max(16 * 1024 * 1024, int(float(getattr(args, "max_state_mb", 128.0) or 128.0) * 1024 * 1024))
    if args.cmd == "run":
        return run_agent(args)
    if args.cmd == "stream":
        return stream_events(args)
    if args.cmd == "serve":
        return serve_http(args)
    if args.cmd == "stop":
        try:
            request_agent_stop(args.project_dir)
            return 0
        except Exception as exc:
            print(f"[error] {exc}", file=sys.stderr, flush=True)
            return 1
    if args.cmd == "snapshot":
        print(json.dumps(read_json(path_for(args.project_dir, "cluster_snapshot.json"), {}), ensure_ascii=False))
        return 0
    if args.cmd == "health" or args.cmd == "inspect":
        print(json.dumps(inspect_agent(args.project_dir), ensure_ascii=False))
        return 0

if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception:
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)
`;
