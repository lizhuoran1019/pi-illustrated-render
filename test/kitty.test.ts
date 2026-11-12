import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { PNG } from "pngjs";
import { setCellDimensions, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { forgetFormulaSources, rememberFormulaSource, selectionWithFormulas } from "../src/math/copy.ts";
import {
	createDirectRewriter, deleteImages, forgetImages, installFrameHook, PLACEHOLDER,
	placeholderRows, prepareFrame, registerImage, setKittyWriter, type ImageMode,
} from "../src/math/kitty.ts";
import { state } from "../src/state.ts";
import { clearLexCache } from "../src/render/lexer.ts";
import { cacheStats, clearBlockCache, RichMarkdown } from "../src/render/rich-markdown.ts";
import { noMath, type MathRenderer } from "../src/render/context.ts";
import { plainStyle } from "../src/style.ts";
import { IllustrationService } from "../src/illustrations.ts";
import { clearFormulaCache, createMathRenderer } from "../src/math/formula.ts";
import { loadMathJax } from "../src/math/mathjax.ts";
import { fileURLToPath } from "node:url";

const BYTES = 64 * 1024 * 1024;
const FIRST = 0x200000;
const modes = ["placeholder", "direct"] as const;
const originalMode = process.env.PI_BETTER_RENDER_IMAGES;
let uninstall: (() => void) | undefined;

// Real, deterministic PNGs. Uncompressed scanlines make the budget independent
// of compression ratios; changing the first pixel gives genuinely distinct data.
function png(tag = 0, side = 1): string {
	const image = new PNG({ width: side, height: side });
	image.data[0] = tag;
	image.data[1] = tag >>> 8;
	image.data[3] = 255;
	return PNG.sync.write(image, { deflateLevel: 0, filterType: 0 }).toString("base64");
}
const tiny = png();

function capture(mode: ImageMode) {
	let output = "";
	const terminal = { write(data: string) { output = data; } };
	uninstall = installFrameHook(terminal, mode);
	return (data: string) => { output = ""; terminal.write(data); return output; };
}
function transmissions(output: string): number[] {
	return [...output.matchAll(/\x1b_Ga=[Tt],f=100,q=2,(?:U=1,)?i=(\d+)[,;]/g)].map((m) => Number(m[1]));
}
function frame(id: number, columns = 1, rows = 1): string {
	return placeholderRows(id, columns, rows).join("\n");
}

beforeEach(() => {
	setKittyWriter(undefined);
	setCellDimensions({ widthPx: 8, heightPx: 16 });
	forgetImages();
	forgetFormulaSources();
	clearBlockCache();
	clearLexCache();
});
afterEach(() => {
	uninstall?.(); uninstall = undefined;
	forgetImages();
	forgetFormulaSources();
	setKittyWriter(undefined);
	if (originalMode === undefined) delete process.env.PI_BETTER_RENDER_IMAGES;
	else process.env.PI_BETTER_RENDER_IMAGES = originalMode;
});

for (const mode of modes) {
	test(`${mode}: fifty copy IDs share one payload, survive repeated clear frames and keep geometry`, () => {
		const write = capture(mode);
		const base64 = png(1, 512);
		assert.ok(base64.length * 50 > BYTES, "reproduces the original per-ID accounting overflow");
		const ids = Array.from({ length: 50 }, (_, i) => FIRST + i);
		const version = state.version;
		for (let pass = 0; pass < 3; pass++) {
			for (const id of ids) registerImage(id, base64, 64, 28);
			write("\x1b[2J");
			for (const id of ids) assert.deepEqual(transmissions(write(frame(id))), [id]);
			for (const id of ids) assert.deepEqual(transmissions(write(frame(id))), []);
		}
		assert.equal(state.version, version);
		rememberFormulaSource(ids[0]!, "![first](same.png)", true);
		rememberFormulaSource(ids[1]!, "![second](same.png)", true);
		assert.equal(selectionWithFormulas([frame(ids[0]!), frame(ids[1]!)]), "![first](same.png)\n![second](same.png)");
		registerImage(FIRST + 100, base64, 32, 14);
		const output = write(frame(FIRST + 100));
		assert.deepEqual(transmissions(output), [FIRST + 100]);
		assert.match(output, mode === "placeholder" ? /c=32,r=14/ : /x=0,y=0,w=16,h=37,c=1,r=1/);
	});

	test(`${mode}: distinct payload pressure pins this batch, falls back stably and recovers after eviction`, () => {
		const write = capture(mode);
		const sample = png(0, 512);
		const count = Math.floor(BYTES / sample.length);
		const images = Array.from({ length: count + 2 }, (_, i) => png(i, 512));
		assert.ok(images.every((data) => data.length === sample.length));
		assert.equal(new Set(images).size, images.length);
		const version = state.version;
		for (let pass = 0; pass < 2; pass++) {
			images.forEach((data, i) => registerImage(FIRST + i, data, 32, 1));
			write("\x1b[2J");
			for (let i = 0; i < images.length; i++) {
				const output = write(frame(FIRST + i, 32));
				assert.deepEqual(transmissions(output), i < count ? [FIRST + i] : []);
				if (i >= count) {
					assert.equal(stripTerminalSequences(output), "? image unavailable".padEnd(32));
					assert.ok(!output.includes(PLACEHOLDER));
					assert.equal(visibleWidth(output), 32);
				}
			}
		}
		// A later, smaller working set can evict a previous batch. The old
		// cached lines stay safe without any global rerender/version churn.
		registerImage(FIRST + count, images[count]!, 32, 1);
		assert.deepEqual(transmissions(write(frame(FIRST + count))), [FIRST + count]);
		assert.match(stripTerminalSequences(write(frame(FIRST, 32))), /image unavailable/);
		registerImage(FIRST, images[0]!, 32, 1);
		assert.deepEqual(transmissions(write("\x1b[3J" + frame(FIRST))), [FIRST]);
		assert.equal(state.version, version);
	});

	test(`${mode}: eviction releases shared bytes only after the last reference; failed admission is atomic`, () => {
		const write = capture(mode);
		const shared = png(0, 512);
		const count = Math.floor(BYTES / shared.length);
		const images = Array.from({ length: count + 1 }, (_, i) => png(i, 512));
		registerImage(FIRST, shared, 1, 1);
		registerImage(FIRST + 1, shared, 1, 1);
		for (let i = 1; i < count; i++) registerImage(FIRST + i + 1, images[i]!, 1, 1);
		write("previous batch");
		// Pin every payload, leaving just one alias eligible for eviction. It
		// cannot free bytes, so a failed admission must leave that alias intact.
		registerImage(FIRST + 1, shared, 1, 1);
		for (let i = 1; i < count; i++) registerImage(FIRST + i + 1, images[i]!, 1, 1);
		registerImage(FIRST + count + 1, images[count]!, 1, 1);
		assert.deepEqual(transmissions(write(frame(FIRST))), [FIRST]);
		assert.equal(stripTerminalSequences(write(frame(FIRST + count + 1))), "?");
		// With the previous batch released, both aliases must be evicted to
		// reclaim one payload. The next unrelated payload remains recoverable.
		registerImage(FIRST + count + 1, images[count]!, 1, 1);
		assert.deepEqual(transmissions(write(frame(FIRST + count + 1))), [FIRST + count + 1]);
		assert.equal(stripTerminalSequences(write(frame(FIRST))), "?");
		assert.equal(stripTerminalSequences(write(frame(FIRST + 1))), "?");
		assert.deepEqual(transmissions(write(frame(FIRST + 2))), [FIRST + 2]);
	});

	test(`${mode}: metadata limit is independent of shared bytes; explicit deletion includes evicted IDs only`, () => {
		const write = capture(mode);
		const version = state.version;
		for (let i = 0; i <= 4000; i++) registerImage(FIRST + i, tiny, 1, 1);
		for (let i = 0; i < 4000; i++) assert.deepEqual(transmissions(write(frame(FIRST + i))), [FIRST + i]);
		assert.equal(stripTerminalSequences(write(frame(FIRST + 4000))), "?");
		registerImage(FIRST + 4000, tiny, 1, 1);
		assert.deepEqual(transmissions(write(frame(FIRST + 4000))), [FIRST + 4000]);
		assert.equal(stripTerminalSequences(write(frame(FIRST))), "?");
		// ED clears transmission state, but not ownership of images in scrollback.
		write("\x1b[2J");
		let deleted = "";
		deleteImages((data) => { deleted += data; });
		const ids = [...deleted.matchAll(/a=d,d=I,i=(\d+),q=2/g)].map((m) => Number(m[1]));
		assert.deepEqual(ids, Array.from({ length: 4001 }, (_, i) => FIRST + i));
		assert.ok(!deleted.includes("d=A") && !deleted.includes("d=a"));
		assert.equal(state.version, version);
		assert.equal(stripTerminalSequences(write(frame(FIRST))), "?");
		registerImage(FIRST, tiny, 1, 1);
		assert.deepEqual(transmissions(write(frame(FIRST))), [FIRST]);
	});

	test(`${mode}: clears and targeted/native deletes recover data and placements in stream order`, () => {
		const write = capture(mode);
		registerImage(FIRST, tiny, 2, 2);
		assert.deepEqual(transmissions(write(frame(FIRST, 2, 2))), [FIRST]);
		assert.deepEqual(transmissions(write(frame(FIRST, 2, 2))), []);
		for (const clear of ["\x1b[2J", "\x1b[3J", "\x1bc", `\x1b_Ga=d,d=I,i=${FIRST}\x1b\\`, "\x1b_Ga=d,d=A\x1b\\"]) {
			const output = write(clear + frame(FIRST, 2, 2));
			assert.deepEqual(transmissions(output), [FIRST]);
			assert.ok(output.indexOf("f=100") > output.indexOf(clear));
		}
		for (const clear of [`\x1b_Ga=d,d=i,i=${FIRST}\x1b\\`, "\x1b_Ga=d,d=a\x1b\\"]) {
			const output = write(clear + frame(FIRST, 2, 2));
			assert.deepEqual(transmissions(output), []);
			assert.match(output, /a=p,q=2,/);
		}
		assert.deepEqual(transmissions(write(`\x1b_Ga=d,d=I,i=42\x1b\\` + frame(FIRST))), []);
		// Both references must be restored, including one before the last clear.
		assert.deepEqual(transmissions(write("\x1b[2J" + frame(FIRST) + "\x1b[2J" + frame(FIRST))), [FIRST, FIRST]);
	});

	test(`${mode}: split escapes, surrogate pairs and fallback cells preserve width and style`, () => {
		const write = capture(mode);
		registerImage(FIRST, tiny, 2, 2);
		const source = "\x1b[2J" + frame(FIRST, 2, 2) + "\n" + frame(FIRST + 1, 32) + "\x1b[31mend\x1b[0m";
		let output = "";
		for (let i = 0; i < source.length; i++) output += write(source[i]!);
		assert.deepEqual(transmissions(output), [FIRST]);
		assert.ok(stripTerminalSequences(output).endsWith("? image unavailable".padEnd(32) + "end"));
		assert.ok(output.endsWith("\x1b[31mend\x1b[0m"));
		if (mode === "direct") assert.ok(!output.includes(PLACEHOLDER));
		else assert.equal((output.match(/\u{10EEEE}/gu) ?? []).length, 4);
	});

	test(`${mode}: no-hook registration remains immediate and shutdown forget does not delete`, () => {
		process.env.PI_BETTER_RENDER_IMAGES = mode;
		const output: string[] = [];
		setKittyWriter((data) => { output.push(data); });
		registerImage(FIRST, tiny, 2, 1);
		registerImage(FIRST, tiny, 2, 1);
		assert.equal(output.length, 1);
		assert.deepEqual(transmissions(output[0]!), [FIRST]);
		assert.ok(output[0]!.includes(mode === "direct" ? "a=t," : "a=T,"));
		if (mode === "direct") assert.match(createDirectRewriter()(frame(FIRST, 2)), /a=p,q=2,/);
		forgetImages();
		deleteImages();
		assert.equal(output.length, 1);
		registerImage(FIRST, tiny, 2, 1);
		assert.equal(output.length, 2);
		deleteImages();
		assert.match(output[2]!, new RegExp(`a=d,d=I,i=${FIRST},q=2`));
	});
}

test("prepareFrame retains its public transmission/clear protocol with shared payloads", () => {
	capture("placeholder");
	const base64 = png(0, 512);
	const ids = Array.from({ length: 50 }, (_, i) => FIRST + i);
	for (const id of ids) registerImage(id, base64, 64, 28);
	const source = "\x1b[2J" + ids.map((id) => frame(id)).join("\n");
	const prepared = prepareFrame(source);
	assert.equal(prepared.insertAt, 4);
	assert.deepEqual(transmissions(prepared.transmissions), ids);
	assert.equal(prepareFrame(source.slice(4)).transmissions, "");
});

function markdown(text: string, math: MathRenderer): RichMarkdown {
	return new RichMarkdown(text, { style: plainStyle(), math, streaming: false, paddingX: 0 });
}
function evictWithMetadataPressure(): void {
	for (let i = 1; i <= 4000; i++) registerImage(FIRST + i, tiny, 1, 1);
}

for (const mode of modes) {
	test(`${mode}: component, token and shared block caches recover only when written`, () => {
		const write = capture(mode);
		let calls = 0;
		const math: MathRenderer = {
			key: "cached-recovery", block: () => undefined,
			inline: () => { calls++; registerImage(FIRST, tiny, 1, 1); return frame(FIRST); },
		};
		let component = markdown("$x$", math);
		const original = component.render(20);
		assert.deepEqual(transmissions(write(original.join("\n"))), [FIRST]);
		for (const path of ["component", "token", "shared block"]) {
			evictWithMetadataPressure();
			if (path === "token") component.invalidate();
			if (path === "shared block") {
				clearLexCache();
				component = markdown("$x$", math);
			}
			const before = calls;
			const lines = component.render(20);
			assert.deepEqual(lines, original);
			assert.equal(calls, before, `${path} publishes a recipe without rendering`);
			assert.deepEqual(transmissions(write("\x1b[2J" + lines.join("\n"))), [FIRST]);
			assert.equal(calls, before + 1);
			assert.deepEqual(transmissions(write("\x1b[2J" + component.render(20).join("\n"))), [FIRST]);
			assert.equal(calls, before + 1, "resident image needs no replay");
		}
		assert.ok(cacheStats.hits >= 2);
	});

	for (const budget of ["metadata", "bytes"] as const) {
		test(`${mode}: cached ${budget}-overcapacity frames stay stable; visible tail recovers despite rendered history`, () => {
			const write = capture(mode);
			const sample = budget === "bytes" ? png(0, 512) : tiny;
			const capacity = budget === "bytes" ? Math.floor(BYTES / sample.length) : 4000;
			const images = Array.from({ length: capacity + 1 }, (_, i) => budget === "bytes" ? png(i, 512) : tiny);
			let calls = 0;
			const math: MathRenderer = {
				key: `cached-pressure-${budget}`, block: () => undefined,
				inline: (tex) => {
					calls++;
					const i = Number(tex);
					registerImage(FIRST + i, images[i]!, 1, 1);
					return frame(FIRST + i);
				},
			};
			const component = markdown(images.map((_, i) => `$${i}$`).join("\n\n"), math);
			const version = state.version;
			const lines = component.render(20);
			const full = lines.join("\n");
			const initial = transmissions(write(full));
			assert.equal(initial.length, capacity);
			for (let pass = 0; pass < 3; pass++) {
				assert.equal(component.render(20), lines);
				const output = write("\x1b[2J" + full);
				assert.deepEqual(transmissions(output), initial);
				assert.equal(stripTerminalSequences(output).split("?").length - 1, 1);
				assert.equal(calls, images.length, "no replay/raster churn while capacity is pinned");
			}
			// Pi renders history to measure it, then writes only the viewport.
			// Recovery must use that viewport rather than pinning every cached block.
			component.render(20);
			const tail = lines.at(-1)!;
			assert.deepEqual(transmissions(write("\x1b[2J" + tail)), [FIRST + capacity]);
			assert.equal(calls, images.length + 1);
			// FIRST is now missing and precedes all resident IDs in the frame.
			// Pre-pinning later IDs prevents a sequential recovery/eviction cycle.
			for (let pass = 0; pass < 3; pass++) {
				component.render(20);
				assert.deepEqual(transmissions(write("\x1b[2J" + full)), [...initial.slice(1), FIRST + capacity]);
				assert.equal(calls, images.length + 1);
			}
			assert.equal(state.version, version);
		});
	}

	test(`${mode}: recovery recognizes a shared payload reintroduced after its last ID was evicted`, () => {
		const write = capture(mode);
		const data = png(0, 512);
		const capacity = Math.floor(BYTES / data.length);
		let calls = 0;
		const component = markdown("$x$", {
			key: "reintroduced-payload", block: () => undefined,
			inline: () => { calls++; registerImage(FIRST, data, 1, 1); return frame(FIRST); },
		});
		write(component.render(20).join("\n"));
		// Remove the original Payload object entirely, then create a new one
		// with identical pixels under a different placement/copy ID.
		for (let i = 1; i <= capacity; i++) registerImage(FIRST + i, png(i, 512), 1, 1);
		write("release registrations");
		const alias = FIRST + capacity + 1;
		registerImage(alias, data, 1, 1);
		const resident = Array.from({ length: capacity - 1 }, (_, i) => FIRST + i + 2);
		const visible = component.render(20).join("\n") + resident.map((id) => frame(id)).join("") + frame(alias);
		assert.deepEqual(transmissions(write("\x1b[2J" + visible)), [FIRST, ...resident, alias]);
		assert.equal(calls, 2, "original ID needs zero extra payload bytes despite the full budget");
	});

	test(`${mode}: real cached formula restores original ID after raster cache expiry`, async () => {
		process.env.PI_BETTER_RENDER_IMAGES = mode;
		const previous = { math: state.math, imagesAllowed: state.imagesAllowed };
		state.math = "streaming"; state.imagesAllowed = true;
		try {
			await loadMathJax();
			const write = capture(mode);
			const component = markdown("$x$", createMathRenderer(() => "#ffffff"));
			const lines = component.render(20);
			const [id] = transmissions(write(lines.join("\n")));
			assert.ok(id);
			clearFormulaCache();
			evictWithMetadataPressure();
			const version = state.version;
			assert.deepEqual(transmissions(write("\x1b[2J" + component.render(20).join("\n"))), [id]);
			assert.equal(selectionWithFormulas(lines), "$x$");
			assert.equal(state.version, version);
		} finally { Object.assign(state, previous); clearFormulaCache(); }
	});

	test(`${mode}: real cached illustrations restore separate copy IDs after placement expiry`, async () => {
		process.env.PI_BETTER_RENDER_IMAGES = mode;
		const previous = { imagesAllowed: state.imagesAllowed, illustrations: state.illustrations };
		state.imagesAllowed = state.illustrations = true;
		const service = new IllustrationService(fileURLToPath(new URL("../", import.meta.url)), () => {});
		try {
			const write = capture(mode);
			const first = "![first](examples/electric-field.png)";
			const second = "![second](examples/electric-field.png)";
			const component = new RichMarkdown(`${first}\n\n${second}`, {
				style: plainStyle(), math: noMath, illustrations: service, streaming: false, paddingX: 0,
			});
			component.render(20);
			await service.idle();
			clearBlockCache(); component.invalidate();
			const lines = component.render(20);
			const ids = transmissions(write(lines.join("\n")));
			assert.equal(ids.length, 2);
			for (let i = 0; i < 513; i++) service.block({ href: "examples/electric-field.png", alt: "", source: `![${i}](examples/electric-field.png)` }, 20);
			write("release registrations");
			evictWithMetadataPressure();
			const rasterized = service.stats.rasterized;
			const version = state.version;
			const recovered = write("\x1b[2J" + component.render(20).join("\n"));
			assert.deepEqual(transmissions(recovered), ids);
			assert.ok(!stripTerminalSequences(recovered).includes("image unavailable"));
			assert.equal(service.stats.rasterized, rasterized);
			assert.ok(selectionWithFormulas(lines).includes(first));
			assert.ok(selectionWithFormulas(lines).includes(second));
			assert.equal(state.version, version);
		} finally { service.dispose(); Object.assign(state, previous); }
	});
}

test("oversized payload admission does not evict resident images or invalidate rendering", () => {
	const write = capture("placeholder");
	registerImage(FIRST, tiny, 1, 1);
	write(frame(FIRST));
	const version = state.version;
	// A PNG-header fixture suffices: oversized input must be rejected before
	// decoding dimensions or retaining data. No terminal receives this fixture.
	registerImage(FIRST + 1, tiny + "A".repeat(BYTES), 32, 1);
	assert.match(stripTerminalSequences(write(frame(FIRST + 1, 32))), /image unavailable/);
	assert.deepEqual(transmissions(write("\x1b[2J" + frame(FIRST))), [FIRST]);
	assert.equal(state.version, version);
});
