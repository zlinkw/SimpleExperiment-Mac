export const PLAN_CODE_SCOPE_OPERATIONS_PYTHON = String.raw`
def start_plan_scope_request(root, payload, worker_id):
    operation_id = str(payload.get("operationId") or "")
    if not re.fullmatch(r"[a-zA-Z0-9._:-]{1,128}", operation_id): raise ValueError("PLAN_SOURCE_OPERATION_ID_INVALID")
    frozen = copy.deepcopy({key: value for key, value in payload.items() if key != "operationId"})
    missing = [key for key in ("projectId", "planFile", "planRevision", "codeFingerprint") if not isinstance(frozen.get(key), str) or not frozen[key]]
    if missing: raise ValueError("PLAN_SOURCE_IDENTITY_REQUIRED: " + ", ".join(missing))
    request_digest = hashlib.sha256(json.dumps(frozen, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    key = (os.path.abspath(root), str(worker_id), operation_id)
    with CODE_SYNC_REQUEST_LOCK:
        existing = CODE_SYNC_REQUESTS.get(key)
        if existing:
            if existing.get("type") != "plan-code-scope" or existing["requestDigest"] != request_digest: raise ValueError("PLAN_SOURCE_OPERATION_INPUT_CONFLICT")
            return code_sync_request_state(root, worker_id, operation_id)
        # Share the existing bounded registration slots; never evict active work.
        for old_key in list(CODE_SYNC_REQUESTS):
            if len(CODE_SYNC_REQUESTS) < 128: break
            if CODE_SYNC_REQUESTS[old_key]["status"] in ("completed", "failed"): del CODE_SYNC_REQUESTS[old_key]
        if len(CODE_SYNC_REQUESTS) >= 128: raise ValueError("PLAN_SOURCE_OPERATION_CAPACITY: query existing operations")
        for prior_key, prior in list(CODE_SYNC_REQUESTS.items()):
            if prior_key[:2] == key[:2] and prior.get("type") == "plan-code-scope" and prior.get("requestDigest") == request_digest and prior["status"] in ("queued", "running"):
                CODE_SYNC_REQUESTS[key] = prior
                return code_sync_request_state(root, worker_id, operation_id)
        row = {"operationId": operation_id, "workerId": str(worker_id), "type": "plan-code-scope", "readOnly": True, "remoteExecution": "not_started",
               **{field: frozen[field] for field in ("projectId", "planFile", "planRevision", "codeFingerprint")},
               "sourceDigest": (frozen.get("executionSource") or {}).get("digest", ""), "status": "queued", "progressSequence": 0,
               "progress": {"phase": "queued"}, "timings": {}, "requestDigest": request_digest, "createdAt": now_iso()}
        CODE_SYNC_REQUESTS[key] = row
    def progress(event):
        with CODE_SYNC_REQUEST_LOCK:
            if event["phase"] != row["progress"].get("phase"): row["progress"] = {"phase": event["phase"]}
            row["progress"].update({name: value for name, value in event.items() if name not in ("elapsedMs",)})
            row["progressSequence"] += 1
            if "elapsedMs" in event: row["timings"][event["phase"]] = row["timings"].get(event["phase"], 0) + event["elapsedMs"]
    def run():
        started = time.monotonic()
        with CODE_SYNC_REQUEST_LOCK: row.update(status="running", startedAt=now_iso())
        try:
            result = inspect_plan_code_scope(root, frozen, progress)
            result = plan_scope_timed(progress, "resultPreparationMs", lambda: copy.deepcopy(result))
            with CODE_SYNC_REQUEST_LOCK: row.update(status="completed", result=result)
        except Exception as error:
            with CODE_SYNC_REQUEST_LOCK: row.update(status="failed", error=str(error), traceback=traceback.format_exc()[-8000:])
        finally:
            with CODE_SYNC_REQUEST_LOCK: row.update(totalElapsedMs=(time.monotonic()-started)*1000, finishedAt=now_iso())
    threading.Thread(target=run, name="plan-source-verification", daemon=True).start()
    return code_sync_request_state(root, worker_id, operation_id)
`;
