import type { Style } from "../style.ts";

/** Turns formulas into terminal output; returns undefined to request the text fallback. */
export interface MathRenderer {
	/**
	 * Single-row image placeholder string for an inline formula. `source` is
	 * its Markdown, delimiters included, which a copied selection gets back.
	 * Optional `maxColumns` is the whole line budget, not its remaining space;
	 * callers without it retain the original unconstrained inline behavior.
	 */
	inline(tex: string, display: boolean, streaming: boolean, source?: string, maxColumns?: number): string | undefined;
	/** Placeholder rows for a display formula no wider than `maxColumns`. */
	block(tex: string, maxColumns: number, streaming: boolean, source?: string): string[] | undefined;
	/** Part of every cache key: changes when image output would change. */
	readonly key: string;
}

export interface IllustrationRequest { href: string; alt: string; source: string }
/** `sourceUrl`, when present, is an escaped file:// URL supplied by the image service. */
export type IllustrationResult = { status: "ready"; lines: string[]; columns: number; sourceUrl?: string } | { status: "fallback"; message: string };
export interface IllustrationRenderer {
	readonly key: string;
	block(image: IllustrationRequest, maxColumns: number): IllustrationResult;
}

export interface CodeAction {
	x: number;
	y: number;
	width: number;
	code: string;
}

/** Translate code-button geometry along with the block that contains it. */
export function offsetCodeActions(ctx: RenderContext, x: number, y: number): RenderContext {
	return { ...ctx, onCode: ctx.onCode ? (action) => ctx.onCode!({ ...action, x: action.x + x, y: action.y + y }) : undefined };
}

export interface RenderContext {
	onCode?: (action: CodeAction) => void;
	style: Style;
	math: MathRenderer;
	illustrations?: IllustrationRenderer;
	/** Available columns for the block being rendered. */
	width: number;
	/** The whole message is still streaming. */
	streaming: boolean;
	/** List nesting depth (bullet style rotates with it). */
	listDepth: number;
	/** Applied to plain text leaves (e.g. dim color inside block quotes). */
	textStyle?: (text: string) => string;
}

export const noMath: MathRenderer = {
	inline: () => undefined,
	block: () => undefined,
	key: "none",
};
