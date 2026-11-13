import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
import { imageMode, type ImageMode } from "./math/kitty.ts";
import { validRgb } from "./math/sixel-colors.ts";

interface ResizeEvents {
	on(event: "resize", listener: () => void): void;
	off(event: "resize", listener: () => void): void;
}

/** Pi skips CSI 16 t when it detects neither Kitty nor iTerm2. Its input parser
 * still handles the reply and invalidates the layout, so just request the size
 * ourselves. Resize also covers font/zoom changes. Never fake Pi's capabilities
 * as Kitty: that would make native tool images emit an unsupported protocol.
 */
export function installSixelCellSize(
	terminal: { write(data: string): void },
	mode: ImageMode = imageMode(),
	events: ResizeEvents = process.stdout,
): () => void {
	if (mode !== "sixel") return () => {};
	const query = () => terminal.write("\x1b[16t");
	query();
	events.on("resize", query);
	return () => { events.off("resize", query); };
}

export type SixelColorHost = Partial<Pick<TUI, "queryTerminalColors" | "onTerminalColorSchemeChange">>;

/** Reuse Pi's OSC parser instead of stealing terminal input. Query once and on
 * terminal appearance changes; late replies trigger a repaint. Keep the theme
 * fallback live, and ignore replies from superseded queries or after /reload.
 */
export function createSixelColorSource(
	host: SixelColorHost,
	fallback: () => RgbColor,
	changed: () => void,
	mode: ImageMode = imageMode(),
): { read(): TerminalColors; dispose(): void } {
	let colors: TerminalColors = {};
	let active = mode === "sixel";
	let generation = 0;
	let unsubscribe: (() => void) | undefined;
	const query = () => {
		if (!active || !host.queryTerminalColors) return;
		const request = ++generation;
		const accept = (reply: TerminalColors) => {
			if (!active || request !== generation) return;
			const next = { ...colors };
			if (reply.background && validRgb(reply.background)) next.background = { ...reply.background };
			if (reply.palette?.length === 16 && reply.palette.every(validRgb)) next.palette = reply.palette.map((c) => ({ ...c }));
			if (JSON.stringify(next) === JSON.stringify(colors)) return;
			colors = next;
			changed();
		};
		try {
			void host.queryTerminalColors({ timeoutMs: 100, onLateReply: accept }).then(accept).catch(() => {});
		} catch { /* Older/unsupported hosts keep the theme-based fallback. */ }
	};
	if (active) {
		unsubscribe = host.onTerminalColorSchemeChange?.(query);
		query();
	}
	return {
		read: () => ({ ...colors, background: colors.background ?? fallback() }),
		dispose() {
			if (!active) return;
			active = false;
			unsubscribe?.();
		},
	};
}
