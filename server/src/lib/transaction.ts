import mongoose, { type ClientSession } from "mongoose";

/**
 * Runs work inside a MongoDB transaction, retrying on the transient errors
 * the driver expects callers to handle.
 *
 * Splitting messages out of the thread document cost us the atomicity a
 * single document gave for free. Writing a message and incrementing the
 * thread's counters are now two writes, and a crash between them leaves the
 * sidebar showing a count that does not match reality. A transaction puts
 * that guarantee back where it matters.
 *
 * Transactions need a replica set. Atlas — including the free M0 tier — is
 * always a three-node replica set, so this works in production; tests start
 * an in-memory replica set for the same reason.
 *
 * `withTransaction` on the session already retries internally, but a
 * TransientTransactionError surfaced to us means the whole callback should
 * be replayed, which is what the outer loop is for.
 */
export async function withTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  const session = await mongoose.startSession();

  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        let result!: T;
        await session.withTransaction(async () => {
          result = await work(session);
        });
        return result;
      } catch (err) {
        if (attempt >= maxAttempts || !isTransient(err)) throw err;
        // Back off briefly; contention resolves on its own most of the time.
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  } finally {
    // Sessions are a server-side resource. Leaking them exhausts the pool,
    // which on M0 is a small number.
    await session.endSession();
  }
}

function isTransient(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "hasErrorLabel" in err &&
    typeof (err as { hasErrorLabel: unknown }).hasErrorLabel === "function" &&
    (err as { hasErrorLabel: (label: string) => boolean }).hasErrorLabel(
      "TransientTransactionError",
    )
  );
}
