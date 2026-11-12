import { hyperlink, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderCode } from "./code.ts";
import { offsetCodeActions, type RenderContext } from "./context.ts";
import { latexFallback, renderInline } from "./inline.ts";
import { renderTable } from "./table.ts";
import { visibleWidth, wrap } from "./util.ts";

const BULLETS = ["•", "◦", "▪"];

const CALLOUTS: Record<string, { icon: string; color: string; label: string }> = {
	NOTE: { icon: "ℹ", color: "mdLink", label: "Note" },
	TIP: { icon: "✦", color: "success", label: "Tip" },
	IMPORTANT: { icon: "❖", color: "accent", label: "Important" },
	WARNING: { icon: "▲", color: "warning", label: "Warning" },
	CAUTION: { icon: "✖", color: "error", label: "Caution" },
};

/** Render a sequence of block tokens, separated by one blank line (or none when `tight`). */
export function renderBlocks(tokens: any[], ctx: RenderContext, tight = false): string[] {
	const out: string[] = [];
	for (const token of tokens) {
		if (token.type === "space" || token.type === "def") continue;
		const lines = renderBlock(token, offsetCodeActions(ctx, 0, out.length + (out.length > 0 && !tight ? 1 : 0)));
		if (lines.length === 0) continue;
		if (out.length > 0 && !tight) out.push("");
		out.push(...lines);
	}
	return out;
}

export function renderBlock(token: any, ctx: RenderContext): string[] {
	switch (token.type) {
		case "heading":
			return renderHeading(token, ctx);
		case "paragraph":
		case "text":
			return renderIllustration(token, ctx) ?? wrap(token.tokens ? renderInline(token.tokens, ctx) : token.text, ctx.width);
		case "code":
			return renderCode(token, ctx);
		case "table":
			return renderTable(token, ctx);
		case "list":
			return renderList(token, ctx);
		case "blockquote":
			return renderQuote(token, ctx);
		case "hr":
			return [ctx.style.fg("mdHr", "─".repeat(Math.max(1, ctx.width)))];
		case "html":
			return wrap(ctx.style.fg("muted", String(token.text ?? token.raw).replace(/\n+$/, "")), ctx.width);
		case "blockMath":
			return renderBlockMath(token, ctx);
		default:
			return token.raw ? wrap(String(token.raw).replace(/\n+$/, ""), ctx.width) : [];
	}
}

/** Keep inline syntax verbatim; expand references so clipboard text works on its own. */
function imageCopySource(image: any): string {
	const raw = String(image.raw ?? "");
	let depth = 1;
	for (let i = 2; i < raw.length; i++) {
		if (raw[i] === "\\") { i++; continue; }
		if (raw[i] === "[") depth++;
		if (raw[i] === "]" && --depth === 0) {
			if (raw[i + 1] === "(") return raw;
			break;
		}
	}
	const alt = String(image.text ?? "").replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&").replace(/\r?\n/g, " ");
	const href = String(image.href ?? "").replace(/&/g, "&amp;").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\\/g, "%5C").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	const title = image.title ? ` "${String(image.title).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"` : "";
	return `![${alt}](<${href}>${title})`;
}

/** Images occupy a paragraph of their own; inline images remain readable links. */
function renderIllustration(token: any, ctx: RenderContext): string[] | undefined {
	if (!ctx.illustrations || !Array.isArray(token.tokens)) return;
	const meaningful = token.tokens.filter((t: any) => !(t.type === "text" && !String(t.text).trim()));
	if (meaningful.length !== 1 || meaningful[0].type !== "image") return;
	const image = meaningful[0];
	const safeText = (s: string) => stripTerminalSequences(s).replace(/[\x00-\x1f\x7f]/g, " ");
	const alt = safeText(String(image.text ?? ""));
	const href = String(image.href ?? "");
	const result = ctx.illustrations.block({ href, alt, source: imageCopySource(image) }, ctx.width);
	if (result.status === "fallback") {
		return wrap(ctx.style.fg("muted", `[图片${alt ? "：" + alt : ""}] ${safeText(result.message)}\n${safeText(href)}`), ctx.width);
	}
	const left = " ".repeat(Math.max(0, Math.floor((ctx.width - result.columns) / 2)));
	const lines = result.lines.map((line) => left + line);
	if (alt) {
		let caption = wrap(alt, result.columns);
		// Avoid leaving a lone CJK character or closing punctuation under a wide figure.
		if (result.columns >= 8 && caption.length > 1 && visibleWidth(caption.at(-1)!) <= 2) caption = wrap(alt, result.columns - 2);
		lines.push(...caption.map((line) => left + ctx.style.fg("muted", line)));
	}
	if (result.sourceUrl) {
		const label = result.columns >= 8 ? "查看原图" : result.columns >= 4 ? "原图" : result.columns >= 2 ? "图" : "↗";
		lines.push(left + hyperlink(ctx.style.fg("mdLink", safeText(label)), result.sourceUrl));
	}
	return lines;
}

function renderHeading(token: any, ctx: RenderContext): string[] {
	const { style } = ctx;
	const content = renderInline(token.tokens, ctx);
	const width = ctx.width;
	switch (token.depth) {
		case 1: {
			const lines = wrap(style.bold(style.fg("mdHeading", content)), width);
			return [...lines, style.fg("mdHeading", "━".repeat(width))];
		}
		case 2: {
			const lines = wrap(style.bold(style.fg("mdHeading", content)), width);
			const underline = Math.min(width, Math.max(...lines.map(visibleWidth)) + 2);
			return [...lines, style.fg("mdHr", "─".repeat(underline))];
		}
		case 3:
			return wrap(style.fg("accent", "▍") + " " + style.bold(style.fg("mdHeading", content)), width);
		case 4:
			return wrap(style.bold(style.fg("accent", content)), width);
		case 5:
			return wrap(style.bold(content), width);
		default:
			return wrap(style.italic(style.fg("muted", content)), width);
	}
}

function renderList(token: any, ctx: RenderContext): string[] {
	const { style } = ctx;
	const out: string[] = [];
	const start = typeof token.start === "number" ? token.start : 1;
	const last = start + token.items.length - 1;
	const numberWidth = token.ordered ? String(last).length + 1 : 0;

	token.items.forEach((item: any, index: number) => {
		let marker: string;
		let markerWidth: number;
		if (token.ordered) {
			const n = `${start + index}.`;
			marker = style.fg("mdListBullet", n.padStart(numberWidth));
			markerWidth = numberWidth;
		} else {
			marker = style.fg("mdListBullet", BULLETS[ctx.listDepth % BULLETS.length]!);
			markerWidth = 1;
		}
		if (item.task) {
			const box = item.checked ? style.fg("success", "☑") : style.fg("muted", "☐");
			marker = token.ordered ? `${marker} ${box}` : box;
			markerWidth = token.ordered ? markerWidth + 2 : 1;
		}
		const indent = Math.min(markerWidth + 1, Math.max(0, ctx.width - 2));
		const prefix = sliceByColumn(marker + " ", 0, indent, true);
		const childCtx: RenderContext = { ...offsetCodeActions(ctx, indent, out.length + (index > 0 && token.loose ? 1 : 0)), width: ctx.width - indent, listDepth: ctx.listDepth + 1 };
		const tokens = (item.tokens ?? []).filter((t: any) => t.type !== "checkbox");
		const body = renderBlocks(tokens, childCtx, !item.loose);
		const lines = body.length > 0 ? body : [""];
		if (index > 0 && token.loose) out.push("");
		lines.forEach((line, i) => {
			out.push((i === 0 ? prefix : " ".repeat(indent)) + line);
		});
	});
	return out;
}

function renderQuote(token: any, ctx: RenderContext): string[] {
	const { style } = ctx;
	let tokens: any[] = token.tokens ?? [];
	let callout: (typeof CALLOUTS)[string] | undefined;

	// GitHub alert syntax: first paragraph starts with [!TYPE]
	const first = tokens[0];
	if (first?.type === "paragraph") {
		const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i.exec(first.raw ?? "");
		if (m) {
			callout = CALLOUTS[m[1]!.toUpperCase()];
			const rest = String(first.raw).slice(m[0].length);
			let remaining = m[0].length;
			const inline = (first.tokens ?? []).flatMap((part: any) => {
				if (remaining === 0) return [part];
				const raw = String(part.raw ?? "");
				const removed = Math.min(remaining, raw.length);
				remaining -= removed;
				return removed === raw.length ? [] : [{ ...part, raw: raw.slice(removed), text: String(part.text).slice(removed) }];
			});
			tokens = rest.trim()
				? [{ ...first, raw: rest, text: rest, tokens: inline }, ...tokens.slice(1)]
				: tokens.slice(1);
		}
	}

	const color = callout?.color ?? "mdQuoteBorder";
	const bar = style.fg(color, "▎");
	const indent = Math.min(2, Math.max(0, ctx.width - 2));
	const prefix = indent === 2 ? `${bar} ` : indent === 1 ? bar : "";
	const header = callout ? wrap(style.bold(style.fg(callout.color, `${callout.icon} ${callout.label}`)), ctx.width - indent) : [];
	const innerCtx: RenderContext = {
		...offsetCodeActions(ctx, indent, header.length),
		width: ctx.width - indent,
		textStyle: callout ? ctx.textStyle : (t) => style.fg("mdQuote", t),
	};
	const body = renderBlocks(tokens, innerCtx);
	const lines = header.map((line) => prefix + line);
	for (const line of body) lines.push(prefix + line);
	return lines.length > 0 ? lines : [bar];
}

function renderBlockMath(token: any, ctx: RenderContext): string[] {
	const { style } = ctx;
	if (!token.closed) {
		// Still streaming: show the source dimmed until the closing delimiter arrives.
		return wrap(style.fg("dim", String(token.text)), ctx.width);
	}
	const image = ctx.math.block(token.text, ctx.width, ctx.streaming, String(token.raw).trim());
	if (image) {
		const imageWidth = visibleWidth(image[0] ?? "");
		const left = Math.max(0, Math.floor((ctx.width - imageWidth) / 2));
		return image.map((line) => " ".repeat(left) + line);
	}
	const fallback = latexFallback(token.text, true);
	const lines = fallback.split("\n").map((l) => style.fg("mdCode", l));
	const widest = Math.max(...lines.map(visibleWidth));
	if (widest > ctx.width) return wrap(lines.join("\n"), ctx.width);
	// Center the block as a whole so multi-line layouts (fractions, cases) stay aligned.
	const left = " ".repeat(Math.floor((ctx.width - widest) / 2));
	return lines.map((l) => left + l);
}
