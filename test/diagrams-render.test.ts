import assert from "node:assert/strict";
import { test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { renderDiagram, type DiagramInput, type RenderedDiagram } from "../src/diagrams/render.ts";
import { checkSvg } from "../src/illustrations.ts";

function raster(diagram: RenderedDiagram): PNG {
	checkSvg(diagram.svg);
	assert.doesNotMatch(diagram.svg, /var\s*\(|foreignObject|<image\b|<script\b|<text\b/i);
	assert.ok(Buffer.byteLength(diagram.svg) <= 4 * 1024 * 1024);
	const image = PNG.sync.read(new Resvg(diagram.svg, { font: { loadSystemFonts: false } }).render().asPng());
	assert.equal(image.width, diagram.width);
	assert.equal(image.height, diagram.height);
	return image;
}

function colorCount(image: PNG, color: number[], tolerance = 0): number {
	let count = 0;
	for (let i = 0; i < image.data.length; i += 4) {
		if (color.every((value, channel) => Math.abs(image.data[i + channel]! - value) <= tolerance) && image.data[i + 3] === 255) count++;
	}
	return count;
}

const fixtures = {
	flowchart: "flowchart LR\n A[开始] --> B{是否完成}\n B -->|是| C[结束]\n B -->|否| A",
	sequence: "sequenceDiagram\n participant A as 用户\n participant B as 服务\n A->>B: 请求数据\n B-->>A: 返回结果",
	ER: "erDiagram\n 用户 ||--o{ 订单 : 提交\n 订单 ||--|{ 商品 : 包含",
	mindmap: "mindmap\n  root((知识))\n    概念\n      定义\n    应用\n      示例",
};

for (const [name, source] of Object.entries(fixtures)) {
	test(`Chinese ${name} has standalone vectors and readable raster colors`, async () => {
		const diagram = await renderDiagram({ format: "mermaid", source });
		assert.ok(diagram.width > 80 && diagram.height > 80);
		const image = raster(diagram);
		assert.deepEqual([...image.data.subarray(0, 4)], [255, 255, 255, 255]);
		assert.ok(colorCount(image, [255, 255, 255]) > image.width * image.height * 0.1, "painted light background");
		assert.ok(colorCount(image, [243, 243, 243]) > 100, "light node surfaces, not black var() fills");
		assert.ok(colorCount(image, [31, 31, 31]) > 100, "dark text and edges");
		for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], 255, "opaque on either terminal theme");
	});
}

test("Pele font shorthand is expanded so 20px labels do not rasterize at resvg's 12px default", async () => {
	const image = raster(await renderDiagram({ format: "mermaid", source: "flowchart TB\n A[MMMM]" }));
	let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
	for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
		const i = (y * image.width + x) * 4;
		if (image.data[i] === 31 && image.data[i + 1] === 31 && image.data[i + 2] === 31) {
			minX = Math.min(minX, x); maxX = Math.max(maxX, x);
			minY = Math.min(minY, y); maxY = Math.max(maxY, y);
		}
	}
	assert.ok(maxX - minX >= 45, "label width reflects the layout's font size");
	assert.ok(maxY - minY >= 12, "label height reflects the layout's font size");
});

test("explicit Mermaid node/edge colors survive materialization and outlining", async () => {
	const diagram = await renderDiagram({ format: "mermaid", source: "flowchart LR\n A[中文] --> B[完成]\n style A fill:#ff0000,stroke:#0000ff,stroke-width:2,color:#008000\n linkStyle 0 stroke:#9900cc" });
	const image = raster(diagram);
	for (const color of [[255, 0, 0], [0, 0, 255], [0, 128, 0], [153, 0, 204]]) {
		assert.ok(colorCount(image, color) > 5, `explicit ${color} is painted`);
	}
});

test("Pele series fallbacks and configured palette properties are concrete raster colors", async () => {
	const mindmap = raster(await renderDiagram({ format: "mermaid", source: fixtures.mindmap }));
	// 1.5px horizontal strokes cover each neighboring pixel by 75%.
	assert.ok(colorCount(mindmap, [121, 154, 190], 1) > 10);
	assert.ok(colorCount(mindmap, [247, 164, 82], 1) > 10);
	const pie = raster(await renderDiagram({ format: "mermaid", source: '---\nconfig:\n  themeVariables:\n    pie1: "#00aa88"\n    pie2: "#8855cc"\n---\npie\n "第一" : 2\n "第二" : 1' }));
	assert.ok(colorCount(pie, [0, 170, 136]) > 1000);
	assert.ok(colorCount(pie, [136, 85, 204]) > 1000);
});

test("$$math$$ labels use bundled MathJax paths, including fractions and Chinese text", async () => {
	for (const source of [
		String.raw`flowchart LR
 A["$$E=mc^2$$"] --> B["$$\frac{1}{2}+\sqrt{x}$$"]`,
		String.raw`flowchart TB
 A["$$\text{中文}+\bm{x}$$"]`,
		String.raw`sequenceDiagram
 A->>B: $$\frac{x}{y}$$`,
	]) {
		const diagram = await renderDiagram({ format: "mermaid", source });
		assert.doesNotMatch(diagram.svg, /\$\$|data-latex|katex/i);
		assert.ok((diagram.svg.match(/<path\b/g) ?? []).length >= 5);
		assert.ok(colorCount(raster(diagram), [31, 31, 31]) > 50);
	}
	await assert.rejects(renderDiagram({ format: "mermaid", source: String.raw`flowchart LR
 A["$$\notARealCommand$$"]` }), /Undefined control sequence/);
});

test("manual SVG supports local gradients, reusable geometry, inline styles and offset viewBoxes", async () => {
	const diagram = await renderDiagram({ format: "svg", source: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="10 20 120 80">
 <defs><linearGradient id="g"><stop stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><path id="图形" d="M20 30H100V70H20Z"/></defs>
 <use href="#图形" style="fill:url(#g);stroke:#111111;stroke-width:2"/>
 <text x="20" y="90" font-size="16" fill="#111111">示意图</text>
 </svg>` });
	assert.equal(diagram.width, 120);
	assert.equal(diagram.height, 80);
	const image = raster(diagram);
	assert.ok(colorCount(image, [255, 255, 255]) > 1000);
	assert.ok(colorCount(image, [17, 17, 17]) > 50);
});

test("manual SVG rejects active, unsupported, obfuscated and external-resource constructs", async () => {
	const bodies = [
		'<script>alert(1)</script>', '<foreignObject><div>HTML</div></foreignObject>',
		'<animate attributeName="x"/>', '<set attributeName="fill" to="red"/>', '<filter id="f"/>',
		'<style>rect { fill:red }</style>', '<a href="#x"><rect width="10" height="10"/></a>',
		'<image href="https://example.invalid/x.png"/>', '<image href="data:image/png;base64,AAAA"/>',
		'<use href="file:///tmp/private.svg"/>', '<use href="//example.invalid/x.svg"/>',
		'<use href="&#102;ile:///tmp/private.svg"/>', '<use href="#x" onload="alert(1)"/>',
		'<g xml:base="file:///tmp/"><use href="#x"/></g>',
		'<path style="fill:url(https://example.invalid/x.svg)"/>',
		'<path style="fill:u&#x72;l(https://example.invalid/x.svg)"/>',
		'<path style="fill:u\\72l(https://example.invalid/x.svg)"/>',
		'<path style="fill:var(--color,red)"/>', '<path style="font:20px serif"/>', '<rect style="rx:4px"/>',
		'<evil:path xmlns:evil="https://example.invalid/ns"/>',
		'<g xmlns="http://www.w3.org/1999/xhtml"/>',
	];
	for (const body of bodies) await assert.rejects(renderDiagram({ format: "svg", source: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>` }), Error, body);
	for (const source of [
		'<!DOCTYPE svg [<!ENTITY x "boom">]><svg/>',
		'<?xml-stylesheet href="https://example.invalid/x.css"?><svg/>',
		'<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[unsupported]]></svg>',
	]) await assert.rejects(renderDiagram({ format: "svg", source }));
});

test("Mermaid links and images are disabled and rendering never calls fetch", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => { calls++; throw new Error("network must not be used"); };
	try {
		const diagram = await renderDiagram({ format: "mermaid", source: 'flowchart LR\n A[中文] --> B["$$x^2$$"]\n click A "https://example.invalid/"' });
		raster(diagram);
		assert.doesNotMatch(diagram.svg, /example\.invalid|<a\b|href=/);
		const image = await renderDiagram({ format: "mermaid", source: 'flowchart LR\n A@{ img: "https://example.invalid/a.png", label: "本地图", w: 60, h: 60 }' });
		assert.doesNotMatch(image.svg, /example\.invalid|<image\b/);
		assert.equal(calls, 0);
	} finally { globalThis.fetch = original; }
});

test("invalid inputs and Mermaid/XML syntax errors surface rather than producing blank diagrams", async () => {
	for (const input of [
		{ format: "html", source: "<svg/>" }, { format: "svg", source: "" }, { format: "mermaid", source: " \n" },
		{ format: "mermaid", source: "flowchart LR\n A[unfinished" },
		{ format: "mermaid", source: "not a supported diagram" },
		{ format: "svg", source: '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>' },
		{ format: "svg", source: 'not XML' },
	]) await assert.rejects(renderDiagram(input as DiagramInput));
});

test("source, edge count, dimensions and expanded SVG output are bounded", async () => {
	for (const format of ["svg", "mermaid"] as const) {
		await assert.rejects(renderDiagram({ format, source: "x".repeat(50_001) }), /50000/);
	}
	await assert.rejects(renderDiagram({ format: "mermaid", source: "flowchart LR\n" + "A-->B\n".repeat(501) }), /limit|edges/i);
	for (const [width, height] of [[8193, 1], [1, 8193], [4001, 4000], [0, 0]]) {
		await assert.rejects(renderDiagram({ format: "svg", source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>` }));
	}
	await assert.rejects(renderDiagram({ format: "mermaid", source: "flowchart TB\n" + Array.from({ length: 100 }, (_, i) => `A${i}-->A${i + 1}`).join("\n") }), /dimensions/i);
	// The short source fits; outlining repeated CJK glyphs exceeds the output cap.
	await assert.rejects(renderDiagram({ format: "svg", source: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text y="20">' + "繁".repeat(3000) + "</text></svg>" }), /4 MiB/);
});
