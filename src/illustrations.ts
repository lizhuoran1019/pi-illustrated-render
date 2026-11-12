/** Local illustrations, independent of the formula engine. Never fetch URLs. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { getCellDimensions } from "@earendil-works/pi-tui";
import { rememberFormulaSource } from "./math/copy.ts";
import { allocateId, imageMode, MAX_PLACEHOLDER_CELLS, placeholderRows, registerImage } from "./math/kitty.ts";
import type { IllustrationRenderer, IllustrationRequest, IllustrationResult } from "./render/context.ts";
import { bumpVersion, requestRender, state } from "./state.ts";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const CACHE_BYTES = 32 * 1024 * 1024;
const MAX_COLUMNS = 100;
const MAX_RASTER_SIDE = 4096;

interface Size { width: number; height: number }
interface Resource extends Size { svg: string }
type ResourceEntry = { status: "pending" } | { status: "ready"; value: Resource } | { status: "error"; message: string };
interface Raster { base64: string; columns: number; rows: number }
const BACKGROUNDS = { light: "#ffffff", dark: "#171a21", none: undefined } as const;

/** Decode Markdown URL escapes, but preserve ordinary filenames containing a literal %. */
export function resolveImagePath(href: string, cwd: string): string {
	if (/^file:/i.test(href)) return fileURLToPath(href);
	if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) throw new Error("仅显示本地 SVG/PNG；远程图片未下载");
	let path = href;
	try { path = decodeURIComponent(href); } catch { /* literal % in a local filename */ }
	if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("图片路径无效");
	if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
	return resolve(cwd, path);
}

function checkDimensions(width: number, height: number): void {
	if (!(width > 0 && height > 0 && Number.isFinite(width + height)) || width * height > MAX_PIXELS) {
		throw new Error("图片尺寸无效或超过 1600 万像素");
	}
}

/** SVGs must be standalone vectors: internal #references are fine; external assets are not. */
export function checkSvg(svg: string): void {
	if (/<!DOCTYPE|<!ENTITY|@import/i.test(svg)) throw new Error("SVG 不支持 DTD、实体声明或外部样式");
	for (const match of svg.matchAll(/(?:\b|:)href\s*=\s*(["'])(.*?)\1/gs)) {
		if (!match[2]?.trim().startsWith("#")) throw new Error("SVG 请使用独立矢量图，不要引用外部文件或嵌入图片");
	}
	for (const match of svg.matchAll(/url\(\s*["']?([^)'"\s]+)/gi)) {
		if (!match[1]?.startsWith("#")) throw new Error("SVG 不支持外部资源");
	}
}

/** Enforce dimensions and a decompression ceiling BEFORE pngjs allocates pixel buffers. */
export function validatePng(data: Buffer): { width: number; height: number } {
	if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("PNG 文件无效");
	let offset = 8;
	let width = 0, height = 0, bits = 0, interlace = 0;
	let header = false, ended = false, dataEnded = false;
	const compressed: Buffer[] = [];
	while (offset < data.length) {
		if (data.length - offset < 12) throw new Error("PNG chunk 截断");
		const length = data.readUInt32BE(offset);
		if (length > data.length - offset - 12) throw new Error("PNG chunk 长度无效");
		const type = data.toString("ascii", offset + 4, offset + 8);
		const chunk = data.subarray(offset + 8, offset + 8 + length);
		if (!header && type !== "IHDR") throw new Error("PNG 首个 chunk 必须为 IHDR");
		if (type === "IHDR") {
			if (header || offset !== 8 || length !== 13) throw new Error("PNG IHDR 重复或无效");
			header = true;
			width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
			checkDimensions(width, height);
			const depth = chunk[8]!, color = chunk[9]!;
			const formats: Record<number, { channels: number; depths: number[] }> = {
				0: { channels: 1, depths: [1, 2, 4, 8, 16] }, 2: { channels: 3, depths: [8, 16] },
				3: { channels: 1, depths: [1, 2, 4, 8] }, 4: { channels: 2, depths: [8, 16] }, 6: { channels: 4, depths: [8, 16] },
			};
			const format = formats[color];
			if (!format?.depths.includes(depth) || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12]! > 1) throw new Error("PNG 编码无效");
			bits = format.channels * depth; interlace = chunk[12]!;
		} else if (type === "IDAT") {
			if (dataEnded) throw new Error("PNG IDAT 顺序无效");
			compressed.push(chunk);
		} else {
			if (compressed.length) dataEnded = true;
			if (type === "IEND") {
				if (length || !compressed.length || offset + 12 !== data.length) throw new Error("PNG IEND 无效");
				ended = true;
			}
		}
		offset += length + 12;
	}
	if (!ended) throw new Error("PNG 缺少 IEND");
	const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
	let expected = 0;
	for (const [x, y, dx, dy] of passes) {
		const w = Math.max(0, Math.ceil((width - x!) / dx!));
		const h = Math.max(0, Math.ceil((height - y!) / dy!));
		if (w && h) expected += h * (1 + Math.ceil(w * bits / 8));
	}
	const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
	if (pixels.length !== expected) throw new Error("PNG 解压数据与像素尺寸不符");
	// Includes CRC, palette and scanline/filter validation. The input is now bounded,
	// including Adam7 files and headers that a permissive decoder could reinterpret.
	PNG.sync.read(data, { checkCRC: true });
	return { width, height };
}

async function readResource(path: string): Promise<Resource> {
	const kind = extname(path).toLowerCase();
	if (kind !== ".svg" && kind !== ".png") throw new Error("支持的图片格式：SVG、PNG");
	// O_NONBLOCK avoids hanging the renderer if a link accidentally names a FIFO.
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	let data: Buffer;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("图片路径不是普通文件");
		if (stat.size > MAX_FILE_BYTES) throw new Error("图片超过 8 MiB");
		const buffer = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > stat.size) throw new Error("图片正在改写；完成后运行 /illustrated-render refresh");
		data = buffer.subarray(0, offset);
	} finally {
		await handle.close();
	}
	if (kind === ".png") {
		const base64 = data.toString("base64");
		const { width, height } = validatePng(data);
		return {
			width, height,
			svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${base64}"/></svg>`,
		};
	}
	const svg = data.toString("utf8");
	checkSvg(svg);
	// Parse once and convert text to paths using system fonts; no font download.
	const parsed = new Resvg(svg, { font: { loadSystemFonts: /<(?:[A-Za-z_][\w.-]*:)?text[\s/>]/.test(svg), defaultFontFamily: "sans-serif" } });
	checkDimensions(parsed.width, parsed.height);
	if (parsed.imagesToResolve().length) throw new Error("SVG 不支持外部资源");
	const normalized = parsed.toString();
	if (normalized.length > CACHE_BYTES) throw new Error("SVG 展开后过大");
	return { svg: normalized, width: parsed.width, height: parsed.height };
}

function errorText(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		if (error.code === "ENOENT") return "找不到图片；检查路径后运行 /illustrated-render refresh";
		if (error.code === "EACCES") return "没有读取图片的权限";
	}
	return error instanceof Error ? error.message : String(error);
}

/** Size on an exact cell canvas; aspect ratio is preserved even with fractional cell sizes. */
export function rasterLayout(width: number, height: number, maxColumns: number, cellW: number, cellH: number, maxRows = 28) {
	const columnsLimit = Math.max(1, Math.min(MAX_COLUMNS, MAX_PLACEHOLDER_CELLS, Math.floor(maxColumns)));
	const rowsLimit = Math.max(1, Math.min(MAX_PLACEHOLDER_CELLS, Math.floor(maxRows)));
	const scale = Math.min(1, columnsLimit * cellW / width, rowsLimit * cellH / height,
		MAX_RASTER_SIDE / (2 * width), MAX_RASTER_SIDE / (2 * height));
	const contentW = width * scale;
	const contentH = height * scale;
	const columns = Math.max(1, Math.ceil(contentW / cellW - 1e-8));
	const rows = Math.max(1, Math.ceil(contentH / cellH - 1e-8));
	return { columns, rows, contentW, contentH, canvasW: Math.round(columns * cellW * 2), canvasH: Math.round(rows * cellH * 2) };
}

/** One service per active session; shared by every streaming component replacement. */
export class IllustrationService implements IllustrationRenderer {
	private resources = new Map<string, ResourceEntry>();
	private resident = new Map<string, Resource>();
	/** Small geometry records let cached pixels outlive their parsed source. */
	private sizes = new Map<string, Size>();
	private rasters = new Map<string, Raster>();
	/** Copy identity is separate from pixels: two captions can share one raster. */
	private placements = new Map<string, number>();
	private jobs = new Set<Promise<void>>();
	private generation = 0;
	private resourceBytes = 0;
	private rasterBytes = 0;
	readonly stats = { rasterized: 0, rasterHits: 0 };
	private disposed = false;
	constructor(private readonly cwd: string, private readonly changed = () => { bumpVersion(); requestRender(); }) {}

	get key(): string {
		const cell = getCellDimensions();
		return JSON.stringify([this.cwd, this.generation, state.imagesAllowed, state.illustrations, state.imageBackground, state.imageMaxRows, imageMode(), cell.widthPx, cell.heightPx]);
	}

	/** Await scheduled reads (test/preview harness); rendering itself never blocks on I/O. */
	async idle(): Promise<void> { await Promise.all(this.jobs); }

	clear(): void {
		this.generation++;
		this.resources.clear();
		this.resident.clear();
		this.sizes.clear();
		this.rasters.clear();
		this.placements.clear();
		this.resourceBytes = this.rasterBytes = 0;
		this.stats.rasterized = this.stats.rasterHits = 0;
	}

	dispose(): void { this.disposed = true; this.clear(); }

	private resource(path: string): ResourceEntry {
		const hit = this.resources.get(path);
		if (hit) {
			if (hit.status === "ready") { this.resident.delete(path); this.resident.set(path, hit.value); }
			return hit;
		}
		const pending: ResourceEntry = { status: "pending" };
		this.resources.set(path, pending);
		const generation = this.generation;
		const job = readResource(path).then(
			(value): ResourceEntry => ({ status: "ready", value }),
			(error): ResourceEntry => ({ status: "error", message: errorText(error) }),
		).then((entry) => {
			if (this.disposed || generation !== this.generation) return;
			this.resources.set(path, entry);
			if (entry.status === "ready") {
				this.resourceBytes += entry.value.svg.length;
				this.resident.set(path, entry.value);
				this.sizes.set(path, { width: entry.value.width, height: entry.value.height });
			}
			while (this.resident.size > 64 || this.resourceBytes > CACHE_BYTES) {
				const first = this.resident.keys().next().value!;
				this.resourceBytes -= this.resident.get(first)!.svg.length;
				this.resident.delete(first);
				// Retain a lightweight tombstone: never make redraw → read → eviction
				// schedule itself forever when the transcript exceeds the working set.
				this.resources.set(first, { status: "error", message: "插图源缓存已满；可运行 /illustrated-render refresh 或打开原图" });
			}
			this.changed();
		});
		this.jobs.add(job);
		void job.finally(() => this.jobs.delete(job));
		return pending;
	}

	block(image: IllustrationRequest, maxColumns: number): IllustrationResult {
		if (!state.imagesAllowed) return { status: "fallback", message: "终端图片已关闭（terminal.showImages）" };
		if (this.disposed || !state.illustrations) return { status: "fallback", message: "图片显示已关闭" };
		if (imageMode() === "off") return { status: "fallback", message: "终端不支持 Kitty 图像" };
		try {
			const path = resolveImagePath(image.href, this.cwd);
			const cell = getCellDimensions();
			let size = this.sizes.get(path);
			if (!size) {
				const resource = this.resource(path);
				if (resource.status === "pending") return { status: "fallback", message: "图片加载中…" };
				if (resource.status === "error") return { status: "fallback", message: resource.message };
				size = resource.value;
			}
			const { width, height } = size;
			const { contentW, contentH, canvasW, canvasH, columns, rows } = rasterLayout(width, height, maxColumns, cell.widthPx, cell.heightPx, state.imageMaxRows);
			// Window width and caption do not identify pixels. Reuse the exact canvas
			// whenever the final scale and cell grid are unchanged (e.g. 110 → 109 cols).
			const key = JSON.stringify([path, contentW, contentH, canvasW, canvasH, columns, rows, state.imageBackground]);
			let raster = this.rasters.get(key);
			if (raster) {
				this.rasters.delete(key);
				this.rasters.set(key, raster);
				this.stats.rasterHits++;
			} else {
				const resource = this.resource(path);
				if (resource.status === "pending") return { status: "fallback", message: "图片加载中…" };
				if (resource.status === "error") return { status: "fallback", message: resource.message };
				const x = (canvasW - contentW * 2) / 2;
				const y = (canvasH - contentH * 2) / 2;
				const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}"><g transform="translate(${x},${y}) scale(${contentW * 2 / width})">${resource.value.svg}</g></svg>`;
				const base64 = new Resvg(canvas, { font: { loadSystemFonts: false }, background: BACKGROUNDS[state.imageBackground] }).render().asPng().toString("base64");
				raster = { base64, columns, rows };
				this.rasters.set(key, raster);
				this.rasterBytes += base64.length;
				this.stats.rasterized++;
				while (this.rasters.size > 128 || this.rasterBytes > CACHE_BYTES) {
					const first = this.rasters.keys().next().value!;
					this.rasterBytes -= this.rasters.get(first)!.base64.length;
					this.rasters.delete(first);
				}
			}
			const placementKey = JSON.stringify([key, image.source]);
			let id = this.placements.get(placementKey);
			if (id === undefined) id = allocateId();
			this.placements.delete(placementKey);
			this.placements.set(placementKey, id);
			if (this.placements.size > 512) this.placements.delete(this.placements.keys().next().value!);
			registerImage(id, raster.base64, raster.columns, raster.rows);
			rememberFormulaSource(id, image.source, true);
			return { status: "ready", lines: placeholderRows(id, raster.columns, raster.rows), columns: raster.columns, sourceUrl: pathToFileURL(path).href };
		} catch (error) {
			return { status: "fallback", message: errorText(error) };
		}
	}
}
