/** Local Mermaid → Pele → standalone SVG. No browser, asset fetching or disk cache. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { render, type MathResolver } from "pele";
import { checkSvg } from "../illustrations.ts";

export interface DiagramInput { format: "mermaid" | "svg"; source: string }
export interface RenderedDiagram { svg: string; width: number; height: number }

const MAX_SOURCE = 50_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_SIDE = 8192;
const MAX_PIXELS = 16_000_000;
const FONT = "Noto Sans CJK SC, Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif";
const BACKGROUND = "#ffffff";

function checkSize(width: number, height: number): void {
	if (!(width > 0 && height > 0 && Number.isFinite(width + height)) ||
		width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
		throw new Error("Diagram dimensions exceed 8192 per side or 16 million pixels, or are invalid");
	}
}

function checkOutput(svg: string): void {
	if (Buffer.byteLength(svg, "utf8") > MAX_OUTPUT) throw new Error("Diagram SVG exceeds 4 MiB");
}

/** Pele 1.13 emits only root custom properties, their aliases, and literal fallbacks.
 * Resolve those in attributes, never in label text. resvg does not implement var().
 * Palette properties emitted from themeVariables take precedence over fallbacks.
 */
function materializePele(svg: string): string {
	const root = /^<svg\b[^>]*>/.exec(svg)?.[0];
	if (!root) throw new Error("Pele produced no SVG");
	const style = /\sstyle="([^"]*)"/.exec(root)?.[1] ?? "";
	const variables = new Map<string, string>();
	for (const match of style.matchAll(/(?:^|;)(--[\w-]+):([^;]*)/g)) variables.set(match[1]!, match[2]!);
	const resolve = (value: string, depth = 0): string => {
		if (depth > 8) throw new Error("Unsupported cyclic Pele CSS variable");
		const result = value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_match, name: string, fallback: string | undefined) => {
			const replacement = variables.get(name) ?? fallback;
			if (replacement === undefined) throw new Error(`Unsupported Pele CSS variable: ${name}`);
			return resolve(replacement, depth + 1);
		});
		if (/var\s*\(/i.test(result)) throw new Error("Unsupported Pele CSS variable expression");
		return result;
	};
	return svg.replace(/<[^>]*>/g, (tag) => {
		const geometry = new Map<string, string>();
		let result = tag.replace(/(\s[\w:-]+=")([^"]*)(")/g, (_match, start: string, value: string, end: string) => {
			let resolved = resolve(value);
			if (start.trim() === 'style="') {
				resolved = resolved.replace(/(?:^|;)--[\w-]+:[^;]*/g, "").replace(/^;/, "")
					// resvg also ignores Pele's font shorthand and CSS geometry.
					.replace(/(^|;)font:([\d.]+)px sans-serif(?=;|$)/g, "$1font-size:$2px")
					.replace(/(^|;)(rx|ry):([^;]*)/g, (_declaration, _separator, name: string, radius: string) => {
						geometry.set(name, radius.trim());
						return "";
					}).replace(/^;+/, "");
			}
			return start + resolved + end;
		});
		for (const [name, value] of geometry) {
			result = result.replace(new RegExp(`\\s${name}="[^"]*"`, "g"), "").replace(/\/?\s*>$/, (end) => ` ${name}="${value}"${end}`);
		}
		return result;
	});
}

let mathResolver: MathResolver | undefined;

/** Use the same bundled modules and SVG font path as math/mathjax.ts, with a
 * separate document because its public API intentionally exposes only rasters.
 * Do not call textFontOptions: its optional font downloader is not used here.
 */
function labelMath(): MathResolver {
	if (mathResolver) return mathResolver;
	const require = createRequire(import.meta.url);
	const bundle = fileURLToPath(new URL("../../vendor/mathjax.cjs", import.meta.url));
	const { mathjax, liteAdaptor, RegisterHTMLHandler, TeX, SVG, MathJaxNewcmFont, packages } =
		require(existsSync(bundle) ? bundle : "../math/mathjax-lib.cjs");
	const adaptor = liteAdaptor({ cjkCharWidth: 1, unknownCharWidth: 0.6, unknownCharHeight: 0.8 });
	RegisterHTMLHandler(adaptor);
	const input = new TeX({
		packages, maxBuffer: 20_000, maxMacros: 1_000,
		macros: { bm: ["\\boldsymbol{#1}", 1], llbracket: "\\mathopen{\u27E6}", rrbracket: "\\mathclose{\u27E7}" },
		formatError: (_jax: unknown, error: { message: string }) => { throw new Error(error.message); },
	});
	const output = new SVG({ fontData: MathJaxNewcmFont, fontCache: "none", mtextInheritFont: true, linebreaks: { inline: false } });
	const doc = mathjax.document("", { InputJax: input, OutputJax: output });
	mathResolver = (tex, size) => {
		input.reset?.();
		const ex = size * output.font.params.x_height;
		const html: string = adaptor.outerHTML(doc.convert(tex, { display: false, em: size, ex }));
		const start = html.indexOf("<svg"), end = html.lastIndexOf("</svg>");
		if (start < 0 || end < start) throw new Error("MathJax produced no diagram label SVG");
		// MathJax's data-latex can contain unescaped XML; it is not needed to draw.
		let svg = html.slice(start, end + 6).replace(/\sdata-latex="[^"]*"/g, "");
		const width = Number(/\swidth="([\d.]+)ex"/.exec(svg)?.[1]) * ex;
		const height = Number(/\sheight="([\d.]+)ex"/.exec(svg)?.[1]) * ex;
		checkSize(width, height);
		if (svg.includes('data-mml-node="merror"')) throw new Error("Invalid diagram label TeX");
		svg = svg.replace(/\s(width|height)="[\d.]+ex"/g, (_match, dimension) => ` ${dimension}="${dimension === "width" ? width : height}"`);
		checkOutput(svg);
		checkSvg(svg);
		return { svg, width, height };
	};
	return mathResolver;
}

const ELEMENTS = new Set("svg g defs title desc path rect circle ellipse line polyline polygon text tspan textPath use symbol marker linearGradient radialGradient stop clipPath mask pattern".split(" "));
const PRESENTATION = new Set(("fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset " +
	"opacity color font-family font-size font-weight font-style font-variant font-stretch text-anchor text-decoration letter-spacing word-spacing " +
	"dominant-baseline alignment-baseline baseline-shift visibility display overflow clip-path clip-rule mask marker-start marker-mid marker-end " +
	"stop-color stop-opacity paint-order vector-effect shape-rendering text-rendering color-interpolation").split(" "));
const ATTRIBUTES = new Set(("id class style role xmlns xmlns:xlink xml:space xml:lang href xlink:href " +
	"x y x1 y1 x2 y2 dx dy width height viewBox preserveAspectRatio transform d points r rx ry cx cy fx fy fr " +
	"pathLength textLength lengthAdjust rotate startOffset method spacing " +
	"refX refY markerWidth markerHeight markerUnits orient gradientUnits gradientTransform spreadMethod offset " +
	"clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform").split(" "));

function decodeAttribute(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
		if (code[0] === "#") {
			const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
			return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		}
		return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code] ?? entity;
	});
}

/** Deliberately small static-vector subset for tool-supplied SVG, not a change
 * to illustrations.ts's existing local-file contract. XML correctness is then
 * checked by resvg; this pass prevents unsupported constructs being ignored.
 */
function checkManual(svg: string): void {
	checkSvg(svg);
	const markup = svg.replace(/^\s*<\?xml\s[^?]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
	if (/<[!?]/.test(markup)) throw new Error("SVG declarations and processing instructions are unsupported");
	for (const tag of markup.matchAll(/<\/?([^\s/>]+)((?:[^<>"']|"[^"]*"|'[^']*')*)\/?\s*>/g)) {
		const name = tag[1]!;
		if (!ELEMENTS.has(name)) throw new Error(`Unsupported SVG element: ${name}`);
		for (const attr of tag[2]!.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
			const key = attr[1]!, value = decodeAttribute(attr[3] ?? attr[4]!);
			if (!ATTRIBUTES.has(key) && !PRESENTATION.has(key) && !/^(?:aria|data)-[\w-]+$/.test(key)) {
				throw new Error(`Unsupported SVG attribute: ${key}`);
			}
			if (key === "xmlns" && value !== "http://www.w3.org/2000/svg" ||
				key === "xmlns:xlink" && value !== "http://www.w3.org/1999/xlink") throw new Error("Unsupported SVG namespace");
			if ((key === "href" || key === "xlink:href") && !/^#[^\s"'<>]+$/.test(value)) throw new Error("SVG references must be local #ids");
			if (key === "style" || PRESENTATION.has(key)) {
				if (/[\\@]|\/\*|var\s*\(|expression\s*\(/i.test(value)) throw new Error("Unsupported SVG CSS");
				checkSvg(value);
				if (key === "style") for (const declaration of value.split(";")) {
					if (!declaration.trim()) continue;
					const property = declaration.slice(0, declaration.indexOf(":")).trim();
					if (!PRESENTATION.has(property)) throw new Error(`Unsupported SVG CSS property: ${property}`);
				}
			}
		}
	}
}

export async function renderDiagram(input: DiagramInput): Promise<RenderedDiagram> {
	if (!input || (input.format !== "mermaid" && input.format !== "svg")) throw new Error("Diagram format must be mermaid or svg");
	if (typeof input.source !== "string" || !input.source.trim()) throw new Error("Diagram source is empty");
	if (input.source.length > MAX_SOURCE) throw new Error("Diagram source exceeds 50000 characters");
	let svg: string;
	if (input.format === "mermaid") {
		const result = render(input.source, {
			responsive: false, fontFamily: FONT, fontSize: 20, maxWidth: 960, padding: 20,
			links: false, images: false, limit: MAX_SOURCE, outputLimit: MAX_OUTPUT, maxEdges: 500,
			math: input.source.includes("$$") ? labelMath() : undefined,
		});
		checkSize(result.width, result.height);
		svg = materializePele(result.svg);
	} else {
		checkManual(input.source);
		svg = input.source;
	}
	checkOutput(svg);
	checkSvg(svg);
	// Local system fonts only; outlining makes the result independent of fonts
	// at its eventual consumer. Parsing does not allocate a raster canvas.
	const parsed = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" } });
	const { width, height } = parsed;
	checkSize(width, height);
	if (parsed.imagesToResolve().length) throw new Error("SVG external resources are unsupported");
	const normalized = parsed.toString();
	checkOutput(normalized);
	// An actual painted rectangle, not CSS background (unsupported by resvg).
	svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${BACKGROUND}"/>${normalized}</svg>`;
	checkOutput(svg);
	checkSvg(svg);
	return { svg, width, height };
}
