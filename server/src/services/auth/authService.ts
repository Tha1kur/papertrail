import bcrypt from "bcrypt";
import { env } from "../../config/env.js";
import UserModel from "../../models/User.js";
import { ConflictError, UnauthorizedError } from "../../lib/errors.js";
import {
  issueRefreshToken,
  revokeAllForUser,
  revokeToken,
  rotateRefreshToken,
  signAccessToken,
  type SessionMeta,
} from "./tokens.js";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export async function register(
  email: string,
  password: string,
  displayName: string | undefined,
  meta: SessionMeta = {},
): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  let user;
  try {
    user = await UserModel.create({
      email,
      passwordHash,
      ...(displayName ? { displayName } : {}),
    });
  } catch (err) {
    // The unique index is what actually prevents duplicate accounts. Checking
    // findOne first and then inserting loses the race when two registrations
    // for the same address arrive together.
    if (isDuplicateKey(err)) throw new ConflictError("An account with that email already exists");
    throw err;
  }

  return issueSession(String(user._id), toPublicUser(user), user.tokenVersion, meta);
}

export async function login(
  email: string,
  password: string,
  meta: SessionMeta = {},
): Promise<AuthResult> {
  // passwordHash is select:false, so it must be asked for explicitly.
  const user = await UserModel.findOne({ email }).select("+passwordHash");

  /**
   * Both branches below return the same error and take comparable time.
   *
   * Returning "no such user" versus "wrong password" turns the login form
   * into an account enumeration oracle. So does returning instantly for an
   * unknown email while spending 250ms hashing for a known one — the timing
   * alone leaks membership. Hashing against a dummy value keeps the two
   * paths similar.
   */
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw new UnauthorizedError("Incorrect email or password");
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) throw new UnauthorizedError("Incorrect email or password");

  user.lastLoginAt = new Date();
  await user.save();

  return issueSession(String(user._id), toPublicUser(user), user.tokenVersion, meta);
}

export async function refresh(rawRefreshToken: string, meta: SessionMeta = {}): Promise<AuthResult> {
  const rotated = await rotateRefreshToken(rawRefreshToken, meta);

  const user = await UserModel.findById(rotated.userId);
  // The account was deleted while a session was still live.
  if (!user) throw new UnauthorizedError("Session expired or invalid");

  return {
    user: toPublicUser(user),
    accessToken: signAccessToken(String(user._id), user.tokenVersion),
    refreshToken: rotated.refresh.token,
    refreshExpiresAt: rotated.refresh.expiresAt,
  };
}

export async function logout(rawRefreshToken: string | undefined): Promise<void> {
  if (rawRefreshToken) await revokeToken(rawRefreshToken);
}

/** Signs out every device. Used after a password change, and available to
 *  the user directly when they suspect a session is not theirs. */
export async function logoutEverywhere(userId: string): Promise<void> {
  await Promise.all([
    revokeAllForUser(userId),
    // Also invalidates access tokens already in the wild, which revoking
    // refresh tokens alone would not — they stay valid until they expire.
    UserModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }),
  ]);
}

async function issueSession(
  userId: string,
  user: PublicUser,
  tokenVersion: number,
  meta: SessionMeta,
): Promise<AuthResult> {
  const refreshToken = await issueRefreshToken(userId, meta);

  return {
    user,
    accessToken: signAccessToken(userId, tokenVersion),
    refreshToken: refreshToken.token,
    refreshExpiresAt: refreshToken.expiresAt,
  };
}

interface RawUser {
  _id: unknown;
  email: string;
  displayName?: string | null;
  createdAt: Date;
}

export function toPublicUser(user: RawUser): PublicUser {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? null,
    createdAt: user.createdAt,
  };
}

/**
 * A real bcrypt hash of a value nobody will ever submit. Comparing against it
 * costs the same as a genuine check, which is the point.
 */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.jXwHkzuHQzrK0EPk5RfGw4WBu9qOc.C";

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}
