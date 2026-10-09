import { ResourceOperationLeaseManager, ResourceTarget } from "./ResourceOperationLease";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export const HOST_OPERATION_LEASE_SCHEMA_VERSION = 1;
export const HOST_OPERATION_LEASE_DIRECTORY = "SimpleExperiment";
export const HOST_OPERATION_LEASE_FILENAME = "host-operation-lease.json";
export const HOST_OPERATION_LEASE_TTL_MS = 30_000;
export const HOST_OPERATION_LEASE_HEARTBEAT_MS = 5_000;

const WINDOW_ID_SYMBOL = Symbol.for("simple-local.host-operation-window-id.v1");
const SESSION_MAP_SYMBOL = Symbol.for("simple-local.host-operation-lease-sessions.v1");

export type HostOperationLeaseRecord = {
    schemaVersion: 1;
    leaseId: string;
    pluginId: string;
    windowId: string;
    processId: number;
    workspaceUri: string;
    hostProjectPath: string;
    actionType: string;
    actionLabel: string;
    createdAt: string;
    heartbeatAt: string;
    expiresAt: string;
    releasedAt?: string;
};

export type HostOperationLeaseInput = {
    pluginId: string;
    workspaceUri: string;
    hostProjectPath: string;
    actionType: string;
    actionLabel?: string;
    resources?: ResourceTarget[];
    readOnly?: boolean;
    waitForConflict?: boolean;
    signal?: AbortSignal;
};

export type HostOperationLeaseManagerOptions = {
    leasePath?: string;
    ttlMs?: number;
    heartbeatMs?: number;
    windowId?: string;
    processId?: number;
    now?: () => number;
    ownerAlive?: (record: HostOperationLeaseRecord) => boolean;
};

type LeaseInspection = {
    record?: HostOperationLeaseRecord;
    expiresAtMs: number;
    malformed: boolean;
};

type SharedLeaseSession = {
    leasePath: string;
    leaseId: string;
    windowId: string;
    refs: number;
    lostError?: Error;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    renew: () => Promise<void>;
    expire: () => Promise<void>;
};

export type HostOperationLeaseHandle = {
    readonly record: HostOperationLeaseRecord;
    assertHeld: () => Promise<void>;
    release: () => Promise<void>;
};

export class HostOperationLeaseConflictError extends Error {
    readonly current: HostOperationLeaseRecord;
    readonly code = "RESOURCE_CONFLICT";
    readonly sideEffectStarted = false;

    constructor(current: HostOperationLeaseRecord) {
        super(formatHostOperationLeaseConflict(current));
        this.name = "HostOperationLeaseConflictError";
        this.current = current;
    }
}

export class HostOperationLeaseLostError extends Error {
    readonly code = "RESOURCE_LEASE_LOST";
    readonly outcomeUnknown = true;
    constructor(message = "宿主操作租约已失效，当前窗口不能继续提交副作用操作。") {
        super(message);
        this.name = "HostOperationLeaseLostError";
    }
}

export class LegacyHostOperationLeaseManager {
    readonly leasePath: string;
    readonly ttlMs: number;
    readonly heartbeatMs: number;
    readonly windowId: string;
    readonly processId: number;
    private readonly now: () => number;

    constructor(options: HostOperationLeaseManagerOptions = {}) {
        this.leasePath = options.leasePath || defaultHostOperationLeasePath();
        this.ttlMs = Math.max(100, Number(options.ttlMs) || HOST_OPERATION_LEASE_TTL_MS);
        this.heartbeatMs = Math.max(0, Number(options.heartbeatMs ?? HOST_OPERATION_LEASE_HEARTBEAT_MS) || 0);
        this.windowId = options.windowId || sharedWindowId();
        this.processId = Number(options.processId ?? process.pid);
        this.now = options.now || Date.now;
    }

    async run<T>(input: HostOperationLeaseInput, operation: () => Promise<T>): Promise<T> {
        const handle = await this.acquire(input);
        try {
            const result = await operation();
            await handle.assertHeld();
            return result;
        }
        finally {
            await handle.release();
        }
    }

    async acquire(input: HostOperationLeaseInput): Promise<HostOperationLeaseHandle> {
        validateLeaseInput(input);
        await fs.mkdir(path.dirname(this.leasePath), { recursive: true });
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const record = this.createRecord(input);
            try {
                await createExclusiveLeaseFile(this.leasePath, record);
                return this.attachNewSession(record);
            }
            catch (error) {
                if (!hasErrorCode(error, "EEXIST"))
                    throw error;
            }

            const inspection = await this.inspect();
            if (inspection.record?.windowId === this.windowId) {
                const session = sharedSessions().get(sessionKey(this.leasePath));
                if (session?.windowId === this.windowId) {
                    if (session.leaseId === inspection.record.leaseId) {
                        session.refs += 1;
                        return this.createHandle(inspection.record, session);
                    }
                    // 同窗口不同 leaseId：视为重入而非冲突，避免 prepareAgents -> uploadFiles 自死锁
                    if (inspection.expiresAtMs > this.now()) {
                        console.warn("[HostOperationLease] reentrant acquire from same window, reusing", inspection.record.leaseId, "-> nested");
                        (session as unknown as { parentLeaseId?: string }).parentLeaseId = inspection.record.leaseId;
                        session.refs += 1;
                        return this.createHandle(inspection.record, session);
                    }
                    // 已过期则走下面的过期回收逻辑，不抛冲突
                } else if (inspection.expiresAtMs > this.now()) {
                    // 同窗口但无本地 session 缓存：仅凭同窗口身份重入仍可复用，
                    // 但必须续租并在每个 handle 的副作用前校验磁盘 lease 身份。
                    console.warn("[HostOperationLease] reentrant acquire from same window without local session, reusing", inspection.record.leaseId);
                    const fallbackSession: SharedLeaseSession = {
                        leasePath: this.leasePath,
                        leaseId: inspection.record.leaseId,
                        windowId: inspection.record.windowId,
                        refs: 1,
                        renew: () => this.updateOwnedLease(inspection.record!.leaseId, false),
                        expire: async () => {
                            const k = sessionKey(this.leasePath);
                            if (sharedSessions().get(k) === fallbackSession)
                                sharedSessions().delete(k);
                        },
                    };
                    if (this.heartbeatMs > 0) {
                        fallbackSession.heartbeatTimer = setInterval(() => {
                            void fallbackSession.renew().catch((error) => {
                                if (error instanceof HostOperationLeaseLostError)
                                    fallbackSession.lostError = error;
                            });
                        }, this.heartbeatMs);
                        fallbackSession.heartbeatTimer.unref?.();
                    }
                    sharedSessions().set(sessionKey(this.leasePath), fallbackSession);
                    return this.createHandle(inspection.record, fallbackSession);
                }
            }
            if (inspection.expiresAtMs > this.now() && !ownerProcessDefinitelyGone(inspection.record))
                throw new HostOperationLeaseConflictError(inspection.record || malformedLeaseRecord(this.leasePath, inspection.expiresAtMs));

            // This is a single, reusable recovery slot. A random filename here
            // becomes permanent debris if the Extension Host exits between the
            // rename and its finally block.
            const movedPath = `${this.leasePath}.expired`;
            if (!await clearExpiredLeaseRecoverySlot(movedPath, this.now(), this.ttlMs)) {
                await shortDelay();
                continue;
            }
            try {
                await fs.rename(this.leasePath, movedPath);
            }
            catch (error) {
                if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM") || hasErrorCode(error, "EBUSY")) {
                    await shortDelay();
                    continue;
                }
                throw error;
            }
            try {
                await createExclusiveLeaseFile(this.leasePath, record);
                return this.attachNewSession(record);
            }
            catch (error) {
                if (!hasErrorCode(error, "EEXIST"))
                    throw error;
            }
            await shortDelay();
        }
        const current = await this.inspect();
        throw new HostOperationLeaseConflictError(current.record || malformedLeaseRecord(this.leasePath, current.expiresAtMs));
    }

    async inspect(): Promise<LeaseInspection> {
        try {
            const text = await fs.readFile(this.leasePath, "utf8");
            const record = parseHostOperationLeaseRecord(text);
            if (record) {
                return {
                    record,
                    expiresAtMs: parseTimestamp(record.expiresAt),
                    malformed: false,
                };
            }
            const stat = await fs.stat(this.leasePath);
            return { expiresAtMs: stat.mtimeMs + this.ttlMs, malformed: true };
        }
        catch (error) {
            if (hasErrorCode(error, "ENOENT"))
                return { expiresAtMs: 0, malformed: false };
            throw error;
        }
    }

    private createRecord(input: HostOperationLeaseInput): HostOperationLeaseRecord {
        const now = this.now();
        const timestamp = new Date(now).toISOString();
        return {
            schemaVersion: HOST_OPERATION_LEASE_SCHEMA_VERSION,
            leaseId: crypto.randomUUID(),
            pluginId: input.pluginId.trim(),
            windowId: this.windowId,
            processId: this.processId,
            workspaceUri: input.workspaceUri.trim(),
            hostProjectPath: path.win32.normalize(input.hostProjectPath.trim()),
            actionType: input.actionType.trim(),
            actionLabel: String(input.actionLabel || input.actionType).trim(),
            createdAt: timestamp,
            heartbeatAt: timestamp,
            expiresAt: new Date(now + this.ttlMs).toISOString(),
        };
    }

    private attachNewSession(record: HostOperationLeaseRecord): HostOperationLeaseHandle {
        const key = sessionKey(this.leasePath);
        const session: SharedLeaseSession = {
            leasePath: this.leasePath,
            leaseId: record.leaseId,
            windowId: record.windowId,
            refs: 1,
            renew: () => this.updateOwnedLease(record.leaseId, false),
            expire: () => this.updateOwnedLease(record.leaseId, true),
        };
        if (this.heartbeatMs > 0) {
            session.heartbeatTimer = setInterval(() => {
                void session.renew().catch((error) => {
                    if (error instanceof HostOperationLeaseLostError)
                        session.lostError = error;
                });
            }, this.heartbeatMs);
            session.heartbeatTimer.unref?.();
        }
        sharedSessions().set(key, session);
        return this.createHandle(record, session);
    }

    private createHandle(record: HostOperationLeaseRecord, session: SharedLeaseSession): HostOperationLeaseHandle {
        let released = false;
        return {
            record,
            assertHeld: async () => {
                if (session.lostError)
                    throw session.lostError;
                const inspection = await this.inspect();
                if (inspection.record?.leaseId !== session.leaseId || inspection.record.windowId !== session.windowId)
                    throw new HostOperationLeaseLostError();
            },
            release: async () => {
                if (released)
                    return;
                released = true;
                session.refs = Math.max(0, session.refs - 1);
                if (session.refs > 0)
                    return;
                if (session.heartbeatTimer)
                    clearInterval(session.heartbeatTimer);
                const key = sessionKey(session.leasePath);
                if (sharedSessions().get(key) === session)
                    sharedSessions().delete(key);
                await session.expire().catch((error) => {
                    if (!(error instanceof HostOperationLeaseLostError))
                        throw error;
                });
            },
        };
    }

    private async updateOwnedLease(leaseId: string, release: boolean): Promise<void> {
        let handle;
        try {
            handle = await fs.open(this.leasePath, "r+");
            const currentText = await handle.readFile("utf8");
            const current = parseHostOperationLeaseRecord(currentText);
            if (!current || current.leaseId !== leaseId || current.windowId !== this.windowId)
                throw new HostOperationLeaseLostError();
            const now = this.now();
            const heartbeatAt = new Date(now).toISOString();
            const expiresAt = new Date(release ? now : now + this.ttlMs).toISOString();
            // Patch fixed-width timestamp fields in place. Truncating first lets another
            // window observe an empty or partial JSON lease during heartbeat renewal.
            await writeLeaseTimestamp(handle, currentText, "heartbeatAt", heartbeatAt);
            await writeLeaseTimestamp(handle, currentText, "expiresAt", expiresAt);
            await handle.sync();
        }
        catch (error) {
            if (hasErrorCode(error, "ENOENT"))
                throw new HostOperationLeaseLostError();
            throw error;
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
}

async function writeLeaseTimestamp(handle: import("fs/promises").FileHandle, text: string, field: string, value: string): Promise<void> {
    const match = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`).exec(text);
    const valueOffset = match ? match.index + match[0].indexOf(match[1]) : -1;
    const offset = valueOffset < 0 ? -1 : Buffer.byteLength(text.slice(0, valueOffset), "utf8");
    if (offset < 0 || match?.[1].length !== value.length)
        throw new HostOperationLeaseLostError("宿主操作租约格式已变化，当前窗口不能继续提交副作用操作。");
    const bytes = Buffer.from(value, "utf8");
    await handle.write(bytes, 0, bytes.length, offset);
}

export function defaultHostOperationLeasePath(localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")): string {
    return path.join(localAppData, HOST_OPERATION_LEASE_DIRECTORY, HOST_OPERATION_LEASE_FILENAME);
}

export function parseHostOperationLeaseRecord(text: string): HostOperationLeaseRecord | undefined {
    try {
        const value = JSON.parse(text) as Partial<HostOperationLeaseRecord>;
        if (value.schemaVersion !== HOST_OPERATION_LEASE_SCHEMA_VERSION)
            return undefined;
        const requiredStrings: Array<keyof HostOperationLeaseRecord> = [
            "leaseId", "pluginId", "windowId", "workspaceUri", "hostProjectPath", "actionType", "actionLabel", "createdAt", "heartbeatAt", "expiresAt",
        ];
        if (!Number.isInteger(value.processId) || requiredStrings.some((key) => !String(value[key] || "").trim()))
            return undefined;
        if (!Number.isFinite(parseTimestamp(String(value.expiresAt))))
            return undefined;
        return value as HostOperationLeaseRecord;
    }
    catch {
        return undefined;
    }
}

export function formatHostOperationLeaseConflict(current: HostOperationLeaseRecord): string {
    return [
        "目标资源正在由另一个操作修改。",
        `持有插件：${current.pluginId}`,
        `持有窗口：${current.windowId}（PID ${current.processId}）`,
        `工作区：${current.workspaceUri}`,
        `宿主项目：${current.hostProjectPath}`,
        `当前动作：${current.actionLabel || current.actionType}`,
        `最近心跳：${current.heartbeatAt}`,
        `下一步：等待持有操作完成后重试；若持有窗口已崩溃，请重新加载该窗口。不要删除活动锁记录。`,
    ].join("\n");
}

async function createExclusiveLeaseFile(leasePath: string, record: HostOperationLeaseRecord): Promise<void> {
    const handle = await fs.open(leasePath, "wx");
    try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}

function sharedWindowId(): string {
    const globals = globalThis as Record<symbol, unknown>;
    if (!globals[WINDOW_ID_SYMBOL])
        globals[WINDOW_ID_SYMBOL] = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
    return String(globals[WINDOW_ID_SYMBOL]);
}

function sharedSessions(): Map<string, SharedLeaseSession> {
    const globals = globalThis as Record<symbol, unknown>;
    if (!(globals[SESSION_MAP_SYMBOL] instanceof Map))
        globals[SESSION_MAP_SYMBOL] = new Map<string, SharedLeaseSession>();
    return globals[SESSION_MAP_SYMBOL] as Map<string, SharedLeaseSession>;
}

function sessionKey(leasePath: string): string {
    return path.resolve(leasePath).toLowerCase();
}

function validateLeaseInput(input: HostOperationLeaseInput): void {
    const required: Array<keyof HostOperationLeaseInput> = ["pluginId", "workspaceUri", "hostProjectPath", "actionType"];
    for (const key of required) {
        if (!String(input[key] || "").trim())
            throw new Error(`宿主操作租约缺少 ${key}。`);
    }
}

function malformedLeaseRecord(leasePath: string, expiresAtMs: number): HostOperationLeaseRecord {
    const timestamp = new Date(Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + HOST_OPERATION_LEASE_TTL_MS).toISOString();
    return {
        schemaVersion: HOST_OPERATION_LEASE_SCHEMA_VERSION,
        leaseId: "malformed",
        pluginId: "unknown",
        windowId: "unknown",
        processId: 0,
        workspaceUri: "unknown",
        hostProjectPath: leasePath,
        actionType: "malformed-lease",
        actionLabel: "无法解析的宿主操作租约",
        createdAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: timestamp,
    };
}

function parseTimestamp(value: string): number {
    return Date.parse(value);
}

function ownerProcessDefinitelyGone(record: HostOperationLeaseRecord | undefined): boolean {
    if (!record || record.processId <= 0 || !record.windowId.startsWith(`${os.hostname()}:${record.processId}:`))
        return false;
    try {
        process.kill(record.processId, 0);
        return false;
    }
    catch (error) {
        // EPERM and unknown probe failures cannot prove that an owner is gone.
        return hasErrorCode(error, "ESRCH");
    }
}

async function clearExpiredLeaseRecoverySlot(file: string, now: number, ttlMs: number): Promise<boolean> {
    let before: import("fs").Stats;
    try { before = await fs.lstat(file); }
    catch (error) { if (hasErrorCode(error, "ENOENT")) return true; throw error; }
    if (!before.isFile() || before.isSymbolicLink())
        throw new Error("宿主租约固定恢复槽不是普通文件，拒绝覆盖或删除。请检查插件全局状态目录。");
    const parent = path.dirname(file);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
        throw new Error("宿主租约恢复槽父目录不安全，拒绝清理。");
    const text = await fs.readFile(file, "utf8");
    const record = parseHostOperationLeaseRecord(text);
    const expiresAt = record ? parseTimestamp(record.expiresAt) : before.mtimeMs + ttlMs;
    if (!record || !Number.isFinite(expiresAt) || expiresAt > now || !ownerProcessDefinitelyGone(record))
        return false;
    const current = await fs.lstat(file).catch((error) => hasErrorCode(error, "ENOENT") ? undefined : Promise.reject(error));
    if (!current) return true;
    if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs)
        return false;
    // Keep this one fixed recovery slot. The next verified stale takeover may
    // atomically replace it; unlinking on every recovery creates a delete race
    // and makes Extension Host crashes leave random cleanup work behind.
    return true;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

function shortDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
}

export class HostOperationLeaseManager extends ResourceOperationLeaseManager {
    constructor(options: HostOperationLeaseManagerOptions = {}) {
        super({ ...options, leasePath: options.leasePath || defaultHostOperationLeasePath(),
            windowId: options.windowId || sharedWindowId(),
            conflictError: (row: HostOperationLeaseRecord) => new HostOperationLeaseConflictError(row),
            lostError: () => new HostOperationLeaseLostError() });
    }
}
