import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { getPngDimensions, setCellDimensions, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { IllustrationService, MAX_FILE_BYTES, checkSvg, rasterLayout, resolveImagePath, validatePng } from "../src/illustrations.ts";
import { forgetFormulaSources, selectionWithFormulas } from "../src/math/copy.ts";
import { clearFormulaCache, createMathRenderer } from "../src/math/formula.ts";
import { forgetImages, installFrameHook, PLACEHOLDER, setKittyWriter } from "../src/math/kitty.ts";
import { loadMathJax } from "../src/math/mathjax.ts";
import { noMath } from "../src/render/context.ts";
import { clearLexCache } from "../src/render/lexer.ts";
import { clearBlockCache, renderMarkdown, RichMarkdown } from "../src/render/rich-markdown.ts";
import { bumpVersion, state } from "../src/state.ts";
import { plainStyle } from "../src/style.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const svg = "examples/electric-field.svg";
const png = "examples/electric-field.png";
const services: IllustrationService[] = [];
let writes: string[] = [];
const service = (cwd = root, changed?: () => void) => { const s = new IllustrationService(cwd, changed); services.push(s); return s; };
const draw = (s: IllustrationService, source: string, width = 90, streaming = false) => renderMarkdown(source, width, { style: plainStyle(), math: noMath, illustrations: s, streaming });
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
async function ready(s: IllustrationService, source: string, width = 90): Promise<string[]> { draw(s, source, width); await s.idle(); return draw(s, source, width); }

beforeEach(() => {
	process.env.PI_BETTER_RENDER_IMAGES = "placeholder";
	process.env.PI_BETTER_RENDER_FONT_DOWNLOAD = "0";
	process.env.PI_BETTER_RENDER_MERMAID_INSTALL = "0";
	state.enabled = state.imagesAllowed = state.illustrations = true;
	state.imageBackground = "none";
	state.imageMaxRows = 28;
	state.math = "streaming";
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	writes = [];
	setKittyWriter((data) => writes.push(data));
	clearBlockCache(); clearLexCache(); clearFormulaCache(); forgetImages(); forgetFormulaSources(); bumpVersion();
});
afterEach(() => { for (const s of services.splice(0)) s.dispose(); setKittyWriter(undefined); delete process.env.PI_BETTER_RENDER_IMAGES; });

test("paragraph → SVG → paragraph → PNG, aspect ratio and source stay intact", async () => {
	const s = service();
	const source = `第一段：场强决定力。\n\n![场强图](${svg})\n\n第二段：势能还取决于电荷。\n\n![PNG 图](${png})\n\n结尾。`;
	const lines = await ready(s, source);
	assert.ok(lines.some((l) => l.includes(PLACEHOLDER)));
	assert.ok(lines.every((l) => visibleWidth(l) <= 90));
	const result = plain(lines);
	assert.ok(result.indexOf("第一段") < result.indexOf(PLACEHOLDER));
	assert.ok(result.indexOf("场强图") < result.indexOf("第二段"));
	assert.ok(result.indexOf("第二段") < result.indexOf("PNG 图"));
	assert.ok(result.indexOf("PNG 图") < result.indexOf("结尾"));
	assert.ok(selectionWithFormulas(lines).includes(`![场强图](${svg})`));
	assert.equal(selectionWithFormulas(lines).split(`![PNG 图](${png})`).length, 2);
	assert.ok(writes.join("").includes("a=T,f=100"));
});

test("completed image syntax appears during streaming; partial links and code fences are not fetched", async () => {
	const s = service();
	for (const source of [`![图](${svg}`, `\`\`\`md\n![图](${svg})\n\`\`\``]) assert.ok(!plain(draw(s, source, 80, true)).includes(PLACEHOLDER));
	const source = `介绍。\n\n![图](${svg})\n\n接着解释`;
	assert.match(plain(draw(s, source, 80, true)), /加载中/);
	await s.idle();
	assert.ok(plain(draw(s, source, 80, true)).includes(PLACEHOLDER));
});

test("reference definitions participate in cache identity, including a trailing streaming list", () => {
	const seen: string[] = [];
	const illustrations = { key: "spy", block: (image: { href: string }) => { seen.push(image.href); return { status: "fallback" as const, message: image.href }; } };
	for (const href of ["a.svg", "b.svg"]) renderMarkdown(`![图][x]\n\n[x]: ${href}\n\n- 尾部`, 80, { style: plainStyle(), math: noMath, illustrations, streaming: true });
	assert.deepEqual(seen, ["a.svg", "b.svg"]);
});

test("relative base directories, percent escapes, file URLs, and literal percent", () => {
	assert.equal(resolveImagePath("图%20一.svg", root), resolve(root, "图 一.svg"));
	assert.equal(resolveImagePath("100%.png", root), resolve(root, "100%.png"));
	const path = resolve(root, svg);
	assert.equal(resolveImagePath(pathToFileURL(path).href, "/"), path);
	assert.notEqual(service("/a").key, service("/b").key);
	for (const path of ["https://example.test/x.svg", "//host/x.png", "data:image/png;base64,xx", "ftp://host/x"]) assert.throws(() => resolveImagePath(path, root), /本地/);
});

test("terminal permission gates cached illustration pixels independently of the illustration toggle", async () => {
	const s = service();
	const source = `![PNG 图](${png})`;
	assert.ok((await ready(s, source)).join("").includes(PLACEHOLDER));
	const key = s.key, rasterized = s.stats.rasterized;
	state.imagesAllowed = false;
	assert.notEqual(s.key, key);
	writes = [];
	const fallback = draw(s, source);
	assert.ok(!fallback.join("").includes(PLACEHOLDER));
	assert.match(plain(fallback), /terminal.showImages/);
	assert.equal(writes.length, 0);
	assert.equal(s.stats.rasterized, rasterized);
	state.imagesAllowed = true;
	assert.ok(draw(s, source).join("").includes(PLACEHOLDER));
	assert.equal(s.stats.rasterized, rasterized);
});

test("same file with different captions keeps distinct copy sources", async () => {
	const s = service();
	const source = `![正电荷](${svg})\n\n中间。\n\n![负电荷](${svg})`;
	const lines = await ready(s, source);
	const copied = selectionWithFormulas(lines);
	assert.ok(copied.includes(`![正电荷](${svg})`));
	assert.ok(copied.includes(`![负电荷](${svg})`));
});

test("reference image copy includes its destination and title without a hidden definition", async () => {
	const s = service();
	const copied = selectionWithFormulas(await ready(s, `![field][diagram]\n\n[diagram]: ${svg} "电场图"`));
	assert.ok(copied.includes(`![field](<${svg}> "电场图")`));
	assert.ok(!copied.includes("[diagram]"));
});

test("resize and cell-size changes fit the grid without distortion", async () => {
	const s = service();
	const source = `![图](${svg})`;
	await ready(s, source);
	for (const width of [110, 36, 8, 1]) {
		const lines = draw(s, source, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const before = s.key;
	setCellDimensions({ widthPx: 9, heightPx: 22 });
	assert.notEqual(s.key, before);
	const layout = rasterLayout(1000, 620, 64, 9, 22);
	assert.ok(Math.abs(layout.contentW / layout.contentH - 1000 / 620) < 1e-12);
	assert.ok(layout.columns <= 64 && layout.rows <= 28);
	const lines = draw(s, source, 64);
	assert.ok(lines.every((line) => visibleWidth(line) <= 64));
	// Decode a complete, non-chunked transmission when available (larger ones are tested by Kitty itself).
	for (const output of writes) {
		const match = /a=T,f=100,q=2,U=1,i=\d+,p=1,c=(\d+),r=(\d+);([^\x1b]+)\x1b\\/.exec(output);
		if (match) assert.ok(getPngDimensions(match[3]!)!.widthPx > 0);
	}
});

test("unchanged canvas and changed captions reuse pixels; distinct copy sources remain intact", async () => {
	setCellDimensions({ widthPx: 9, heightPx: 20 });
	const s = service();
	const request = { href: png, alt: "PNG", source: `![PNG](${png})` };
	s.block(request, 110); await s.idle();
	const original = s.block(request, 110);
	assert.equal(original.status, "ready");
	assert.equal(s.stats.rasterized, 1);
	for (const width of [109, 108, 107, 106, 105]) {
		const resized = s.block(request, width);
		assert.deepEqual(resized, original, "same pixel grid and source keep the same placement");
	}
	const second = s.block({ ...request, source: `![另一图题](${png})` }, 110);
	assert.equal(second.status, "ready");
	assert.equal(s.stats.rasterized, 1, "a new caption must not rasterize the PNG again");
	if (original.status === "ready" && second.status === "ready") {
		assert.notEqual(original.lines[0], second.lines[0]);
		assert.ok(selectionWithFormulas(original.lines).includes(request.source));
		assert.ok(selectionWithFormulas(second.lines).includes(`![另一图题](${png})`));
		assert.equal(original.sourceUrl, pathToFileURL(resolve(root, png)).href);
	}
	s.block(request, 40);
	assert.equal(s.stats.rasterized, 2, "a genuinely smaller canvas needs new pixels");
	s.block(request, 110);
	assert.equal(s.stats.rasterized, 2, "returning to the old size reuses it");
});

function lastPng(): PNG {
	const encoded = [...writes.at(-1)!.matchAll(/\x1b_G[^;\x1b]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join("");
	return PNG.sync.read(Buffer.from(encoded, "base64"));
}

test("optional image backplates preserve opaque pixels and the original file", async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "illustrated-backplate-"));
	const input = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="10" y="10" width="20" height="20" fill="black"/></svg>';
	try {
		await writeFile(resolve(dir, "透明 图.svg"), input);
		const s = service(dir);
		const request = { href: "透明%20图.svg", alt: "", source: "![](透明%20图.svg)" };
		s.block(request, 80); await s.idle();
		const initialKey = s.key;
		for (const [background, rgb] of [["none", undefined], ["light", [255, 255, 255]], ["dark", [23, 26, 33]]] as const) {
			state.imageBackground = background;
			assert.equal(s.block(request, 80).status, "ready");
			const rendered = lastPng();
			assert.equal(rendered.data[3], rgb ? 255 : 0);
			if (rgb) assert.deepEqual([...rendered.data.subarray(0, 3)], [...rgb]);
			const center = ((rendered.height / 2) * rendered.width + rendered.width / 2) * 4;
			assert.deepEqual([...rendered.data.subarray(center, center + 4)], [0, 0, 0, 255]);
		}
		assert.notEqual(s.key, initialKey);
		assert.equal(await readFile(resolve(dir, "透明 图.svg"), "utf8"), input);
		assert.equal(s.stats.rasterized, 3);
		state.imageBackground = "none";
		s.block(request, 80);
		assert.equal(s.stats.rasterized, 3, "background toggling reuses prior variants");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("portrait height is adjustable without distortion and clear invalidates pixel variants", async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "illustrated-portrait-"));
	try {
		await writeFile(resolve(dir, "portrait.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1740"><rect width="900" height="1740" fill="white"/></svg>');
		const s = service(dir);
		const request = { href: "portrait.svg", alt: "长图", source: "![长图](portrait.svg)" };
		s.block(request, 110); await s.idle();
		const compact = s.block(request, 110);
		const oldKey = s.key;
		state.imageMaxRows = 56;
		const expanded = s.block(request, 110);
		assert.notEqual(s.key, oldKey);
		assert.equal(compact.status, "ready"); assert.equal(expanded.status, "ready");
		if (compact.status === "ready" && expanded.status === "ready") {
			assert.equal(compact.lines.length, 28);
			assert.equal(expanded.lines.length, 56);
			assert.ok(expanded.columns > compact.columns);
			assert.equal(compact.sourceUrl, expanded.sourceUrl);
		}
		for (const rows of [8, 28, 56, 120]) {
			const layout = rasterLayout(900, 1740, 110, 10, 20, rows);
			assert.ok(Math.abs(layout.contentW / layout.contentH - 900 / 1740) < 1e-12);
			assert.ok(layout.rows <= rows && layout.canvasW <= 4096 && layout.canvasH <= 4096);
		}
		s.clear();
		assert.equal(s.stats.rasterized, 0);
		assert.equal(s.block(request, 110).status, "fallback");
		await s.idle(); assert.equal(s.block(request, 110).status, "ready");
		assert.equal(s.stats.rasterized, 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("frame hook restores pictures after full clear and native Kitty delete", async () => {
	const s = service();
	const output: string[] = [];
	const terminal = { write: (data: string) => { output.push(data); } };
	const original = terminal.write;
	const uninstall = installFrameHook(terminal, "placeholder");
	try {
		const lines = await ready(s, `![图](${png})`);
		const frame = lines.join("\n");
		terminal.write(frame);
		assert.ok(output.at(-1)!.includes("a=T,f=100"));
		terminal.write(frame);
		assert.ok(!output.at(-1)!.includes("a=T,f=100"));
		terminal.write("\x1b[2J" + frame);
		assert.ok(output.at(-1)!.includes("a=T,f=100"));
		terminal.write("\x1b_Ga=d,d=a,q=2\x1b\\" + frame);
		assert.ok(output.at(-1)!.includes("a=p,q=2,U=1"));
	} finally { uninstall(); }
	assert.equal(terminal.write, original);
});

test("missing, corrupt, oversized and externally-referencing images show useful fallbacks", async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "illustrated-errors-"));
	try {
		await writeFile(resolve(dir, "broken.png"), "not a PNG");
		await writeFile(resolve(dir, "broken.svg"), "not SVG");
		await writeFile(resolve(dir, "big.png"), Buffer.alloc(MAX_FILE_BYTES + 1));
		await writeFile(resolve(dir, "external.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><image href="file:///private.png"/></svg>');
		const original = await readFile(resolve(root, png)); original[original.length - 20] = original[original.length - 20]! ^ 0xff;
		await writeFile(resolve(dir, "bad-crc.png"), original);
		const s = service(dir);
		for (const [name, expected] of [["missing.png", /找不到/], ["broken.png", /PNG/], ["broken.svg", /SVG|svg|parsing/], ["big.png", /8 MiB/], ["external.svg", /外部/], ["bad-crc.png", /CRC|error|unrecognised|chunk|checksum|inflate|stream/i]]) {
			const lines = await ready(s, `![错误](${name})`);
			assert.ok(!plain(lines).includes(PLACEHOLDER));
			assert.match(plain(lines), expected as RegExp);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// Construct valid CRCs for adversarial PNG chunks (the container requires CRC32).
function pngChunk(type: string, data: Buffer): Buffer {
	const content = Buffer.concat([Buffer.from(type), data]);
	let crc = 0xffffffff;
	for (const byte of content) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
	length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, content, checksum]);
}

test("PNG preflight rejects duplicate IHDR and bounded-inflate violations, including Adam7", () => {
	const one = PNG.sync.write(new PNG({ width: 1, height: 1 }));
	const two = PNG.sync.write(new PNG({ width: 2, height: 2 }));
	const duplicate = Buffer.concat([one.subarray(0, 33), two.subarray(8)]);
	// A permissive decoder accepts the second IHDR despite the first header's dimensions.
	assert.equal(PNG.sync.read(duplicate).width, 2);
	assert.throws(() => validatePng(duplicate), /IHDR/);
	for (const interlace of [0, 1]) {
		const header = Buffer.from(one.subarray(16, 29)); header[12] = interlace;
		const huge = Buffer.concat([one.subarray(0, 8), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.alloc(1024 * 1024))), pngChunk("IEND", Buffer.alloc(0))]);
		assert.ok(huge.length < 1200);
		assert.throws(() => validatePng(huge), /larger than|length|size/i);
		const valid = Buffer.concat([one.subarray(0, 8), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]);
		assert.deepEqual(validatePng(valid), { width: 1, height: 1 });
	}
});

test("cache overflow settles; placements survive source eviction and do not trigger reread loops", async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "illustrated-capacity-"));
	try {
		await Promise.all(Array.from({ length: 66 }, (_, i) => writeFile(resolve(dir, `${i}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${i === 65 ? 1000 : 4}" height="4"><rect width="1000" height="4" fill="red"/></svg>`)));
		let completions = 0;
		const s = service(dir, () => { completions++; });
		const request = (i: number) => ({ href: `${i}.svg`, alt: "", source: `![](${i}.svg)` });
		s.block(request(0), 10); await s.idle(); assert.equal(s.block(request(0), 10).status, "ready");
		for (let i = 1; i < 66; i++) s.block(request(i), 10);
		await s.idle();
		assert.equal(s.block(request(0), 10).status, "ready", "cached placement does not need its evicted source");
		// Copy identities are cheap and distinct from pixels; exhausting them must not reread sources.
		for (let i = 0; i < 520; i++) s.block({ ...request(65), source: `![${i}](65.svg)` }, 10);
		// More than 128 genuinely different pixel grids/backplates also evict the first raster.
		for (let width = 1; width <= 100; width++) s.block(request(65), width);
		state.imageBackground = "light";
		for (let width = 1; width <= 40; width++) s.block(request(65), width);
		state.imageBackground = "none";
		assert.equal(s.block(request(0), 10).status, "fallback", "evicted pixels cannot revive an evicted source");
		const settled = completions;
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 66; i++) {
				const result = s.block(request(i), 10);
				if (result.status === "fallback") assert.match(result.message, /缓存已满/);
			}
			await s.idle();
			assert.equal(completions, settled, "redraw must not schedule more reads after capacity is reached");
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("SVG policy rejects external references and declarations, permits internal markers", () => {
	checkSvg('<svg><use href="#arrow"/><path style="fill:url(#grad)"/></svg>');
	for (const source of ['<!DOCTYPE svg><svg/>', '<svg><image href="https://x"/></svg>', '<svg><use href="&#102;ile:///x"/></svg>', '<svg style="fill:url(https://x)"></svg>']) assert.throws(() => checkSvg(source));
});

test("disabled/unsupported images retain alt text and path; refresh retries a missing file", async () => {
	const s = service();
	state.illustrations = false;
	assert.match(plain(draw(s, `![图](${svg})`)), /关闭/);
	state.illustrations = true; process.env.PI_BETTER_RENDER_IMAGES = "off";
	assert.match(plain(draw(s, `![图](${svg})`)), /不支持/);
	process.env.PI_BETTER_RENDER_IMAGES = "placeholder";
	const dir = await mkdtemp(resolve(tmpdir(), "illustrated-refresh-"));
	try {
		const r = service(dir);
		assert.match(plain(await ready(r, "![图](new.svg)")), /找不到/);
		await writeFile(resolve(dir, "new.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
		r.clear();
		assert.ok(plain(await ready(r, "![图](new.svg)")).includes(PLACEHOLDER));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("pending completions cannot repopulate caches after clear or shutdown", async () => {
	let changes = 0;
	const s = service(root, () => { changes++; });
	draw(s, `![图](${svg})`); s.clear(); await s.idle(); assert.equal(changes, 0);
	draw(s, `![图](${svg})`); s.dispose(); await s.idle(); assert.equal(changes, 0);
});

test("math, CJK tables and Markdown transforms coexist with pictures", async () => {
	assert.ok(await loadMathJax());
	const s = service();
	const source = `原文\n\n![图](${svg})\n\n$$E_p=q\\varphi$$\n\n| 场量 | 物理意义 |\n| --- | --- |\n| 电势 | 单位电荷的势能 |`;
	let transforms = 0;
	const component = new RichMarkdown(source, { paddingX: 1, streaming: false, style: plainStyle(), math: createMathRenderer(() => "#ffffff"), illustrations: s, transform: (text) => { transforms++; return text.replace("原文", "已变换"); } });
	component.render(90); await s.idle();
	const lines = component.render(90);
	assert.match(plain(lines), /已变换/);
	assert.match(plain(lines), /单位电荷/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 90));
	assert.ok(selectionWithFormulas(lines).includes("$$E_p=q\\varphi$$"));
	const count = transforms; component.render(90); assert.equal(transforms, count);
});
