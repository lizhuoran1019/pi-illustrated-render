/** Runtime switches shared by the patch, renderers and /illustrated-render command. */

export type MathMode = "streaming" | "final" | "off";

export const state = {
	/** Rich Markdown rendering replaces pi's built-in assistant Markdown. */
	enabled: true,
	/** Local Markdown illustrations; independent of formula rendering. */
	illustrations: true,
	/** When formulas become images: while streaming, only after message_end, or never. */
	math: "streaming" as MathMode,
	/** Draw ```mermaid blocks as diagrams instead of showing their source. */
	mermaid: false,
	/** Show line numbers in code blocks. */
	lineNumbers: false,
	/** Bumped whenever something that affects rendered output changes (mode, theme, math engine loaded). */
	version: 0,
};

export function bumpVersion(): void {
	state.version++;
}

let renderRequester: (() => void) | undefined;

export function setRenderRequester(fn: (() => void) | undefined): void {
	renderRequester = fn;
}

/** Ask the TUI for a new frame (used after asynchronous work finishes). */
export function requestRender(): void {
	renderRequester?.();
}
