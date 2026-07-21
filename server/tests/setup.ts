/**
 * Environment for the test run, set before any module reads it.
 *
 * config/env.ts validates at import time and exits the process on failure,
 * so these must exist before the first `import` of anything that touches it.
 * Real credentials are deliberately absent: the suite must never reach a
 * paid API, and a missing key should surface as an obvious failure rather
 * than an unexpected charge.
 */
process.env.NODE_ENV = "test";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/papertrail-test";
process.env.JWT_ACCESS_SECRET = "test-secret-that-is-definitely-long-enough-32";
process.env.GEMINI_API_KEY = "test-key";
process.env.GROQ_API_KEY = "test-key";
process.env.LOG_LEVEL = "silent";

// Cheapest bcrypt cost the schema allows. At the production factor of 12,
// every test that registers a user would spend a quarter second hashing,
// and the suite would take minutes instead of seconds.
process.env.BCRYPT_ROUNDS = "10";

/**
 * Rate limits are effectively disabled for the suite.
 *
 * Integration tests register dozens of accounts from one IP and would
 * otherwise trip the credential limiter partway through — failing tests that
 * have nothing to do with rate limiting, in an order-dependent way that
 * looks like flakiness.
 *
 * The limiter is not going untested: its semantics are covered directly in
 * tests/unit/rateLimiter.test.ts, where the window can be driven precisely
 * rather than as a side effect of unrelated requests.
 */
process.env.RATE_LIMIT_AUTH_PER_15MIN = "100000";
process.env.RATE_LIMIT_CHAT_PER_MINUTE = "100000";
process.env.RATE_LIMIT_UPLOAD_PER_HOUR = "100000";
