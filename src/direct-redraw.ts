import { imageMode, type ImageMode } from "./math/kitty.ts";

interface FrameHost {
	mode?: string;
	doRender?: () => void;
	resetRenderState?: () => void;
	uploadedKittyImages?: Map<number, unknown>;
}

/** Direct placements live outside Kitty's text grid. Pi cannot see them in its
 * logical placeholder lines, so a differential redraw can leave old slices over
 * new text. In this opt-in compatibility mode, let Pi redraw its whole viewport
 * (including native images) instead. No extra frame is requested.
 *
 * These protected instance hooks are checked against Pi 1.5.2, like the assistant
 * component patch. Main-screen scrollback and the default placeholder path are
 * left alone; forcing full redraws there would duplicate the scrollback.
 */
export function installDirectRedraw(tui: unknown, mode: ImageMode = imageMode()): () => void {
	const host = tui as FrameHost;
	if (mode !== "direct" || host.mode !== "fullscreen") return () => {};
	const render = host.doRender, reset = host.resetRenderState;
	if (typeof render !== "function" || typeof reset !== "function") {
		throw new Error("当前 Pi 不支持 direct 模式的完整视口重绘；请使用默认 placeholder 模式");
	}
	let active = true;
	const hook = function (this: FrameHost) {
		if (active) {
			reset.call(this);
			// Reupload native tool images too. Kitty 0.50 can discard their last
			// placement during a full clear; Pi's placement-only cache would then
			// draw an empty rectangle. Pixel/source caches remain untouched.
			this.uploadedKittyImages?.clear();
		}
		return render.call(this);
	};
	host.doRender = hook;
	return () => {
		active = false;
		if (host.doRender === hook) host.doRender = render;
	};
}
