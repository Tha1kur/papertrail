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
