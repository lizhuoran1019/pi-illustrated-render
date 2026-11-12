import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { selectionWithFormulas } from "../math/copy.ts";

export { visibleWidth };

export type Align = "left" | "center" | "right";

/** An inline image: `\x1b[38;2;R;G;Bm` + placeholder cells + `\x1b[39m` (see math/kitty.ts). */
const IMAGE_RUN = /(\x1b\[38;2;\d{1,3};\d{1,3};\d{1,3}m)((?:\u{10EEEE}\p{M}*)+)\x1b\[39m/gu;
/** Replay the styling at the end of a line, without its visible contents. */
function trailingStyle(line: string): string {
	return sliceByColumn(line + " ", visibleWidth(line), 1).slice(0, -1);
}

/** Word-wrap text, keeping each inline image an indivisible layout unit. */
export function wrap(text: string, width: number): string[] {
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
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
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
