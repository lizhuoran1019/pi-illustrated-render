import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getOsc8LinkAtColumn, setCellDimensions, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { selectionWithFormulas, rememberFormulaSource, forgetFormulaSources } from "../src/math/copy.ts";
import { clearFormulaCache, createMathRenderer } from "../src/math/formula.ts";
import { forgetImages, placeholderRows, PLACEHOLDER, setKittyWriter } from "../src/math/kitty.ts";
import { loadMathJax } from "../src/math/mathjax.ts";
import { renderBlock } from "../src/render/blocks.ts";
import { codeButtonText } from "../src/render/code-action.ts";
import { noMath, type CodeAction, type IllustrationRenderer, type MathRenderer } from "../src/render/context.ts";
import { clearLexCache, lex } from "../src/render/lexer.ts";
import { clearBlockCache, renderMarkdown, RichMarkdown } from "../src/render/rich-markdown.ts";
import { wrap } from "../src/render/util.ts";
import { state } from "../src/state.ts";
import { plainStyle } from "../src/style.ts";

const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const bounded = (lines: string[], width: number) => {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
};
const draw = (source: string, width: number, math: MathRenderer = noMath, streaming = false, actions?: CodeAction[], illustrations?: IllustrationRenderer) =>
	renderMarkdown(source, width, { style: plainStyle(), math, streaming, illustrations }, actions);
let saved: { math: typeof state.math; lineNumbers: boolean; images?: string; fonts?: string };
beforeEach(() => {
	saved = { math: state.math, lineNumbers: state.lineNumbers, images: process.env.PI_BETTER_RENDER_IMAGES, fonts: process.env.PI_BETTER_RENDER_FONT_DOWNLOAD };
	state.math = "streaming"; state.lineNumbers = false;
	process.env.PI_BETTER_RENDER_IMAGES = "placeholder";
	process.env.PI_BETTER_RENDER_FONT_DOWNLOAD = "0";
	setCellDimensions({ widthPx: 9, heightPx: 20 });
	setKittyWriter(() => {});
	clearBlockCache(); clearLexCache(); clearFormulaCache(); forgetImages(); forgetFormulaSources();
});
afterEach(() => {
	state.math = saved.math; state.lineNumbers = saved.lineNumbers;
	for (const [key, value] of [["PI_BETTER_RENDER_IMAGES", saved.images], ["PI_BETTER_RENDER_FONT_DOWNLOAD", saved.fonts]]) {
		if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
	}
	setKittyWriter(undefined);
});

test("code wraps consumed CJK/emoji graphemes without losing boundary characters or ANSI styles", () => {
	for (const source of ["甲乙丙丁戊己", "a👩‍💻b🇨🇳c👍🏽dé甲乙", "12345678"]) {
		for (const width of [2, 3, 4, 5, 9, 10, 17]) {
			const style = { ...plainStyle(), key: "ansi", codeBg: "\x1b[48;5;235m", highlight: (text: string) => [`\x1b[31m${text}\x1b[39m`] };
			const lines = renderMarkdown(`\`\`\`text\n${source}\n\`\`\``, width, { style, math: noMath, streaming: false });
			bounded(lines, width);
			assert.equal(plain(lines.slice(1, -1)).map((line) => line.replace(/^[ ↪]/, "").trimEnd()).join(""), source);
			assert.ok(lines.slice(1, -1).every((line) => line.includes("\x1b[31m")));
		}
	}
	bounded(draw("```\n甲👩‍💻乙\n```", 1), 1);
});

test("nested code, list/callout prefixes, and component padding honor narrow budgets", () => {
	const sources = ["> > ```\n> > 12345678\n> > ```", "> [!WARNING]\n> - item\n>\n>   ```js\n>   12345678甲乙\n>   ```", "| A | B |\n| - | - |\n| 甲乙 | 12345678 |"];
	for (const lineNumbers of [false, true]) {
		state.lineNumbers = lineNumbers;
		for (let width = 1; width <= 16; width++) {
			for (const source of sources) {
				const actions: CodeAction[] = [];
				bounded(draw(source, width, noMath, false, actions), width);
				const component = new RichMarkdown(source, { paddingX: 5, style: plainStyle(), math: noMath, streaming: false });
				bounded(component.render(width), width);
			}
		}
	}
	assert.equal(plain(draw(sources[0]!, 10)).join("").replace(/[▎ ↪]/g, ""), "12345678");
});

test("copy controls retain exact original code and nested/padded coordinates", async () => {
	const source = "> [!NOTE]\n> - item\n>\n>   ```js\n>   1 + 2\n>   ```";
	for (const width of [12, 18, 40]) {
		const actions: CodeAction[] = [];
		const lines = draw(source, width, noMath, false, actions);
		bounded(lines, width);
		for (const action of actions) {
			assert.equal(sliceByColumn(stripTerminalSequences(lines[action.y]!), action.x, action.width), codeButtonText("idle"));
			assert.equal(action.code, "1 + 2");
		}
		if (width === 40) assert.equal(actions.length, 1);
	}
	let copied = "";
	const padded = new RichMarkdown(source, { paddingX: 2, style: plainStyle(), math: noMath, streaming: false, copyCode: async (code) => { copied = code; } });
	const rendered = plain(padded.render(40));
	const y = rendered.findIndex((line) => line.includes(codeButtonText("idle")));
	const x = visibleWidth(rendered[y]!.split(codeButtonText("idle"))[0]!);
	const event = { button: "left" as const, x, y, screenX: x, screenY: y, width: 40, height: rendered.length, shift: false, alt: false, ctrl: false };
	assert.ok(padded.handleMouse({ ...event, type: "press" })?.capture);
	assert.ok(padded.handleMouse({ ...event, type: "release" })?.handled);
	await Promise.resolve();
	assert.equal(copied, "1 + 2");
	assert.equal(sliceByColumn(stripTerminalSequences(padded.render(40)[y]!), x, visibleWidth(codeButtonText("success"))), codeButtonText("success"));
	let available = 0;
	const component = new RichMarkdown("old", { paddingX: 10, style: plainStyle(), math: noMath, streaming: true, transform: (_text, width) => { available = width; return "new"; } });
	assert.equal(plain(component.render(3)).join(""), " n e w");
	assert.equal(available, 1);
});

test("code spans preserve literal entities while normal prose decodes them", () => {
	assert.deepEqual(plain(draw("`&lt;div&gt; &#65; &amp;`", 80)), ["&lt;div&gt; &#65; &amp;"]);
	assert.deepEqual(plain(draw("&lt;div&gt; &#65; &amp;", 80)), ["<div> A &"]);
});

test("callout marker removal preserves resolved references and shared lexer tokens", () => {
	const source = "> [!NOTE]\n> See [guide][g] and ![field][f].\n\n[g]: https://example.com\n[f]: field.svg";
	const tokens = lex(source, false);
	const before = JSON.stringify(tokens);
	const ctx = { style: plainStyle(), math: noMath, width: 80, streaming: false, listDepth: 0 };
	const lines = renderBlock(tokens[0], ctx);
	assert.equal(JSON.stringify(tokens), before);
	assert.match(plain(lines).join("\n"), /See guide ‹https:\/\/example.com› and \[image: field\]/);
	const linkLine = lines.find((line) => stripTerminalSequences(line).includes("guide"))!;
	assert.equal(getOsc8LinkAtColumn(linkLine, 6), "https://example.com");
	let href = "";
	const illustrations: IllustrationRenderer = { key: "reference", block: (image) => { href = image.href; return { status: "ready", lines: ["IMG"], columns: 3 }; } };
	draw("> [!TIP]\n> ![field][f]\n\n[f]: field.svg", 30, noMath, true, undefined, illustrations);
	assert.equal(href, "field.svg");
});

test("inline images move whole to the next line and preserve all cells/source", () => {
	const image = placeholderRows(101, 8, 1)[0]!;
	rememberFormulaSource(101, "$x+y$", false);
	for (const input of [`甲乙丙丁戊${image}尾巴`, `prefix ${image}longunbrokenwordandmore`, `${image}${image}结束`, `\x1b[1m123456789${image}done\x1b[22m`]) {
		const lines = wrap(input, 12);
		bounded(lines, 12);
		assert.equal(lines.join("").split(image).length - 1, input.split(image).length - 1);
		assert.equal((lines.join("").match(/\u{10EEEE}/gu) ?? []).length, (input.match(/\u{10EEEE}/gu) ?? []).length);
		assert.ok(selectionWithFormulas(lines).includes("$x+y$"));
		assert.equal(plain(lines).join("").replace(/\s/g, ""), stripTerminalSequences(input).replace(/\s/g, ""));
	}
	const moved = wrap(`123456${image}`, 12);
	assert.equal(moved[0], "123456");
	assert.equal(moved[1], image);
	const tooWide = wrap(image, 4);
	bounded(tooWide, 4);
	assert.equal(plain(tooWide).join(""), "$x+y$");
});

test("text after full and partial inline image lines is never lost", () => {
	for (const columns of [3, 8, 12]) {
		const image = placeholderRows(101, columns, 1)[0]!;
		for (const prefix of ["", "1234 ", "甲乙 "]) {
			for (const suffix of [" and text", " next again more", "   甲乙 丙", "longunbrokenword"]) {
				const input = prefix + image + suffix;
				const lines = wrap(input, 12);
				bounded(lines, 12);
				assert.equal(plain(lines).join("").replace(/\s/g, ""), stripTerminalSequences(input).replace(/\s/g, ""));
				assert.equal(lines.join("").split(image).length - 1, 1);
			}
		}
	}
});

test("image-induced and literal line breaks retain formatting and hyperlink state", () => {
	const image = placeholderRows(101, 8, 1)[0]!;
	const open = "\x1b]8;;https://example.com\x1b\\";
	const close = "\x1b]8;;\x1b\\";
	for (const separator of [" ", "\n", "\r\n"]) {
		const lines = wrap(`\x1b[1m${open}123456${separator}${image} tail${close}\x1b[22m`, 12);
		bounded(lines, 12);
		const imageLine = lines.find((line) => line.includes(image))!;
		assert.match(imageLine.slice(0, imageLine.indexOf(image)), /\x1b\[1m/);
		assert.equal(getOsc8LinkAtColumn(imageLine, 0), "https://example.com");
		const tailLine = lines.find((line) => stripTerminalSequences(line).includes("tail"))!;
		const tailColumn = stripTerminalSequences(tailLine).indexOf("tail");
		assert.match(sliceByColumn(tailLine, tailColumn, 1), /\x1b\[1m/);
		assert.equal(getOsc8LinkAtColumn(tailLine, tailColumn), "https://example.com");
		assert.equal(getOsc8LinkAtColumn(tailLine + " padding", visibleWidth(tailLine) + 1), undefined);
	}
	const lines = wrap(`${open}123456 ${image} tail${close}`, 12);
	assert.equal(getOsc8LinkAtColumn(lines[0]! + " padding", 8), undefined);
});

test("real inline math respects width, streaming/final/off modes and original copy source", async () => {
	assert.ok(await loadMathJax());
	const math = createMathRenderer(() => "#ffffff");
	const source = "$x+y$";
	// Existing four-argument calls retain their behavior.
	const image = math.inline("x+y", false, false, source)!;
	assert.ok(image.includes(PLACEHOLDER));
	assert.equal(selectionWithFormulas([image]), source);
	const formulaWidth = visibleWidth(image);
	const exact = draw(`${source} and text`, formulaWidth, math);
	assert.equal(selectionWithFormulas(exact).replace(/\s/g, ""), `${source}andtext`);
	const width = formulaWidth + 2;
	for (const streaming of [false, true]) {
		const lines = draw(`abcdef ${source} end`, width, math, streaming);
		bounded(lines, width);
		const rendered = math.inline("x+y", false, streaming, source, width)!;
		assert.equal(lines.filter((line) => line.includes(rendered)).length, 1);
		assert.ok(selectionWithFormulas(lines).includes(source));
	}
	assert.ok(!draw("prefix $x+y", 20, math, true).join("").includes(PLACEHOLDER));
	const long = String.raw`$W_{AB}=q(\varphi_A-\varphi_B)=qEd=F_ed=qE(x_B-x_A)=E_{pA}-E_{pB}=K_B-K_A$`;
	for (const columns of [2, 10, 24, 64]) {
		const expectedImage = math.inline(long.slice(1, -1), false, true, long, columns);
		const paragraph = draw(`功与能关系：${long}，因此成立。`, columns, math, true);
		if (expectedImage) {
			assert.equal(paragraph.filter((line) => line.includes(expectedImage)).length, 1);
			assert.ok(selectionWithFormulas(paragraph).includes(long));
		} else assert.ok(!paragraph.join("").includes(PLACEHOLDER));
		for (const markdown of [`功与能关系：${long}，因此成立。`, `> > 关系 ${long}`, `| Formula | value |\n| --- | --- |\n| ${long} | ${source} |`]) {
			const lines = draw(markdown, columns, math, true);
			bounded(lines, columns);
			for (const line of lines) {
				for (const run of line.matchAll(/\x1b\[38;2;\d+;\d+;\d+m(?:\u{10EEEE}\p{M}*)+\x1b\[39m/gu)) {
					assert.ok(selectionWithFormulas([run[0]]).startsWith("$"));
				}
			}
		}
	}
	state.math = "final";
	assert.ok(!draw(`prefix ${source}`, 30, math, true).join("").includes(PLACEHOLDER));
	assert.ok(draw(`prefix ${source}`, 30, math, false).join("").includes(PLACEHOLDER));
	state.math = "off";
	assert.ok(!draw(`prefix ${source}`, 30, math).join("").includes(PLACEHOLDER));
});

test("figure captions and decoded original links share the centered image bounds, including nested quotes", () => {
	const sourceUrl = "file:///tmp/%E5%9B%BE%20%231.svg";
	let lastSource = "";
	const illustrations: IllustrationRenderer = {
		key: "figures",
		block: (image, width) => {
			lastSource = image.source;
			const columns = Math.min(10, width);
			rememberFormulaSource(202, image.source, true);
			return { status: "ready", columns, lines: placeholderRows(202, columns, 1), sourceUrl };
		},
	};
	const markdown = "![甲乙丙丁戊己庚辛壬癸](<图%20一.svg> \"标题\")";
	for (const prefix of ["", "> ", "> > ", "> - "]) {
		for (const width of [1, 2, 3, 4, 8, 12, 40]) {
			const lines = draw(prefix + markdown, width, noMath, false, undefined, illustrations);
			bounded(lines, width);
			assert.equal(lastSource, markdown);
			assert.ok(selectionWithFormulas(lines).includes(markdown));
			const imageLine = lines.find((line) => line.includes(PLACEHOLDER))!;
			const left = visibleWidth(imageLine.slice(0, imageLine.indexOf("\x1b[38;2;")));
			const columns = (imageLine.match(/\u{10EEEE}/gu) ?? []).length;
			const linkLine = lines.at(-1)!;
			assert.equal(getOsc8LinkAtColumn(linkLine, left), sourceUrl);
			for (const line of lines.slice(1)) assert.ok(visibleWidth(line) <= left + columns);
			if (columns >= 2) {
				const caption = lines.slice(1, -1).map((line) => stripTerminalSequences(sliceByColumn(line, left, columns))).join("");
				assert.equal(caption, "甲乙丙丁戊己庚辛壬癸");
			}
		}
	}
	for (const caption of ["甲乙丙丁戊。", "甲乙丙丁戊己"]) {
		const lines = draw(`![${caption}](a.svg)`, 40, noMath, false, undefined, illustrations);
		const text = plain(lines.slice(1, -1)).map((line) => line.trim());
		assert.equal(text.join(""), caption);
		assert.ok(text.every((line) => visibleWidth(line) > 2));
		bounded(lines, 40);
	}
	const ctx = { style: plainStyle(), math: noMath, illustrations, width: 40, streaming: false, listDepth: 0 };
	const lines = renderBlock({ type: "paragraph", tokens: [{ type: "image", text: "safe\x1b[31mtext\x07", href: "a.svg", raw: "![safe](a.svg)" }] }, ctx);
	assert.ok(!lines.join("").includes("\x1b[31m"));
	assert.ok(!lines.join("").includes("\x07"));
});
