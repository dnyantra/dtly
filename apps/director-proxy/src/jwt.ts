import { base64UrlDecode, hmacKey } from "./crypto";

/** Session token claims (contracts.md §2). */
export interface SessionClaims {
	sid: string;
	org: string | number;
	usr: string | number;
	prj: string | number;
	mode: string;
	models: string[];
	/** Budget in micro-USD. */
	bud: number;
	/** Prompt bundle version. */
	pv: string | number;
	iat: number;
	exp: number;
}

export class TokenError extends Error {}

const dec = new TextDecoder();

/** Verify an HS256 JWT with WebCrypto and return its claims. Throws TokenError. */
export async function verifySessionToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<SessionClaims> {
	if (!secret) throw new TokenError("proxy secret not configured");
	const parts = token.split(".");
	if (parts.length !== 3) throw new TokenError("malformed token");
	const [h, p, s] = parts as [string, string, string];

	let header: { alg?: string };
	let claims: Partial<SessionClaims>;
	let sig: Uint8Array;
	try {
		header = JSON.parse(dec.decode(base64UrlDecode(h)));
		claims = JSON.parse(dec.decode(base64UrlDecode(p)));
		sig = base64UrlDecode(s);
	} catch {
		throw new TokenError("malformed token");
	}
	if (header.alg !== "HS256") throw new TokenError("unsupported alg");

	const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, new TextEncoder().encode(`${h}.${p}`));
	if (!ok) throw new TokenError("bad signature");

	if (typeof claims.exp !== "number" || claims.exp <= nowSec) throw new TokenError("token expired");
	if (
		typeof claims.sid !== "string" ||
		!claims.sid ||
		!Array.isArray(claims.models) ||
		typeof claims.bud !== "number" ||
		claims.pv === undefined ||
		claims.pv === null ||
		claims.pv === ""
	) {
		throw new TokenError("missing claims");
	}
	return claims as SessionClaims;
}
