import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { selectionWithFormulas } from "../math/copy.ts";

export { visibleWidth };

export type Align = "left" | "center" | "right";

/** An inline image: `\x1b[38;2;R;G;Bm` + placeholder cells + `\x1b[39m` (see math/kitty.ts). */
const IMAGE_RUN = /(\x1b\[38;2;\d{1,3};\d{1,3};\d{1,3}m)((?:\u{10EEEE}\p{M}*)+)\x1b\[39m/gu;
/** Replay the styling at the end of a line, without its visible contents. */
function trailingStyle(line: string): string {
	return sliceByColumn(line + " ", visibleWidth(line), 1).slice(0, -1);
}

const NO_START = new Set("，。、；：！？）》〉」』】〕］｝”’");
const NO_END = new Set("（《〈「『【〔［｛“‘");
const CJK_PUNCTUATION = /[，。、；：！？）》〉」』】〕］｝”’（《〈「『【〔［｛“‘]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Visible units for choosing a break; a formula image is one whole unit. */
function lineUnits(line: string): { text: string; column: number; width: number }[] {
	const images = [...line.matchAll(IMAGE_RUN)].map((match) => ({ column: visibleWidth(line.slice(0, match.index)), width: visibleWidth(match[0]) }));
	const units: { text: string; column: number; width: number }[] = [];
	let column = 0, imageEnd = 0;
	for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
		const width = visibleWidth(segment);
		const image = images.find((item) => item.column === column);
		if (image) { units.push({ text: "\u{10EEEE}", column, width: image.width }); imageEnd = column + image.width; }
		else if (column >= imageEnd && width > 0) units.push({ text: segment, column, width });
		column += width;
	}
	return units;
}

/** Column slicing may omit an image's trailing color reset. Restore complete
 * image runs so later wrapping and transport still see the same atomic unit.
 */
function sliceUnits(line: string, start: number, width: number): string {
	const sliced = sliceByColumn(line, start, width, true);
	const images = [...line.matchAll(IMAGE_RUN)].map((match) => ({ text: match[0], column: visibleWidth(line.slice(0, match.index)), width: visibleWidth(match[0]) }));
	return sliced.replace(/(?:\u{10EEEE}\p{M}*)+/gu, (cells, offset: number) => {
		const column = start + visibleWidth(sliced.slice(0, offset));
		return images.find((image) => image.column === column && image.width === visibleWidth(cells))?.text ?? cells;
	});
}

/** Use the host to close active SGR/OSC 8 state at an inserted line break. */
function closeLine(line: string, width: number): string {
	if (!line.includes("\x1b") || visibleWidth(line) === 0) return line;
	return wrapTextWithAnsi(line + " " + "x".repeat(width), width)[0]!;
}

/** Repair soft CJK breaks without splitting a visible unit. */
function balanceCjk(lines: string[], width: number): string[] {
	for (let i = 0; i + 1 < lines.length; i++) {
		let before = lineUnits(lines[i]!);
		let after = lineUnits(lines[i + 1]!);
		if (before.length === 0 || after.length === 0) continue;
		// Moving an opener forward can leave a short intermediate line. Fill its
		// spare space with the following closer before trying another forward move.
		if (NO_START.has(after[0]!.text)) {
			const spare = width - visibleWidth(lines[i]!);
			const nextWidth = visibleWidth(lines[i + 1]!);
			let take = nextWidth <= spare ? nextWidth : 0;
			if (take === 0) {
				for (const unit of after) {
					if (!NO_START.has(unit.text) || take + unit.width > spare) break;
					take += unit.width;
				}
			}
			if (take > 0) {
				lines[i] = closeLine(lines[i]! + sliceUnits(lines[i + 1]!, 0, take), width);
				if (take === nextWidth) {
					lines.splice(i + 1, 1);
					i--; // Check the newly adjacent boundary, if there is one.
					continue;
				}
				lines[i + 1] = closeLine(sliceUnits(lines[i + 1]!, take, nextWidth - take), width);
				before = lineUnits(lines[i]!);
				after = lineUnits(lines[i + 1]!);
			}
		}
		if (before.length < 2 || after.length === 0) continue;
		if (!NO_END.has(before.at(-1)!.text) && !NO_START.has(after[0]!.text)) continue;
		let cut = before.length - 1;
		// Carry closing punctuation together with its preceding character, and
		// never leave an opening bracket/quote alone at the previous line's end.
		while (cut > 0 && NO_START.has(before[cut]!.text)) cut--;
		while (cut > 0 && NO_END.has(before[cut - 1]!.text)) cut--;
		const column = before[cut]!.column;
		const moved = visibleWidth(lines[i]!) - column;
		// Some units cannot fit together (e.g. a full-width formula + punctuation).
		// Preserve them intact rather than exceeding the budget or losing text.
		if (column === 0 || moved + after[0]!.width > width) continue;
		const left = closeLine(sliceUnits(lines[i]!, 0, column), width);
		const right = sliceUnits(lines[i]!, column, moved) + lines[i + 1]!;
		lines.splice(i, 2, left, ...wrapAtomic(right, width));
	}
	return lines;
}

/** Wrap prose with basic CJK punctuation rules; explicit newlines stay hard. */
export function wrap(text: string, width: number): string[] {
	const w = Math.max(1, width);
	if (!CJK_PUNCTUATION.test(text)) return wrapAtomic(text, w);
	const parts = text.split(/\r\n|\r|\n/);
	const lines: string[] = [];
	let carry = "";
	parts.forEach((part, index) => {
		const input = carry + part;
		carry = trailingStyle(input);
		const wrapped = balanceCjk(wrapAtomic(input, w), w);
		if (index < parts.length - 1 && wrapped.length > 0) wrapped[wrapped.length - 1] = closeLine(wrapped.at(-1)!, w);
		lines.push(...wrapped);
	});
	return lines;
}

/** Word-wrap text, keeping each inline image an indivisible layout unit. */
function wrapAtomic(text: string, width: number): string[] {
	const w = Math.max(1, width);
	const wrapText = (value: string) => wrapTextWithAnsi(value, w)
		.map((part) => visibleWidth(part) > w ? truncateToWidth(part, w, "�") : part);
	if (!text.includes("\u{10EEEE}")) return wrapText(text);
	const out: string[] = [];
	let carry = "";
	for (const input of text.split(/\r\n|\r|\n/)) {
		const line = carry + input;
		carry = trailingStyle(line);
		if (visibleWidth(line) <= w) {
			out.push(line);
			continue;
		}
		const images = [...line.matchAll(IMAGE_RUN)];
		if (images.length === 0) {
			out.push(...wrapText(line));
			continue;
		}
		let current = "";
		const appendText = (value: string) => {
			if (!value) return;
			const used = visibleWidth(current);
			// A non-whitespace reservation cannot be trimmed by the host wrapper.
			// It stays on the first line, even when the following word is too wide.
			const parts = wrapText("x".repeat(used) + trailingStyle(current) + value);
			current += parts[0]!.slice(used);
			for (const part of parts.slice(1)) {
				out.push(current);
				current = part;
			}
		};
		let end = 0;
		for (const match of images) {
			appendText(line.slice(end, match.index));
			const image = match[0];
			const columns = visibleWidth(image);
			if (columns > w) {
				// Legacy renderers may ignore the optional width argument. Never
				// slice their pixels; retain registered Markdown as readable text.
				const source = selectionWithFormulas([image]);
				appendText(source.includes("\u{10EEEE}") ? "[formula]" : source);
			} else {
				if (visibleWidth(current) + columns > w) {
					// Force a normal host line break before an artificial full-width
					// word. The host closes/reopens SGR and OSC 8 state; discard only
					// that word and keep its continuation styling for the image.
					const parts = wrapText(current + " " + "x".repeat(w));
					out.push(...parts.slice(0, -1));
					current = trailingStyle(parts.at(-1)!);
				}
				current += image;
			}
			end = match.index + image.length;
		}
		appendText(line.slice(end));
		out.push(current);
	}
	return out;
}

export function pad(text: string, width: number, align: Align = "left"): string {
	const gap = Math.max(0, width - visibleWidth(text));
	if (align === "right") return " ".repeat(gap) + text;
	if (align === "center") {
		const left = Math.floor(gap / 2);
		return " ".repeat(left) + text + " ".repeat(gap - left);
	}
	return text + " ".repeat(gap);
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			// Entities are text, not a route for injecting terminal commands. Keep
			// rejected entities visible; only ordinary text whitespace is decoded.
			const control = code < 0x20 && code !== 9 && code !== 10 && code !== 13 || code >= 0x7f && code <= 0x9f;
			const scalar = Number.isFinite(code) && code >= 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff);
			return scalar && !control ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[body.toLowerCase()] ?? match;
	});
}

/** Plain text of an inline token tree (used for callout detection, link labels). */
export function plainText(tokens: any[] | undefined): string {
	if (!tokens) return "";
	return tokens
		.map((t) => (t.tokens ? plainText(t.tokens) : decodeEntities(t.text ?? t.raw ?? "")))
		.join("");
}
