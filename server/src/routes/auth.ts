import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth, currentUser } from "../middleware/requireAuth.js";
import { UnauthorizedError } from "../lib/errors.js";
import UserModel from "../models/User.js";
import {
  login,
  logout,
  logoutEverywhere,
  refresh,
  register,
  toPublicUser,
} from "../services/auth/authService.js";
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from "../services/auth/cookies.js";

const router = Router();

const Credentials = z.object({
  email: z.email("Enter a valid email address").max(254).toLowerCase().trim(),
  /**
   * Length is the only rule. Composition requirements ("one uppercase, one
   * symbol") measurably push people toward predictable patterns like
   * "Password1!" — NIST dropped them for that reason. A 12-character floor
   * buys more real entropy than any character class rule.
   *
   * The 72-byte ceiling is bcrypt's: it silently truncates beyond that, so a
   * longer password would give a false sense of strength.
   */
  password: z.string().min(12, "Use at least 12 characters").max(72),
});

const RegisterBody = Credentials.extend({
  displayName: z.string().trim().min(1).max(80).optional(),
});

function sessionMeta(req: Parameters<Parameters<typeof router.post>[1]>[0]) {
  return {
    userAgent: req.get("user-agent"),
    ip: req.ip,
  };
}

router.post("/register", validate({ body: RegisterBody }), async (req, res) => {
  const { email, password, displayName } = req.body as z.infer<typeof RegisterBody>;

  const result = await register(email, password, displayName, sessionMeta(req));
  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);

  req.log?.info({ userId: result.user.id }, "user registered");
  res.status(201).json({ user: result.user });
});

router.post("/login", validate({ body: Credentials }), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof Credentials>;

  const result = await login(email, password, sessionMeta(req));
  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);

  req.log?.info({ userId: result.user.id }, "user logged in");
  res.json({ user: result.user });
});

/**
 * Exchanges the refresh cookie for a fresh pair. The old refresh token is
 * revoked in the same operation — see rotateRefreshToken for why reuse of a
 * revoked token nukes the whole session family.
 */
router.post("/refresh", async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (!token) throw new UnauthorizedError("No session to refresh");

  try {
    const result = await refresh(token, sessionMeta(req));
    setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);
    res.json({ user: result.user });
  } catch (err) {
    // Clear the cookies on failure, or the client retries forever with a
    // credential that will never work again.
    clearAuthCookies(res);
    throw err;
  }
});

router.post("/logout", async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];

  await logout(token);
  clearAuthCookies(res);

  // 204 regardless of whether a session existed — logout is idempotent, and
  // reporting "you were not logged in" tells a caller something about state
  // they have not proven they can see.
  res.status(204).end();
});

router.post("/logout-all", requireAuth, async (req, res) => {
  const user = currentUser(req);

  await logoutEverywhere(user.id);
  clearAuthCookies(res);

  req.log?.info({ userId: user.id }, "all sessions revoked");
  res.status(204).end();
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await UserModel.findById(currentUser(req).id).lean();
  if (!user) throw new UnauthorizedError("Session expired or invalid");

  res.json({ user: toPublicUser(user) });
});

export default router;
