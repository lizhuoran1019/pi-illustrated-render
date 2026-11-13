import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";
import { PNG } from "pngjs";
import { setCellDimensions, visibleWidth } from "@earendil-works/pi-tui";
import { clearFormulaCache, createMathRenderer, mathStats } from "../src/math/formula.ts";
import { forgetImages, installFrameHook, PLACEHOLDER, setKittyWriter } from "../src/math/kitty.ts";
import { forgetFormulaSources, selectionWithFormulas } from "../src/math/copy.ts";
import { loadMathJax, MathError, rasterize } from "../src/math/mathjax.ts";
import { clearBlockCache, renderMarkdown } from "../src/render/rich-markdown.ts";
import { state } from "../src/state.ts";
import { plainStyle } from "../src/style.ts";

const previousMode = process.env.PI_BETTER_RENDER_IMAGES;
before(async () => { assert.ok(await loadMathJax()); });
beforeEach(() => {
	process.env.PI_BETTER_RENDER_IMAGES = "sixel";
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	setKittyWriter(() => {});
	state.math = "streaming"; state.imagesAllowed = true;
	clearFormulaCache(); forgetImages(); forgetFormulaSources(); clearBlockCache();
});
afterEach(() => {
	setKittyWriter(undefined);
	if (previousMode === undefined) delete process.env.PI_BETTER_RENDER_IMAGES;
	else process.env.PI_BETTER_RENDER_IMAGES = previousMode;
});

function render(tex: string, height: number, inlineLayout: "text" | undefined = "text") {
	return rasterize({ tex, display: false, color: "#ffffff", cellWidth: height / 2, cellHeight: height, maxColumns: 80, maxRows: 1, fitRows: true, inlineLayout });
}
function pixels(tex: string, height: number) {
	return PNG.sync.read(Buffer.from(render(tex, height).base64, "base64"));
}
function bounds(png: PNG, fromY = 0) {
	let top = png.height, bottom = -1;
	for (let y = fromY; y < png.height; y++) for (let x = 0; x < png.width; x++) {
		if (png.data[(y * png.width + x) * 4 + 3]! >= 64) {
			top = Math.min(top, y); bottom = Math.max(bottom, y);
		}
	}
	return { top, bottom };
}

test("Sixel accents and superscripts keep the same base-letter size and baseline", () => {
	for (const height of [16, 20, 24, 32, 40]) {
		const scale = height < 24 ? 2 : 1;
		for (const letter of ["E", "H", "x"]) {
			const plain = pixels(letter, height), base = bounds(plain);
			assert.ok(Math.abs(base.bottom - height * scale * 0.8) <= 1, `${letter}: shared text baseline`);
			for (const tex of [String.raw`\vec{${letter}}`, `${letter}^2`]) {
				const decorated = pixels(tex, height), ink = bounds(decorated);
				assert.equal(decorated.height, plain.height, "exactly one row, not overflow into the next bullet");
				assert.ok(ink.top < base.top, "accent/script has its own space above the unchanged body");
				assert.ok(Math.abs(ink.bottom - base.bottom) <= 1, `${tex}: accent must not push the base letter down`);
				// The stem/letter body extends through the same rows as the plain
				// glyph; old independent fit-to-row scaling fails this check.
				const body = bounds(decorated, base.top);
				assert.ok(Math.abs(body.bottom - body.top - (base.bottom - base.top)) <= 1);
			}
		}
	}
});

test("the screenshot's dS/vector/normal/theta all fit one row without clipping", () => {
	for (const height of [16, 20, 24, 32, 40]) {
		for (const tex of ["dS", String.raw`\vec{E}`, String.raw`\vec{e}_n`, String.raw`\theta`, "g", "y", "x_i"]) {
			const result = render(tex, height), png = PNG.sync.read(Buffer.from(result.base64, "base64"));
			assert.equal(result.rows, 1);
			const ink = bounds(png);
			assert.ok(ink.top >= 0 && ink.bottom < png.height, tex);
			if (tex === "g" || tex === "y" || tex === "x_i") assert.ok(ink.bottom > png.height * 0.8, "descender/subscript stays below the shared baseline");
		}
	}
});

test("oversized inline formulas fall back rather than changing font size or squashing fractions", () => {
	for (const tex of [String.raw`\frac{a}{b}`, String.raw`\dfrac{a}{b}`, "x_i^2"]) {
		assert.throws(() => render(tex, 20), (e) => e instanceof MathError && /no room/.test(e.message));
		assert.equal(createMathRenderer(() => "#ffffff").inline(tex, false, false), undefined);
	}
	assert.throws(() => rasterize({ tex: "dS", display: false, color: "#ffffff", cellWidth: 10, cellHeight: 20, maxColumns: 1, maxRows: 1, fitRows: true, inlineLayout: "text" }), /no room/);
});

test("Kitty and block layouts are unchanged; inline raster cache separates the Sixel policy", () => {
	const request = { tex: String.raw`\int_S \vec E\cdot d\vec S`, display: true, color: "#ffffff", cellWidth: 10, cellHeight: 20, maxColumns: 60, maxRows: 12 };
	assert.deepEqual(rasterize(request), rasterize({ ...request, inlineLayout: "text" }));
	const math = createMathRenderer(() => "#ffffff");
	process.env.PI_BETTER_RENDER_IMAGES = "placeholder";
	const kitty = math.inline("dS", false, false);
	assert.ok(kitty?.includes(PLACEHOLDER));
	assert.equal(mathStats.rendered, 1);
	process.env.PI_BETTER_RENDER_IMAGES = "sixel";
	const sixel = math.inline("dS", false, false);
	assert.ok(sixel?.includes(PLACEHOLDER));
	assert.notEqual(sixel, kitty);
	assert.equal(mathStats.rendered, 2, "do not reuse the old centered PNG");
	process.env.PI_BETTER_RENDER_IMAGES = "placeholder";
	assert.equal(math.inline("dS", false, false), kitty);
	assert.equal(mathStats.rendered, 2);
});

test("the screenshot's Chinese list stays within width, preserves copy sources, and reaches Sixel", () => {
	const source = String.raw`- 青色平行四边形：一小块面，面积为 $dS$。
- 橙色箭头：电场 $\vec{E}$。
- 黑色箭头 $\vec{e}_n$：**垂直于面**的方向，叫法线，不是另一股电场。
- $\theta$：电场与法线的夹角，不是电场与面的夹角！`;
	const math = createMathRenderer(() => "#ffffff");
	let output = "";
	const terminal = { write(s: string) { output += s; } };
	const stop = installFrameHook(terminal, "sixel");
	try {
		for (const width of [100, 60, 30, 18]) {
			const lines = renderMarkdown(source, width, { style: plainStyle(), math, streaming: false });
			assert.ok(lines.every((s) => visibleWidth(s) <= width));
			const copied = selectionWithFormulas(lines);
			for (const tex of ["$dS$", String.raw`$\vec{E}$`, String.raw`$\vec{e}_n$`, String.raw`$\theta$`]) assert.ok(copied.includes(tex), tex);
			output = ""; terminal.write(lines.join("\r\n"));
			assert.equal((output.match(/\x1bP[\d;]*q/g) ?? []).length, 4);
			assert.ok(!output.includes(PLACEHOLDER) && !output.includes("\x1b_G"));
		}
	} finally { stop(); }
});
