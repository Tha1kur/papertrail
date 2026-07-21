import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import RefreshTokenModel from "../../models/RefreshToken.js";
import { UnauthorizedError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

const ISSUER = "papertrail";

export interface AccessTokenPayload {
  sub: string;
  /** Checked against the user's current value, so bumping it invalidates
   *  every token issued before — revocation without a blocklist. */
  ver: number;
}

export function signAccessToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ ver: tokenVersion } satisfies Omit<AccessTokenPayload, "sub">, env.JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: ISSUER,
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
    // Pinned explicitly. Left to the library's default, a token could be
    // presented with alg:none or a weaker algorithm and still verify — the
    // classic JWT confusion attack.
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: ISSUER,
      algorithms: ["HS256"],
    });

    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      throw new UnauthorizedError("Malformed token");
    }

    return { sub: decoded.sub, ver: typeof decoded.ver === "number" ? decoded.ver : 0 };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    // Never surface the library's reason — "invalid signature" versus
    // "jwt expired" tells an attacker which half of their guess was right.
    throw new UnauthorizedError("Session expired or invalid");
  }
}

/** Opaque, high-entropy, and meaningless outside our database — unlike a
 *  JWT, it carries no claims to be tampered with and can be revoked. */
function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export async function issueRefreshToken(
  userId: string,
  meta: SessionMeta = {},
  family: string = randomUUID(),
): Promise<IssuedRefreshToken> {
  const token = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await RefreshTokenModel.create({
    tokenHash: hashRefreshToken(token),
    userId,
    family,
    expiresAt,
    ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    ...(meta.ip ? { ip: meta.ip } : {}),
  });

  return { token, expiresAt };
}

export interface RotationResult {
  userId: string;
  refresh: IssuedRefreshToken;
}

/**
 * Exchanges a refresh token for a new one, and detects theft.
 *
 * Because tokens rotate on every use, each one should be presented exactly
 * once. Seeing an already-rotated token again means two parties hold the
 * same credential — the legitimate user and someone else — and there is no
 * way to tell which one is asking. Revoking the entire family is the only
 * safe response: it costs the real user a login and costs the attacker
 * everything.
 */
export async function rotateRefreshToken(
  rawToken: string,
  meta: SessionMeta = {},
): Promise<RotationResult> {
  const tokenHash = hashRefreshToken(rawToken);
  const existing = await RefreshTokenModel.findOne({ tokenHash });

  if (!existing) throw new UnauthorizedError("Session expired or invalid");

  if (existing.revokedAt) {
    logger.warn(
      { userId: String(existing.userId), family: existing.family },
      "refresh token reuse detected — revoking session family",
    );
    await revokeFamily(existing.family);
    throw new UnauthorizedError("Session expired or invalid");
  }

  // The TTL index sweeps roughly once a minute, so an expired document can
  // still be present. Expiry is enforced here, at read time.
  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError("Session expired or invalid");
  }

  const userId = String(existing.userId);
  const next = await issueRefreshToken(userId, meta, existing.family);

  existing.revokedAt = new Date();
  existing.replacedByHash = hashRefreshToken(next.token);
  await existing.save();

  return { userId, refresh: next };
}

export async function revokeToken(rawToken: string): Promise<void> {
  await RefreshTokenModel.updateOne(
    { tokenHash: hashRefreshToken(rawToken), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeFamily(family: string): Promise<void> {
  await RefreshTokenModel.updateMany(
    { family, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await RefreshTokenModel.updateMany(
    { userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}
