import type { CookieOptions, Response } from "express";
import { env, isProduction } from "../../config/env.js";

export const ACCESS_COOKIE = "pt_access";
export const REFRESH_COOKIE = "pt_refresh";

/**
 * Tokens live in httpOnly cookies, not localStorage.
 *
 * localStorage is readable by any JavaScript on the page, so a single XSS —
 * yours or any dependency's — hands over every user's session. An httpOnly
 * cookie cannot be read by script at all, which converts "one XSS equals
 * total account takeover" into something far more limited.
 *
 * The trade is CSRF exposure, which is why SameSite is set and why CORS is
 * an explicit origin allowlist rather than a wildcard.
 */
function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    // Cookies marked Secure are only sent over HTTPS. Required in production,
    // impossible on http://localhost, hence the environment check.
    secure: isProduction,
    /**
     * Lax by default, in production as well as locally.
     *
     * This was originally "none" in production, on the assumption that the
     * client on Vercel and the API on Render are different sites and a
     * cross-site request would drop a Lax cookie. The deployed architecture
     * makes that assumption false: Vercel rewrites /api to the API service,
     * so every request the browser makes is to the Vercel origin and the
     * cookies are first-party.
     *
     * Lax is strictly safer — it withholds the cookie on cross-site
     * requests, which is CSRF protection at no cost. "none" is available
     * via COOKIE_SAMESITE for a deployment that really does call the API
     * host directly from a browser, but it should be a deliberate choice
     * rather than a default nobody revisited.
     */
    sameSite: env.COOKIE_SAMESITE,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    path: "/",
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60_000,
  });

  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    /**
     * Scoped to the auth routes, so the browser does not attach the
     * long-lived credential to every ordinary API call. It is only needed at
     * the one endpoint that consumes it, and anything that never travels
     * cannot be intercepted in transit.
     */
    path: "/api/auth",
    expires: refreshExpiresAt,
  });
}

export function clearAuthCookies(res: Response): void {
  // Path must match what was set, or the browser clears nothing and the
  // stale cookie is sent on the very next request.
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions(), path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(), path: "/api/auth" });
}
