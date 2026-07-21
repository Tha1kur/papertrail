import "dotenv/config";
import { z } from "zod";

/**
 * Environment is validated once, at boot, before anything else starts.
 *
 * The alternative — reading `process.env.FOO` at the call site — fails at
 * 3am on the first request that happens to need FOO, with a `undefined is
 * not a string` five frames deep. Failing here means a misconfigured deploy
 * dies immediately with a message that says exactly which key is wrong.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  PORT: z.coerce.number().int().positive().max(65535).default(8080),

  MONGODB_URI: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("mongodb://") || v.startsWith("mongodb+srv://"), {
      message: "must be a mongodb:// or mongodb+srv:// connection string",
    }),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  /** Comma-separated list. Never `*` — this API will use cookie auth. */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /** Graceful shutdown gives in-flight requests this long to finish. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // --- Language model providers ---
  // Gemini is primary: it is the only one of the two with a free embeddings
  // endpoint, which the retrieval pipeline depends on. Groq is the failover
  // for chat only.

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_CHAT_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GEMINI_EMBED_MODEL: z.string().min(1).default("gemini-embedding-001"),
  /**
   * Must match the Atlas vector index definition exactly, and must not change
   * once documents are indexed — every stored vector would need recomputing.
   * 768 over the model's native 3072 is a deliberate storage trade: Atlas M0
   * has 512MB total, and 3072 floats per chunk would exhaust it fast.
   */
  GEMINI_EMBED_DIMENSIONS: z.coerce.number().int().positive().default(768),

  /**
   * gemini-2.5-flash reasons before answering by default, which spends output
   * tokens and adds seconds of latency before the first one arrives. For
   * chat-over-documents the retrieval does the hard work, so it is off by
   * default. Raise it if answer quality on multi-step questions suffers.
   */
  GEMINI_THINKING_BUDGET: z.coerce.number().int().min(0).default(0),

  GROQ_API_KEY: z.string().min(1),
  GROQ_CHAT_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),

  /** Upper bound on a single model call before we give up and fail over. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Input tokens available for system prompt plus conversation history.
   * Far below the model's actual context window on purpose: the window is a
   * hard limit, but tokens are also latency and quota. Retrieved document
   * chunks will compete for this same budget once RAG lands.
   */
  CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(8_000),

  /** SSE comment sent on an idle stream to stop proxies closing it. */
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Authentication ---

  /**
   * Signs access tokens. 32 bytes minimum because a JWT secret short enough
   * to brute force is the same as no authentication at all — and the failure
   * is silent, since short secrets verify perfectly well.
   */
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, "must be at least 32 characters — generate with: openssl rand -base64 48"),

  /**
   * Short by design. The access token is a bearer credential we cannot
   * revoke, so its blast radius is bounded by its lifetime; the refresh
   * token, which we *can* revoke, does the long-lived work.
   */
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /** bcrypt work factor. 12 is roughly 250ms on current hardware — slow
   *  enough to punish offline cracking, fast enough for a login form. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  /** Set when the API and client are on different subdomains in production. */
  COOKIE_DOMAIN: z.string().optional(),

  // --- Retrieval ---

  /**
   * Passages returned per query. More is not better: every extra chunk
   * spends context budget and dilutes the signal, and the model starts
   * hedging across sources instead of answering from the best one.
   */
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(6),

  /** Slice of the context budget reserved for retrieved passages. The rest
   *  goes to the system prompt and conversation history. */
  RAG_CONTEXT_TOKENS: z.coerce.number().int().positive().default(3_000),

  /**
   * Minimum score for a passage to be used at all.
   *
   * Without a floor, a question the documents do not answer still returns
   * the six least-irrelevant chunks, and the model dutifully builds an
   * answer out of them. Retrieving nothing is a far better failure than
   * retrieving noise and citing it.
   *
   * The value is measured, not guessed, and the scale is the trap. Atlas
   * reports cosine similarity rescaled to (1 + cos) / 2, so 0.5 means
   * *orthogonal* — not zero. A threshold that looks conservative on a raw
   * cosine scale accepts essentially everything here.
   *
   * Measured against a sample corpus:
   *   on-topic   0.883  0.887  0.877
   *   off-topic  0.749  0.740
   *   nonsense   0.773
   *
   * 0.80 sits in the gap. Note nonsense scored *above* coherent off-topic
   * questions, which is a good reminder that these scores measure
   * embedding-space proximity, not relevance or truth.
   */
  RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.8),

  /**
   * A passage is also dropped if it scores this far below the best match.
   *
   * An absolute floor alone cannot tell "six passages all strongly on
   * topic" from "one good match and five that merely cleared the bar". This
   * keeps a strong result from being diluted by weaker ones, which matters
   * because the model hedges across whatever it is given.
   */
  RAG_SCORE_DROPOFF: z.coerce.number().min(0).max(1).default(0.08),

  /** Atlas M0 has 512MB total, shared with every collection. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  /**
   * Target chunk size in characters, and the overlap between neighbours.
   *
   * Chunk size is the single biggest lever on retrieval quality, so this
   * value was measured with the eval harness rather than chosen:
   *
   *   chars   chunks   passed   recall@6   MRR     refused by threshold
   *   1200    2        14/15    91.7%      0.917   2/3
   *   700     4        15/15    100%       0.917   2/3
   *   450     6        15/15    100%       0.875   1/3
   *
   * 1200 failed a question because a whole document landed just under the
   * target and became one chunk spanning three unrelated topics — its
   * embedding averaged all of them and matched none sharply.
   *
   * 450 recovers recall but costs precision: MRR falls, and fewer
   * unanswerable questions are stopped by the relevance threshold, pushing
   * that work onto the model declining instead — the weaker of the two
   * defences, since it depends on the prompt being obeyed.
   *
   * 700 has the recall of the small setting and the precision of the large
   * one. Re-measure if the corpus changes character: the right value depends
   * on how the documents are written, which is exactly why this is
   * configuration and not a constant.
   */
  CHUNK_TARGET_CHARS: z.coerce.number().int().min(200).max(4_000).default(700),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).max(1_000).default(120),

  // --- Rate limiting and cost control ---

  /**
   * Optional. Without these the limiter falls back to in-memory, which is
   * per-process and therefore only correct on a single instance.
   */
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  /** Chat requests per user per minute. Generous for a human, ruinous for
   *  a script trying to drain the API quota. */
  RATE_LIMIT_CHAT_PER_MINUTE: z.coerce.number().int().positive().default(12),

  /** Uploads are far more expensive than a chat turn — one document can be
   *  hundreds of embedding calls. */
  RATE_LIMIT_UPLOAD_PER_HOUR: z.coerce.number().int().positive().default(20),

  /** Login and register, keyed on IP, to slow credential stuffing. */
  RATE_LIMIT_AUTH_PER_15MIN: z.coerce.number().int().positive().default(20),

  /**
   * Hard ceiling on tokens a single user can spend per day.
   *
   * Rate limiting caps requests per minute; this caps total cost. They
   * solve different problems — twelve requests a minute all day is still a
   * very large bill, and the free tiers this runs on have daily caps that,
   * once hit, take the app down for everyone.
   */
  DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(150_000),

  // --- Observability ---

  /** Optional. Without it, errors reach the logs and nowhere else. */
  SENTRY_DSN: z.string().url().optional(),

  /** Ties an error to the commit that caused it. Set from the git SHA in CI. */
  SENTRY_RELEASE: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    // Deliberately not the logger: the logger's own level comes from env,
    // so at this point we cannot trust it to be configured.
    console.error(`\nInvalid environment configuration:\n${details}\n`);
    console.error("See .env.example for the full list of required variables.\n");
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
