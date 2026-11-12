/** Disposable diagram files; recipes live in Pi tool-result details, not in this cache. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, utimes } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { renderDiagram, type DiagramInput, type RenderedDiagram } from "./render.ts";

export const DIAGRAM_CACHE_BYTES = 256 * 1024 * 1024;
export const DIAGRAM_CACHE_FILES = 512;
export const DIAGRAM_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CACHE_FILE = /^diagram-([0-9a-f-]{36})\.svg$/;
const TEMP_FILE = /^\.writing-([0-9a-f-]{36})$/;

export interface DiagramRecord extends DiagramInput {
	version: 1;
	id: string;
	/** Original embed path, retained as an alias when a session moves to another cache root. */
	path: string;
	width: number;
	height: number;
}
export interface CacheReport { files: number; bytes: number; removedFiles: number; removedBytes: number }
interface CacheOptions {
	maxBytes?: number;
	maxFiles?: number;
	maxAgeMs?: number;
	now?: () => number;
	render?: (input: DiagramInput) => Promise<RenderedDiagram>;
}

// Serialize cache mutations across stores in this process. Different sessions use unique IDs;
// atomic renames and ENOENT-tolerant pruning also allow independent Pi processes to share it.
const queues = new Map<string, Promise<unknown>>();
function inCacheQueue<T>(root: string, work: () => Promise<T>): Promise<T> {
	const run = (queues.get(root) ?? Promise.resolve()).catch(() => {}).then(work);
	queues.set(root, run);
	void run.finally(() => { if (queues.get(root) === run) queues.delete(root); }).catch(() => {});
	return run;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }

/** Treat persisted session data as input, not as permission to write its stored path. */
export function isDiagramRecord(value: unknown): value is DiagramRecord {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<DiagramRecord>;
	return v.version === 1 && typeof v.id === "string" && ID.test(v.id)
		&& (v.format === "mermaid" || v.format === "svg") && typeof v.source === "string"
		&& v.source.length > 0 && v.source.length <= 50_000
		&& typeof v.path === "string" && isAbsolute(v.path) && !/[\x00-\x1f\x7f]/.test(v.path)
		&& basename(v.path) === `diagram-${v.id}.svg`
		&& typeof v.width === "number" && typeof v.height === "number"
		&& v.width > 0 && v.height > 0 && Number.isFinite(v.width * v.height) && v.width * v.height <= 16_000_000;
}

export class DiagramCache {
	readonly root: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	readonly maxAgeMs: number;
	private readonly now: () => number;
	private readonly render: (input: DiagramInput) => Promise<RenderedDiagram>;
	private records = new Map<string, DiagramRecord>();
	private aliases = new Map<string, string>();
	private sources = new Map<string, string>();
	private pending = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(root: string, options: CacheOptions = {}) {
		this.root = resolve(root);
		this.maxBytes = options.maxBytes ?? DIAGRAM_CACHE_BYTES;
		this.maxFiles = options.maxFiles ?? DIAGRAM_CACHE_FILES;
		this.maxAgeMs = options.maxAgeMs ?? DIAGRAM_CACHE_AGE_MS;
		this.now = options.now ?? Date.now;
		this.render = options.render ?? renderDiagram;
	}

	path(id: string): string { return join(this.root, `diagram-${id}.svg`); }

	/** Restore only recipes from the current branch; old paths are read aliases, never write targets. */
	restore(values: unknown[]): void {
		this.records.clear(); this.aliases.clear(); this.sources.clear();
		for (const value of values) if (isDiagramRecord(value)) this.remember(value);
	}

	private remember(record: DiagramRecord): void {
		this.records.set(record.id, record);
		this.aliases.set(resolve(record.path), record.id);
		this.aliases.set(this.path(record.id), record.id);
		this.sources.set(JSON.stringify([record.format, record.source]), record.id);
	}

	/** Existing ordinary paths pass through unchanged. No scheme or global path ownership is added. */
	resolvePath(path: string): string {
		const id = this.aliases.get(resolve(path));
		return id === undefined ? path : this.path(id);
	}

	/** Called before a managed file is read. It can recreate a pruned file from session source. */
	async prepare(path: string): Promise<void> {
		const id = this.aliases.get(resolve(path));
		if (id === undefined) return;
		const record = this.records.get(id)!;
		let job = this.pending.get(id);
		if (!job) {
			job = inCacheQueue(this.root, async () => {
				if (this.disposed) throw new Error("图示会话已结束");
				await this.directory(false);
				try {
					const stat = await lstat(this.path(id));
					if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("图示缓存文件不是普通文件");
					await utimes(this.path(id), new Date(this.now()), new Date(this.now()));
					return;
				} catch (error) { if (!missing(error)) throw error; }
				const result = await this.render(record);
				if (this.disposed) throw new Error("图示会话已结束");
				await this.write(id, result.svg);
				await this.sweep(false, id);
			});
			this.pending.set(id, job);
			void job.finally(() => { if (this.pending.get(id) === job) this.pending.delete(id); }).catch(() => {});
		}
		await job;
	}

	async create(input: DiagramInput, signal?: AbortSignal): Promise<DiagramRecord> {
		aborted(signal);
		if (this.disposed) throw new Error("图示会话已结束");
		const existing = this.sources.get(JSON.stringify([input.format, input.source]));
		if (existing) {
			await this.prepare(this.path(existing));
			aborted(signal);
			return this.records.get(existing)!;
		}
		const result = await this.render(input);
		aborted(signal);
		const id = randomUUID();
		const record: DiagramRecord = { version: 1, id, format: input.format, source: input.source, path: this.path(id), width: result.width, height: result.height };
		if (!isDiagramRecord(record)) throw new Error("图示源码或尺寸超出限制");
		await inCacheQueue(this.root, async () => {
			aborted(signal);
			if (this.disposed) throw new Error("图示会话已结束");
			await this.write(id, result.svg);
			await this.sweep(false, id);
		});
		aborted(signal);
		if (this.disposed) throw new Error("图示会话已结束");
		this.remember(record);
		return record;
	}

	/** No directories are created just by opening an ordinary, diagram-free session. */
	private async directory(create: boolean): Promise<boolean> {
		if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
		try {
			const stat = await lstat(this.root);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("图示缓存目录必须是普通目录，不能是符号链接");
			return true;
		} catch (error) { if (missing(error) && !create) return false; throw error; }
	}

	private async write(id: string, svg: string): Promise<void> {
		const bytes = Buffer.byteLength(svg);
		if (bytes > 4 * 1024 * 1024 || bytes > this.maxBytes) throw new Error("图示输出超过缓存单图容量限制");
		await this.directory(true);
		const temp = join(this.root, `.writing-${randomUUID()}`);
		const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			await handle.writeFile(svg, "utf8");
			await handle.close();
			await rename(temp, this.path(id));
			await utimes(this.path(id), new Date(this.now()), new Date(this.now()));
		} finally {
			await handle.close();
			await unlink(temp).catch((error) => { if (!missing(error)) throw error; });
		}
	}

	/** Deletes only this cache's regular diagram-UUID.svg files; never follows symlinks. */
	private async sweep(all: boolean, keep?: string, inspectOnly = false): Promise<CacheReport> {
		const report: CacheReport = { files: 0, bytes: 0, removedFiles: 0, removedBytes: 0 };
		if (!await this.directory(false)) return report;
		const files: { path: string; id: string; bytes: number; used: number; temporary: boolean }[] = [];
		for (const name of await readdir(this.root)) {
			const temporary = TEMP_FILE.test(name);
			const match = (temporary ? TEMP_FILE : CACHE_FILE).exec(name);
			if (!match || !ID.test(match[1]!)) continue;
			const path = join(this.root, name);
			try {
				const stat = await lstat(path);
				if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path, id: match[1]!, bytes: stat.size, used: stat.mtimeMs, temporary });
			} catch (error) { if (!missing(error)) throw error; }
		}
		files.sort((a, b) => a.used - b.used || a.id.localeCompare(b.id));
		report.files = files.length;
		report.bytes = files.reduce((sum, file) => sum + file.bytes, 0);
		if (inspectOnly) return report;
		for (const file of files) {
			// Leave active atomic writes alone, but collect files left by interrupted processes.
			if (file.temporary) { if (this.now() - file.used < 24 * 60 * 60 * 1000) continue; }
			else if (file.id === keep || (!all && this.now() - file.used <= this.maxAgeMs && report.bytes <= this.maxBytes && report.files <= this.maxFiles)) continue;
			try { await unlink(file.path); } catch (error) { if (!missing(error)) throw error; }
			report.files--; report.bytes -= file.bytes;
			report.removedFiles++; report.removedBytes += file.bytes;
		}
		return report;
	}

	prune(): Promise<CacheReport> { return inCacheQueue(this.root, () => this.sweep(false)); }
	status(): Promise<CacheReport> { return inCacheQueue(this.root, () => this.sweep(false, undefined, true)); }
	clear(): Promise<CacheReport> { return inCacheQueue(this.root, () => this.sweep(true)); }
	dispose(): void { this.disposed = true; this.records.clear(); this.aliases.clear(); this.sources.clear(); }
}
