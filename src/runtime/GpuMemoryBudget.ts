/** Project-independent observation; all durable facts remain native task-window options. */
export const GPU_MEMORY_BUDGET_PYTHON = String.raw`
def task_budget_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0

def task_budget_group(row):
    return json.dumps([row.get("projectId", ""), row.get("workflowId", ""), row.get("planRevision", ""),
        row.get("codeFingerprint", ""), row.get("case", ""), row.get("executionMode") or row.get("mode") or ""], ensure_ascii=False, separators=(",", ":"))

def task_budget_hardware(worker, gpu):
    total = next((gpu[k] for k in ("memoryTotalMb", "memory_total_mb", "memoryTotal", "memory_total") if gpu.get(k) is not None), 0)
    return json.dumps([worker, str(gpu.get("name") or gpu.get("gpuName") or gpu.get("gpu_name") or ""), total], ensure_ascii=False, separators=(",", ":"))

def task_budget_size(peak):
    return math.ceil(peak * 1.2 + 1024)

def task_budget_read(row):
    try:
        value = row.get("_gpuBudget") if "_gpuBudget" in row else json.loads(task_option(row["tmuxPane"], "gpu_budget") or "{}")
        if value.get("version") == 1 and value.get("commandId") == row["commandId"] and value.get("projectId") == row["projectId"] and value.get("group") == task_budget_group(row):
            return value
    except (ValueError, TypeError):
        pass
    return {}

def task_budget_current(row, gpu):
    # Device-side attribution already published by the existing collector. No PID lifecycle control.
    current, seen = 0, set()
    for process in gpu.get("processes") or []:
        if process.get("pluginManaged") is not True or process.get("jobCommandId") != row["commandId"] or process.get("jobProjectId") != row["projectId"]:
            continue
        pid, used = process.get("pid"), process.get("usedMemoryMb")
        if pid not in seen and task_budget_number(used):
            seen.add(pid)
            current += used
    return current

def task_budget_update(root, rows, gpus, now=None):
    now = time.monotonic() if now is None else now
    active = [row for row in rows if not row.get("dead") and row.get("phase") in ("admitted", "starting", "running")]
    for row in rows:
        evidence = task_budget_read(row)
        if not evidence or evidence.get("finished"):
            continue
        if row.get("dead") and not evidence.get("finished"):
            if evidence.get("started") is not None and row.get("exitCode") == 0:
                evidence["durationSeconds"] = max(0.001, now - evidence["started"])
                evidence["ready"] = evidence.get("peakMb", 0) > 0 and not evidence.get("oom")
            evidence["finished"] = True
        elif not row.get("dead") and row.get("phase") == "running":
            gpu = next((gpu for gpu in gpus if gpu_row_id(gpu) == str(row.get("gpuId"))), None)
            if gpu is None:
                if evidence.get("lastSample") is None or now - evidence["lastSample"] > 30:
                    evidence["sampleStart"] = None
            else:
                used = next((gpu[k] for k in ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used") if gpu.get(k) is not None), None)
                current = task_budget_current(row, gpu)
                exclusive = sum(str(item.get("gpuId")) == str(row.get("gpuId")) for item in active) == 1
                # The exclusive probe includes contexts, workspaces and external allocations, conservatively.
                measured = max(current, used - evidence.get("usedBeforeMb", 0)) if evidence.get("probe") and exclusive and task_budget_number(used) and current > 0 else used if evidence.get("probe") and exclusive and task_budget_number(used) else current
                evidence["concurrency"] = max(evidence.get("concurrency", 1), sum(str(item.get("gpuId")) == str(row.get("gpuId")) for item in active))
                allocated = measured > 0 and (current > 0 or exclusive and task_budget_number(used) and used > evidence.get("usedBeforeMb", 0))
                if task_budget_number(used) and (allocated or evidence.get("started") is not None):
                    evidence.setdefault("started", now)
                    if evidence.get("lastSample") is None or now - evidence["lastSample"] > 30 or evidence.get("sampleStart") is None:
                        evidence["sampleStart"] = now
                    evidence["lastSample"] = now
                    evidence["peakMb"] = max(evidence.get("peakMb", 0), measured)
                    evidence["samples"] = evidence.get("samples", 0) + 1
                    if evidence["samples"] >= 2 and now - evidence["sampleStart"] >= 600:
                        evidence["ready"] = not evidence.get("oom", False)
                else:
                    evidence["sampleStart"] = None
        # Read only the exact native task pane; never guess epoch progress from project logs.
        if not evidence.get("finished") or row.get("dead"):
            tail = task_tmux(["capture-pane", "-p", "-t", row["tmuxPane"], "-S", "-100"])
            if re.search(r"(?i)(?:CUDA[^\n]*out of memory|CUDA_ERROR_OUT_OF_MEMORY|CUBLAS_STATUS_ALLOC_FAILED|CUDNN_STATUS_ALLOC_FAILED|torch\.OutOfMemoryError)", tail):
                evidence["oom"] = True
                evidence["ready"] = False
        if evidence.get("ready"):
            evidence["budgetMb"] = task_budget_size(evidence["peakMb"])
        task_option(row["tmuxPane"], "gpu_budget", json.dumps(evidence, ensure_ascii=False, separators=(",", ":")))
        row["_gpuBudget"] = evidence

def task_budget_public(row):
    value = task_budget_read(row)
    return {key: value[key] for key in ("version", "commandId", "projectId", "group", "hardware", "peakMb", "ready", "oom", "durationSeconds", "concurrency") if key in value} if value else None

def task_budget_admit(row, gpu, live, evidence):
    options = row.get("options") or {}
    if options.get("gpuMemoryBudgetScheduling") != 1:
        return True
    hardware, group = task_budget_hardware(row["workerId"], gpu), task_budget_group(row)
    request = options.get("gpuMemoryReservation") or {}
    if not request:
        local = [value for item, value in evidence if value.get("group") == group and value.get("hardware") == hardware]
        known = [value for value in local if value.get("ready") and value.get("peakMb", 0) > 0]
        total = next((gpu[k] for k in ("memoryTotalMb", "memory_total_mb", "memoryTotal", "memory_total") if gpu.get(k) is not None), 0)
        used = next((gpu[k] for k in ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used") if gpu.get(k) is not None), 0)
        request = {"version": 1, "group": group, "hardware": hardware, "probe": not bool(known),
                   "budgetMb": task_budget_size(max(value["peakMb"] for value in known)) if known else max(0, total - used)}
        if known and request["budgetMb"] > total - used and max(value["peakMb"] for value in known) + 1024 <= total - used:
            request.update(budgetMb=total - used, exclusive=True)
    if request.get("version") != 1 or request.get("group") != group or request.get("hardware") != hardware or not task_budget_number(request.get("budgetMb")) or request["budgetMb"] <= 0 or type(request.get("probe")) is not bool:
        return False
    same_card = [item for item in live if str(item.get("gpuId")) == gpu_row_id(gpu)]
    if request.get("exclusive") and same_card:
        return False
    siblings = [value for item, value in evidence if task_budget_group(item) == group and value.get("hardware") == hardware]
    if any(value.get("oom") for value in siblings):
        return False
    # The authenticated local scheduler carries the current PLAN's durable estimate.
    # Group/hardware above bind it to this exact configuration and physical Worker.
    estimate = request.get("estimate")
    if estimate is not None and (not isinstance(estimate, dict) or estimate.get("version") != 1 or estimate.get("ready") is not True or not task_budget_number(estimate.get("peakMb")) or estimate["peakMb"] <= 0):
        return False
    if request["probe"]:
        if same_card or any(not item.get("dead") and value.get("probe") and not value.get("ready") for item, value in evidence if value.get("group") == group and value.get("hardware") == hardware):
            return False
    else:
        known = [value for value in siblings if value.get("ready") and value.get("peakMb", 0) > 0]
        if estimate is not None:
            known.append(estimate)
        if not known and not same_card:
            # The source tab may have been explicitly closed. Reobserve this new job, never replay the old one.
            request = {**request, "probe": True, "budgetMb": next((gpu[k] for k in ("memoryTotalMb", "memory_total_mb", "memoryTotal", "memory_total") if gpu.get(k) is not None), 0)}
            if any(not item.get("dead") and value.get("probe") and not value.get("ready") for item, value in evidence if value.get("group") == group and value.get("hardware") == hardware):
                return False
        elif not known or request["budgetMb"] < (max(value.get("peakMb", 0) for value in siblings + known) + 1024 if request.get("exclusive") else task_budget_size(max(value.get("peakMb", 0) for value in siblings + known))):
            return False
    used = next((gpu[k] for k in ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used") if gpu.get(k) is not None), None)
    total = next((gpu[k] for k in ("memoryTotalMb", "memory_total_mb", "memoryTotal", "memory_total") if gpu.get(k) is not None), None)
    if not task_budget_number(total) or not task_budget_number(used) or total <= 0 or used > total:
        return False
    deficit, uncredited_used = 0, used
    for item in same_card:
        value = next((value for candidate, value in evidence if candidate["commandId"] == item["commandId"]), {})
        if not value or value.get("exclusive") or not value.get("ready") or value.get("oom"):
            return False
        group_peak = max([value.get("peakMb", 0)] + [sample.get("peakMb", 0) for candidate, sample in evidence if sample.get("group") == value.get("group") and sample.get("hardware") == hardware])
        budget = max(value.get("budgetMb", 0), task_budget_size(group_peak))
        credit = min(task_budget_current(item, gpu), uncredited_used)
        uncredited_used -= credit
        deficit += max(0, budget - credit)
    if not request["probe"] and total - used - deficit < request["budgetMb"]:
        return False
    options["gpuMemoryReservation"] = request
    return True

def task_budget_reserve(row, gpu):
    request = (row.get("options") or {}).get("gpuMemoryReservation")
    if (row.get("options") or {}).get("gpuMemoryBudgetScheduling") != 1:
        return
    value = {**request, "commandId": row["commandId"], "projectId": row["projectId"], "peakMb": (request.get("estimate") or {}).get("peakMb", 0),
             "ready": not request["probe"], "oom": False, "concurrency": 1, "samples": 0}
    value["usedBeforeMb"] = next((gpu[k] for k in ("memoryUsedMb", "memory_used_mb", "memoryUsed", "memory_used") if gpu.get(k) is not None), 0)
    task_option(row["tmuxPane"], "gpu_budget", json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    row["_gpuBudget"] = value

def task_budget_order(queued, evidence):
    if not any(row.get("gpuMemoryBudgetScheduling") == 1 for row in queued):
        return queued
    counts = {}
    durations = {}
    for row in queued:
        group = task_budget_group(row)
        counts[group] = counts.get(group, 0) + 1
    for row, value in evidence:
        if value.get("finished") and value.get("durationSeconds"):
            group = task_budget_group(row)
            durations[group] = max(durations.get(group, 1), value["durationSeconds"])
    return sorted(queued, key=lambda row: (row.get("dispatchPolicy") != "manual", -counts[task_budget_group(row)] * durations.get(task_budget_group(row), 1)))
`;
