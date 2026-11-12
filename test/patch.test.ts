import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AssistantMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import extension, { hasCompetingRenderer } from "../src/index.ts";
import { applyPatch, isPatched, removePatch } from "../src/patch.ts";
import { RichMarkdown } from "../src/render/rich-markdown.ts";
import { noMath } from "../src/render/context.ts";
import { state } from "../src/state.ts";
import { plainStyle } from "../src/style.ts";

const original = AssistantMessageComponent.prototype.updateContent;
type Message = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
const message = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });
const render = (c: AssistantMessageComponent) => c.render(90).map(stripTerminalSequences).join("\n");

beforeEach(() => { initTheme("dark"); state.enabled = true; });
afterEach(() => { removePatch(); AssistantMessageComponent.prototype.updateContent = original; });

test("actual assistant slots survive repeated streaming updates; transforms and stored content stay intact", () => {
	let calls = 0;
	applyPatch((text, paddingX, streaming, transform) => new RichMarkdown(text, { style: plainStyle(), math: noMath, streaming, paddingX, transform }));
	const saved = message("first");
	const snapshot = JSON.stringify(saved);
	const component = new AssistantMessageComponent(saved, false, undefined, undefined, 1, [(text, context) => { calls++; assert.equal(context.messageType, "assistant"); return text.toUpperCase(); }]);
	assert.match(render(component), /FIRST/);
	assert.equal(calls, 1);
	for (const text of ["first second", "first second third", "final"]) {
		component.updateContent(message(text), text !== "final");
		assert.ok(render(component).includes(text.toUpperCase()));
	}
	assert.equal(calls, 4);
	assert.equal(JSON.stringify(saved), snapshot);
	assert.equal(isPatched(), true);
});

test("on/off affects existing components immediately; removal restores the native entry point", () => {
	applyPatch(() => ({ render: () => ["ILLUSTRATED"], invalidate() {} }));
	const component = new AssistantMessageComponent(message("Native"));
	assert.match(render(component), /ILLUSTRATED/);
	state.enabled = false;
	assert.match(render(component), /Native/);
	state.enabled = true;
	assert.match(render(component), /ILLUSTRATED/);
	removePatch();
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	assert.match(render(component), /Native/);
});

test("upstream ownership is refused and later wrappers are not overwritten on shutdown", () => {
	const proto = AssistantMessageComponent.prototype as unknown as Record<symbol, unknown>;
	const upstream = Symbol.for("pi-better-render.assistant-patch");
	proto[upstream] = {};
	try { assert.equal(applyPatch(() => ({ render: () => [], invalidate() {} })), false); }
	finally { delete proto[upstream]; }
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	applyPatch(() => ({ render: () => ["ours"], invalidate() {} }));
	const ours = AssistantMessageComponent.prototype.updateContent;
	const later: typeof ours = function (this: AssistantMessageComponent, m, streaming) { ours.call(this, m, streaming); };
	AssistantMessageComponent.prototype.updateContent = later;
	removePatch();
	assert.equal(AssistantMessageComponent.prototype.updateContent, later);
	assert.match(render(new AssistantMessageComponent(message("Native"))), /Native/);
});

test("conflict detection uses registered source metadata before startup ordering matters", () => {
	const commands = [{ name: "renamed", source: "extension", sourceInfo: { path: "/tmp/pi-better-render/src/index.ts", source: "npm:pi-better-render", scope: "user", origin: "package" } }] satisfies ReturnType<ExtensionAPI["getCommands"]>;
	assert.equal(hasCompetingRenderer(commands), true);
	assert.equal(hasCompetingRenderer([]), false);
});

test("an exact command argument closes completion so Enter submits it", async () => {
	let definition: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const api = { on() {}, registerCommand: (_name: string, command: NonNullable<typeof definition>) => { definition = command; } } as unknown as ExtensionAPI;
	extension(api);
	assert.deepEqual(await definition!.getArgumentCompletions!("images:off"), []);
	const matches = await definition!.getArgumentCompletions!("images:o");
	assert.deepEqual(matches?.map((item) => item.value), ["images:on", "images:off"]);
});

test("extension never registers context/message mutation hooks and skips RPC rendering", async () => {
	const hooks = new Map<string, (...args: any[]) => any>();
	const api = { on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); }, registerCommand() {} } as unknown as ExtensionAPI;
	extension(api);
	assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start"]);
	await hooks.get("session_start")!({}, { mode: "rpc" });
	assert.equal(isPatched(), false);
});
