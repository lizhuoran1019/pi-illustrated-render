/** Sixel has no image IDs or scaling: cache physical-pixel rasters and row slices. */
import { getCellDimensions, getPngDimensions, type RgbColor } from "@earendil-works/pi-tui";
import { validRgb } from "./sixel-colors.ts";
import { Resvg } from "@resvg/resvg-js";
import { FINALIZER, introducer, sixelEncode, toRGBA8888 } from "sixel";
// Pinned to sixel 0.16.0. image2sixel's indexed encoder ignores transparency;
// use its quantizer but restore the binary alpha mask before sixelEncode.
import { reduce } from "sixel/lib/Quantizer.js";

interface Raster {
	width: number;
	height: number;
	pixels: Uint8Array;
	palette: number[];
}
export interface SixelImage {
	key: string;
	base64: string;
	columns: number;
	rows: number;
}

class Cache<T> {
	private entries = new Map<string, { value: T; bytes: number }>();
	bytes = 0;
	constructor(private readonly limit: number, private readonly maxEntries: number) {}
	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key); this.entries.set(key, entry);
		return entry.value;
	}
	set(key: string, value: T, bytes: number): void {
		if (bytes > this.limit) return;
		const previous = this.entries.get(key);
		if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
		while (this.entries.size && (this.bytes + bytes > this.limit || this.entries.size >= this.maxEntries)) {
			const oldest = this.entries.keys().next().value!;
			this.bytes -= this.entries.get(oldest)!.bytes;
			this.entries.delete(oldest);
		}
		this.entries.set(key, { value, bytes }); this.bytes += bytes;
	}
	clear(): void { this.entries.clear(); this.bytes = 0; }
}

/** Composite antialiased edges, then preserve exact colors when possible.
 * Fully transparent pixels stay transparent; do not add an opaque canvas.
 */
function quantize(pixels: Uint8Array, width: number, background: RgbColor): number[] {
	const bg = [background.r, background.g, background.b];
	const words = new Uint32Array(pixels.buffer);
	const colors = new Set<number>();
	const transparent = new Uint8Array(words.length);
	for (let i = 0; i < words.length; i++) {
		const alpha = pixels[i * 4 + 3]!;
		if (alpha === 0) {
			transparent[i] = 1; words[i] = 0;
		} else {
			// resvg.pixels is already premultiplied: C_out = C_pm + B*(1-a).
			// Binary coverage dithering drops thin glyph strokes; using gray/color
			// edge shades keeps every covered pixel instead of punching holes.
			if (alpha < 255) for (let channel = 0; channel < 3; channel++) {
				const offset = i * 4 + channel;
				pixels[offset] = Math.min(255, Math.round(pixels[offset]! + bg[channel]! * (255 - alpha) / 255));
			}
			pixels[i * 4 + 3] = 255;
			if (colors.size <= 256) colors.add(words[i]!);
		}
	}
	if (colors.size <= 256) return colors.size ? [...colors] : [toRGBA8888(0, 0, 0)];
	const result = reduce(pixels, width, 256);
	// The quantizer may create semi-transparent palette entries. The encoder
	// only knows opaque colors and a skipped pixel, so normalize both together.
	const palette = result.palette.map((color) => (color | 0xff000000) >>> 0);
	for (let i = 0; i < words.length; i++) words[i] = transparent[i] ? 0 : palette[result.indices[i]!]!;
	return palette;
}

/** Additional memory is bounded independently of the shared PNG registry. */
export class SixelCache {
	private rasters: Cache<Raster | null>;
	private slices: Cache<string>;
	readonly stats = { rasterized: 0, encoded: 0 };
	constructor(byteLimit = 16 * 1024 * 1024) {
		this.rasters = new Cache(byteLimit, 64);
		this.slices = new Cache(byteLimit, 1024);
	}
	get bytes(): number { return this.rasters.bytes + this.slices.bytes; }
	clear(): void {
		this.rasters.clear(); this.slices.clear();
		this.stats.rasterized = this.stats.encoded = 0;
	}

	/** Undefined means invalid/unrenderable pixels; the writer must use text. */
	slice(image: SixelImage, row: number, start: number, length: number, background: RgbColor = { r: 0, g: 0, b: 0 }): string | undefined {
		const cell = getCellDimensions();
		if (![row, start, length, image.columns, image.rows].every(Number.isInteger) ||
			row < 0 || row >= image.rows || start < 0 || length < 1 || start + length > image.columns ||
			!Number.isFinite(cell.widthPx + cell.heightPx) || cell.widthPx < 1 || cell.heightPx < 1 || !validRgb(background)) return;
		const width = Math.round(image.columns * cell.widthPx), height = Math.round(image.rows * cell.heightPx);
		if (width > 4096 || height > 4096 || width * height > 16_000_000) return;
		const key = `${image.key}:${image.columns}:${image.rows}:${cell.widthPx}:${cell.heightPx}:${background.r},${background.g},${background.b}`;
		const sliceKey = `${key}:${row}:${start}:${length}`;
		const cached = this.slices.get(sliceKey);
		if (cached !== undefined) return cached;
		let raster = this.rasters.get(key);
		if (raster === null) return;
		try {
			if (!raster) {
				const dimensions = getPngDimensions(image.base64);
				if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 ||
					dimensions.widthPx * dimensions.heightPx > 16_000_000) throw new Error("Invalid Sixel source dimensions");
				// Existing renderers supply 2x PNGs. Unlike Kitty, Sixel paints one
				// source pixel per screen pixel, so downscale BEFORE encoding.
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${image.base64}"/></svg>`;
				const rendered = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
				// sixel's encoder/quantizer use .buffer without .byteOffset. Never
				// pass a pooled Node Buffer or a cropped subarray to either one.
				const pixels = Uint8Array.from(rendered.pixels);
				raster = { width, height, pixels, palette: quantize(pixels, width, background) };
				this.rasters.set(key, raster, pixels.byteLength + raster.palette.length * 4);
				this.stats.rasterized++;
			}
			const x = Math.round(start * cell.widthPx), y = Math.round(row * cell.heightPx);
			const w = Math.round((start + length) * cell.widthPx) - x;
			const h = Math.round((row + 1) * cell.heightPx) - y;
			const pixels = new Uint8Array(w * h * 4);
			for (let line = 0; line < h; line++) {
				const offset = ((y + line) * raster.width + x) * 4;
				pixels.set(raster.pixels.subarray(offset, offset + w * 4), line * w * 4);
			}
			// No trailing band advance: that could scroll the bottom screen row.
			const sequence = introducer(1) + sixelEncode(pixels, w, h, raster.palette).replaceAll("\n", "") + FINALIZER;
			this.slices.set(sliceKey, sequence, sequence.length);
			this.stats.encoded++;
			return sequence;
		} catch {
			this.rasters.set(key, null, 0);
			return;
		}
	}
}
