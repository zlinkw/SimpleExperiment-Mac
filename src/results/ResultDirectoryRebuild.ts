import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createReadStream } from "node:fs";

function child(root: string, relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.includes(":") || /[?*]/.test(relative)
        || relative.replace(/\\/g, "/").split("/").some(part => !part || part === "." || part === ".."))
        throw new Error("结果重建路径不安全。");
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep)) throw new Error("结果重建路径超出项目。");
    return full;
}

async function checkedParents(root: string, full: string): Promise<void> {
    const relative = path.relative(root, full);
    const device = (await fs.lstat(root)).dev;
    let current = root;
    for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        const stat = await fs.lstat(current).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (stat?.isSymbolicLink()) throw new Error("结果重建拒绝链接：" + current);
        if (stat && stat.dev !== device) throw new Error("结果重建拒绝挂载边界：" + current);
        if (stat && await fs.realpath(current) !== current) throw new Error("结果重建路径身份不一致：" + current);
    }
}

async function inventory(root: string): Promise<any[]> {
    const rows: any[] = [];
    const device = (await fs.lstat(root)).dev;
    const visit = async (full: string, relative: string) => {
        const stat = await fs.lstat(full);
        if (stat.dev !== device || relative.split("/").some(part => [".git", "clean_dir"].includes(part.toLowerCase())))
            throw new Error("结果目录含受保护路径或挂载边界，未替换：" + full);
        if (stat.isSymbolicLink()) throw new Error("结果目录含链接，未替换：" + full);
        if (rows.length >= 20000) throw new Error("结果目录超过 20000 项，未替换。");
        if (stat.isDirectory()) {
            rows.push({ path: relative, type: "directory", dev: stat.dev, ino: stat.ino });
            for (const entry of (await fs.readdir(full)).sort()) await visit(path.join(full, entry), relative ? relative + "/" + entry : entry);
        } else if (stat.isFile()) {
            const hash = crypto.createHash("sha256");
            for await (const chunk of createReadStream(full)) hash.update(chunk);
            const after = await fs.lstat(full);
            if (after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino)
                throw new Error("结果文件校验期间发生变化：" + full);
            rows.push({ path: relative, type: "file", size: stat.size, sha256: hash.digest("hex"), dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
        } else throw new Error("结果目录含非普通文件，未替换：" + full);
    };
    await visit(root, "");
    return rows;
}

/** The caller prepares and validates every new result before moving any old output. */
export async function replaceResultDirectory(options: {
    root: string; resultDir: string; stagedDir: string; batchId: string; gitStatus?: string;
    allowSuperseded?: boolean; allowDirtyResults?: boolean; isCurrent?: () => boolean;
}): Promise<{ source: string; backup: string; superseded?: string }> {
    const root = await fs.realpath(options.root);
    const resultDir = options.resultDir.replace(/\\/g, "/");
    if (String(options.gitStatus || "").split(/\r?\n/).some(line => line.trim() && !line.startsWith("??")) && !options.allowDirtyResults)
        throw new Error("结果目录有未提交的已跟踪修改，未获准备份。");
    if (["experiments/plans", "experiments/runs", "experiments/simple_project.yaml"].some(protectedPath => protectedPath.startsWith(resultDir + "/")))
        throw new Error("结果目录包含受保护实验区域，未替换。");
    if (resultDir.split("/").some(part => [".git", "clean_dir", "simple_cluster", "paper", "src", "configs", "models"].includes(part.toLowerCase())))
        throw new Error("结果目录与受保护区域重叠，未替换。");
    if (!/^[a-zA-Z0-9_-]+$/.test(options.batchId)) throw new Error("重建批次标识无效。");
    const source = child(root, resultDir);
    const stage = child(root, options.stagedDir.replace(/\\/g, "/"));
    if (source === stage || stage.startsWith(source + path.sep) || source.startsWith(stage + path.sep))
        throw new Error("暂存目录与结果目录重叠，未替换。");
    const backup = child(root, "clean_dir/" + resultDir);
    const superseded = child(root, "clean_dir/_superseded/" + options.batchId + "/" + resultDir);
    const manifest = child(root, "clean_dir/MANIFEST.md");
    for (const target of [source, stage, backup, superseded, manifest]) await checkedParents(root, target);
    const sourceInventory = await inventory(source);
    const stageInventory = await inventory(stage);
    if (!stageInventory.some(row => row.type === "file" && /(?:^|\/)final\/final\.csv$/.test(row.path)))
        throw new Error("新结果没有数据集总表，旧目录保留。");
    const previous = await fs.lstat(backup).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (previous && !options.allowSuperseded) throw new Error("备份目标已存在，未替换：" + backup);
    const previousInventory = previous ? await inventory(backup) : undefined;
    if (await fs.lstat(superseded).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))
        throw new Error("历史备份目标已存在，未替换。");
    const verify = async (full: string, expected: any[], checkCurrent = true) => {
        if (checkCurrent && options.isCurrent?.() === false) throw new Error("工作区已切换，结果重建取消。");
        await checkedParents(root, full);
        if (JSON.stringify(await inventory(full)) !== JSON.stringify(expected)) throw new Error("结果目录校验后发生变化，未替换：" + full);
    };
    const absent = async (full: string) => {
        if (await fs.lstat(full).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))
            throw new Error("结果重建目标已存在：" + full);
    };
    const move = async (from: string, to: string, expected: any[]) => {
        await verify(from, expected);
        await checkedParents(root, to);
        await absent(to);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await checkedParents(root, to);
        await verify(from, expected);
        await absent(to);
        await fs.rename(from, to);
        await absent(from);
        await verify(to, expected);
        await checkedParents(root, manifest);
        await fs.appendFile(manifest, JSON.stringify({ source: from, destination: to, type: "directory", timestamp: new Date().toISOString(), batchId: options.batchId, reason: "完整重建本机结果目录", gitStatus: options.gitStatus || "", inventory: expected }) + "\n", "utf8");
    };
    // Preflight the whole batch, including an existing backup, before the first move.
    await verify(source, sourceInventory);
    await verify(stage, stageInventory);
    if (previousInventory) await move(backup, superseded, previousInventory);
    try {
        await move(source, backup, sourceInventory);
        await verify(stage, stageInventory);
        await absent(source);
        await fs.rename(stage, source);
        await verify(source, stageInventory);
    } catch (error) {
        // If publication never created a destination, restore the verified original.
        if (!await fs.lstat(source).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
            await verify(backup, sourceInventory, false);
            await fs.rename(backup, source);
            await fs.appendFile(manifest, JSON.stringify({ source: backup, destination: source, type: "directory", timestamp: new Date().toISOString(), reason: "发布失败，恢复旧结果" }) + "\n", "utf8");
        }
        throw error;
    }
    return { source, backup, ...(previousInventory ? { superseded } : {}) };
}
