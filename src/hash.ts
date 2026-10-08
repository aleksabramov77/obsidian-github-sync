// Byte / hashing helpers that work in Obsidian mobile (WKWebView) and desktop.

const encoder = new TextEncoder();

export function utf8Encode(text: string): Uint8Array {
	return encoder.encode(text);
}

/** Strict UTF-8 decode; returns null if bytes are not valid UTF-8 text. */
export function tryDecodeText(bytes: Uint8Array): string | null {
	// NUL bytes almost always mean a binary file.
	const probe = Math.min(bytes.length, 8000);
	for (let i = 0; i < probe; i++) if (bytes[i] === 0) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function toHex(buf: ArrayBuffer): string {
	const arr = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
	return out;
}

/** SHA-1 of a git blob object: sha1("blob <len>\0" + content). Matches GitHub blob SHAs. */
export async function gitBlobSha(content: Uint8Array): Promise<string> {
	const header = utf8Encode(`blob ${content.length}\0`);
	const data = new Uint8Array(header.length + content.length);
	data.set(header, 0);
	data.set(content, header.length);
	const digest = await crypto.subtle.digest("SHA-1", data);
	return toHex(digest);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i] << 16;
		out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
	}
	return out;
}

const B64_LOOKUP = (() => {
	const t = new Int16Array(256).fill(-1);
	for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
	return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
	const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let o = 0;
	let buf = 0;
	let bits = 0;
	for (let i = 0; i < clean.length; i++) {
		buf = ((buf << 6) | B64_LOOKUP[clean.charCodeAt(i)]) & 0xffffff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (buf >> bits) & 0xff;
		}
	}
	return out.subarray(0, o);
}
