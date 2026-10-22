/** A batch approves exact control targets once. No file deletion authority is created. */
export function planStopBatchSignature(rows: any[], targets: any[] = []): string {
    const jobs = rows.map(row => [row.kind, row.planId, row.jobIndex, row.commandId || "", row.workerId || "", row.gpuId ?? "", row.outputDir || ""]);
    const operations = targets.map(row => [row.operationId, row.workerId || "", row.tmuxTarget || "", row.tmuxSession || ""]);
    return JSON.stringify([jobs.map(row => JSON.stringify(row)).sort(), operations.map(row => JSON.stringify(row)).sort()]);
}

async function parallel<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<R[]> {
    const output: R[] = new Array(items.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        for (;;) { const index = next++; if (index >= items.length) return; output[index] = await action(items[index]); }
    }));
    return output;
}

export async function runPlanStopClearBatch(host: any, planFiles: string[], root: string,
    confirm: (preview: string) => Promise<boolean>, workspaceRoot: () => string | undefined) {
    if (!root || !planFiles.length || planFiles.length > 1000) throw Error("请勾选本项目要中止并清理的 Plan，最多 1000 条。");
    if (host.planStopClearBatchLease || host.distributedPlanStopEpoch) throw Error("已有中止清理批次正在处理，请等待本次结果。");
    const generation = host.projectContextGeneration, client = host.client, lease = {};
    host.planStopClearBatchLease = lease;
    const current = () => host.planStopClearBatchLease === lease && root === workspaceRoot()
        && generation === host.projectContextGeneration && client === host.client;
    let epoch: number | undefined, localTail = Promise.resolve();
    const local = <T>(action: () => Promise<T>): Promise<T> => {
        const task = localTail.then(() => { if (!current()) throw Error("项目已切换，停止后续批次。"); return action(); });
        localTail = task.then(() => undefined, () => undefined); return task;
    };
    try {
        const prepared = await parallel(planFiles, async planFile => {
            if (!current()) return { status: "cancelled", message: "项目已切换" };
            try { return await host.stopAndClearPlanFromUi({ planFile, clearMode: "history" }, { prepare: true, lease }); }
            catch (error) { return { status: "failed", message: String(error instanceof Error ? error.message : error) }; }
        });
        const settle = (status: "cancelled" | "failed", message: string) => {
            if (current()) for (const item of prepared.filter(item => typeof item?.run === "function"))
                host.finishPlanStopClear?.(item.planFile, { phase: "batch-not-executed", outcome: status, message,
                    nextStep: "需要时重新选择并确认完整批次。" });
            return { status, message };
        };
        const failed = prepared.filter(item => typeof item?.run !== "function");
        if (failed.length || !current()) return settle("failed", `批次尚未执行：${failed.map(item => item?.message || "目标预览失败").join("；") || "项目已切换"}`);
        const preview = [`项目：${root}\n中止并清理 ${prepared.length} 个 Plan（最多 4 个并行）`,
            "本次只确认下列完整批次，后续不逐 Plan 弹窗。清理已确认队列和本机进度，保留 PLAN、配置、日志、权重和结果文件。",
            ...prepared.map(item => String(item.preview).replace("关闭对应 tmux 标签前会再次确认完整目标。", "本批次统一确认所有精确目标。"))].join("\n\n");
        if (!await confirm(preview) || !current()) return settle("cancelled", "批次已取消，未发送停止或清理命令。");
        // Do not begin any mutation if confirmation-time target identities changed.
        const valid = await parallel(prepared, async item => { try { return await item.validate(); } catch { return false; } });
        if (!current() || valid.some(value => !value)) return settle("failed", "确认后批次目标已变化，未执行；请刷新后重新确认完整批次。");
        epoch = host.distributedPlanStopEpoch = (host.distributedPlanStopEpoch || 0) + 1;
        host.distributedQueueGeneration = (host.distributedQueueGeneration || 0) + 1;
        const queueGeneration = host.distributedQueueGeneration;
        host.distributedTickAbort?.abort();
        if (host.distributedQueueTickPromise) host.detachStaleDistributedTick(host.distributedQueueTickPromise);
        const batch = { epoch, queueGeneration, current, local,
            mutate: async (change: (latest: any) => any) => host.saveDistributedQueue(root, undefined, {
                controlMutation: true, stopBatchEpoch: epoch, stopBatchLease: lease, stopBatchCurrent: current, mutateLatest: (latest: any) => {
                    if (!current() || host.distributedPlanStopEpoch !== epoch) throw Error("项目或批次已变化，未写入队列。");
                    return change(latest);
                },
            }),
        };
        const results = await parallel(prepared, async item => {
            if (!current()) return { planFile: item.planFile, status: "failed", message: "项目已切换，未执行后续 Plan。" };
            try { return { planFile: item.planFile, ...await item.run(batch) }; }
            catch (error) {
                const message = String(error instanceof Error ? error.message : error);
                if (current()) host.finishPlanStopClear?.(item.planFile, { phase: "batch-error", outcome: "failed", message, nextStep: "核对该 Plan 后重试。" });
                return { planFile: item.planFile, status: "failed", message };
            }
        });
        await localTail;
        const completed = results.filter(item => item.status === "completed").length;
        const failures = results.filter(item => item.status !== "completed");
        return { status: failures.length ? completed ? "partial" : "failed" : "completed", results,
            message: `并行处理完成 ${completed}/${results.length} 个 Plan；产物保留。${failures.map(item => `${item.planFile}：${item.message}`).join("；")}` };
    } finally {
        await localTail;
        if (host.planStopClearBatchLease === lease) {
            if (epoch !== undefined && host.distributedPlanStopEpoch === epoch) host.distributedPlanStopEpoch = 0;
            host.planStopClearBatchLease = undefined;
            host.postState?.();
        }
    }
}
