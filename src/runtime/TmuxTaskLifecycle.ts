import { GPU_MEMORY_BUDGET_PYTHON } from "./GpuMemoryBudget";
/** Embedded in the existing Agent runtime: no extra deployed module or state database. */
export const TMUX_TASK_LIFECYCLE_PYTHON = GPU_MEMORY_BUDGET_PYTHON + String.raw`
TASK_LIFECYCLE_PROTOCOL = 2
NATIVE_TASK_RUNNER_CONTEXT = None
TASK_SCHEDULER_UPDATE_ERROR = ""

def task_tmux(args, timeout=5):
    proc = subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=timeout)
    if proc.returncode:
        low = (proc.stderr or "").lower()
        absent = "no server running" in low or "no sessions" in low or "error connecting" in low and any(text in low for text in ("no such file or directory", "connection refused"))
        if args[0] in ("list-panes", "list-windows") and absent:
            return ""
        raise RuntimeError("TMUX_QUERY_FAILED: " + (proc.stderr or "")[-1000:])
    return proc.stdout.rstrip("\r\n")

def task_option(target, key, value=None):
    if value is None:
        return task_tmux(["display-message", "-p", "-t", target, "#{@se_" + key + "}"])
    command = ["set-option", "-w", "-t", target, "@se_" + key, str(value)]
    task_tmux(command)

def task_write_job(target, job):
    encoded = base64.urlsafe_b64encode(json.dumps(job, ensure_ascii=False).encode("utf-8")).decode("ascii")
    if len(encoded) <= 2048:
        return task_option(target, "job", encoded)
    parts = [encoded[index:index + 2048] for index in range(0, len(encoded), 2048)]
    if len(parts) > 1024:
        raise ValueError("TASK_WINDOW_PAYLOAD_LIMIT")
    digest = hashlib.sha256(encoded.encode("ascii")).hexdigest()
    prefix = "job_" + digest[:16] + "_"
    for index, value in enumerate(parts):
        task_option(target, prefix + str(index), value)
    header = {key: value for key, value in job.items() if key not in ("codeManifest", "executionSource", "options", "distributedResults", "checkpointSource", "gpuMemoryReservation")}
    header["_se_payload"] = {"version": 1, "parts": len(parts), "bytes": len(encoded), "sha256": digest}
    wrapper = base64.urlsafe_b64encode(json.dumps(header, ensure_ascii=False).encode("utf-8")).decode("ascii")
    if len(wrapper) > 3072:
        raise ValueError("TASK_WINDOW_IDENTITY_LIMIT")
    # Publish only after every bounded native option exists. Older tmux needs
    # neither source-file stdin nor a filesystem spool.
    task_option(target, "job", wrapper)

def task_read_job(target, encoded=None):
    header = json.loads(base64.urlsafe_b64decode(encoded or task_option(target, "job")).decode("utf-8"))
    binding = header.get("_se_payload")
    if binding is None:
        return header
    if not isinstance(binding, dict) or binding.get("version") != 1 or type(binding.get("parts")) is not int or not 1 <= binding["parts"] <= 1024 or not re.fullmatch(r"[a-f0-9]{64}", str(binding.get("sha256") or "")):
        raise RuntimeError("TASK_WINDOW_PAYLOAD_INVALID")
    prefix = "job_" + binding["sha256"][:16] + "_"
    pieces = []
    for start in range(0, binding["parts"], 32):
        fmt = "".join("#{@se_" + prefix + str(index) + "}" for index in range(start, min(start + 32, binding["parts"])))
        pieces.append(task_tmux(["display-message", "-p", "-t", target, fmt]))
    payload = "".join(pieces)
    if len(payload) != binding.get("bytes") or len(payload) > 2097152 or hashlib.sha256(payload.encode("ascii")).hexdigest() != binding["sha256"]:
        raise RuntimeError("TASK_WINDOW_PAYLOAD_INCOMPLETE")
    job = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    if any(job.get(key) != value for key, value in header.items() if key != "_se_payload"):
        raise RuntimeError("TASK_WINDOW_PAYLOAD_IDENTITY_MISMATCH")
    return job

def task_safe_path(root, relative):
    value = str(relative or "").replace("\\", "/")
    if not value or value.startswith("/") or any(x in value for x in (":", "*", "?", "\0")) or any(x in ("", ".", "..", ".git", "clean_dir") for x in value.split("/")):
        raise ValueError("UNSAFE_TASK_PATH")
    root = os.path.realpath(root)
    full = os.path.join(root, *value.split("/"))
    parent = root
    for leaf in value.split("/"):
        parent = os.path.join(parent, leaf)
        if os.path.islink(parent):
            raise ValueError("TASK_PATH_LINK")
    if os.path.commonpath([root, os.path.realpath(full)]) != root or os.path.realpath(full) == root:
        raise ValueError("UNSAFE_TASK_PATH")
    return full

def task_inventory(root, execution_only=False):
    fmt = "#{pane_id}\t#{window_id}\t#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{@se_job}\t#{@se_phase}\t#{@se_gpu}\t#{@se_log}\t#{@se_gpu_budget}"
    rows = []
    for line in task_tmux(["list-panes", "-a", "-F", fmt]).splitlines():
        fields = line.split("\t")
        if len(fields) not in (9, 10) or not fields[5]:
            continue
        try:
            # The published header already carries the execution identity. A
            # window-only query must not read its full source/config payload.
            job = json.loads(base64.urlsafe_b64decode(fields[5]).decode("utf-8")) if execution_only else task_read_job(fields[0], fields[5])
        except (ValueError, UnicodeError):
            continue
        if job.get("root") != os.path.realpath(root) or job.get("lifecycleProtocol") != 2:
            continue
        if job.get("pane") and job["pane"] != fields[0]:
            continue
        row = {**job, "tmuxPane": fields[0], "tmuxWindowId": fields[1], "tmuxSession": fields[2],
               "dead": fields[3] == "1", "phase": fields[6], "gpuId": fields[7] or job.get("gpuId", ""), "logPath": fields[8]}
        row["exitCode"] = int(fields[4]) if re.fullmatch(r"-?\d+", fields[4]) else None
        try:
            row["_gpuBudget"] = json.loads(fields[9] or "{}") if len(fields) == 10 else {}
        except (ValueError, TypeError):
            row["_gpuBudget"] = {}
        rows.append(row)
    return rows

def task_execution_inventory(root, queries=()):
    """Current tmux bindings only; makes no assertion about results or clean logs."""
    if not isinstance(queries, (list, tuple)) or len(queries) > 500:
        raise ValueError("TASK_QUERY_LIMIT")
    for query in queries:
        if not isinstance(query, dict) or not all(isinstance(query.get(key), str) and query[key].strip() for key in ("commandId", "projectId", "workerId", "outputDir")):
            raise ValueError("TASK_QUERY_IDENTITY_REQUIRED")
        task_safe_path(root, query["outputDir"])
    rows = task_inventory(root, execution_only=True)
    if queries:
        legacy = local_stop_tmux_inventory(root) if "local_stop_tmux_inventory" in globals() else []
        for query in queries:
            if any(row["commandId"] == query["commandId"] and (row["projectId"] != query["projectId"] or row["workerId"] != query["workerId"]) for row in rows):
                raise ValueError("TASK_OWNER_MISMATCH")
            if any(tab["command"] == query["commandId"] and tab["project"] != query["projectId"] for tab in legacy):
                raise ValueError("TASK_OWNER_MISMATCH")
            for tab in legacy:
                if tab["command"] == query["commandId"] and tab["project"] == query["projectId"] and not any(row["tmuxPane"] == tab["pane"] for row in rows):
                    rows.append({**query, "tmuxPane": tab["pane"], "tmuxWindowId": tab["window"], "tmuxSession": tab["session"],
                        "dead": tab["dead"] == "1", "exitCode": int(tab["exitCode"]) if re.fullmatch(r"-?\d+", tab["exitCode"]) else None,
                        "phase": "running", "gpuId": query.get("gpuId", "")})
        wanted = {(query["projectId"], query["commandId"]) for query in queries}
        rows = [row for row in rows if (row["projectId"], row["commandId"]) in wanted]
        rows += [query for query in queries if not any(row["projectId"] == query["projectId"] and row["commandId"] == query["commandId"] for row in rows)]
    tasks = []
    cancelled_by_worker = {}
    for row in rows:
        public = {key: row[key] for key in ("commandId", "projectId", "workerId", "workflowId", "globalJobId", "planFile", "planRevision", "codeFingerprint",
                  "experimentIndex", "outputDir", "collectionResultCsv", "resultPathPolicy", "planJobCount", "fullPlanJobCount", "enqueuedAt",
                  "executionMode", "mode", "checkpointTestOnly", "runKey", "case", "seed", "configPath", "tmuxPane", "tmuxWindowId", "tmuxSession", "gpuId") if key in row}
        observed = {
            "lifecycleProtocol": 2, "commandId": row["commandId"], "projectId": row["projectId"], "workerId": row["workerId"],
            "observedAt": now_iso()}
        if row.get("tmuxPane"):
            observed["tmux"] = {"windowId": row["tmuxWindowId"], "paneId": row["tmuxPane"],
                                "dead": row["dead"], "exitCode": row["exitCode"], "phase": row["phase"]}
        if queries:
            worker = row["workerId"]
            if worker not in cancelled_by_worker:
                cancelled = json.loads(task_option(task_queue_session(root, worker) + ":queue", "cancelled") or "[]")
                if not isinstance(cancelled, list) or any(not isinstance(value, str) for value in cancelled):
                    raise ValueError("TASK_CANCEL_FENCE_INVALID")
                cancelled_by_worker[worker] = set(cancelled)
            observed["cancelled"] = row["commandId"] in cancelled_by_worker[worker]
        execution = "missing" if not row.get("tmuxPane") else (
            "failed" if row["dead"] and row["exitCode"] is not None and row["exitCode"] != 0 else "exited" if row["dead"] else
            "queued" if row["phase"] in ("queued", "bound") else "starting" if row["phase"] in ("admitted", "starting") else
            "running" if row["phase"] == "running" else "unknown")
        tasks.append({**public, "gpuMemoryProfile": task_budget_public(row) if row.get("_gpuBudget") else None,
                      "lifecycleProtocol": 2, "observation": observed, "executionState": execution,
                      "status": "queued" if execution in ("queued", "starting") else execution if execution in ("running", "failed") else "unknown"})
    # The fast inventory may only CARRY an already-collected sample: it tries the
    # shared cache without ever waiting on a sampler that holds the lock during
    # nvidia-smi. Missing or lock-busy stays honestly absent (never a partial
    # frame, never synchronous sampling, never a re-timestamp) and the state is
    # reported as-is so the Host cannot mistake absence for a fresh frame.
    gpu_sample = None
    gpu_sample_state = "missing"
    # A fresh shared collector frame is a plain validated file read: it carries
    # without touching the sampler lock or nvidia-smi, so inventory stays fast
    # even between Agent sampler ticks and across an Agent restart.
    collector_registered = False
    if "read_gpu_collector_frame" in globals():
        try:
            shared_worker = str(os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
            shared = read_gpu_collector_frame(shared_worker, root)
            shared_mode = str(shared.get("mode") or "absent")
            # The SHARED reader already fused registration + frame capability:
            # "absent" is only returned when BOTH files are ENOENT-proven.
            collector_registered = True
            shared_frame = shared.get("frame")
            if shared_mode == "fresh" and shared_frame:
                gpu_sample = {"schemaVersion": 1, "generatedAt": str(shared_frame.get("collectedAt") or now_iso()),
                              "source": "worker_telemetry", "frameSource": GPU_COLLECTOR_SOURCE, "collectorMode": "fresh",
                              "collectorAgeMs": round(float(shared.get("ageMs") or 0.0), 1),
                              "gpu": shared_frame["gpus"], "gpus": shared_frame["gpus"],
                              "status": str(shared_frame.get("status") or "ok"), "error": str(shared_frame.get("error") or ""),
                              "completeness": str(shared_frame.get("completeness") or "full"),
                              "seq": int(shared_frame["seq"]), "epoch": str(shared_frame["epoch"])}
                gpu_sample_state = "ready"
            elif collector_registered:
                # A registered collector in a failed state is reported honestly
                # (stale/partial/foreign/unreadable/stalled): the inventory must
                # not dress an old sampler cache as "ready" while the shared
                # source is broken.
                gpu_sample = None
                gpu_sample_state = shared_mode if shared_mode != "absent" else "stalled"
        except Exception:
            # Unknown is not absent and certainly not ready.
            collector_registered = True
            gpu_sample = None
            gpu_sample_state = "unreadable"
    if gpu_sample is None and not collector_registered \
            and "WORKER_GPU_SAMPLE_CACHE" in globals() and "WORKER_GPU_SAMPLE_LOCK" in globals():
        if WORKER_GPU_SAMPLE_LOCK.acquire(False):
            try:
                cached_gpu = WORKER_GPU_SAMPLE_CACHE.get("sample")
                if cached_gpu:
                    gpu_sample = copy.deepcopy(cached_gpu[1])
                    gpu_sample_state = "ready"
            finally:
                WORKER_GPU_SAMPLE_LOCK.release()
        else:
            gpu_sample_state = "sampling"
    return {"schemaVersion": 1, "queryComplete": True, "executionOnly": True, "generatedAt": now_iso(), "gpuSample": gpu_sample, "gpuSampleState": gpu_sample_state,
            # Agent protocol support is static; do not query Scheduler windows
            # for every progress refresh. Admission still checks live capacity.
            "capabilities": {"schemaVersion": 1, "durablePlanQueue": True, "declaredJobPaths": True,
                "idleGpuAdmission": True, "queuedJobRecall": True, "taskLifecycle": 2, "manualDispatch": 1,
                "runtimeDiagnostics": 1, "gpuQuotaScheduling": 1, "gpuCardQuotaScheduling": 1,
                "gpuCardLimitScheduling": 1, "gpuMemoryBudgetScheduling": 1, "declaredResultQuery": 1, "resultCollection": 1,
                # This runtime carries the shared independent-collector frames; the
                # carried sample's frameSource says honestly whether the current
                # frame is collector-shared or a marked direct sample.
                "gpuCollector": 1}, "tasks": tasks}

def task_manifest_observation(root, job):
    import stat as statmod
    output = str(job.get("outputDir") or "")
    manifest = task_safe_path(root, output + "/artifact_manifest.json")
    try:
        manifest_stat = os.stat(manifest)
    except FileNotFoundError:
        return None
    if not statmod.S_ISREG(manifest_stat.st_mode):
        raise ValueError("TASK_MANIFEST_NOT_REGULAR")
    if os.path.getsize(manifest) > 1024 * 1024:
        raise ValueError("TASK_MANIFEST_TOO_LARGE")
    with open(manifest, encoding="utf-8") as handle:
        document = json.load(handle)
    report = document.get("simpleExperiment") or {}
    if not report:
        return None  # Historical project evidence remains available to manual result inspection.
    weights = report.get("weights") or []
    if not isinstance(weights, list) or any(not isinstance(file, str) or not file.startswith(output + "/") for file in weights):
        raise ValueError("TASK_MANIFEST_WEIGHT_PATH_INVALID")
    files = list(weights)
    mode = report.get("mode")
    result_csv = report.get("resultCsv")
    if mode in ("test", "train_test") and result_csv:
        files.append(result_csv)
    # Resolve each exact path once in this query. Repeated component checks
    # multiply NFS metadata calls; never cache path evidence across queries.
    paths = {file: task_safe_path(root, file) for file in files}
    infos = {}
    for file, full in paths.items():
        try:
            infos[file] = os.stat(full)
        except FileNotFoundError:
            infos[file] = None
    present = mode in ("train", "test", "train_test") and bool(files) and all(
        infos[file] and statmod.S_ISREG(infos[file].st_mode) and infos[file].st_size > 0 for file in files)
    for file in files:
        expected = (report.get("fileStats") or {}).get(file)
        if expected and infos[file]:
            info = infos[file]
            # inode/device/ctime belong to the writer filesystem, not a copied
            # artifact. Verify portable content evidence on every current query.
            if expected.get("size") is not None and info.st_size != expected["size"]:
                present = False
    metric_hash = (report.get("sha256") or {}).get(result_csv)
    if present and result_csv and metric_hash:
        full = paths[result_csv]
        if infos[result_csv].st_size > 4 * 1024 * 1024:
            raise ValueError("TASK_METRIC_TOO_LARGE")
        before = os.stat(full)
        with open(full, "rb") as handle:
            content = handle.read(4 * 1024 * 1024 + 1)
        after = os.stat(full)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_ino, before.st_dev) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_ino, after.st_dev):
            raise ValueError("TASK_METRIC_CHANGED_DURING_QUERY")
        if len(content) != after.st_size or hashlib.sha256(content).hexdigest() != metric_hash:
            present = False
    if mode in ("train", "train_test") and not report.get("weights"):
        present = False
    if mode in ("test", "train_test") and (not result_csv or result_csv != job.get("collectionResultCsv")):
        present = False
    expected_mode = "test" if job.get("checkpointTestOnly") and job.get("executionMode") == "train_test" else job.get("mode") or job.get("executionMode")
    expected_job = {key: job[field] for key, field in (("index", "experimentIndex"), ("case", "case"), ("seed", "seed")) if field in job}
    identity_matches = isinstance(report.get("runId"), str) and bool(report["runId"].strip()) and report.get("status") in ("completed", "failed") and report.get("outputDir") == output and (not expected_mode or mode == expected_mode)
    if expected_job:
        identity_matches = identity_matches and isinstance(report.get("job"), dict) and all(report["job"].get(key) == value for key, value in expected_job.items())
    return {"runId": report.get("runId"), "status": report.get("status"), "present": present, "job": report.get("job"), "runtimeDiagnostics": report.get("runtimeDiagnostics"), "exitCode": report.get("exitCode"),
            "identityMatches": bool(identity_matches), "verified": bool(present and identity_matches), "artifactsComplete": bool(present and identity_matches)}

def task_public_observation(root, job, row=None):
    result_error = ""
    try:
        result = task_manifest_observation(root, job)
    except Exception as exc:
        result, result_error = None, str(exc)
    observed = {"lifecycleProtocol": 2, "commandId": job["commandId"], "projectId": job["projectId"],
                "workerId": job["workerId"], "observedAt": now_iso(), "result": result}
    if result_error:
        observed["resultQueryError"] = result_error
    if row:
        observed["tmux"] = {"windowId": row["tmuxWindowId"], "paneId": row["tmuxPane"], "dead": row["dead"],
                            "exitCode": row["exitCode"], "phase": row["phase"]}
    execution = "missing"
    if row:
        execution = ("failed" if row["exitCode"] is not None and row["exitCode"] != 0 else "exited") if row["dead"] else (
            "queued" if row["phase"] in ("queued", "bound") else "starting" if row["phase"] in ("admitted", "starting") else "running" if row["phase"] == "running" else "unknown")
    result_state = "unverified" if result_error else "incomplete" if result is None else (
        "conflict" if result["runId"] != job["commandId"] or result.get("identityMatches") is False else
        "complete" if result.get("artifactsComplete") and result["present"] and result["verified"] else "incomplete")
    known_exit = row.get("exitCode") if row else None
    if known_exit is None and result and result.get("runId") == job["commandId"] and result.get("identityMatches"):
        known_exit = result.get("exitCode")
    if (not row or row["dead"]) and isinstance(known_exit, int):
        execution = "failed" if known_exit != 0 else "exited"
        if row:
            observed["tmux"]["exitCode"] = known_exit
    binding = result.get("runtimeDiagnostics") if result and result.get("runId") == job["commandId"] else None
    diagnostics = task_log_diagnostics(root, job, row, not row or row["dead"], binding) if "task_log_diagnostics" in globals() else None
    observed["runtimeDiagnostics"] = diagnostics
    completion = "review_required" if diagnostics and diagnostics.get("count", 0) else "verified" if diagnostics and diagnostics.get("state") == "clear" and diagnostics.get("scanComplete") else "unverified"
    if completion == "verified" and known_exit is None and result and result.get("status") == "failed":
        completion = "unverified"
    status = "queued" if execution in ("queued", "starting") else "running" if execution == "running" else (
        "failed" if execution == "failed" else "unknown" if execution == "unknown" else "completed" if result_state == "complete" else "unknown")
    if completion == "review_required" and (execution in ("exited", "failed") or execution == "missing" and result_state == "complete"):
        status = "failed"
    public = {key: job[key] for key in ("commandId", "projectId", "workerId", "workflowId", "globalJobId", "planFile", "planRevision", "codeFingerprint",
        "experimentIndex", "case", "seed", "outputDir", "collectionResultCsv", "resultPathPolicy", "planJobCount", "fullPlanJobCount", "enqueuedAt",
        "executionMode", "mode", "checkpointSource", "lifecycleProtocol", "runKey", "dispatchPolicy") if key in job}
    actual_mode = "test" if job.get("checkpointTestOnly") and job.get("executionMode") == "train_test" else job.get("mode") or job.get("executionMode")
    return {**public, "gpuMemoryProfile": task_budget_public(row) if row and row.get("_gpuBudget") else None, "actualExecutionMode": actual_mode, **({k: row[k] for k in ("tmuxWindowId", "tmuxPane", "tmuxSession", "gpuId", "exitCode")} if row else {}),
            "status": status, "executionState": execution, "resultState": result_state, "runtimeDiagnostics": diagnostics, "completionState": completion,
            "exitCode": known_exit,
            "successful": status == "completed" and completion == "verified",
            "logPath": row.get("logPath") if row else "", "observation": observed, "lifecycleProtocol": 2, "durableAccepted": True}


def task_collection_result(root, declaration):
    """Bounded live metadata for memory-only collection; never use an owner, queue or hash database."""
    output = declaration["output_dir"]
    manifest_path = output + "/artifact_manifest.json"
    manifest = task_safe_path(root, manifest_path)
    result = {"index": declaration["index"], "outputDir": output, "completed": False, "resultState": "missing"}
    if not os.path.isfile(manifest):
        return result
    result["resultState"] = "incomplete"
    def fingerprint(relative):
        full = task_safe_path(root, relative)
        before = os.stat(full)
        if not os.path.isfile(full) or before.st_size <= 0 or before.st_size > 4 * 1024 * 1024:
            raise ValueError("RESULT_FILE_SIZE_INVALID: " + relative)
        with open(full, "rb") as handle:
            text = handle.read(4 * 1024 * 1024 + 1)
        after = os.stat(full)
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(text) != before.st_size:
            raise ValueError("RESULT_FILE_CHANGED: " + relative)
        return text, {"remotePath": relative, "bytes": len(text), "sha256": hashlib.sha256(text).hexdigest()}
    text, proof = fingerprint(manifest_path)
    report = json.loads(text.decode("utf-8")).get("simpleExperiment") or {}
    mode = declaration["mode"]
    if report.get("status") not in ("completed", "failed") or report.get("outputDir") != output or report.get("mode") != mode or not report.get("runId"):
        return result
    if report.get("job") != {key: declaration[key] for key in ("index", "case", "seed")}:
        raise ValueError("RESULT_MANIFEST_JOB_MISMATCH")
    if report.get("planFile") and declaration.get("planFile") and report["planFile"] != declaration["planFile"]:
        raise ValueError("RESULT_MANIFEST_PLAN_MISMATCH")
    weights = report.get("weights") or []
    if not isinstance(weights, list) or mode != "test" and not weights:
        return result
    for relative in weights:
        if not isinstance(relative, str) or not relative.startswith(output + "/"):
            raise ValueError("RESULT_WEIGHT_PATH_INVALID")
        full = task_safe_path(root, relative)
        expected = (report.get("fileStats") or {}).get(relative) or {}
        if not os.path.isfile(full) or os.path.getsize(full) <= 0 or expected.get("size") is not None and os.path.getsize(full) != expected["size"]:
            return result
    files = [proof]
    if mode != "train":
        relative = declaration["result_csv"]
        if report.get("resultCsv") != relative:
            raise ValueError("RESULT_METRIC_PATH_MISMATCH")
        _, metric = fingerprint(relative)
        if (report.get("sha256") or {}).get(relative) and report["sha256"][relative] != metric["sha256"]:
            raise ValueError("RESULT_METRIC_HASH_CHANGED")
        files.append(metric)
    # Result aggregation verifies artifacts only. Task diagnostics use their own endpoint.
    return {**result, "completed": True, "resultState": "complete", "runId": report["runId"], "files": files, "exitCode": report.get("exitCode"), "executionStatus": report.get("status")}

def task_collection_query(root, declarations):
    if not isinstance(declarations, list) or len(declarations) > 500:
        raise ValueError("DECLARED_RESULT_QUERY_LIMIT")
    outputs = {item.get("output_dir") for item in declarations if isinstance(item, dict)}
    tasks = []
    for row in task_inventory(root):
        if row.get("outputDir") in outputs:
            tasks.append({"commandId": row.get("commandId"), "outputDir": row.get("outputDir"),
                          "observation": {"tmux": {"dead": row["dead"], "exitCode": row["exitCode"], "windowId": row["tmuxWindowId"]}}})
    return {"queryComplete": True, "generatedAt": now_iso(), "capabilities": {"resultCollection": 1, "runtimeDiagnostics": 1}, "tasks": tasks,
            "declaredResults": task_declared_results(root, declarations)}

def task_declared_results(root, declarations, tasks=()):
    if not isinstance(declarations, list) or len(declarations) > 500:
        raise ValueError("DECLARED_RESULT_QUERY_LIMIT")
    results = []
    for declaration in declarations:
        try:
            if declaration.get("collect") is True:
                results.append(task_collection_result(root, declaration))
                continue
            job = {"outputDir": declaration["output_dir"], "collectionResultCsv": declaration.get("result_csv"), "mode": declaration["mode"]}
            result = task_manifest_observation(root, job)
            expected = {"index": declaration["index"], "case": declaration["case"], "seed": declaration["seed"]}
            execution_blocks = False
            for task in tasks:
                if task.get("outputDir") != job["outputDir"]:
                    continue
                observed = task.get("observation") or {}
                pane = observed.get("tmux")
                if observed.get("queryError") or pane and not pane.get("dead"):
                    execution_blocks = True
                if result and task.get("commandId") == result.get("runId") and pane and pane.get("dead") and pane.get("exitCode") is not None and pane["exitCode"] != 0:
                    execution_blocks = True
            results.append({"index": declaration["index"], **job, "completed": bool(result and result["status"] == "completed"
                and isinstance(result.get("runId"), str) and result["runId"].strip() and result["verified"] and result.get("job") == expected
                and not execution_blocks), "runId": result.get("runId") if result else None})
        except Exception as exc:
            results.append({"index": declaration.get("index") if isinstance(declaration, dict) else None,
                            "outputDir": declaration.get("output_dir") if isinstance(declaration, dict) else None, "completed": False, "error": str(exc)})
    return results

def task_result_query(root, queries, diagnostics_only=False, compact=False):
    """Filesystem/log evidence only. Execution is queried separately, once per round."""
    if not isinstance(queries, list) or not queries or len(queries) > 500:
        raise ValueError("TASK_QUERY_SELECTION_INVALID")
    tasks = []
    for job in queries:
        if not isinstance(job, dict) or not all(isinstance(job.get(key), str) and job[key].strip() for key in ("commandId", "projectId", "workerId", "outputDir")):
            raise ValueError("TASK_QUERY_IDENTITY_REQUIRED")
        task_safe_path(root, job["outputDir"])
        public = {key: job[key] for key in ("commandId", "projectId", "workerId", "workflowId", "globalJobId", "planFile", "planRevision", "codeFingerprint",
            "experimentIndex", "case", "seed", "outputDir", "collectionResultCsv", "resultPathPolicy", "planJobCount", "fullPlanJobCount", "enqueuedAt",
            "executionMode", "mode", "runKey", "gpuId") if key in job}
        observed = {"lifecycleProtocol": 2, "commandId": job["commandId"], "projectId": job["projectId"], "workerId": job["workerId"], "observedAt": now_iso()}
        try:
            result = task_manifest_observation(root, job)
            observed["result"] = result
            if not diagnostics_only:
                if result is None:
                    observed["artifactIssue"] = "missing_or_invalid_manifest"
                elif not result.get("present") or not result.get("verified") or result.get("runId") != job["commandId"]:
                    observed["artifactIssue"] = "artifact_verification_failed"
            terminal = bool(result and result.get("runId") == job["commandId"] and result.get("identityMatches") and result.get("status") in ("completed", "failed"))
            if diagnostics_only and "task_log_diagnostics" in globals():
                observed["runtimeDiagnostics"] = task_log_diagnostics(root, job, terminal=terminal,
                    binding=result.get("runtimeDiagnostics") if terminal else None)
        except Exception as exc:
            observed["runtimeQueryError" if diagnostics_only else "resultQueryError"] = str(exc)
        if compact:
            # UI polling needs identity, verdicts and scan progress. Explicit
            # anomaly inspection retains the full exception report elsewhere.
            public = {key: job[key] for key in ("commandId", "projectId", "workerId")}
            if diagnostics_only:
                observed.pop("result", None)
                diagnostics = observed.get("runtimeDiagnostics")
                if diagnostics:
                    observed["runtimeDiagnostics"] = {key: diagnostics[key] for key in ("schemaVersion", "commandId", "runId",
                        "state", "count", "scanComplete", "bytesRead", "totalBytes", "types", "phases", "reason", "logPath") if key in diagnostics}
            elif observed.get("result"):
                observed["result"] = {key: observed["result"][key] for key in ("runId", "status", "present", "verified",
                    "identityMatches", "artifactsComplete", "exitCode") if key in observed["result"]}
        tasks.append({**public, "lifecycleProtocol": 2, "observation": observed})
    return {"schemaVersion": 1, "generatedAt": now_iso(), "queryComplete": True, "resultsOnly": True,
            "diagnosticsOnly" if diagnostics_only else "metadataOnly": True,
            "capabilities": {"taskLifecycle": 2, "runtimeDiagnostics": 1}, "tasks": tasks}


def task_declaration_query(root, declarations):
    """Launch checks need current panes/cleanup and this PLAN's manifests, never history logs."""
    if not isinstance(declarations, list) or len(declarations) > 500:
        raise ValueError("DECLARED_RESULT_QUERY_LIMIT")
    value = task_execution_inventory(root)
    value.pop("executionOnly", None)
    cleanup = []
    for line in task_tmux(["list-panes", "-a", "-F", "#{pane_dead}\t#{pane_id}\t#{window_id}\t#{@sftp_cleanup_target}"]).splitlines():
        fields = line.split("\t")
        if len(fields) == 4 and fields[0] != "1" and fields[3]:
            binding = json.loads(base64.urlsafe_b64decode(fields[3]).decode("utf-8"))
            if binding.get("root") == os.path.realpath(root):
                cleanup.append({"paneId": fields[1], "windowId": fields[2], "relativePath": binding["relativePath"], "destination": binding["destination"]})
    value.update(declarationOnly=True, cleanupExecutors=cleanup,
                 declaredResults=task_declared_results(root, declarations, value["tasks"]))
    value["capabilities"]["declaredResultQuery"] = 1
    return value


def task_query(root, queries=(), selected_only=False, observation_only=False):
    if not isinstance(queries, (list, tuple)) or len(queries) > 500:
        raise ValueError("TASK_QUERY_LIMIT")
    # Observations need the published identity and current pane, not every
    # job's multi-part launch source. Launch/admission still verify that payload.
    rows = task_inventory(root, execution_only=True)
    valid_queries, query_errors = [], []
    for index, query in enumerate(queries):
        try:
            if not isinstance(query, dict) or not all(isinstance(query.get(key), str) and query[key].strip() for key in ("commandId", "projectId", "workerId", "outputDir")):
                raise ValueError("TASK_QUERY_IDENTITY_REQUIRED")
            task_safe_path(root, query["outputDir"])
            valid_queries.append(query)
        except Exception as exc:
            query_errors.append({"index": index, "commandId": query.get("commandId") if isinstance(query, dict) else None, "error": str(exc)})
    queries = valid_queries
    if selected_only:
        if not queries or query_errors:
            raise ValueError("TASK_QUERY_SELECTION_INVALID")
        for query in queries:
            if any(row["commandId"] == query["commandId"] and (row["projectId"] != query["projectId"] or row["workerId"] != query["workerId"]) for row in rows):
                raise ValueError("TASK_OWNER_MISMATCH")
        wanted = {(query["projectId"], query["commandId"]) for query in queries}
        rows = [row for row in rows if (row["projectId"], row["commandId"]) in wanted]
        for index, row in enumerate(rows if not observation_only else []):
            payload = task_read_job(row["tmuxPane"])
            if any(payload.get(key) != row.get(key) for key in ("root", "projectId", "workerId", "commandId", "outputDir", "pane")):
                raise ValueError("TASK_WINDOW_PAYLOAD_IDENTITY_MISMATCH")
            rows[index] = {**payload, **row}
    # Old managed tabs can be controlled by their real tmux markers, without a task snapshot.
    if queries and "local_stop_tmux_inventory" in globals():
        legacy = local_stop_tmux_inventory(root)
        for query in queries:
            if not isinstance(query, dict):
                continue
            for tab in legacy:
                if tab["command"] == query.get("commandId") and tab["project"] == query.get("projectId") and not any(row["tmuxPane"] == tab["pane"] for row in rows):
                    rows.append({**query, "tmuxPane": tab["pane"], "tmuxWindowId": tab["window"], "tmuxSession": tab["session"],
                        "dead": tab["dead"] == "1", "exitCode": int(tab["exitCode"]) if re.fullmatch(r"-?\d+", tab["exitCode"]) else None,
                        "phase": "running", "gpuId": query.get("gpuId", ""), "logPath": ""})
    # Selectors bound artifact reads for absent windows; they cannot hide a real
    # exited pane just because another job was selected for a result query.
    jobs = {(row["projectId"], row["commandId"]): row for row in rows}
    for query in queries:
        if not isinstance(query, dict) or not query.get("commandId") or not query.get("projectId") or not query.get("workerId"):
            raise ValueError("TASK_QUERY_IDENTITY_REQUIRED")
        task_safe_path(root, query.get("outputDir"))
        key = (query["projectId"], query["commandId"])
        if key not in jobs:
            jobs[key] = query
        elif query.get("runtimeLogAnalysisId"):
            jobs[key] = {**jobs[key], "runtimeLogAnalysisId": query["runtimeLogAnalysisId"]}
    tasks = []
    cancelled_by_worker = {}
    for key, job in jobs.items():
        row = next((item for item in rows if (item["projectId"], item["commandId"]) == key), None)
        try:
            public = task_public_observation(root, job, row)
            try:
                if job["workerId"] not in cancelled_by_worker:
                    # A missing/slow controller is one failed read, not N serial
                    # tmux timeouts for N historical jobs. None proves no cancellation.
                    cancelled_by_worker[job["workerId"]] = None
                    cancelled_by_worker[job["workerId"]] = json.loads(task_option(task_queue_session(root, job["workerId"]) + ":queue", "cancelled") or "[]")
                cancelled = cancelled_by_worker[job["workerId"]]
                if cancelled is not None:
                    public["observation"]["cancelled"] = job["commandId"] in cancelled
                    if not row and job["commandId"] in cancelled and public["status"] != "completed":
                        public["status"] = "cancelled"
            except Exception:
                pass
            if public["status"] == "failed" and row:
                try:
                    public["error"] = task_tmux(["capture-pane", "-p", "-t", row["tmuxPane"], "-S", "-80"])[-8000:]
                except RuntimeError as exc:
                    # A user may close an exited tab between inventory and log capture.
                    # A fresh inventory distinguishes disappearance from a broken tmux query.
                    if any(item["tmuxPane"] == row["tmuxPane"] for item in task_inventory(root, execution_only=True)):
                        raise
                    public["logQueryError"] = str(exc)
            tasks.append(public)
        except Exception as exc:
            tasks.append({**job, "status": "unknown", "lifecycleProtocol": 2, "observation": {
                "lifecycleProtocol": 2, "commandId": job["commandId"], "projectId": job["projectId"], "workerId": job["workerId"],
                "observedAt": now_iso(), "queryError": str(exc)}})
    cleanup_executors = []
    for line in task_tmux(["list-panes", "-a", "-F", "#{pane_dead}\t#{pane_id}\t#{window_id}\t#{@sftp_cleanup_target}"]).splitlines():
        fields = line.split("\t")
        if len(fields) == 4 and fields[0] != "1" and fields[3]:
            binding = json.loads(base64.urlsafe_b64decode(fields[3]).decode("utf-8"))
            if binding.get("root") == os.path.realpath(root):
                cleanup_executors.append({"paneId": fields[1], "windowId": fields[2], "relativePath": binding["relativePath"], "destination": binding["destination"]})
    return {"schemaVersion": 1, "generatedAt": now_iso(), "tasks": tasks, "queryComplete": True, "queryErrors": query_errors, "cleanupExecutors": cleanup_executors,
            "activeOperations": active_cleanup_operations(root) if "active_cleanup_operations" in globals() else [],
            "capabilities": {"schemaVersion": 1, "durablePlanQueue": True, "declaredJobPaths": True,
                             "idleGpuAdmission": True, "queuedJobRecall": True, "taskLifecycle": 2, "manualDispatch": 1, "runtimeDiagnostics": 1,
                             "gpuMemoryRatioScheduling": task_memory_scheduler_capability(root), "gpuQuotaScheduling": 1, "gpuCardQuotaScheduling": 1, "gpuCardLimitScheduling": 1, "gpuMemoryBudgetScheduling": 1, "declaredResultQuery": 1, "resultCollection": 1, "gpuCollector": 1}}

def task_session_prefix():
    prefix = re.sub(r"[^a-z0-9._-]+", "-", str(os.environ.get("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX") or "simple").strip().lower()).strip("-")[:32]
    if not re.match(r"^[a-z0-9]", prefix):
        prefix = "simple"
    return prefix

def task_queue_session(root, worker_id, refresh=False):
    key = hashlib.sha256((os.path.realpath(root) + "\0" + worker_id).encode("utf-8")).hexdigest()[:16]
    prefix = task_session_prefix()
    # Volatile address hints only. Every RPC/report still verifies the live
    # endpoint binding; no cached hint proves acceptance or execution.
    locators = globals().setdefault("_TASK_QUEUE_LOCATORS", {})
    scope = (os.path.realpath(root), worker_id, prefix)
    if not refresh and scope in locators:
        return locators[scope]
    legacy = "simple-sch-" + key
    if prefix != "simple":
        # Locate an existing pre-prefix controller by its native root/Worker
        # binding. Naming changes must never create a second queue for it.
        found = subprocess.run(["tmux", "display-message", "-p", "-t", legacy + ":queue", "#{@se_endpoint}"], capture_output=True, text=True, timeout=3)
        if found.returncode == 0 and (found.stdout or "").strip():
            endpoint = json.loads(found.stdout)
            if endpoint.get("root") != os.path.realpath(root) or endpoint.get("workerId") != worker_id:
                raise ValueError("SCHEDULER_OWNER_MISMATCH")
            locators[scope] = legacy
            return legacy
    if len(locators) >= 128:
        locators.pop(next(iter(locators)))
    locators[scope] = prefix + "-sch-" + key
    return locators[scope]

def task_describe_plan(root, discovery):
    plan = str(discovery.get("planFile") or "")
    task_safe_path(root, plan)
    env = os.environ.copy()
    env["SIMPLE_EXPERIMENT_CONDA_ENV"] = str(discovery.get("condaEnv") or "")
    args = [simple_runtime_python(env), "-B", "-X", "utf8", cluster_scheduler_path(root), "--describe-jobs", "--plan", plan]
    proc = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, timeout=8)
    if proc.returncode or len(proc.stdout) > 2 * 1024 * 1024:
        raise RuntimeError("PLAN_DECLARATIONS_QUERY_FAILED: " + (proc.stderr or "")[-1000:])
    document = json.loads(proc.stdout)
    return [{**job, "planHash": document.get("planHash")} for job in document["jobs"]]

def task_queue_endpoint(root, worker_id):
    session = task_queue_session(root, worker_id)
    try:
        text = task_tmux(["display-message", "-p", "-t", session + ":queue", "#{@se_endpoint}"])
    except RuntimeError:
        session = task_queue_session(root, worker_id, refresh=True)
        text = task_tmux(["display-message", "-p", "-t", session + ":queue", "#{@se_endpoint}"])
    endpoint = json.loads(text)
    if endpoint.get("root") != os.path.realpath(root) or endpoint.get("workerId") != worker_id:
        raise ValueError("SCHEDULER_OWNER_MISMATCH")
    return endpoint


def task_runtime_files(root):
    identity = globals().get("AGENT_LIFECYCLE_IDENTITY") or {}
    if identity.get("runtimeFiles"):
        return dict(identity["runtimeFiles"])
    paths = {"cluster_agent.py": os.path.abspath(__file__)}
    if "cluster_scheduler_path" in globals():
        paths["cluster_scheduler.py"] = cluster_scheduler_path(root)
    return {name: hashlib.sha256(pathlib.Path(filename).read_bytes()).hexdigest() for name, filename in paths.items()}


def task_scheduler_runtime_report(root, worker_id):
    """Read the running controller's native binding; never expose its channel secret."""
    try:
        session = task_queue_session(root, worker_id)
        found = subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, text=True, timeout=3)
        if found.returncode:
            error = (found.stderr or "").lower()
            if any(text in error for text in ("can't find session", "no server running", "no sessions")) or "error connecting" in error and "no such file or directory" in error:
                return {"protocol": 1, "status": "absent", "workerId": worker_id}
            raise RuntimeError("SCHEDULER_QUERY_FAILED: " + error[-500:])
        fields = task_tmux(["display-message", "-p", "-t", session + ":queue",
            "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{window_panes}\t#{@se_job}"]).split("\t")
        if len(fields) != 5 or not re.fullmatch(r"@\d+", fields[0]) or not re.fullmatch(r"%\d+", fields[1]) or fields[3] != "1" or fields[4]:
            raise ValueError("SCHEDULER_CONTROL_WINDOW_UNVERIFIED")
        endpoint = task_queue_endpoint(root, worker_id)
        version = globals().get("RUNTIME_VERSION", "fixture")
        current = fields[2] != "1" and endpoint.get("runningVersion") == version and endpoint.get("runtimeFiles") == task_runtime_files(root)
        return {"protocol": 1, "status": "current" if current else "update_required", "workerId": worker_id,
            "windowId": fields[0], "paneId": fields[1], "dead": fields[2] == "1", "epoch": endpoint["epoch"],
            "runningVersion": endpoint.get("runningVersion"), "runtimeFiles": endpoint.get("runtimeFiles") or {},
            "gpuMemoryRatioScheduling": endpoint.get("gpuMemoryRatioScheduling", 0), "gpuQuotaScheduling": endpoint.get("gpuQuotaScheduling", 0), "gpuCardQuotaScheduling": endpoint.get("gpuCardQuotaScheduling", 0), "gpuCardLimitScheduling": endpoint.get("gpuCardLimitScheduling", 0)}
    except Exception as exc:
        return {"protocol": 1, "status": "unknown", "workerId": worker_id, "error": str(exc)}


def task_queue_command(root, worker_id):
    argv = [sys.executable, "-B", os.path.abspath(__file__), "task-queue", "--project-dir", os.path.realpath(root), "--worker-id", worker_id]
    if "agent_dir" in globals():
        argv.extend(["--state-dir", agent_dir(root)])
    # tmux children inherit the server's initial environment, not the Agent's.
    # Carry the configured prefix explicitly for both startup and replacement.
    carry = ["SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX=" + task_session_prefix()]
    if "gpu_collector_state_root" in globals():
        carry.append("SIMPLE_EXPERIMENT_WORKER_STATE_DIR=" + gpu_collector_state_root(root))
    return "exec env " + shlex.join([*carry, *argv])


def task_update_scheduler_runtime(root, worker_id):
    """Agent deployment replaces only the verified queue controller, retaining all task windows."""
    before = task_scheduler_runtime_report(root, worker_id)
    if before["status"] in ("absent", "current"):
        return before
    if before["status"] != "update_required":
        raise RuntimeError("SCHEDULER_RUNTIME_UNVERIFIED: " + before.get("error", "unknown controller"))
    pane = before["paneId"]
    # Recheck the exact pane, window and epoch immediately before replacement.
    if task_scheduler_runtime_report(root, worker_id) != before:
        raise RuntimeError("SCHEDULER_CONTROL_CHANGED")
    task_tmux(["set-option", "-w", "-t", before["windowId"], "remain-on-exit", "on"])
    # -k replaces this controller process tree only. Queued/running tasks have independent windows.
    task_tmux(["respawn-pane", "-k", "-t", pane, "-c", os.path.realpath(root), task_queue_command(root, worker_id)])
    deadline = time.monotonic() + 4
    while True:
        report = task_scheduler_runtime_report(root, worker_id)
        if report["status"] == "current" and report.get("epoch") != before["epoch"]:
            return report
        if time.monotonic() >= deadline:
            raise RuntimeError("SCHEDULER_RESTART_UNCONFIRMED: " + json.dumps(report))
        time.sleep(0.05)


def task_memory_scheduler_capability(root):
    worker_id = os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker"
    session = task_queue_session(root, worker_id)
    exists = subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, timeout=3).returncode == 0
    if not exists:
        return 1  # The next accept starts the new controller.
    try:
        if task_tmux(["display-message", "-p", "-t", session + ":queue", "#{pane_dead}"]) == "1":
            return 1  # A dead controller is already recovered by the existing bounded startup path.
        return int(task_queue_endpoint(root, worker_id).get("gpuMemoryRatioScheduling") == 1)
    except Exception:
        return 0

def task_queue_rpc(root, worker_id, action, payload, ensure=False):
    if ensure:
        session = task_queue_session(root, worker_id)
        previous_epoch = None
        exists = subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, timeout=3).returncode == 0
        if not exists:
            # If an old controller disappeared, create with today's prefix.
            session = task_queue_session(root, worker_id, refresh=True)
            exists = subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, timeout=3).returncode == 0
        shell = task_queue_command(root, worker_id)
        if not exists:
            made = subprocess.run(["tmux", "new-session", "-d", "-s", session, "-n", "queue", "-c", root,
                                   shell], capture_output=True, text=True, timeout=5)
            if made.returncode and "duplicate session" not in (made.stderr or "").lower():
                raise RuntimeError("SCHEDULER_START_FAILED: " + str(made.stderr))
            task_tmux(["set-option", "-w", "-t", session + ":queue", "remain-on-exit", "on"])
        elif task_tmux(["display-message", "-p", "-t", session + ":queue", "#{pane_dead}"]) == "1":
            try:
                previous_epoch = task_queue_endpoint(root, worker_id).get("epoch")
            except Exception:
                pass
            # Never kill a healthy controller. Concurrent recovery may already have respawned this dead pane.
            subprocess.run(["tmux", "respawn-pane", "-t", session + ":queue", shell], capture_output=True, timeout=5)
        # Bounded startup observation. This is not an acceptance/termination wait.
        deadline = time.monotonic() + 4
        while True:
            try:
                endpoint = task_queue_endpoint(root, worker_id)
                if previous_epoch and endpoint.get("epoch") == previous_epoch:
                    raise RuntimeError("SCHEDULER_RESTARTING")
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise RuntimeError("SCHEDULER_QUERY_FAILED: control window is not ready")
                time.sleep(0.05)
    else:
        endpoint = task_queue_endpoint(root, worker_id)
    policy = (payload.get("options") or {}) if action == "accept" else payload
    if action in ("accept", "configure") and policy.get("gpuMaxConcurrentCards") is not None and endpoint.get("gpuCardLimitScheduling") != 1:
        raise RuntimeError("SCHEDULER_UPDATE_REQUIRED: update this project's Scheduler for server card limits; task windows are preserved")
    if action in ("accept", "configure") and policy.get("gpuCardOverrides") and endpoint.get("gpuCardQuotaScheduling") != 1:
        raise RuntimeError("SCHEDULER_UPDATE_REQUIRED: update this project's Scheduler for per-GPU quotas; task windows are preserved")
    if action == "accept" and (payload.get("options") or {}).get("gpuQuotaScheduling") == 1 and endpoint.get("gpuQuotaScheduling") != 1:
        raise RuntimeError("SCHEDULER_UPDATE_REQUIRED: update this project's Scheduler for GPU quotas; task windows are preserved")
    if action == "accept" and (payload.get("options") or {}).get("gpuMemoryBudgetScheduling") == 1 and endpoint.get("gpuMemoryBudgetScheduling") != 1:
        raise RuntimeError("SCHEDULER_UPDATE_REQUIRED: update Scheduler for memory reservations; task windows are preserved")
    if action == "accept" and payload.get("dispatchPolicy") != "manual" and (payload.get("options") or {}).get("gpuMemoryRatioEnabled") is True and endpoint.get("gpuMemoryRatioScheduling") != 1:
        raise RuntimeError("SCHEDULER_UPDATE_REQUIRED: restart this project's Scheduler control window to enable memory-ratio scheduling; task windows are preserved")
    body = json.dumps({"action": action, "payload": payload, "epoch": endpoint["epoch"]}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request("http://" + endpoint["host"] + ":" + str(endpoint["port"]) + "/control", data=body,
                                    headers={"Content-Type": "application/json", "Authorization": "Bearer " + endpoint["secret"]})
    with urllib.request.urlopen(request, timeout=8) as response:
        result = json.loads(response.read(1024 * 1024))
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "SCHEDULER_ACTION_FAILED")
    return result.get("value")

def task_queue_job(root, worker_id, command):
    allowed = {"action", "commandId", "operationId", "runKey", "projectId", "workflowId", "planFile", "planRevision", "codeFingerprint",
               "globalJobId", "experimentIndex", "case", "seed", "outputDir", "collectionResultCsv", "resultPathPolicy", "planJobCount",
               "fullPlanJobCount", "enqueuedAt", "workerId", "gpuId", "requireIdleGpu", "executionMode", "mode", "checkpointSource",
               "checkpointTestOnly", "condaEnv", "distributedResults", "codeSyncProofId", "codeManifest", "manifestDigest", "executionSource", "tmuxSessionPrefix", "maxConcurrentGpus",
               "gpuIdleUtilThreshold", "gpuIdleMemThresholdMb", "schedulerPath", "defaultResultCsvDir", "lifecycleProtocol", "dispatchPolicy",
               "gpuMemoryRatioEnabled", "gpuMemoryPerJobGb", "gpuMemoryMaxJobsPerGpu", "gpuMemoryReserveGb", "gpuMemoryTolerancePercent",
                             "gpuQuotaScheduling", "gpuJobsPerCard", "gpuMinFreeMemoryGb", "gpuCardOverrides", "gpuMaxConcurrentCards", "gpuMemoryBudgetScheduling", "gpuMemoryReservation"}
    job = {key: command[key] for key in allowed if key in command}
    options = command.get("options") if isinstance(command.get("options"), dict) else {}
    job["options"] = {key: value for key, value in options.items() if key in allowed or key == "distributedResults"}
    for key in allowed:
        if key not in job and key in job["options"]:
            job[key] = job["options"][key]
    if job.get("workerId") != worker_id or job.get("resultPathPolicy") != "declared":
        raise ValueError("TASK_OWNER_REQUIRED")
    if job.get("dispatchPolicy", "automatic") not in ("manual", "automatic"):
        raise ValueError("TASK_DISPATCH_POLICY_INVALID")
    if job.get("dispatchPolicy") == "manual" and not str(job.get("gpuId") or "").strip():
        raise ValueError("MANUAL_GPU_REQUIRED")
    if not re.fullmatch(r"[a-zA-Z0-9._:-]{1,128}", str(job.get("commandId") or "")):
        raise ValueError("TASK_COMMAND_ID_REQUIRED")
    for key in ("projectId", "workflowId", "planFile", "outputDir", "collectionResultCsv", "planRevision", "codeFingerprint", "globalJobId"):
        if not job.get(key):
            raise ValueError("TASK_IDENTITY_REQUIRED: " + key)
    for key in ("planFile", "outputDir", "collectionResultCsv"):
        task_safe_path(root, job[key])
    index = job.get("experimentIndex")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or job["globalJobId"] != job["workflowId"] + ":" + str(index):
        raise ValueError("TASK_GLOBAL_JOB_ID_MISMATCH")
    if "attempts" in job["outputDir"].split("/"):
        raise ValueError("HISTORICAL_ATTEMPT_READ_ONLY")
    if job.get("executionSource"):
        verify_plan_execution_source(root, job, job["executionSource"])
    job.update(root=os.path.realpath(root), lifecycleProtocol=2, runKey=job["commandId"], action="start-worker-task")
    overlap = lambda a, b: a == b or a.startswith(b + "/") or b.startswith(a + "/")
    if any(not row["dead"] and row["commandId"] != job["commandId"] and
           any(overlap(str(row.get(a) or ""), job[b]) for a in ("outputDir", "collectionResultCsv") for b in ("outputDir", "collectionResultCsv"))
           for row in task_inventory(root)):
        raise ValueError("TASK_OUTPUT_BUSY: another managed tmux job uses this declared output/result")
    return job

def task_queue_accept(root, worker_id, command, window, prepared=None):
    job = prepared if prepared is not None else task_queue_job(root, worker_id, command)
    title = pathlib.Path(job["planFile"]).stem + "·" + str(job.get("case") or job.get("experimentIndex")) + "·seed" + str(job.get("seed")) + "·" + job["commandId"][-8:]
    title = title.replace(":", "_").replace("\n", "_")[:160]
    runner = [sys.executable, "-B", os.path.abspath(__file__), "task-runner", "--project-dir", root, "--worker-id", worker_id]
    if "agent_dir" in globals():
        runner.extend(["--state-dir", agent_dir(root)])
    session = task_tmux(["display-message", "-p", "-t", window, "#{session_id}"])
    if not re.fullmatch(r"\$\d+", session):
        raise RuntimeError("SCHEDULER_SESSION_UNVERIFIED")
    pane = task_tmux(["new-window", "-d", "-t", session + ":", "-n", title, "-c", root,
                      "-P", "-F", "#{pane_id}", "--", "sh", "-c", "exec " + shlex.join(runner)])
    job["pane"] = pane
    task_tmux(["set-option", "-w", "-t", pane, "remain-on-exit", "on"])
    core = {key: value for key, value in job.items() if key not in ("codeManifest", "executionSource", "options", "distributedResults", "gpuMemoryReservation")}
    task_option(pane, "phase", "binding")
    task_option(pane, "job", base64.urlsafe_b64encode(json.dumps(core, ensure_ascii=False).encode("utf-8")).decode("ascii"))
    try:
        task_write_job(pane, job)
    except Exception as exc:
        task_option(pane, "error", "TASK_WINDOW_BINDING_FAILED: " + str(exc)[:1000])
        task_option(pane, "phase", "rejected")
        raise
    task_option(pane, "phase", "queued")
    for key, value in (("@simple_experiment_command", job["commandId"]), ("@simple_experiment_project", job["projectId"])):
        task_tmux(["set-option", "-w", "-t", pane, key, value])
    return job

def task_memory_info(gpu, options):
    if options.get("gpuMemoryRatioEnabled") is not True:
        return None
    def number(value, default=None):
        try:
            parsed = float(value)
            return parsed if parsed == parsed and abs(parsed) != float("inf") else default
        except (ValueError, TypeError):
            return default
    total = number(next((gpu[key] for key in ("memoryTotalMb", "memory_total_mb", "memoryTotal", "memory_total") if gpu.get(key) is not None), None))
    used = number(next((gpu[key] for key in ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used") if gpu.get(key) is not None), None))
    if total is None or used is None or total <= 0 or used < 0 or used > total:
        return None
    base = max(1, min(1024, number(options.get("gpuMemoryPerJobGb"), 24))) * 1024
    tolerance = max(0, min(5, number(options.get("gpuMemoryTolerancePercent"), 3))) / 100
    ratio = total / base
    upper = int(ratio) + int(ratio != int(ratio))
    limit = max(1, upper if ratio >= upper * (1 - tolerance) else int(ratio))
    ceiling = max(0, min(1024, int(number(options.get("gpuMemoryMaxJobsPerGpu"), 0))))
    if ceiling:
        limit = min(limit, ceiling)
    reserve = max(0, min(1024, number(options.get("gpuMemoryReserveGb"), 0))) * 1024
    return {"limit": limit, "unit": min(total, base) * (1 - tolerance), "budget": total - reserve,
            "free": total - used - reserve - gpu.get("_se_reserved_mb", 0)}


def task_gpu_quota_policy(options, gpus):
    quota = options.get("gpuJobsPerCard")
    if quota is None:
        legacy = next((task_memory_info(gpu, options) for gpu in gpus if task_memory_info(gpu, options)), None)
        quota = legacy["limit"] if legacy else 1
    quota, minimum = float(quota), float(options.get("gpuMinFreeMemoryGb", 22))
    if not (1 <= quota <= 1024 and quota.is_integer() and 0 <= minimum <= 1024):
        raise ValueError("GPU_QUOTA_SETTINGS_INVALID")
    policy = {"gpuQuotaScheduling": 1, "gpuJobsPerCard": int(quota), "gpuMinFreeMemoryGb": minimum}
    cap = options.get("gpuMaxConcurrentCards")
    if cap is not None and cap != "":
        cap = float(cap)
        if not 0 <= cap <= 256 or not cap.is_integer():
            raise ValueError("GPU_CARD_LIMIT_INVALID")
        policy["gpuMaxConcurrentCards"] = int(cap)
    cards = options.get("gpuCardOverrides") or {}
    if not isinstance(cards, dict) or len(cards) > 256:
        raise ValueError("GPU_CARD_SETTINGS_INVALID")
    normalized = {}
    for gpu_id, fields in cards.items():
        if not isinstance(gpu_id, str) or not gpu_id.isascii() or not gpu_id.isdecimal() or str(int(gpu_id)) != gpu_id or not isinstance(fields, dict):
            raise ValueError("GPU_CARD_SETTINGS_INVALID")
        entry = {}
        for key in ("gpuJobsPerCard", "gpuMinFreeMemoryGb"):
            value = fields.get(key)
            if value is None or value == "":
                continue
            value = float(value)
            if not 0 <= value <= 1024 or key == "gpuJobsPerCard" and not value.is_integer():
                raise ValueError("GPU_CARD_SETTINGS_INVALID: " + gpu_id + "." + key)
            entry[key] = int(value) if key == "gpuJobsPerCard" else value
        if entry:
            normalized[gpu_id] = entry
    if normalized:
        policy["gpuCardOverrides"] = normalized
    return policy


def task_admission_gpu(row, gpus, occupied):
    options = row.get("options") or {}
    pinned = str(row.get("gpuId") or "")
    if options.get("gpuQuotaScheduling") == 1:
        if row.get("dispatchPolicy") == "manual" and not any(gpu_row_id(gpu) == pinned for gpu in gpus):
            raise ValueError("MANUAL_GPU_NOT_VISIBLE: " + pinned)
        policy = task_gpu_quota_policy(options, gpus)
        active = {gpu_id for gpu_id, count in occupied.items() if count > 0}
        cap = policy.get("gpuMaxConcurrentCards", len(active) + len(gpus))
        if len(active) > cap:
            return None
        for gpu in sorted(gpus, key=lambda item: gpu_row_id(item) != pinned):
            gpu_id = gpu_row_id(gpu)
            if gpu_id not in active and len(active) >= cap:
                continue
            card_policy = {**policy, **policy.get("gpuCardOverrides", {}).get(gpu_id, {})}
            if row.get("dispatchPolicy") == "manual" and gpu_id != pinned:
                continue
            if options.get("gpuMemoryBudgetScheduling") == 1 and pinned and gpu_id != pinned:
                continue
            total = gpu.get("memoryTotalMb", gpu.get("memory_total_mb", gpu.get("memoryTotal", gpu.get("memory_total"))))
            used = gpu.get("memoryUsedMb", gpu.get("memory_used_mb", gpu.get("memoryUsed", gpu.get("memory_used"))))
            try:
                total, used = float(total), float(used)
                valid = 0 < total and 0 <= used <= total and total != float("inf")
            except (ValueError, TypeError):
                valid = False
            if valid and total - used >= card_policy["gpuMinFreeMemoryGb"] * 1024 and occupied.get(gpu_id, 0) < card_policy["gpuJobsPerCard"]:
                if options.get("gpuMemoryBudgetScheduling") == 1 and not task_budget_admit(row, gpu, row.get("_budgetLive", []), row.get("_budgetEvidence", [])):
                    continue
                return gpu_id
        return None
    if row.get("dispatchPolicy") == "manual":
        if not any(gpu_row_id(gpu) == pinned for gpu in gpus):
            raise ValueError("MANUAL_GPU_NOT_VISIBLE: " + pinned)
        return pinned
    cap = max(1, int(row.get("maxConcurrentGpus") or options.get("maxConcurrentGpus") or len(gpus) or 1))
    pinned = pinned if row.get("requireIdleGpu") else ""
    # Automatic placement is a preference. A queued job must follow currently
    # available capacity when its original card filled before admission.
    for gpu in sorted(gpus, key=lambda item: gpu_row_id(item) != pinned):
        gpu_id = gpu_row_id(gpu)
        count = occupied.get(gpu_id, 0) if isinstance(occupied, dict) else int(gpu_id in occupied)
        active_ids = [gpu_row_id(item) for item in gpus if gpu_row_id(item) in occupied]
        if count and gpu_id not in active_ids[:cap]:
            continue
        memory = task_memory_info(gpu, options)
        if count >= (memory["limit"] if memory else 1):
            continue
        if not count and len(occupied) >= min(cap, len(gpus)):
            continue
        if memory and (memory["free"] < memory["unit"] or memory["budget"] < (count + 1) * memory["unit"]):
            continue
        if (not count or not memory) and gpu_row_busy(gpu,
                row.get("gpuIdleUtilThreshold", options.get("gpuIdleUtilThreshold")),
                row.get("gpuIdleMemThresholdMb", options.get("gpuIdleMemThresholdMb"))):
            continue
        return gpu_id
    return None

def task_queue_serve(root, worker_id):
    root = os.path.realpath(root)
    controller = os.environ["TMUX_PANE"]
    secret, epoch = uuid.uuid4().hex, uuid.uuid4().hex
    mutex = threading.RLock()
    wake = threading.Event()
    remembered = set(json.loads(task_option(controller, "cancelled") or "[]"))
    accepted = set(json.loads(task_option(controller, "accepted") or "[]")) | {row["commandId"] for row in task_inventory(root, execution_only=True)}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            try:
                if self.headers.get("Authorization") != "Bearer " + secret:
                    raise ValueError("SCHEDULER_AUTH_REQUIRED")
                size = int(self.headers.get("Content-Length") or 0)
                if size < 1 or size > 256 * 1024:
                    raise ValueError("SCHEDULER_REQUEST_LIMIT")
                request = json.loads(self.rfile.read(size))
                if request.get("epoch") != epoch:
                    raise ValueError("SCHEDULER_INSTANCE_CHANGED")
                payload = request.get("payload") or {}
                with mutex:
                    if request["action"] == "accept":
                        command_id = payload.get("commandId")
                        if (payload.get("options") or {}).get("gpuQuotaScheduling") == 1:
                            policy = task_gpu_quota_policy(payload["options"], [])
                        if command_id in remembered:
                            raise ValueError("TASK_CANCELLED")
                        found = next((row for row in task_inventory(root, execution_only=True) if row["commandId"] == command_id), None)
                        if found:
                            # Match admission's top-level-over-options precedence without rerunning
                            # launch/source probes for an already accepted command.
                            identity = {**(payload.get("options") if isinstance(payload.get("options"), dict) else {}), **payload}
                            if any(found.get(key) != identity.get(key) for key in ("projectId", "workerId", "workflowId", "experimentIndex", "globalJobId", "case", "seed", "outputDir", "collectionResultCsv")):
                                raise ValueError("TASK_COMMAND_ID_CONFLICT")
                            value = task_public_observation(root, found, found)
                        elif command_id in accepted:
                            raise ValueError("TASK_ALREADY_ACCEPTED_WINDOW_CLOSED: query result without redispatch")
                        else:
                            prepared = task_queue_job(root, worker_id, payload)
                            if len(accepted) >= 10000:
                                raise ValueError("SCHEDULER_ACCEPTANCE_CAPACITY")
                            # Reserve the command in native window metadata before creating its tab.
                            # A controller restart cannot replay a job whose tab was manually closed.
                            accepted.add(command_id)
                            task_option(controller, "accepted", json.dumps(sorted(accepted)))
                            job = task_queue_accept(root, worker_id, payload, controller, prepared)
                            wake.set()
                            value = {**job, "status": "queued", "durableAccepted": True}
                        if (payload.get("options") or {}).get("gpuQuotaScheduling") == 1:
                            # Explicit current configuration outranks launch
                            # snapshots, including a delayed duplicate accept.
                            if task_option(controller, "gpu_policy_explicit") != "1":
                                task_option(controller, "gpu_policy", json.dumps(policy))
                            wake.set()
                    elif request["action"] == "configure":
                        policy = task_gpu_quota_policy(payload, [])
                        task_option(controller, "gpu_policy", json.dumps(policy))
                        task_option(controller, "gpu_policy_explicit", "1")
                        value = policy
                        wake.set()
                    elif request["action"] == "cancel":
                        command_id = payload["targetCommandId"]
                        if any(row["projectId"] != payload["projectId"] for row in task_inventory(root, execution_only=True) if row["commandId"] == command_id):
                            raise ValueError("TASK_OWNER_MISMATCH")
                        if len(remembered) >= 10000 and command_id not in remembered:
                            raise ValueError("CANCELLATION_CAPACITY")
                        remembered.add(command_id)
                        task_option(controller, "cancelled", json.dumps(sorted(remembered)))
                        for row in task_inventory(root, execution_only=True):
                            if row["commandId"] == command_id:
                                if row["projectId"] != payload["projectId"] or row["workerId"] != worker_id:
                                    raise ValueError("TASK_OWNER_MISMATCH")
                                current = [item for item in task_inventory(root, execution_only=True) if item["tmuxWindowId"] == row["tmuxWindowId"]]
                                if any(item["commandId"] != command_id or item["projectId"] != payload["projectId"] or item["workerId"] != worker_id for item in current):
                                    raise ValueError("TASK_OWNER_MISMATCH")
                                if current:
                                    task_tmux(["kill-window", "-t", row["tmuxWindowId"]])
                        value = {"cancelled": True}
                        wake.set()
                    else:
                        raise ValueError("UNKNOWN_SCHEDULER_ACTION")
                result = {"ok": True, "value": value}
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    task_option(controller, "endpoint", json.dumps({"host": server.server_address[0], "port": server.server_address[1],
        "secret": secret, "epoch": epoch, "root": root, "workerId": worker_id, "protocol": 2,
        "runningVersion": globals().get("RUNTIME_VERSION", "fixture"), "runtimeFiles": task_runtime_files(root), "gpuMemoryRatioScheduling": 1, "gpuQuotaScheduling": 1, "gpuCardQuotaScheduling": 1, "gpuCardLimitScheduling": 1, "gpuMemoryBudgetScheduling": 1}))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        queued = []
        try:
            with mutex:
                rows = task_inventory(root, execution_only=True)
                occupied = {}
                for live in rows:
                    if not live["dead"] and live["phase"] in ("admitted", "starting", "running") and live["gpuId"]:
                        occupied[live["gpuId"]] = occupied.get(live["gpuId"], 0) + 1
                queued = sorted([row for row in rows if not row["dead"] and row["phase"] == "queued"], key=lambda row: row.get("dispatchPolicy") != "manual")
                if queued or any(row.get("_gpuBudget") and not row["_gpuBudget"].get("finished") for row in rows):
                    gpus, error = gpu_admission_probe(root, worker_id) if "gpu_admission_probe" in globals() else collect_local_gpu()
                    if gpus or not error:
                        task_budget_update(root, rows, gpus if not error else [])
                        live_budget_rows = [item for item in rows if not item["dead"] and item["phase"] in ("admitted", "starting", "running")]
                        budget_evidence = [(item, task_budget_read(item)) for item in rows]
                        for row in task_budget_order(queued, budget_evidence):
                            # Occupancy and cancellation need only live headers;
                            # load the full, hash-checked launch input for queued jobs.
                            job = task_read_job(row["tmuxPane"])
                            if any(job.get(key) != row.get(key) for key in ("commandId", "projectId", "workerId", "workflowId", "outputDir")):
                                raise ValueError("TASK_WINDOW_PAYLOAD_IDENTITY_MISMATCH")
                            row = {**job, **row}
                            options = row.get("options") or {}
                            policy_text = task_option(controller, "gpu_policy")
                            if not policy_text:
                                policy_text = json.dumps(task_gpu_quota_policy(options, gpus))
                                task_option(controller, "gpu_policy", policy_text)
                            current_policy = json.loads(policy_text)
                            options = {**options, **current_policy, "gpuCardOverrides": current_policy.get("gpuCardOverrides") or {},
                                       "gpuMaxConcurrentCards": current_policy.get("gpuMaxConcurrentCards")}
                            row = {**row, "options": options, "_budgetLive": live_budget_rows, "_budgetEvidence": budget_evidence}
                            if error and row.get("dispatchPolicy") != "manual":
                                continue
                            try:
                                chosen = task_admission_gpu(row, gpus, occupied)
                            except ValueError as exc:
                                task_option(row["tmuxWindowId"], "error", str(exc))
                                task_option(row["tmuxWindowId"], "phase", "rejected")
                                continue
                            if chosen is None:
                                continue
                            gpu = next(gpu for gpu in gpus if gpu_row_id(gpu) == chosen)
                            task_budget_reserve(row, gpu)
                            session = fixed_gpu_window_name(row.get("tmuxSessionPrefix") or options.get("tmuxSessionPrefix") or os.environ.get("SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX"), chosen)
                            if subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, timeout=3).returncode:
                                task_tmux(["new-session", "-d", "-s", session])
                            target = task_tmux(["display-message", "-p", "-t", session + ":", "#{session_id}"])
                            task_tmux(["move-window", "-s", row["tmuxWindowId"], "-t", target + ":"])
                            task_option(row["tmuxWindowId"], "gpu", chosen)
                            task_option(row["tmuxWindowId"], "phase", "admitted")
                            row = {**row, "gpuId": chosen, "phase": "admitted"}
                            live_budget_rows.append(row)
                            budget_evidence.append((row, task_budget_read(row)))
                            if options.get("gpuQuotaScheduling") == 1 or row.get("dispatchPolicy") != "manual":
                                occupied[chosen] = occupied.get(chosen, 0) + 1
                                gpu = next(gpu for gpu in gpus if gpu_row_id(gpu) == chosen)
                                memory = None if options.get("gpuQuotaScheduling") == 1 else task_memory_info(gpu, options)
                                if memory:
                                    gpu["_se_reserved_mb"] = gpu.get("_se_reserved_mb", 0) + memory["unit"]
        except Exception as exc:
            print("[queue] " + str(exc), file=sys.stderr, flush=True)
        wake.wait(timeout=1 if queued else 5)
        wake.clear()

def task_runner(root, worker_id):
    global NATIVE_TASK_RUNNER_CONTEXT
    pane = os.environ["TMUX_PANE"]
    deadline = time.monotonic() + 8
    while not task_option(pane, "job"):
        if time.monotonic() > deadline:
            raise RuntimeError("TASK_WINDOW_BINDING_MISSING")
        time.sleep(0.05)
    while task_option(pane, "phase") in ("", "binding"):
        if time.monotonic() > deadline:
            raise RuntimeError("TASK_WINDOW_BINDING_INCOMPLETE")
        time.sleep(0.05)
    job = task_read_job(pane)
    if job.get("root") != os.path.realpath(root) or job.get("workerId") != worker_id or job.get("pane") != pane:
        raise ValueError("TASK_WINDOW_OWNER_MISMATCH")
    while task_option(pane, "phase") != "admitted":
        if task_option(pane, "phase") == "rejected":
            raise ValueError(task_option(pane, "error"))
        time.sleep(0.2)
    job["gpuId"] = task_option(pane, "gpu")
    job["_lifecycleRunner"] = True
    if "cluster_scheduler_path" in globals():
        job["schedulerPath"] = cluster_scheduler_path(root)
    job["durablePlanQueue"] = False
    job["options"] = {**(job.get("options") or {}), "durablePlanQueue": False}
    task_option(pane, "phase", "starting")
    NATIVE_TASK_RUNNER_CONTEXT = (job["commandId"], pane, os.path.realpath(root))
    try:
        result = execute_worker_command(root, job, worker_id)
    except Exception as exc:
        # Only the bound task pane above can receive this startup failure.
        try:
            current = task_read_job(pane)
            if all(current.get(key) == job.get(key) for key in ("root", "workerId", "pane", "commandId")):
                task_option(pane, "error", str(exc)[-4000:])
                task_option(pane, "phase", "failed")
        except Exception:
            pass  # Preserve the original startup exception if the exact pane has gone.
        raise
    return 0 if result.get("status") == "completed" else int(result.get("exitCode") or 1)

def task_stop(root, command, worker_id):
    target = str(command.get("targetCommandId") or "")
    project = str(command.get("projectId") or "")
    if not target or not project:
        raise ValueError("TASK_STOP_IDENTITY_REQUIRED")
    if command.get("workerId") and command["workerId"] != worker_id:
        raise ValueError("TASK_OWNER_MISMATCH")
    rows = [row for row in task_inventory(root, execution_only=True) if row["commandId"] == target]
    legacy_tabs = [row for row in local_stop_tmux_inventory(root) if row["command"] == target] if "local_stop_tmux_inventory" in globals() else []
    if any(row["project"] != project for row in legacy_tabs):
        raise ValueError("TASK_OWNER_MISMATCH")
    if any(row["projectId"] != project or row["workerId"] != worker_id for row in rows):
        raise ValueError("TASK_OWNER_MISMATCH")
    cancel_confirmed = False
    try:
        receipt = task_queue_rpc(root, worker_id, "cancel", {"targetCommandId": target, "projectId": project}, ensure=True)
        cancel_confirmed = isinstance(receipt, dict) and receipt.get("cancelled") is True
    except Exception:
        # Exact tab closure remains possible even when its controller is unhealthy.
        if not rows and not legacy_tabs:
            raise
        for row in rows:
            current = [item for item in task_inventory(root, execution_only=True) if item["tmuxWindowId"] == row["tmuxWindowId"]]
            if any(item["commandId"] != target or item["projectId"] != project or item["workerId"] != worker_id for item in current):
                raise ValueError("TASK_OWNER_MISMATCH")
            if current:
                task_tmux(["kill-window", "-t", row["tmuxWindowId"]])
    for tab in legacy_tabs:
        # Reused/renamed windows are rechecked through stable markers immediately before closure.
        current = [row for row in local_stop_tmux_inventory(root) if row["window"] == tab["window"]]
        if any(row["command"] != target or row["project"] != project for row in current):
            raise ValueError("TASK_OWNER_MISMATCH")
        if current:
            task_tmux(["kill-window", "-t", tab["window"]])
    remaining = [row for row in task_inventory(root, execution_only=True) if row["commandId"] == target and row["projectId"] == project]
    if remaining:
        raise RuntimeError("TASK_STOP_NOT_CONFIRMED")
    if not cancel_confirmed:
        raise RuntimeError("TASK_CANCEL_UNCONFIRMED: exact windows closed; retain original stop intent")
    return {"status": "completed", "stoppedTasks": [{"commandId": target, "projectId": project, "workerId": worker_id,
        "workflowId": command.get("workflowId"), "stopBoundary": "local_command", "paneClosed": True, "cacheRetired": True,
        "closedWindowIds": sorted({row["tmuxWindowId"] for row in rows} | {row["window"] for row in legacy_tabs})}], "stoppedPids": []}
`;
