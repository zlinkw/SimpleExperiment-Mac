/** Embedded in Agent and Scheduler. Only original logs and bounded process memory are used. */
export const RUNTIME_LOG_DIAGNOSTICS_PYTHON = String.raw`
def task_log_new(command_id, log_path, legacy=False):
    return {"commandId": command_id, "logPath": log_path, "active": bool(legacy), "begin": False,
            "end": False, "phase": "unknown", "offset": 0, "cursor": 0, "line": 1, "buffer": b"",
            "events": [], "count": 0, "types": {}, "phases": {}, "block": None}

def task_log_close(state):
    block = state.get("block")
    if not block:
        return
    state["count"] += 1
    for field, key in (("types", "type"), ("phases", "phase")):
        value = block[key]
        state[field][value] = state[field].get(value, 0) + 1
    if len(state["events"]) < 100:
        state["events"].append(block)
    state["block"] = None

def task_log_line(state, raw):
    start, line = state["cursor"], state["line"]
    state["cursor"] += len(raw)
    state["line"] += 1
    text = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", raw.decode("utf-8", errors="replace")).rstrip("\r\n")
    marker = "[simple-experiment-runtime-log] "
    if text.startswith(marker):
        try:
            item = json.loads(text[len(marker):])
            task_log_close(state)
            if item.get("commandId") != state["commandId"]:
                state["active"] = False
                return
            if item.get("event") == "begin":
                state["active"] = True
                state["begin"] = True
            state["phase"] = item.get("phase") or state["phase"]
            if item.get("event") == "end":
                state["end"] = True
            return
        except (ValueError, TypeError):
            pass
    if not state["active"]:
        return
    if text.startswith("[simple-experiment-runtime]"):
        task_log_close(state)
        if re.search(r"(?:^|[ /])train\.py(?:\s|$)", text): state["phase"] = "train"
        elif re.search(r"(?:^|[ /])test\.py(?:\s|$)", text): state["phase"] = "test"
        return
    ignored = re.match(r"^Exception ignored (?:on calling ctypes callback function|in(?:\s*|\s+[^\r\n]*):)", text)
    trace = re.match(r"^(?:\s*[+|]\s*)?Traceback \(most recent call last\):", text)
    thread = re.match(r"^Exception in thread ", text)
    terminal = re.match(r"^(?:\s*[+|]\s*)?([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit)|Exception|BaseException|ExceptionGroup|BaseExceptionGroup)(?::\s*(.*)|$)", text)
    block = state.get("block")
    if block and (ignored or thread or trace and block["complete"]):
        task_log_close(state)
        block = None
    if block and block["complete"] and text and not text.startswith((" ", "\t", "|", "+")) and not terminal:
        task_log_close(state)
        block = None
    if not block and (ignored or trace or thread or terminal):
        key = state["commandId"] + ":" + state["logPath"] + ":" + str(start)
        block = {"id": hashlib.sha256(key.encode("utf-8")).hexdigest(), "type": "ctypes_callback" if ignored and "ctypes" in text else "ignored_exception" if ignored else "unhandled_exception",
                 "phase": state["phase"], "summary": "", "logPath": state["logPath"], "byteStart": start,
                 "byteEnd": state["cursor"], "lineStart": line, "lineEnd": line, "complete": False}
        state["block"] = block
    if block:
        block["byteEnd"], block["lineEnd"] = state["cursor"], line
        block["summary"] = (block["summary"] + ("\n" if block["summary"] else "") + text)[:4000]
        if terminal:
            block["type"] = terminal.group(1)
            block["complete"] = True

def task_log_feed(state, data, final=False):
    buffer = state["buffer"] + data
    state["offset"] += len(data)
    start = 0
    for found in re.finditer(b"\r\n|\n|\r", buffer):
        end = found.end()
        if end == len(buffer) and buffer.endswith(b"\r") and not final: break
        task_log_line(state, buffer[start:end])
        start = end
    state["buffer"] = buffer[start:]
    if final and state["buffer"]:
        task_log_line(state, state["buffer"])
        state["buffer"] = b""
    elif len(state["buffer"]) > 262144:
        task_log_line(state, state["buffer"][:262144])
        state["buffer"] = state["buffer"][262144:]
    return state

def task_log_report(state, terminal=False, complete=False, reason=""):
    events = list(state["events"])
    active = state.get("block")
    types, phases = dict(state["types"]), dict(state["phases"])
    count = state["count"] + bool(active)
    if active:
        events.append(active)
        types[active["type"]] = types.get(active["type"], 0) + 1
        phases[active["phase"]] = phases.get(active["phase"], 0) + 1
    checked = bool(complete and terminal and state["logPath"] and state["active"] and (state["end"] or state.get("legacy")))
    return {"schemaVersion": 1, "commandId": state["commandId"], "runId": state["commandId"],
            "state": "anomalous" if count else "clear" if checked else "scanning" if state["active"] else "unverified",
            "count": count, "types": types, "phases": phases, "scanComplete": checked,
            "logPath": state["logPath"], "bytesRead": state["offset"], "exceptions": events[:100],
            "truncatedExceptions": max(0, count - len(events[:100])),
            "reason": reason or ("日志尚未完整核实" if not checked else "")}

def task_log_marker(command_id, event, phase="unknown"):
    print("[simple-experiment-runtime-log] " + json.dumps({"commandId": command_id, "event": event, "phase": phase}, ensure_ascii=False), flush=True)

def task_log_diagnostics(root, job, row=None, terminal=False, binding=None):
    import time as log_time
    command = str(job.get("commandId") or "")
    unknown = {"schemaVersion": 1, "commandId": command, "runId": command, "state": "unverified", "count": 0, "scanComplete": False}
    try:
        if not command: return {**unknown, "reason": "缺少本次任务的 commandId"}
        binding = binding or {}
        log_path = (row or {}).get("logPath") or binding.get("logPath") or ""
        expected = worker_task_console_log(command) if "worker_task_console_log" in globals() else ""
        if not log_path: log_path = expected
        if log_path and os.path.isabs(log_path): log_path = os.path.relpath(log_path, root).replace("\\", "/")
        if not log_path: return {**unknown, "reason": "未取得本次任务的原始日志"}
        full = task_safe_path(root, log_path)
        before = os.stat(full)
        if not os.path.isfile(full): raise ValueError("原始日志不是普通文件")
        authorizations = globals().setdefault("TASK_LOG_ANALYSIS_AUTHORIZATIONS", {})
        authorization_key = (os.path.realpath(root), command)
        if job.get("runtimeLogAnalysisId"):
            authorizations[authorization_key] = str(job["runtimeLogAnalysisId"])
        analysis = authorizations.get(authorization_key, "")
        expected_full = (expected if os.path.isabs(expected) else os.path.join(root, expected)) if expected else ""
        # A terminal task's deterministic commandId log is current evidence, not
        # a historical status record. Ordinary active queries must scan it too.
        automatic_legacy = bool(terminal and expected_full and os.path.realpath(expected_full) == os.path.realpath(full))
        legacy = bool(analysis) or automatic_legacy
        with open(full, "rb") as stream:
            prefix = stream.read(4096)
        native = b"[simple-experiment-runtime-log] " in prefix
        if not native and not legacy: return {**unknown, "logPath": log_path, "reason": "日志尚无本次执行标记或精确终态绑定"}
        if legacy and expected:
            target = expected if os.path.isabs(expected) else os.path.join(root, expected)
            if os.path.realpath(target) != os.path.realpath(full): raise ValueError("历史日志与原 commandId 路径不符")
        cache = globals().setdefault("TASK_LOG_DIAGNOSTIC_CACHE", {})
        lock = globals().setdefault("TASK_LOG_DIAGNOSTIC_LOCK", threading.RLock())
        key = (os.path.realpath(root), command, os.path.realpath(full))
        signature = (before.st_dev, before.st_ino, hashlib.sha256(prefix).hexdigest())
        with lock:
            entry = cache.get(key)
            if entry is None:
                entry = {"lock": threading.RLock(), "users": 0}
                cache[key] = entry
            entry["users"] += 1
        try:
            # Only this exact run/log is serialized. A slow NFS read must not
            # hold the cache mutex while unrelated jobs verify their logs.
            if not entry["lock"].acquire(blocking=False):
                return {**unknown, "logPath": log_path, "reason": "该任务日志正在读取，请稍后刷新"}
            try:
                if entry.get("signature") != signature or before.st_size < entry["state"]["offset"] or entry["analysis"] != analysis or (entry.get("mtimeNs") is not None and (terminal or entry.get("complete")) and entry["mtimeNs"] != before.st_mtime_ns):
                    state = task_log_new(command, log_path, legacy and not native)
                    state["legacy"] = legacy and not native
                    entry.update(state=state, signature=signature, analysis=analysis)
                state = entry["state"]
                # Scan locally in bounded slices, returning only a summary.
                # A large finished log must not need dozens of metadata rounds.
                deadline, scanned = log_time.monotonic() + 1.0, 0
                with open(full, "rb") as stream:
                    stream.seek(state["offset"])
                    while scanned < 8 * 1024 * 1024:
                        data = stream.read(256 * 1024)
                        task_log_feed(state, data)
                        scanned += len(data)
                        if len(data) < 256 * 1024 or log_time.monotonic() >= deadline:
                            break
                after = os.stat(full)
                complete = after.st_size == state["offset"] and before.st_mtime_ns == after.st_mtime_ns
                task_log_feed(state, b"", terminal and complete)
                result = task_log_report(state, terminal, complete)
                result["totalBytes"] = after.st_size
                entry["mtimeNs"], entry["complete"] = after.st_mtime_ns, bool(terminal and complete)
                return result
            finally:
                entry["lock"].release()
        finally:
            with lock:
                entry["users"] -= 1
                for cached_key in list(cache):
                    if len(cache) <= 256: break
                    if not cache[cached_key]["users"]: cache.pop(cached_key)
    except Exception as exc:
        return {**unknown, "reason": str(exc)}
`;
