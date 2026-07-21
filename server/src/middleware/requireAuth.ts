import type { RequestHandler } from "express";
import UserModel from "../models/User.js";
import { UnauthorizedError } from "../lib/errors.js";
import { ACCESS_COOKIE } from "../services/auth/cookies.js";
import { verifyAccessToken } from "../services/auth/tokens.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Reads the access token from the httpOnly cookie, falling back to a bearer
 * header so the API stays usable from scripts and tests that have no cookie
 * jar.
 */
function extractToken(req: Parameters<RequestHandler>[0]): string | null {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  if (cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  return null;
}

/**
 * Rejects the request unless a valid session is present.
 *
 * Note this hits the database on every authenticated request, which
 * technically forfeits the "stateless JWT" property. That is a deliberate
 * trade: without checking tokenVersion, a signed-out-everywhere session
 * would keep working until its access token expired, and "log out all
 * devices" that does not take effect for fifteen minutes is not a security
 * feature, it is a placebo. The cost is one indexed lookup by _id returning
 * two fields.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError();

    const payload = verifyAccessToken(token);

    const user = await UserModel.findById(payload.sub, { email: 1, tokenVersion: 1 }).lean();
    if (!user) throw new UnauthorizedError("Session expired or invalid");

    // Bumped on password change and on refresh-token reuse detection.
    if ((user.tokenVersion ?? 0) !== payload.ver) {
      throw new UnauthorizedError("Session expired or invalid");
    }

    req.user = { id: String(user._id), email: user.email };
    next();
  } catch (err) {
    next(err);
  }
};

/** Narrows `req.user` for handlers mounted behind requireAuth. */
export function currentUser(req: Parameters<RequestHandler>[0]): AuthenticatedUser {
  if (!req.user) {
    // Reaching here means a route was mounted without requireAuth in front —
    // a wiring bug, not a client error, so it should surface as a 500.
    throw new Error("currentUser() called on an unauthenticated route");
  }
  return req.user;
}
