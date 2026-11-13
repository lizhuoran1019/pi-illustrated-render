import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PNG } from "pngjs";
import { Resvg } from "@resvg/resvg-js";
import { decode } from "sixel";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, stripTerminalSequences, TuiAltScreen, type Terminal, type TerminalColors } from "@earendil-works/pi-tui";
import {
	captureImageRecovery, deleteImages, forgetImages, imageMode, installFrameHook,
	PLACEHOLDER, placeholderRows, registerImage, setKittyWriter, useImageRecoveries, type ImageRecoveries,
} from "../src/math/kitty.ts";
import { SixelCache, type SixelImage } from "../src/math/sixel.ts";
import { loadMathJax, rasterize } from "../src/math/mathjax.ts";
import { installSixelCellSize } from "../src/sixel-terminal.ts";
import { installDirectRedraw } from "../src/direct-redraw.ts";
import { forgetFormulaSources, rememberFormulaSource, selectionWithFormulas } from "../src/math/copy.ts";

const FIRST = 0x300000;
const initialMode = process.env.PI_BETTER_RENDER_IMAGES;
let uninstall: (() => void) | undefined;

function image(columns = 4, rows = 2, pixel = (x: number, y: number): number[] => [x < 32 ? 255 : 0, y < 32 ? 0 : 255, x < 32 ? 0 : 255, 255]): SixelImage {
	const png = new PNG({ width: columns * 16, height: rows * 32 });
	for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
		png.data.set(pixel(x, y), (y * png.width + x) * 4);
	}
	const base64 = PNG.sync.write(png).toString("base64");
	return { key: createHash("sha256").update(base64).digest("hex"), base64, columns, rows };
}

function sixels(text: string) {
	return [...text.matchAll(/\x1bP[\d;]*q([\s\S]*?)\x1b\\/g)].map((match) => decode(match[1]!, { fillColor: 0, memoryLimit: 16 * 1024 * 1024 }));
}
function pixel(decoded: ReturnType<typeof decode>, x: number, y: number): number[] {
	return [...decoded.data8.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4)];
}
function capture(getColors?: () => TerminalColors) {
	let output = "";
	const terminal = { write(data: string) { output += data; } };
	uninstall = installFrameHook(terminal, "sixel", getColors);
	return (text: string) => { output = ""; terminal.write(text); return output; };
}

beforeEach(() => {
	process.env.PI_BETTER_RENDER_IMAGES = "sixel";
	setKittyWriter(undefined);
	setCellDimensions({ widthPx: 8, heightPx: 16 });
	forgetImages(); forgetFormulaSources();
});
afterEach(() => {
	uninstall?.(); uninstall = undefined;
	forgetImages(); forgetFormulaSources(); setKittyWriter(undefined);
	if (initialMode === undefined) delete process.env.PI_BETTER_RENDER_IMAGES;
	else process.env.PI_BETTER_RENDER_IMAGES = initialMode;
});

test("Windows Terminal selects Sixel without pretending that Pi supports Kitty", () => {
	assert.equal(imageMode({ WT_SESSION: "test" }, false), "sixel");
	assert.equal(imageMode({ WT_SESSION: "test", TERM_PROGRAM: "WindowsTerminal" }, false), "sixel");
	for (const inherited of [{ TERM_PROGRAM: "vscode" }, { TMUX: "test" }, { STY: "test" }, { SSH_CONNECTION: "test" }, { SSH_TTY: "/dev/pts/1" }]) {
		assert.equal(imageMode({ WT_SESSION: "test", ...inherited }, false), "off");
	}
	assert.equal(imageMode({ WT_SESSION: "inherited", TERM: "xterm-kitty" }, true), "placeholder");
	assert.equal(imageMode({ WT_SESSION: "inherited", TERM_PROGRAM: "WezTerm" }, true), "direct");
	assert.equal(imageMode({ WT_SESSION: "test", PI_BETTER_RENDER_IMAGES: "off" }, false), "off");
	assert.equal(imageMode({ PI_BETTER_RENDER_IMAGES: "SIXEL", TMUX: "verified externally" }, false), "sixel");
	assert.equal(imageMode({}, false), "off");
	assert.equal(imageMode({ TERM_PROGRAM: "kitty", PI_BETTER_RENDER_PLACEHOLDERS: "0" }, true), "off");
});

test("2x PNGs are scaled to physical cell pixels; row/column crops decode correctly", () => {
	const cache = new SixelCache(), source = image();
	const top = sixels(cache.slice(source, 0, 0, 4)!)[0]!;
	assert.deepEqual([top.width, top.height], [32, 16]);
	assert.deepEqual(pixel(top, 4, 8), [255, 0, 0, 255]);
	assert.deepEqual(pixel(top, 24, 8), [0, 0, 255, 255]);
	const bottomRight = sixels(cache.slice(source, 1, 2, 2)!)[0]!;
	assert.deepEqual([bottomRight.width, bottomRight.height], [16, 16]);
	assert.deepEqual(pixel(bottomRight, 8, 8), [0, 255, 255, 255]);
	assert.deepEqual(cache.stats, { rasterized: 1, encoded: 2 });
	assert.ok(!cache.slice(source, 1, 2, 2)!.includes("\n"));
	assert.deepEqual(cache.stats, { rasterized: 1, encoded: 2 }, "repeat frames reuse encoded slices");
});

test("alpha edges blend against the background without dropping pixels or painting transparent space", () => {
	const cache = new SixelCache();
	for (const background of [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, { r: 23, g: 26, b: 33 }]) {
		const bg = [background.r, background.g, background.b];
		for (const foreground of [0, 255]) for (const alpha of [0, 1, 64, 128, 254, 255]) {
			const source = image(2, 1, () => [foreground, foreground, foreground, alpha]);
			const decoded = sixels(cache.slice(source, 0, 0, 2, background)!)[0]!;
			for (let i = 0; i < decoded.data8.length; i += 4) {
				assert.equal(decoded.data8[i + 3], alpha === 0 ? 0 : 255, "coverage is never dithered");
				if (!alpha) continue;
				for (let c = 0; c < 3; c++) {
					const expected = foreground * alpha / 255 + bg[c]! * (255 - alpha) / 255;
					assert.ok(Math.abs(decoded.data8[i + c]! - expected) <= 2, "alpha composition and Sixel's 1% channel precision");
				}
			}
		}
	}
});

test("small real formula glyphs preserve every covered pixel and antialiased shade on light/dark backgrounds", async () => {
	await loadMathJax();
	const cache = new SixelCache();
	for (const cellHeight of [16, 24, 32]) {
		const cellWidth = cellHeight / 2;
		setCellDimensions({ widthPx: cellWidth, heightPx: cellHeight });
		for (const background of [{ r: 23, g: 26, b: 33 }, { r: 255, g: 255, b: 255 }]) {
			const color = background.r === 255 ? "#1f2328" : "#e5e7eb";
			const bg = [background.r, background.g, background.b];
			for (const tex of ["dS", String.raw`\vec{E}`, String.raw`\hat{n}`, String.raw`\theta`]) {
				const rendered = rasterize({ tex, display: false, color, cellWidth, cellHeight, maxColumns: 20, maxRows: 1, fitRows: true, inlineLayout: "text" });
				const source = { ...rendered, key: `${tex}:${cellHeight}:${color}` };
				const width = source.columns * cellWidth, height = source.rows * cellHeight;
				// Reference: the very same transparent PNG scaled to physical pixels,
				// then ordinary alpha composition (what Kitty does), without Sixel.
				const reference = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${source.base64}"/></svg>`, { font: { loadSystemFonts: false } }).render().pixels;
				const decoded = sixels(cache.slice(source, 0, 0, source.columns, background)!)[0]!;
				assert.deepEqual([decoded.width, decoded.height], [width, height]);
				const edgeShades = new Set<number>();
				for (let i = 0; i < reference.length; i += 4) {
					const alpha = reference[i + 3]!;
					assert.equal(decoded.data8[i + 3], alpha ? 255 : 0, `${tex} at ${cellHeight}px: no holes or opaque canvas`);
					if (!alpha) continue;
					if (alpha < 255) edgeShades.add(decoded.data32[i / 4]!);
					for (let c = 0; c < 3; c++) {
						const expected = reference[i + c]! + bg[c]! * (255 - alpha) / 255;
						assert.ok(Math.abs(decoded.data8[i + c]! - expected) <= 2, `${tex}: antialiasing matches alpha composition within palette precision`);
					}
				}
				assert.ok(edgeShades.size > 8, `${tex}: smooth edge shades, not binary foreground/transparent`);
			}
		}
	}
});

test("background identity invalidates both raster and encoded-slice caches", () => {
	const cache = new SixelCache(), source = image(2, 1, () => [255, 255, 255, 128]);
	const dark = { r: 0, g: 0, b: 0 }, light = { r: 255, g: 255, b: 255 };
	const first = cache.slice(source, 0, 0, 2, dark)!;
	const second = cache.slice(source, 0, 0, 2, light)!;
	assert.notEqual(first, second);
	assert.deepEqual(pixel(sixels(second)[0]!, 4, 8), [255, 255, 255, 255]);
	assert.equal(cache.slice(source, 0, 0, 2, { ...dark }), first);
	assert.deepEqual(cache.stats, { rasterized: 2, encoded: 2 });
});

test("antialiasing is identical in full rows and clipped column slices", () => {
	const cache = new SixelCache(), source = image(4, 2, (x, y) => [255, 255, 255, (x * 7 + y * 13) % 256]);
	const background = { r: 23, g: 26, b: 33 };
	for (const row of [0, 1]) {
		const full = sixels(cache.slice(source, row, 0, 4, background)!)[0]!;
		for (const column of [0, 2]) {
			const crop = sixels(cache.slice(source, row, column, 2, background)!)[0]!;
			for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
				assert.deepEqual(pixel(crop, x, y), pixel(full, x + column * 8, y));
			}
		}
	}
	assert.equal(cache.stats.rasterized, 1);
});

test("frame edges follow local SGR backgrounds, split writes, and changing terminal defaults", () => {
	const colors: TerminalColors = { background: { r: 0, g: 0, b: 0 } };
	const write = capture(() => colors), source = image(2, 1, () => [255, 255, 255, 128]);
	registerImage(FIRST, source.base64, source.columns, source.rows);
	const row = placeholderRows(FIRST, 2, 1)[0]!;
	const check = (text: string, bg: number[]) => {
		const rgba = pixel(sixels(write(text))[0]!, 4, 8);
		assert.equal(rgba[3], 255);
		for (let c = 0; c < 3; c++) assert.ok(Math.abs(rgba[c]! - (128 + bg[c]! * 127 / 255)) <= 2);
	};
	check("\x1b[48;2;23;45;67m" + row, [23, 45, 67]);
	check(row, [23, 45, 67]); // Image-ID foreground RGB must not reset the background.
	write("\x1b[48;2;");
	check("40;60;80m" + row, [40, 60, 80]);
	check("\x1b[49m" + row, [0, 0, 0]);
	colors.background = { r: 255, g: 255, b: 255 };
	check(row, [255, 255, 255]); // Same PNG, new OSC 11 reply: no stale dark edges.
	check("\x1b[48:2::23:45:67m" + row, [23, 45, 67]);
	check("\x1bc" + row, [255, 255, 255]);
	check("\x1b[48;5;17m" + row, [0, 0, 95]);
	check("\x1b[0m" + row, [255, 255, 255]);
	colors.palette = Array.from({ length: 16 }, () => ({ r: 10, g: 20, b: 30 }));
	check("\x1b[41m" + row, [10, 20, 30]);
	colors.palette[1] = { r: 100, g: 120, b: 140 };
	check(row, [100, 120, 140]);
});

test("photographic colors are quantized to at most 256 registers without losing coverage", () => {
	const cache = new SixelCache();
	const source = image(8, 2, (x, y) => [x * 2, y * 4, (x * 17 + y * 7) % 256, 255]);
	const encoded = cache.slice(source, 0, 0, 8)!;
	assert.ok(encoded);
	assert.ok([...encoded.matchAll(/#\d+;2;/g)].length <= 256);
	const decoded = sixels(encoded)[0]!;
	for (let i = 3; i < decoded.data8.length; i += 4) assert.equal(decoded.data8[i], 255);
	assert.ok(new Set(decoded.data32).size > 16);
});

test("cell-size changes miss caches; raster and encoded caches have independent byte limits", () => {
	const cache = new SixelCache(8 * 1024);
	const source = image();
	cache.slice(source, 0, 0, 4);
	setCellDimensions({ widthPx: 10, heightPx: 21 });
	const resized = sixels(cache.slice(source, 0, 0, 4)!)[0]!;
	assert.deepEqual([resized.width, resized.height], [40, 21]);
	assert.equal(cache.stats.rasterized, 2);
	for (let i = 0; i < 40; i++) cache.slice(image(4, 2, () => [i * 5, 0, 0, 255]), 0, 0, 4);
	assert.ok(cache.bytes <= 16 * 1024);
	cache.clear();
	assert.equal(cache.bytes, 0);
	assert.deepEqual(cache.stats, { rasterized: 0, encoded: 0 });
});

test("invalid dimensions/crops fail closed instead of allocating or writing escapes", () => {
	const cache = new SixelCache(), source = image();
	for (const [row, start, length] of [[-1, 0, 1], [2, 0, 1], [0, -1, 1], [0, 0, 5], [0, 0, 0], [0, 0.5, 1]]) {
		assert.equal(cache.slice(source, row!, start!, length!), undefined);
	}
	assert.equal(cache.slice({ ...source, key: "bad", base64: "invalid" }, 0, 0, 1), undefined);
	assert.equal(cache.slice({ ...source, columns: 10000 }, 0, 0, 1), undefined);
	assert.equal(cache.slice(source, 0, 0, 1, { r: NaN, g: 0, b: 0 }), undefined);
	assert.equal(cache.stats.rasterized, 0);
});

test("frames contain Sixel row slices with cursor save/restore, never Kitty or placeholders", () => {
	const write = capture(), source = image();
	registerImage(FIRST, source.base64, source.columns, source.rows);
	rememberFormulaSource(FIRST, "![diagram](example.svg)", true);
	const rows = placeholderRows(FIRST, 4, 2);
	for (const prefix of ["", "\x1b[2J", "\x1b[3J"]) {
		const output = write(prefix + "before" + rows.join("\r\n") + "after");
		assert.equal(output.includes(PLACEHOLDER), false);
		assert.equal(output.includes("\x1b_G"), false);
		assert.ok(output.startsWith(prefix + "before"));
		assert.ok(output.endsWith("after"));
		assert.equal((output.match(/\x1b7/g) ?? []).length, 2);
		assert.equal((output.match(/\x1b8\x1b\[4C/g) ?? []).length, 2);
		assert.deepEqual(sixels(output).map(({ width, height }) => [width, height]), [[32, 16], [32, 16]]);
	}
	assert.equal(selectionWithFormulas(rows), "![diagram](example.svg)");
});

test("single-code-unit writes preserve split escapes, surrogate pairs and partial image runs", () => {
	const write = capture(), source = image();
	registerImage(FIRST, source.base64, 4, 2);
	const input = "\x1b[2J" + placeholderRows(FIRST, 4, 2).join("\r\n") + "\x1b[31mend\x1b[0m";
	let output = "";
	for (let i = 0; i < input.length; i++) output += write(input[i]!);
	assert.ok(!output.includes(PLACEHOLDER) && !output.includes("\x1b_G"));
	assert.ok(output.endsWith("\x1b[31mend\x1b[0m"));
	const decoded = sixels(output);
	assert.equal(decoded.reduce((sum, part) => sum + part.width * part.height, 0), 32 * 32);
	assert.ok(decoded.every((part) => part.height === 16 && part.width <= 32));
});

test("no-hook Sixel registration and cache clear never send Kitty uploads/deletions", () => {
	const writes: string[] = [];
	setKittyWriter((data) => writes.push(data));
	const source = image();
	registerImage(FIRST, source.base64, 4, 2);
	assert.equal(writes.length, 0);
	const write = capture();
	assert.equal(sixels(write(placeholderRows(FIRST, 4, 2).join("\n"))).length, 2);
	deleteImages((data) => writes.push(data));
	assert.deepEqual(writes, []);
	const fallback = write(placeholderRows(FIRST, 24, 1)[0]!);
	assert.equal(stripTerminalSequences(fallback), "? image unavailable".padEnd(24));
	assert.ok(!fallback.includes(PLACEHOLDER));
});

test("corrupt registered pixels get text fallback without exposing internal placeholders", () => {
	const write = capture();
	registerImage(FIRST, "invalid", 24, 1);
	const output = write(placeholderRows(FIRST, 24, 1)[0]!);
	assert.equal(stripTerminalSequences(output), "? image unavailable".padEnd(24));
	assert.ok(!output.includes(PLACEHOLDER) && !output.includes("\x1b_G") && !output.includes("\x1bP"));
});

test("evicted Sixel sources recover only when their cached rows become visible", () => {
	const write = capture(), source = image(1, 1);
	const recipes: ImageRecoveries = new Map();
	let calls = 0;
	const render = () => { calls++; registerImage(FIRST, source.base64, 1, 1); return placeholderRows(FIRST, 1, 1)[0]!; };
	const row = captureImageRecovery(recipes, render);
	useImageRecoveries(recipes); write(row);
	for (let i = 1; i <= 4000; i++) registerImage(FIRST + i, source.base64, 1, 1);
	write("unrelated frame");
	useImageRecoveries(recipes);
	assert.equal(calls, 1);
	assert.equal(sixels(write("\x1b[2J" + row)).length, 1);
	assert.equal(calls, 2);
});

test("Sixel cell-size probing uses Pi's parser and removes its resize listener on shutdown", () => {
	const events = new EventEmitter(), writes: string[] = [];
	const terminal = { write(data: string) { writes.push(data); } };
	let stop = installSixelCellSize(terminal, "placeholder", events);
	events.emit("resize"); assert.deepEqual(writes, []); stop();
	stop = installSixelCellSize(terminal, "sixel", events);
	assert.deepEqual(writes, ["\x1b[16t"]);
	events.emit("resize"); assert.deepEqual(writes, ["\x1b[16t", "\x1b[16t"]);
	stop(); stop();
	assert.equal(events.listenerCount("resize"), 0);
	events.emit("resize"); assert.equal(writes.length, 2);
});

test("real Pi fullscreen frames crop on scroll/resize and consume Sixel cell-size replies", () => {
	const previousCaps = getCapabilities();
	setCapabilities({ ...previousCaps, images: null });
	let output = "";
	let input: (data: string) => void = () => {};
	let resize: () => void = () => {};
	const terminal = {
		columns: 20, rows: 5, kittyProtocolActive: false,
		start(onInput, onResize) { input = onInput; resize = onResize; }, stop() {}, async drainInput() {},
		write(data) { output += data; }, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	} satisfies Terminal;
	class TestTui extends TuiAltScreen { flush() { this.doRender(); } }
	const tui = new TestTui(terminal, false, undefined, { mouse: false });
	const source = image(4, 8, (_x, y) => [Math.floor(y / 32) * 30, 0, 255, 255]);
	let visible = true;
	tui.addChild({
		render() {
			if (!visible) return ["no image"];
			registerImage(FIRST, source.base64, 4, 8);
			return ["above", ...placeholderRows(FIRST, 4, 8), "below", "end"];
		}, invalidate() {},
	});
	uninstall = installFrameHook(terminal, "sixel");
	const stopRedraw = installDirectRedraw(tui, "sixel");
	const events = new EventEmitter();
	let stopSize = () => {};
	const frame = () => { output = ""; tui.flush(); return output; };
	try {
		tui.start();
		stopSize = installSixelCellSize(terminal, "sixel", events);
		assert.ok(output.includes("\x1b[16t"));
		input("\x1b[6;16;8t");
		assert.deepEqual(getCellDimensions(), { widthPx: 8, heightPx: 16 });
		frame(); // Establish the document extent before scrolling away from follow-end.
		tui.scrollToTop();
		const top = frame();
		assert.ok(top.includes("\x1b[2J"));
		assert.equal(sixels(top).length, 4, JSON.stringify(tui.getScreenLines()));
		assert.deepEqual(pixel(sixels(top)[0]!, 8, 8), [0, 0, 255, 255]);
		tui.scrollBy(3);
		const scrolled = frame();
		assert.equal(sixels(scrolled).length, 5);
		const [red, green, blue] = pixel(sixels(scrolled)[0]!, 8, 8);
		assert.ok(Math.abs(red! - 60) <= 2 && green === 0 && blue === 255, "top-clipped image starts at source row 2");
		terminal.rows = 4; terminal.columns = 12; resize(); events.emit("resize");
		input("\x1b[6;20;10t");
		const resized = frame();
		assert.ok(sixels(resized).every((part) => part.width === 40 && part.height === 20));
		assert.ok(!resized.includes(PLACEHOLDER) && !resized.includes("\x1b_G"));
		visible = false; tui.invalidate();
		const cleared = frame();
		assert.ok(cleared.includes("\x1b[2J") && cleared.includes("no image"));
		assert.equal(sixels(cleared).length, 0);
	} finally {
		tui.stop(); stopSize(); stopRedraw(); setCapabilities(previousCaps);
	}
});

test("Sixel fullscreen redraw removes old pixels; regular mode does not duplicate scrollback", () => {
	const calls: string[] = [];
	const host = { mode: "fullscreen", resetRenderState() { calls.push("reset"); }, doRender() { calls.push("render"); } };
	const original = host.doRender;
	let stop = installDirectRedraw(host, "sixel");
	host.doRender(); host.doRender();
	assert.deepEqual(calls, ["reset", "render", "reset", "render"]);
	stop(); assert.equal(host.doRender, original);
	host.mode = "regular"; stop = installDirectRedraw(host, "sixel");
	assert.equal(host.doRender, original); stop();
});
