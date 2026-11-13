/** Backgrounds for Sixel's opaque, antialiased edge pixels. */
import type { RgbColor, TerminalColors } from "@earendil-works/pi-tui";
import { ansi256ToHex } from "../style.ts";

export type SixelBackground = number | RgbColor;
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const byte = (value: number) => Number.isInteger(value) && value >= 0 && value <= 255;

export function validRgb(color: RgbColor): boolean {
	return [color.r, color.g, color.b].every(byte);
}

/** Track background SGR independently of the foreground encoding image IDs.
 * Keep indexed colors as indices: a later terminal palette reply can resolve
 * them differently without another SGR. Support both semicolon and colon forms.
 */
export function sgrBackground(params: string, current?: SixelBackground): SixelBackground | undefined {
	const fields = params.split(";");
	for (let i = 0; i < fields.length; i++) {
		const parts = fields[i]!.split(":");
		const code = Number(parts[0]);
		if (code === 0 || code === 49) current = undefined;
		else if (code >= 40 && code <= 47) current = code - 40;
		else if (code >= 100 && code <= 107) current = code - 100 + 8;
		else if (code === 38 || code === 48 || code === 58) {
			const colon = parts.length > 1;
			const kind = Number(colon ? parts[1] : fields[++i]);
			const count = kind === 2 ? 3 : kind === 5 ? 1 : 0;
			let raw: string[];
			if (colon) {
				raw = parts.slice(2);
				// Optional empty/zero color-space ID in 48:2::R:G:B.
				if (kind === 2 && raw.length === 4) {
					if (raw[0] !== "" && raw[0] !== "0") continue;
					raw = raw.slice(1);
				}
			} else {
				raw = fields.slice(i + 1, i + 1 + count);
				i += count;
			}
			// Consume foreground/underline parameters too: their RGB values
			// (e.g. 0 or 49) must never reset the background.
			if (code !== 48 || !count || raw.length !== count || raw.some((v) => v === "")) continue;
			const values = raw.map(Number);
			if (!values.every(byte)) continue;
			current = kind === 5 ? values[0]! : { r: values[0]!, g: values[1]!, b: values[2]! };
		}
	}
	return current;
}

export function resolveSixelBackground(background: SixelBackground | undefined, colors: TerminalColors): RgbColor {
	if (background === undefined) return colors.background ?? BLACK;
	if (typeof background !== "number") return background;
	if (background < 16 && colors.palette?.[background]) return colors.palette[background]!;
	const hex = ansi256ToHex(background);
	return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}
