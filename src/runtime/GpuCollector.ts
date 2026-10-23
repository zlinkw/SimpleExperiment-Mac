/**
 * One structured GPU sampling loop per Worker, carried by its own dedicated tmux
 * session and shared by every consumer (Agent HTTP/telemetry, durable-queue drain,
 * Scheduler admission, host display via the inventory carry). It is deliberately
 * independent of the Agent and VS Code lifecycles: dispatched queues keep running
 * and the sampling sequence keeps advancing when the Agent restarts.
 *
 * Identity: the canonical single-source identity is the Worker id inside the
 * calling UID's tmux server ("se-gpu-collector-<sha(workerId)>"), derived only
 * from the Worker id — never from per-project installDir/stateDir/prefix, so two
 * projects can never each start their own collector. The frame/registration
 * directory is the deployment-injected SIMPLE_EXPERIMENT_WORKER_STATE_DIR or,
 * when unset, the managed per-USER machine anchor "~/.simple-cluster/worker-state"
 * (parent ruling A: zero-config, cross-project identical, never a per-project
 * root and never a second sampler). The Agent launch template and the collector
 * command both carry the SAME resolved authoritative value explicitly.
 *
 * Causality: admission accepts a frame only when its sampling START (the
 * collector's own monotonic clock) is at or after this request's boundary, the
 * frame's epoch equals the registration file's published generation, and the
 * frame is within the monotonic freshness bound. A sample that started before
 * the request and finished after it is NOT accepted; an old-generation frame is
 * never accepted no matter how high its seq; a lock-holding reserve rechecks the
 * exact accepted evidence — bound to Worker + root + command + sample identity +
 * GPU fingerprint, with NO defaults — instead of reusing any cache.
 *
 * Capability (parent ruling A/C, single decision shared by every consumer):
 * This collector-capable runtime never samples directly in a consumer. Legacy
 * runtimes without these functions retain their explicit unoptimized path.
 * Missing files mean startup or lost state. A frame present without a
 * valid registration is "unregistered" (unknown/needs update) — never consumed
 * and never a legacy door (this collector is unreleased, so no frame-only mode
 * compatibility exists). Any unreadable/invalid/foreign state fails closed: jobs
 * stay queued, no second sampler, no fake "ready". Modes are visible to API/
 * inventory consumers via frameSource/collectorMode, not only in the journal.
 *
 * No new system daemon, socket, NVML binding or screen parsing; only the exact
 * collector window is ever managed (never a session/server kill or a scan).
 */
export const GPU_COLLECTOR_PYTHON = String.raw`
GPU_COLLECTOR_FRESH_MS = max(2000.0, float(os.environ.get("SIMPLE_GPU_COLLECTOR_FRESH_MS") or 5000))
GPU_ADMISSION_WAIT_SECONDS = max(0.0, float(os.environ.get("SIMPLE_GPU_ADMISSION_WAIT_SECONDS") or 2.0))
GPU_COLLECTOR_SOURCE = "worker_gpu_collector"
GPU_WORKER_STATE_ENV = "SIMPLE_EXPERIMENT_WORKER_STATE_DIR"
GPU_COLLECTOR_MAX_STATE_BYTES = 65536
GPU_COLLECTOR_RESPAWN_LOCK_STALE_S = 30.0
_GPU_SOURCE_MODE_LAST = {}
_GPU_FRAME_WATERMARKS = {}

def gpu_collector_worker_ns(worker_id):
    return hashlib.sha256(str(worker_id or "worker").encode("utf-8")).hexdigest()[:16]

def gpu_collector_state_root(root=""):
    # Parent ruling A: the Worker machine-state root is EITHER the deployment-
    # injected authoritative value OR the managed per-USER anchor. The root
    # parameter is kept for call-site compatibility and DELIBERATELY IGNORED:
    # any per-project derivation would fork one collector source per project,
    # which is exactly what the single-source contract forbids. The anchor is
    # unrelated to the program root and to research code, stable for the UID's
    # tmux scope, and requires no configuration to work.
    configured = str(os.environ.get(GPU_WORKER_STATE_ENV) or "").strip()
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    return os.path.abspath(os.path.join(os.path.expanduser("~"), ".simple-cluster", "worker-state"))

def gpu_collector_frame_path(worker_id, root=""):
    base = gpu_collector_state_root(root)
    if not base:
        return ""
    return os.path.join(base, gpu_collector_worker_ns(worker_id), "gpu_frame.json")

def gpu_collector_register_path(worker_id, root=""):
    frame_path = gpu_collector_frame_path(worker_id, root)
    if not frame_path:
        return ""
    return os.path.join(os.path.dirname(frame_path), "gpu_collector.register")

def gpu_collector_session(worker_id, root=""):
    # Canonical single-source identity: ONLY the Worker id (same UID + tmux server
    # context). Never the project-derived frame path or the per-project session
    # prefix, so different projects cannot each open a collector source.
    key = hashlib.sha256((str(worker_id or "worker")).encode("utf-8")).hexdigest()[:16]
    return "se-gpu-collector-" + key

def gpu_collector_command(worker_id, root=""):
    argv = [sys.executable, "-B", os.path.abspath(__file__), "gpu-collector",
            "--worker-id", str(worker_id or "worker"), "--project-dir", os.path.realpath(root or os.getcwd())]
    if AGENT_STATE_DIR or os.environ.get("SIMPLE_EXPERIMENT_AGENT_STATE_DIR", ""):
        argv.extend(["--state-dir", AGENT_STATE_DIR or os.environ.get("SIMPLE_EXPERIMENT_AGENT_STATE_DIR", "")])
    # tmux children inherit the server environment, not the Agent's. Carry the
    # RESOLVED authoritative Worker state root (not the raw env var), so even an
    # unset environment makes the collector write exactly the frame path every
    # consumer reads — an identity split would stall admission forever.
    carry = ["SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX=" + task_session_prefix(),
             GPU_WORKER_STATE_ENV + "=" + gpu_collector_state_root(root)]
    return "exec env " + shlex.join([*carry, *argv])

def gpu_collector_tmux(args, timeout=5, keep_trailing=False):
    proc = subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError("GPU_COLLECTOR_TMUX_FAILED: " + ((proc.stderr or proc.stdout or "").strip()[-400:]))
    # keep_trailing preserves a TRAILING EMPTY field ("...\t" when @option is
    # unset): stripping it would collapse 4 real fields into 3 and turn an
    # honestly-unbound window into an unparsable one.
    return (proc.stdout or "").rstrip("\r\n") if keep_trailing else (proc.stdout or "").strip()

def gpu_collector_binding(worker_id, frame_path, epoch):
    # Only the RUNNING collector publishes a binding (gpu_collector_main); ensure
    # never invents an epoch, so no second generation can exist on the window.
    return {"frameSource": GPU_COLLECTOR_SOURCE, "workerId": str(worker_id or "worker"), "framePath": frame_path,
            "epoch": str(epoch or ""), "runningVersion": RUNTIME_VERSION,
            "uid": os.getuid() if hasattr(os, "getuid") else -1}

def _gpu_number_finite(value):
    # bool is a subclass of int; a real sampling clock value must be a finite
    # number, never True/NaN/Infinity smuggled through a corrupt file.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return float(value) == float(value) and abs(float(value)) != float("inf")

def _gpu_uid_sane(value):
    # Published uid is an int uid (>= -1: -1 documents "platform without getuid").
    # Missing, bool, string or below-range values fail validation (parent B).
    return isinstance(value, int) and not isinstance(value, bool) and value >= -1

def gpu_collector_publish_generation(worker_id, root, epoch):
    # The collector publishes its own generation: the registration file is the
    # authority admission binds to, the window annotation is the human/tmux-visible
    # mirror of the same object.
    frame_path = gpu_collector_frame_path(worker_id, root)
    binding = gpu_collector_binding(worker_id, frame_path, epoch)
    register_path = gpu_collector_register_path(worker_id, root)
    if register_path:
        registration = dict(binding)
        registration["genStartedMonotonicMs"] = int(time.monotonic() * 1000)
        atomic_write(register_path, registration)
    try:
        gpu_collector_tmux(["set-option", "-w", "-t", os.environ.get("TMUX_PANE") or "=" + gpu_collector_session(worker_id, root) + ":=collector",
                            "@se_gpu_collector", json.dumps(binding, ensure_ascii=False)])
    except Exception as exc:
        print("[gpu-collector] binding annotation failed: " + str(exc), file=sys.stderr, flush=True)
    return binding

def _gpu_stat_state(path):
    # os.path.isfile SILENTLY swallows PermissionError/ENOTDIR/ELOOP and returns
    # False (parent C): absence must be proven by a real ENOENT from an explicit
    # stat, and every other OSError or non-regular file type is unknown.
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unreadable"
    return "present" if stat.S_ISREG(st.st_mode) else "unreadable"

def _gpu_read_bounded_json(path):
    # Bounded read: a huge or pathological state file can never pin the fast
    # inventory loop. One read past the cap proves "oversized" without ingesting.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("not_regular")
        blob = handle.read(GPU_COLLECTOR_MAX_STATE_BYTES + 1)
    if len(blob) > GPU_COLLECTOR_MAX_STATE_BYTES:
        raise ValueError("oversized")
    return json.loads(blob.decode("utf-8"))

def gpu_collector_read_registration(worker_id, root=""):
    """Registration validity is the capability authority (shared by probe, API,
    inventory and reserve). Absence is proven only by ENOENT; unreadable, invalid
    or foreign states are never "absent" and can never authorize a second sampler.
    Every identity field (source/worker/framePath/epoch/uid/genStart) is verified,
    not just a subset (parent B)."""
    worker_id = str(worker_id or "worker").strip() or "worker"
    register_path = gpu_collector_register_path(worker_id, root)
    if not register_path:
        return {"mode": "unconfigured", "registration": None}
    state = _gpu_stat_state(register_path)
    if state == "absent":
        return {"mode": "absent", "registration": None}
    if state != "present":
        return {"mode": "unreadable", "registration": None}
    try:
        registration = _gpu_read_bounded_json(register_path)
    except FileNotFoundError:
        return {"mode": "absent", "registration": None}
    except (OSError, ValueError):
        return {"mode": "unreadable", "registration": None}
    if not isinstance(registration, dict) or registration.get("frameSource") != GPU_COLLECTOR_SOURCE \
            or str(registration.get("workerId") or "") != worker_id \
            or not str(registration.get("epoch") or "") \
            or not str(registration.get("framePath") or "").startswith(("/", "\\")) \
            or not _gpu_uid_sane(registration.get("uid")) \
            or not _gpu_number_finite(registration.get("genStartedMonotonicMs")) \
            or registration["genStartedMonotonicMs"] < 0:
        return {"mode": "invalid", "registration": None}
    # Registration is the reader's authority, so apply the same complete
    # identity check used by ensure; valid field types alone prove no ownership.
    if _gpu_binding_verdict(registration, worker_id, gpu_collector_frame_path(worker_id, root)) != "own":
        return {"mode": "foreign", "registration": None}
    return {"mode": "registered", "registration": registration}

def _gpu_binding_verdict(binding, worker_id, frame_path):
    # One verdict for EVERY ensure branch (has-session, respawn, startup race):
    # "own" only after full identity verification; empty binding is reported
    # separately so callers can choose starting/unknown — never a mutation.
    if not isinstance(binding, dict) or not binding:
        return "empty"
    if str(binding.get("frameSource") or "") != GPU_COLLECTOR_SOURCE:
        return "mismatch"
    if str(binding.get("workerId") or "") != worker_id:
        return "mismatch"
    if str(binding.get("framePath") or "") != frame_path:
        return "mismatch"
    if not str(binding.get("epoch") or ""):
        return "mismatch"
    if not _gpu_uid_sane(binding.get("uid")):
        # Missing/forged UID: cannot prove the publisher's scope — treat as
        # foreign identity, never takeover (parent B).
        return "mismatch"
    our_uid = os.getuid() if hasattr(os, "getuid") else -1
    if int(binding["uid"]) != our_uid:
        return "foreign_uid"
    return "own"

def gpu_collector_ensure(worker_id, root=""):
    """Idempotent startup on the exact deterministic session. Only the running
    collector publishes the binding epoch. EVERY branch verifies exact identity
    before ANY mutation: a dead pane is respawned only when its binding fully
    validates as ours, inside an exclusive respawn transaction that re-verifies
    after taking the lock, so two concurrent ensures can never respawn-k each
    other's just-started collector. An empty binding (foreign window, collector
    that died before publishing) is reported starting/unknown and never mutated;
    a losing startup race re-verifies the winner's FULL identity."""
    worker_id = str(worker_id or "worker").strip() or "worker"
    frame_path = gpu_collector_frame_path(worker_id, root)
    session = gpu_collector_session(worker_id, root)
    if not frame_path:
        return {"status": "unconfigured", "workerId": worker_id}
    def _inspect():
        fields = gpu_collector_tmux(["display-message", "-p", "-t", "=" + session + ":=collector",
            "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@se_gpu_collector}"], keep_trailing=True).split("\t")
        if len(fields) != 4 or fields[2] not in ("0", "1") or not re.fullmatch(r"@\d+", fields[0] or "") or not re.fullmatch(r"%\d+", fields[1] or ""):
            return None
        binding = {}
        try:
            binding = json.loads(fields[3]) if fields[3] else {}
        except ValueError:
            binding = {}
        return {"windowId": fields[0], "paneId": fields[1], "dead": fields[2] == "1", "binding": binding}
    def _verdict_report(verdict, observed):
        status = {"mismatch": "mismatch", "foreign_uid": "foreign_uid"}.get(verdict, "unknown")
        return {"status": status, "workerId": worker_id, "session": session, "windowId": observed["windowId"]}
    def _respawn_transaction(observed):
        # Single-writer transaction: persistent no-follow flock inode, then
        # RE-VERIFY inside the lock. A concurrent ensure either waits it out and
        # sees a live pane ("starting") or reports the other's verdict — never a
        # second respawn-k over the just-started collector.
        lock_path = gpu_collector_register_path(worker_id, root) + ".respawn.lock"
        try:
            os.makedirs(os.path.dirname(lock_path), exist_ok=True)
        except OSError:
            return {"status": "unverified", "workerId": worker_id, "session": session, "reason": "respawn_lock_uncreatable"}
        import fcntl
        fd = -1
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if fd >= 0:
                os.close(fd)
            return {"status": "unknown", "workerId": worker_id, "session": session, "reason": "respawn_in_progress"}
        try:
            os.write(fd, ("%d %d" % (os.getpid(), int(time.monotonic() * 1000))).encode("utf-8"))
            recheck = _inspect()
            if recheck is None:
                return {"status": "unverified", "workerId": worker_id, "session": session}
            if (recheck["windowId"], recheck["paneId"]) != (observed["windowId"], observed["paneId"]):
                return {"status": "unverified", "workerId": worker_id, "session": session, "reason": "window_changed"}
            if not recheck["dead"]:
                # Another ensure (or a supervisor) already restarted it INSIDE our
                # transaction window: never respawn-k a live collector.
                verdict = _gpu_binding_verdict(recheck["binding"], worker_id, frame_path)
                if verdict == "own":
                    return {"status": "starting", "workerId": worker_id, "session": session,
                            "windowId": recheck["windowId"], "paneId": recheck["paneId"]}
                return _verdict_report(verdict if verdict != "empty" else "unknown", recheck)
            verdict = _gpu_binding_verdict(recheck["binding"], worker_id, frame_path)
            if verdict != "own":
                return _verdict_report(verdict if verdict != "empty" else "unknown", recheck)
            # Without -k tmux itself refuses to replace a live pane, closing the
            # race between the last observation and the actual respawn command.
            gpu_collector_tmux(["respawn-pane", "-t", recheck["paneId"], gpu_collector_command(worker_id, root)])
            # The respawned collector publishes its own NEW generation; ensure adds none.
            return {"status": "respawned", "workerId": worker_id, "session": session,
                    "windowId": recheck["windowId"], "paneId": recheck["paneId"]}
        except RuntimeError:
            return {"status": "unverified", "workerId": worker_id, "session": session, "reason": "respawn_command_failed"}
        finally:
            try:
                os.close(fd)
            except OSError:
                pass
            # Keep the inode: unlinking a lock lets another caller lock a new
            # inode concurrently. flock releases automatically on process exit.
    has = subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, timeout=3).returncode == 0
    if has:
        try:
            observed = _inspect()
        except RuntimeError:
            return {"status": "unverified", "workerId": worker_id, "session": session}
        if observed is None:
            return {"status": "unverified", "workerId": worker_id, "session": session}
        verdict = _gpu_binding_verdict(observed["binding"], worker_id, frame_path)
        if verdict == "own":
            if observed["dead"]:
                return _respawn_transaction(observed)
            return {"status": "running", "workerId": worker_id, "session": session, "windowId": observed["windowId"],
                    "paneId": observed["paneId"], "epoch": str(observed["binding"].get("epoch") or ""),
                    "collectorVersion": str(observed["binding"].get("runningVersion") or ""),
                    "versionCurrent": str(observed["binding"].get("runningVersion") or "") == str(RUNTIME_VERSION)}
        if verdict == "empty":
            if observed["dead"]:
                # A dead window with NO verifiable identity may be foreign or may
                # be ours from before the first publish — indistinguishable, so
                # report honestly and mutate nothing (parent B).
                return {"status": "unknown", "workerId": worker_id, "session": session,
                        "windowId": observed["windowId"], "reason": "unbound_dead_window"}
            return {"status": "starting", "workerId": worker_id, "session": session,
                    "windowId": observed["windowId"], "paneId": observed["paneId"]}
        return _verdict_report(verdict, observed)
    os.makedirs(os.path.dirname(frame_path), exist_ok=True)
    try:
        created = gpu_collector_tmux(["new-session", "-d", "-P", "-F", "#{window_id}\t#{pane_id}", "-s", session, "-n", "collector", gpu_collector_command(worker_id, root)])
    except RuntimeError:
        # Startup race: another process may have won new-session. Re-verify the
        # winner with the SAME full identity check; never overwrite its state and
        # never accept a merely-nonempty binding as "the other" (parent B).
        try:
            if subprocess.run(["tmux", "has-session", "-t", "=" + session], capture_output=True, timeout=3).returncode == 0:
                observed = _inspect()
                if observed is not None:
                    verdict = _gpu_binding_verdict(observed["binding"], worker_id, frame_path)
                    if verdict == "own":
                        return {"status": "race_won_by_other", "workerId": worker_id, "session": session,
                                "windowId": observed["windowId"], "paneId": observed["paneId"]}
                    if verdict == "empty":
                        return {"status": "starting", "workerId": worker_id, "session": session,
                                "windowId": observed["windowId"]}
                    return _verdict_report(verdict, observed)
        except RuntimeError:
            pass
        return {"status": "unverified", "workerId": worker_id, "session": session}
    observed = _inspect()
    if observed is None or created != observed["windowId"] + "\t" + observed["paneId"]:
        return {"status": "unverified", "workerId": worker_id, "session": session}
    verdict = _gpu_binding_verdict(observed["binding"], worker_id, frame_path)
    if verdict not in ("own", "empty"):
        return _verdict_report(verdict, observed)
    gpu_collector_tmux(["set-option", "-w", "-t", observed["windowId"], "remain-on-exit", "on"])
    return {"status": "started", "workerId": worker_id, "session": session,
            "windowId": observed["windowId"], "paneId": observed["paneId"]}

def gpu_collector_note_mode(worker_id, mode, root=""):
    # One machine-journal note per mode transition: consumers never silently switch
    # between the shared frame and the legacy direct sample. The visible truth for
    # API/UI consumers is the frameSource/collectorMode fields on every payload.
    key = str(worker_id or "")
    if _GPU_SOURCE_MODE_LAST.get(key) == mode:
        return
    _GPU_SOURCE_MODE_LAST[key] = mode
    try:
        if root and "append_event" in globals():
            append_event(root, {"type": "gpu_source_mode", "workerId": key, "payload": {"mode": mode, "generatedAt": now_iso()}})
    except Exception:
        pass
    return mode

def gpu_collector_main(root, worker_id, poll_seconds=1.0):
    # The machine lock also covers callers in another tmux server and accidental
    # direct launches: no second publisher may reset the epoch or sample GPUs.
    import fcntl
    frame_path = gpu_collector_frame_path(worker_id, root)
    os.makedirs(os.path.dirname(frame_path), exist_ok=True)
    fd = os.open(frame_path + ".writer.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as writer:
        try:
            fcntl.flock(writer.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("GPU_COLLECTOR_WRITER_BUSY") from exc
        return gpu_collector_loop(root, worker_id, poll_seconds)

def gpu_collector_loop(root, worker_id, poll_seconds=1.0):
    """Single writer for the shared frame. The epoch is this collector's own
    generation and is published here (registration + window annotation) — nowhere
    else. The sequence advances monotonically for the collector's lifetime and is
    never reset by an Agent restart. Cadence matches the previous core frequency."""
    worker_id = str(worker_id or "worker").strip() or "worker"
    frame_path = gpu_collector_frame_path(worker_id, root)
    if not frame_path:
        raise RuntimeError("GPU_COLLECTOR_STATE_ROOT_UNCONFIGURED")
    os.makedirs(os.path.dirname(frame_path), exist_ok=True)
    epoch = "%d-%d" % (int(time.monotonic() * 1000), os.getpid())
    gpu_collector_publish_generation(worker_id, root, epoch)
    seq = 0
    interval = max(0.5, float(poll_seconds or 1.0))
    while True:
        started = time.monotonic()
        try:
            gpus, err = collect_local_gpu()
        except Exception as exc:  # A sampler crash must not fake freshness downstream.
            gpus, err = [], str(exc)
        seq += 1
        frame = {"schemaVersion": 1, "frameSource": GPU_COLLECTOR_SOURCE, "workerId": worker_id,
                 "epoch": epoch, "seq": seq, "collectedAt": now_iso(),
                 "collectedMonotonicMs": int(started * 1000.0),
                 "status": "ok" if not err else "degraded", "error": str(err or ""),
                 "completeness": "full" if gpus and not err else "partial",
                 "runtimeVersion": RUNTIME_VERSION, "gpu": gpus, "gpus": gpus}
        try:
            atomic_write(frame_path, frame)
        except Exception as exc:
            print("[gpu-collector] frame write failed: " + str(exc), file=sys.stderr, flush=True)
        delay = interval - (time.monotonic() - started)
        if delay > 0:
            time.sleep(delay)

_GPU_COLLECTOR_HEAL_AT = {}

def gpu_collector_self_heal(worker_id, root=""):
    # Bounded watchdog from the Agent sampler only: if the shared frame is not
    # fresh, run the SAME verified ensure (which mutates nothing it cannot prove
    # is ours). Cadence-limited; never scans processes, never touches any other
    # window, never respawns an unbound dead window.
    worker_id = str(worker_id or "worker").strip() or "worker"
    now = time.monotonic()
    if now - float(_GPU_COLLECTOR_HEAL_AT.get(worker_id) or 0.0) < 15.0:
        return None
    _GPU_COLLECTOR_HEAL_AT[worker_id] = now
    if read_gpu_collector_frame(worker_id, root).get("mode") == "fresh":
        return None
    report = gpu_collector_ensure(worker_id, root)
    if report.get("status") in ("started", "respawned"):
        gpu_collector_note_mode(worker_id, "collector_" + str(report.get("status")), root)
    return report

def read_gpu_collector_frame(worker_id, root=""):
    """Shared BOUNDED reader with generation consistency (parent C). Absence is
    proven only by ENOENT; permission/type/link/oversized are unreadable. When a
    valid registration exists the frame is fresh ONLY if it carries the CURRENT
    published epoch — a late old-generation frame is "stale" at any seq. A frame
    with no valid registration is "unregistered"/"unknown" (needs update): never
    consumable, never a legacy door. Modes: absent (registration AND frame both
    ENOENT-confirmed → starting/lost state), stalled, unregistered, unknown, unreadable,
    foreign, partial, stale, fresh, unconfigured."""
    worker_id = str(worker_id or "worker").strip() or "worker"
    frame_path = gpu_collector_frame_path(worker_id, root)
    if not frame_path:
        return {"mode": "unconfigured", "frame": None}
    state = _gpu_stat_state(frame_path)
    registration = gpu_collector_read_registration(worker_id, root)
    if state == "unreadable":
        return {"mode": "unreadable", "frame": None}
    if state == "absent":
        if registration["mode"] == "registered":
            return {"mode": "stalled", "frame": None}
        if registration["mode"] == "absent":
            return {"mode": "absent", "frame": None}
        # Frame gone/never written while the registration is unreadable/invalid:
        # capability cannot be proven legacy — stay unknown.
        return {"mode": "unknown", "frame": None}
    try:
        frame = _gpu_read_bounded_json(frame_path)
    except FileNotFoundError:
        if registration["mode"] == "registered":
            return {"mode": "stalled", "frame": None}
        return {"mode": "absent" if registration["mode"] == "absent" else "unknown", "frame": None}
    except (OSError, ValueError):
        return {"mode": "unreadable", "frame": None}
    if not isinstance(frame, dict) or frame.get("frameSource") != GPU_COLLECTOR_SOURCE \
            or str(frame.get("workerId") or "") != worker_id:
        return {"mode": "foreign", "frame": None}
    seq = frame.get("seq")
    epoch = str(frame.get("epoch") or "")
    mono = frame.get("collectedMonotonicMs")
    gpus = frame.get("gpus")
    if type(seq) is not int or seq <= 0 or not epoch or not _gpu_number_finite(mono) or not isinstance(gpus, list):
        return {"mode": "partial", "frame": None}
    if registration["mode"] == "absent":
        # Frame present without any registration: this collector family was never
        # released without the register file, so this is a corrupted/partial state
        # of a NEW deployment — unknown, needs update, never consumed (parent A).
        return {"mode": "unregistered", "frame": frame}
    if registration["mode"] != "registered":
        return {"mode": "unknown", "frame": None}
    published = str((registration.get("registration") or {}).get("epoch") or "")
    if epoch != published:
        # Late old-generation sample: never fresh regardless of seq (parent C).
        return {"mode": "stale", "frame": frame, "ageMs": None, "reason": "generation"}
    gen_start = float(registration["registration"]["genStartedMonotonicMs"])
    previous = _GPU_FRAME_WATERMARKS.get(frame_path)
    if float(mono) < gen_start or previous and (
            epoch == previous[0] and (seq < previous[2] or float(mono) < previous[3])
            or epoch != previous[0] and gen_start <= previous[1]):
        return {"mode": "stale", "frame": frame, "ageMs": None, "reason": "ordering"}
    _GPU_FRAME_WATERMARKS[frame_path] = (epoch, gen_start, seq, float(mono))
    age_ms = time.monotonic() * 1000.0 - float(mono)
    if age_ms < 0.0 or age_ms > GPU_COLLECTOR_FRESH_MS:
        return {"mode": "stale", "frame": frame, "ageMs": age_ms}
    if frame.get("completeness") != "full" or frame.get("status") != "ok" or not gpus:
        return {"mode": "partial", "frame": frame, "ageMs": age_ms}
    return {"mode": "fresh", "frame": frame, "ageMs": age_ms}

def _gpu_evidence_fingerprint(gpus):
    return hashlib.sha256(json.dumps(gpus, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()

def _gpu_evidence_gpu_ids(gpus):
    try:
        return sorted(str(gpu_row_id(row)) for row in gpus if isinstance(row, dict))
    except Exception:
        return []

def gpu_admission_probe_bound(root, worker_id="", intent=None):
    """(gpus, error, evidence) source for every admission/dispatch decision.
    Capability is supplied by this runtime's protocol, never inferred from file
    absence. Missing state waits for startup; "unregistered",
    "unknown", "unreadable", "invalid" or "foreign" return errors — a frame whose
    registration is missing/invalid never degrades to a second sampler (parent D).
    Causality fence (all required): the frame's sampling START is at or after this
    request's monotonic boundary T0 and after the published generation start; the
    shared reader already verified epoch equality with the published generation
    before returning "fresh"; per-probe monotonic ordering blocks replays.
    Evidence binds worker + root + command/request + sample identity + GPU
    fingerprint, with NO defaults: a credential cannot cross project, command or
    GPU set even for the same Worker."""
    worker_id = str(worker_id or os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
    intent = intent if isinstance(intent, dict) else {}
    command_id = str(intent.get("commandId") or "")
    opening_frame = read_gpu_collector_frame(worker_id, root)
    if opening_frame["mode"] == "unconfigured":
        return [], "gpu_collector_state_unconfigured", None
    if opening_frame["mode"] == "absent":
        # This runtime implements the collector protocol. Missing files may be
        # startup or loss of state; they never prove that this is an old runtime.
        gpu_collector_note_mode(worker_id, "collector_starting", root)
    if opening_frame["mode"] in ("foreign", "unreadable", "unknown", "unregistered"):
        gpu_collector_note_mode(worker_id, "collector_" + str(opening_frame["mode"]), root)
        reason = "gpu_collector_needs_update" if opening_frame["mode"] == "unregistered" else "gpu_collector_identity_unverified"
        return [], reason, None
    t0 = time.monotonic() * 1000.0
    deadline = t0 + max(0.0, GPU_ADMISSION_WAIT_SECONDS) * 1000.0
    last_accepted_epoch, last_accepted_seq = "", 0
    latest = opening_frame
    max_mono_seen = -1.0
    while True:
        reg_now = gpu_collector_read_registration(worker_id, root)
        generation = (reg_now.get("registration") or {}) if reg_now["mode"] == "registered" else {}
        latest = read_gpu_collector_frame(worker_id, root)
        frame = latest.get("frame")
        # "fresh" from the shared reader already implies current-generation; the
        # explicit comparison below keeps the fence auditable at this site too.
        if latest["mode"] == "fresh" and frame and generation:
            epoch = str(frame["epoch"])
            seq = int(frame["seq"])
            mono = float(frame["collectedMonotonicMs"])
            gen_start = float(generation.get("genStartedMonotonicMs") or 0.0)
            current_generation = epoch == str(generation.get("epoch") or "")
            request_after_start = mono >= t0 and mono >= gen_start
            ordered = mono > max_mono_seen and (epoch != last_accepted_epoch or seq > last_accepted_seq)
            if current_generation and request_after_start and ordered:
                max_mono_seen = mono
                last_accepted_epoch, last_accepted_seq = epoch, seq
                gpu_collector_note_mode(worker_id, "collector", root)
                evidence = {"workerId": worker_id, "root": str(os.path.abspath(root) if root else ""),
                            "commandId": command_id,
                            "requestStartedMonotonicMs": t0,
                            "epoch": epoch, "seq": seq, "collectedMonotonicMs": mono,
                            "gpuIds": _gpu_evidence_gpu_ids(frame["gpus"]),
                            "fingerprint": _gpu_evidence_fingerprint(frame["gpus"])}
                return list(frame["gpus"]), "", evidence
        if time.monotonic() * 1000.0 >= deadline:
            break
        time.sleep(0.1)
    gpu_collector_note_mode(worker_id, "collector_stalled", root)
    return [], "gpu_collector_stalled: no request-bound sample from the current generation within " \
        + format(GPU_ADMISSION_WAIT_SECONDS, ".1f") + "s (last frame mode " + str(latest.get("mode")) + ")", None

def gpu_admission_probe(root, worker_id=""):
    # (gpus, error) convenience wrapper for lock-free decision loops (drain,
    # scheduler, accept). The bounded wait replaces the historical direct
    # nvidia-smi call at the SAME call sites; fast inventory and stop paths never
    # call this and never wait.
    gpus, error, _evidence = gpu_admission_probe_bound(root, worker_id)
    return gpus, error

GPU_ADMISSION_EVIDENCE_FIELDS = ("workerId", "root", "commandId", "epoch", "seq",
                                 "requestStartedMonotonicMs", "collectedMonotonicMs", "gpuIds", "fingerprint")

def gpu_admission_recheck_evidence(root, worker_id, evidence, intent=None):
    """In-lock revalidation for the GPU reserve (parent D): the credential must
    be COMPLETE and bound to THIS caller — worker, absolute root, command/request
    — with every field present (no silent defaults, so two projects of the same
    Worker can never reuse one credential). The frame on disk must still be the
    exact accepted sample (same epoch+seq+start+fingerprint), still fresh, and
    still the published generation. The caller keeps its own in-lock occupancy
    checks; this function never re-samples and never defaults the Worker."""
    if not isinstance(evidence, dict):
        return [], "gpu_admission_evidence_missing"
    missing = [field for field in GPU_ADMISSION_EVIDENCE_FIELDS
               if field not in evidence or evidence.get(field) in (None, "", [])]
    if missing:
        return [], "gpu_admission_evidence_missing:" + ",".join(missing)
    if not _gpu_number_finite(evidence["requestStartedMonotonicMs"]) \
            or not _gpu_number_finite(evidence["collectedMonotonicMs"]) \
            or evidence["requestStartedMonotonicMs"] > evidence["collectedMonotonicMs"]:
        return [], "gpu_admission_evidence_request_fence"
    if str(worker_id or "") != str(evidence["workerId"]):
        return [], "gpu_admission_evidence_worker_mismatch"
    if str(os.path.abspath(root) if root else "") != str(evidence["root"]):
        return [], "gpu_admission_evidence_root_mismatch"
    if isinstance(intent, dict):
        if str(intent.get("commandId") or "") != str(evidence["commandId"]):
            return [], "gpu_admission_evidence_command_mismatch"
    frame_obs = read_gpu_collector_frame(worker_id, root)
    frame = frame_obs.get("frame")
    if frame_obs["mode"] != "fresh" or not frame:
        return [], "gpu_admission_evidence_frame_not_fresh"
    if str(frame.get("epoch")) != str(evidence["epoch"]) \
            or int(frame.get("seq")) != int(evidence["seq"]) \
            or float(frame.get("collectedMonotonicMs")) != float(evidence["collectedMonotonicMs"]) \
            or _gpu_evidence_fingerprint(frame["gpus"]) != str(evidence["fingerprint"]) \
            or _gpu_evidence_gpu_ids(frame["gpus"]) != sorted(str(item) for item in (evidence.get("gpuIds") or [])):
        return [], "gpu_admission_evidence_changed"
    reg = gpu_collector_read_registration(worker_id, root)
    if reg["mode"] != "registered" or str((reg.get("registration") or {}).get("epoch") or "") != str(frame.get("epoch")):
        return [], "gpu_admission_evidence_generation_changed"
    return list(frame["gpus"]), ""
`;
