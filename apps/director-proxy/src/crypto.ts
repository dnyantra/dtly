const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = "";
	for (const b of u8) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const keyCache = new Map<string, Promise<CryptoKey>>();

export function hmacKey(secret: string): Promise<CryptoKey> {
	let k = keyCache.get(secret);
	if (!k) {
		k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
			"verify",
		]);
		keyCache.set(secret, k);
	}
	return k;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
	return toHex(sig);
}
