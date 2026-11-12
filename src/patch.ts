/**
 * Pi 1.5.2 has no public assistant-component renderer hook. This narrow,
 * reversible patch keeps native Markdown slots intact (including transforms
 * and streaming updates) and changes only their displayed children.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown } from "@earendil-works/pi-tui";
import type { MarkdownTransform } from "./render/rich-markdown.ts";
import { state } from "./state.ts";

export type RichFactory = (text: string, paddingX: number, streaming: boolean, transform: MarkdownTransform | undefined) => Component;
const PATCH = Symbol.for("pi-illustrated-render.assistant-patch");
const UPSTREAM_PATCH = Symbol.for("pi-better-render.assistant-patch");
type Update = AssistantMessageComponent["updateContent"];
interface PatchRecord { original: Update; wrapper: Update; factory: RichFactory; active: boolean }
type PatchedPrototype = { updateContent: Update; [PATCH]?: PatchRecord; [UPSTREAM_PATCH]?: unknown };
interface AssistantInternals { contentContainer?: { children: Component[] }; isStreaming: boolean }

function swapChildren(component: AssistantMessageComponent, record: PatchRecord): void {
	const { contentContainer, isStreaming } = component as unknown as AssistantInternals;
	if (!Array.isArray(contentContainer?.children)) return;
	for (let i = 0; i < contentContainer.children.length; i++) {
		const native = contentContainer.children[i];
		if (!(native instanceof Markdown)) continue;
		const child = native as unknown as { text: unknown; paddingX?: number; options?: { transform?: MarkdownTransform } };
		if (typeof child.text !== "string") continue;
		const rich = record.factory(child.text, child.paddingX ?? 1, isStreaming, child.options?.transform);
		const active = () => record.active && state.enabled;
		contentContainer.children[i] = {
			render: (width) => active() ? rich.render(width) : native.render(width),
			invalidate: () => { native.invalidate(); rich.invalidate(); },
			handleMouse: (event) => active() ? rich.handleMouse?.(event) : undefined,
		};
	}
}

/** False means another renderer owns these components; never wrap it. */
export function applyPatch(factory: RichFactory): boolean {
	const proto = AssistantMessageComponent.prototype as unknown as PatchedPrototype;
	if (proto[UPSTREAM_PATCH]) return false;
	if (proto[PATCH]?.active) {
		proto[PATCH].factory = factory;
		return true;
	}
	const original = proto.updateContent;
	const record: PatchRecord = {
		original, factory, active: true,
		wrapper: function (this: AssistantMessageComponent, message, isStreaming) {
			original.call(this, message, isStreaming);
			if (!record.active) return;
			try { swapChildren(this, record); } catch { /* native children remain usable */ }
		},
	};
	proto.updateContent = record.wrapper;
	proto[PATCH] = record;
	return true;
}

export function removePatch(): void {
	const proto = AssistantMessageComponent.prototype as unknown as PatchedPrototype;
	const record = proto[PATCH];
	if (!record) return;
	record.active = false;
	// A later extension may have wrapped us: do not overwrite its method.
	if (proto.updateContent === record.wrapper) proto.updateContent = record.original;
	delete proto[PATCH];
}

export function isPatched(): boolean {
	return Boolean((AssistantMessageComponent.prototype as unknown as PatchedPrototype)[PATCH]?.active);
}
