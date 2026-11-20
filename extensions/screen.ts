// import { ExtensionAPI, defineTool } from "y:/Dev/NodeJS/node_modules/@earendil-works/pi-coding-agent";	// For intellisense. Will be commented out when done editing.
// import { Type } from "y:/Dev/NodeJS/node_modules/@sinclair/typebox";	// For intellisense. Will be commented out when done editing.
import { ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

export default function screenExtension(pi: ExtensionAPI) {
	const TEMP_DIR = os.tmpdir();
	const SCREENSHOT_PATH = path.join(TEMP_DIR, "pi_screen_capture.png");
	const AHK_LIST_PATH = path.join(TEMP_DIR, "pi_list_windows.ahk");
	const AHK_CAPTURE_PATH = path.join(TEMP_DIR, "pi_capture.ahk");

	// Helper: Get exact window titles via AHK
	async function getWindowTitles(): Promise<string[]> {
		const script = `
			DetectHiddenWindows, Off
			WinGet, id, list,,, Program Manager
			Loop, %id%
			{
				this_id := id%A_Index%
				WinGetTitle, this_title, ahk_id %this_id%
				if (this_title != "")
					FileAppend, %this_title%\`n, *
			}
		`;
		await fs.writeFile(AHK_LIST_PATH, script, "utf8");
		try {
			const result = await pi.exec("AutoHotkeyU64.exe", [AHK_LIST_PATH]);
			return result.stdout.split("\n").map(t => t.trim()).filter(t => t !== "");
		} catch {
			return [];
		}
	}

	// Helper: Get display resolution via ahk
	function getDisplayResolution() {
		try {
			const script = `FileAppend, %A_ScreenWidth%x%A_ScreenHeight%, *`;
			const tempPath = path.join(TEMP_DIR, "pi_screen_resolution.ahk");
			fsSync.writeFileSync(tempPath, script, "utf8");
			const raw = execFileSync("AutoHotkeyU64.exe", [tempPath], { encoding: "utf8" }).trim();
			return raw || "unknownxunknown";
		} catch {
			return "unknownxunknown";
		}
	}

	// Helper: Capture screen or window via FFmpeg
	async function capture(target: string = "-", region: string = "-1:-1:-1:-1") {
		const script = `
            SetTitleMatchMode, 2 ; Crucial: Allows partial substring matching anywhere in the title
            #Include Y:/Dev/AutoHotkey/Lib/Gdip_All.ahk
            if !pToken := Gdip_Startup() 
                ExitApp
            ExternalInput := "${target}"
			ExternalRegion := "${region}"
			; Region capture: x1:y1:x2:y2
			if (ExternalInput = "-" || ExternalInput = "") {
				if (ExternalRegion != "" && ExternalRegion != "-1:-1:-1:-1") {
					StringSplit, r, ExternalRegion, :
					x1 := r1, y1 := r2, x2 := r3, y2 := r4
					pBitmap := Gdip_BitmapFromScreen(x1 "|" y1 "|" (x2 - x1) "|" (y2 - y1))
					Gdip_SaveBitmapToFile(pBitmap, "${SCREENSHOT_PATH}")
					Gdip_DisposeImage(pBitmap)
					Gdip_Shutdown(pToken)
					ExitApp
				}
			}
			; Fuzzy match window title
            Loop, Parse, ExternalInput, % " "
            {
                WinGet, hwnd, ID, % SubStr(ExternalInput, 1, StrLen(ExternalInput) - (A_Index-1)*5)
                if (hwnd)
                    break
            }
            if (!hwnd) {
                FileAppend, NO_WINDOW_MATCH, *
                Gdip_Shutdown(pToken)
                ExitApp
            }
			; Capture using custom method to handle hardware-accelerated windows
            pBitmap := Gdip_BitmapFromHWND_Chromium(hwnd)
            Gdip_SaveBitmapToFile(pBitmap, "${SCREENSHOT_PATH}")
            Gdip_DisposeImage(pBitmap)
            Gdip_Shutdown(pToken)
            ExitApp
            ; --- FIX ENGINE ---
            ; Overrides standard GDI capturing to force-render Hardware Accelerated windows
            Gdip_BitmapFromHWND_Chromium(hwnd) {
                WinGetPos,,, Width, Height, ahk_id %hwnd%
                hbm := CreateDIBSection(Width, Height)
                hdc := CreateCompatibleDC()
                obm := SelectObject(hdc, hbm)
                ; Flag 2 = PW_RENDERFULLCONTENT (Captures hardware-accelerated layouts)
                DllCall("PrintWindow", "Ptr", hwnd, "Ptr", hdc, "UInt", 2) 
                pBitmap := Gdip_CreateBitmapFromHBITMAP(hbm)
                SelectObject(hdc, obm), DeleteObject(hbm), DeleteDC(hdc)
                return pBitmap
            }
        `
		await fs.writeFile(AHK_CAPTURE_PATH, script, "utf8");
		try {
			await pi.exec("AutoHotkeyU64.exe", [AHK_CAPTURE_PATH], { encoding: "utf8" });
			return { target, base64: fsSync.readFileSync(SCREENSHOT_PATH).toString("base64") };
		} catch {
			return [];
		}
	}

	// Helper: fuzzy matching of window titles
	function strBestMatch(input: string, options: string[]): string {
		const needle = input.trim().toLowerCase();
		if (!needle || options.length === 0) return input;

		const candidates = options.map(option => ({ option, lower: option.toLowerCase() }));

		for (const { option, lower } of candidates) if (lower === needle) return option;
		for (const { option, lower } of candidates) if (lower.includes(needle)) return option;

		const needleTokens = needle.split(/\s+/).filter(Boolean);
		if (needleTokens.length) {
			for (const { option, lower } of candidates) {
				const titleTokens = lower.split(/\s+/);
				if (needleTokens.every(token => titleTokens.some(t => t.includes(token)))) {
					return option;
				}
			}
		}

		return options[0];
	}

	// 1. Register the Tool for the AI
	pi.registerTool(defineTool({
		name: "screen",
		label: "screen",
		description: "Capture a screenshot of the entire screen, a specific window, or a rectangular region. Target '-' for full screen. Region format 'x1:y1:x2:y2'. current display resolution: " + getDisplayResolution(),
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "If true, returns a list of window titles instead of capturing.", default: false })),
			target: Type.Optional(Type.String({ description: "Window title or '-' for full screen. Prefer exact matches after looking up with /screen list.", default: "-" })),
			region: Type.Optional(Type.String({ description: "Coordinates x1:y1:x2:y2 or '-1:-1:-1:-1'. eg: '-1:1280:-1:540'", default: "-1:-1:-1:-1" })),
		}),
		async execute(_id, { list = false, target = "-", region = "-1:-1:-1:-1" }) {
			if (list) {
				const titles = await getWindowTitles();
				return {
					content: [
						{ type: "text", text: "Available windows:" + (titles.length > 0 ? "\n- " + titles.join("\n- ") : " No windows found") }
					],
					details: { target, region, "list": true }
				};
			}

			const captured = await capture(target, region);
			if (!captured?.base64) throw new Error("Failed to capture screen.");

			return {
				content: [
					{ type: "text", text: `Captured ${target === "-" ? "full screen" : `window: ${captured.target}`}` },
					{ type: "image", data: captured.base64, mimeType: "image/png" }
				],
				details: { target, region, "list": false }
			};
		}
	}));

	// 2. Register the Slash Command for the user
	pi.registerCommand("screen", {
		description: "Capture screen and send to pi with a message. Usage: /screen [target] [message]",
		getArgumentCompletions: async (prefix) => {
			const titles = await getWindowTitles();
			const matches = titles.filter(t => t.toLowerCase().includes(prefix.toLowerCase()));
			// Add the full-screen option if it matches prefix
			if ("-".startsWith(prefix)) matches.unshift("-");
			return matches.map(t => ({ value: t, label: t }));
		},
		handler: async (args, ctx) => {
			// Parsing: /screen [target]|list [message...]
			// We check if the first word is in our titles or is '-'
			const titles = await getWindowTitles();
			let target = "-";
			let message = args;

			const parts = args.trim().split(" ");
			const firstWord = parts[0];

			if (firstWord === "list") {
				return pi.sendMessage({
					customType: "screen-list",
					content: "Available windows:" + (titles.length > 0 ? "\n- " + titles.join("\n- ") : " No windows found"),
					display: true,
					details: { list: true }
				}, { deliverAs: ctx.isIdle() ? undefined : "steer" });
			}

			if (firstWord === "-" || titles.includes(firstWord)) {
				target = firstWord;
				message = parts.slice(1).join(" ");
			} else {
				// Try to see if the first part is a quoted string or matches a title with spaces
				// For simplicity, we assume the user uses auto-complete or '-'
				// But we can check if the start of the string matches any title
				for (const title of titles) {
					if (args.startsWith(title)) {
						target = title;
						message = args.slice(title.length).trim();
						break;
					}
				}
			}

			ctx.ui.setWorkingMessage(`Capturing ${target}...`);
			const captured = await capture(target);
			ctx.ui.setWorkingMessage("");

			if (captured?.base64) {
				ctx.ui.notify("Captured " + (target === "-" ? "full screen" : `window: ${captured?.target}`), "info");
				pi.sendMessage({
					customType: "screen-capture",
					content: [{ type: "image", data: captured.base64, mimeType: "image/png" }],
					display: true,
					details: `Captured ${target === "-" ? "full screen" : `window: ${captured.target}`}`
				}, { deliverAs: ctx.isIdle() ? undefined : "steer" });
				if (message.trim()) pi.sendUserMessage(message, { deliverAs: ctx.isIdle() ? undefined : "steer" });
			} else {
				ctx.ui.notify("Failed to capture screen. Is the window minimized?", "error");
			}
		}
	});
}
