/** Offline visual harness: actual AssistantMessageComponent, no model/tool calls. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";

type Message = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
function message(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "offline", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
}

export default function fixture(pi: ExtensionAPI) {
	let component: AssistantMessageComponent | undefined;
	pi.registerEntryRenderer<{ text: string }>("visual-fixture", (entry) => {
		component = new AssistantMessageComponent(message(entry.data?.text ?? ""));
		return component;
	});
	pi.registerEntryRenderer<{ base64: string }>("native-image", (entry) => new Image(entry.data!.base64, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 30 }));
	pi.registerCommand("visual-fixture", {
		description: "Offline fixture: [stream|light|dark|native]",
		handler: async (args, ctx) => {
			if (args === "light" || args === "dark") { ctx.ui.setTheme(args); return; }
			if (args === "native") {
				pi.appendEntry("native-image", { base64: (await readFile(fileURLToPath(new URL("../examples/electric-field.png", import.meta.url)))).toString("base64") });
				return;
			}
			const text = await readFile(fileURLToPath(new URL("../examples/physics.md", import.meta.url)), "utf8");
			pi.appendEntry("visual-fixture", { text: args === "stream" ? text.slice(0, 80) : text });
			if (args === "stream") {
				for (let end = 120; end < text.length + 120; end += 120) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					component?.updateContent(message(text.slice(0, end)), end < text.length);
					ctx.ui.setStatus("visual", end < text.length ? "Streaming fixture…" : undefined);
				}
			}
		},
	});
}
