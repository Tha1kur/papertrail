import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import { checkVectorIndex, isVectorIndexReady } from "../src/services/rag/indexHealth.js";
import { retrieve } from "../src/services/rag/retrieve.js";
import { sendMessage } from "../src/services/chatService.js";
import { holdBuffer, processDocument, registerUpload } from "../src/services/rag/ingest.js";
import UserModel from "../src/models/User.js";
import ChunkModel from "../src/models/Chunk.js";
import DocumentModel from "../src/models/Document.js";
import ThreadModel from "../src/models/Thread.js";
import MessageModel from "../src/models/Message.js";
import UsageDailyModel from "../src/models/UsageDaily.js";
import { cases, documents, type EvalCase } from "./dataset.js";

/**
 * Retrieval quality evaluation.
 *
 * This exists because "did that prompt change make things better?" cannot be
 * answered by trying it twice and forming an impression. Chunk size, the
 * relevance threshold, the embedding task type, the system prompt — every
 * one of those silently changes answer quality, and none of them make
 * anything throw. Without a fixed question set and a score, a regression is
 * invisible until a user notices.
 *
 * Deliberately separate from `npm test`. The unit and integration suites are
 * offline, deterministic and free; this one hits real APIs, costs quota, and
 * is non-deterministic enough that a single failure is not necessarily a
 * regression. Mixing the two would make the fast suite slow and flaky.
 */

/**
 * Phrases that indicate the model declined rather than invented an answer.
 *
 * Crude, and deliberately so: the alternative is asking another model to
 * judge, which introduces a second source of non-determinism into the thing
 * measuring non-determinism. A keyword list is auditable and cheap.
 */
const REFUSAL_SIGNALS = [
  "do not mention",
  "does not mention",
  "do not contain",
  "does not contain",
  "do not cover",
  "does not cover",
  "not mentioned",
  "not specified",
  "no information",
  "cannot answer",
  "could not find",
  "not provided",
  "do not provide",
  "does not provide",
];

interface CaseResult {
  id: string;
  question: string;
  unanswerable: boolean;
  retrievedCount: number;
  topScore: number | null;
  /** 1-based rank of the first correct passage; null if never retrieved. */
  correctRank: number | null;
  factsFound: string[];
  factsMissing: string[];
  cited: boolean;
  refused: boolean;
  passed: boolean;
  answer: string;
}

/** Fraction of answerable questions whose correct passage was retrieved. */
function recall(results: CaseResult[]): number {
  const answerable = results.filter((r) => !r.unanswerable);
  if (answerable.length === 0) return 1;
  return answerable.filter((r) => r.correctRank !== null).length / answerable.length;
}

/**
 * Mean reciprocal rank. Rewards putting the right passage first rather than
 * merely somewhere in the list — which matters because everything retrieved
 * competes for the same context budget, and the model weights earlier
 * passages more heavily.
 */
function mrr(results: CaseResult[]): number {
  const answerable = results.filter((r) => !r.unanswerable);
  if (answerable.length === 0) return 1;

  const total = answerable.reduce((sum, r) => sum + (r.correctRank ? 1 / r.correctRank : 0), 0);
  return total / answerable.length;
}

async function evaluateCase(userId: string, testCase: EvalCase): Promise<CaseResult> {
  const retrieved = await retrieve({ userId, query: testCase.question });
  const above = retrieved.filter((chunk) => chunk.score >= env.RAG_MIN_SCORE);

  // Retrieval is scored on its own, before the model gets involved, so a
  // failure can be attributed to retrieval rather than to generation.
  const rankIndex = testCase.expectedPassage
    ? above.findIndex((chunk) =>
        chunk.content.toLowerCase().includes(testCase.expectedPassage.toLowerCase()),
      )
    : -1;

  const result = await sendMessage({
    threadId: randomUUID(),
    userId,
    message: testCase.question,
  });

  const answer = result.reply;
  const lower = answer.toLowerCase();

  const factsFound = testCase.expectedFacts.filter((f) => lower.includes(f.toLowerCase()));
  const factsMissing = testCase.expectedFacts.filter((f) => !lower.includes(f.toLowerCase()));

  /**
   * Unanswerable cases are scored on the ANSWER, not on retrieval count.
   *
   * The first version of this scored them purely on retrieving nothing, and
   * marked a correct outcome as a failure: asked for a December freeze
   * identifier, retrieval surfaced the topically-similar deployment passage
   * (0.817, above the floor) and the model then said plainly that the
   * passages do not cover it. That is the system working — two independent
   * layers, and the second one caught what the first let through.
   *
   * Retrieving nothing is the cleaner outcome and is still reported
   * separately below. What actually matters is that no fabricated fact is
   * asserted, so that is what decides pass or fail.
   */
  const refused = REFUSAL_SIGNALS.some((phrase) => lower.includes(phrase));

  const passed = testCase.unanswerable
    ? result.citations.length === 0 || refused
    : factsMissing.length === 0 && result.citations.length > 0;

  return {
    id: testCase.id,
    question: testCase.question,
    unanswerable: testCase.unanswerable ?? false,
    retrievedCount: above.length,
    topScore: retrieved[0]?.score ?? null,
    correctRank: rankIndex >= 0 ? rankIndex + 1 : null,
    factsFound,
    factsMissing,
    cited: result.citations.length > 0,
    refused,
    passed,
    answer: answer.replace(/\s+/g, " ").trim(),
  };
}

async function main(): Promise<void> {
  await connectDatabase();
  await checkVectorIndex();

  if (!isVectorIndexReady()) {
    console.error("\nVector index is not ready. Run: npm run ensure-index\n");
    process.exit(1);
  }

  // A throwaway user, so the eval corpus can never mix with real data and
  // cleanup is a single scoped delete.
  const user = await UserModel.create({
    email: `eval-${randomUUID()}@evals.invalid`,
    passwordHash: "not-a-real-hash",
  });
  const userId = String(user._id);

  try {
    process.stdout.write("Indexing corpus");
    for (const document of documents) {
      const buffer = Buffer.from(document.content, "utf8");
      const record = await registerUpload({
        userId,
        filename: document.filename,
        mimeType: "text/plain",
        buffer,
      });
      holdBuffer(String(record._id), buffer);
      await processDocument(String(record._id), userId);
      process.stdout.write(".");
    }

    const chunks = await ChunkModel.countDocuments({ userId });
    console.log(` ${chunks} chunks`);

    // Atlas indexes new vectors asynchronously; querying immediately returns
    // nothing and would score as a total retrieval failure.
    process.stdout.write("Waiting for the vector index to catch up");
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    console.log(" done\n");

    const results: CaseResult[] = [];
    for (const testCase of cases) {
      const result = await evaluateCase(userId, testCase);
      results.push(result);

      const mark = result.passed ? "PASS" : "FAIL";
      const detail = result.unanswerable
        ? `retrieved ${result.retrievedCount}, ${result.retrievedCount === 0 ? "nothing above threshold" : result.refused ? "model refused" : "ANSWERED ANYWAY"}, top score ${result.topScore?.toFixed(3) ?? "n/a"}`
        : `rank ${result.correctRank ?? "MISS"}, facts ${result.factsFound.length}/${result.factsFound.length + result.factsMissing.length}, ${result.cited ? "cited" : "NO CITATION"}`;

      console.log(`  ${mark}  ${result.id.padEnd(24)} ${detail}`);
      if (!result.passed) {
        console.log(`        ${result.answer.slice(0, 110)}`);
      }
    }

    const answerable = results.filter((r) => !r.unanswerable);
    const unanswerable = results.filter((r) => r.unanswerable);
    const passed = results.filter((r) => r.passed).length;

    console.log("\n" + "─".repeat(64));
    console.log(`  Passed              ${passed}/${results.length}`);
    console.log(`  Recall@${env.RAG_TOP_K}            ${(recall(results) * 100).toFixed(1)}%`);
    console.log(`  MRR                 ${mrr(results).toFixed(3)}`);
    console.log(
      `  Answerable          ${answerable.filter((r) => r.passed).length}/${answerable.length}`,
    );
    console.log(
      `  Correctly refused   ${unanswerable.filter((r) => r.passed).length}/${unanswerable.length}`,
    );
    // Reported separately because the two layers fail differently: the
    // threshold stopping noise is cheaper and more reliable than relying on
    // the model to decline, so a drop here is worth noticing even while the
    // overall pass rate holds.
    console.log(
      `    by threshold      ${unanswerable.filter((r) => r.retrievedCount === 0).length}/${unanswerable.length}`,
    );
    console.log(
      `    by refusal        ${unanswerable.filter((r) => r.retrievedCount > 0 && r.refused).length}/${unanswerable.length}`,
    );
    console.log("─".repeat(64) + "\n");

    /**
     * Thresholds, not perfection. Language models are non-deterministic, so
     * demanding 100% would make this fail for reasons unrelated to any
     * change. These are set below current measured performance but high
     * enough that a real regression — a broken threshold, a wrong embedding
     * task type, a prompt that stops citing — trips them.
     */
    const MIN_PASS_RATE = 0.8;
    const MIN_RECALL = 0.85;

    const passRate = passed / results.length;
    const failures: string[] = [];

    if (passRate < MIN_PASS_RATE) {
      failures.push(`pass rate ${(passRate * 100).toFixed(1)}% below ${MIN_PASS_RATE * 100}%`);
    }
    if (recall(results) < MIN_RECALL) {
      failures.push(`recall ${(recall(results) * 100).toFixed(1)}% below ${MIN_RECALL * 100}%`);
    }

    if (failures.length > 0) {
      console.error(`FAILED: ${failures.join("; ")}\n`);
      process.exitCode = 1;
    } else {
      console.log("Thresholds met.\n");
    }
  } finally {
    // Scoped cleanup rather than dropDatabase(), which would also destroy the
    // Atlas Search index — learned the hard way.
    await Promise.all([
      ChunkModel.deleteMany({ userId }),
      DocumentModel.deleteMany({ userId }),
      ThreadModel.deleteMany({ userId }),
      MessageModel.deleteMany({ userId }),
      UsageDailyModel.deleteMany({ userId }),
      UserModel.deleteOne({ _id: userId }),
    ]);
    await disconnectDatabase();
  }
}

main().catch(async (err: unknown) => {
  console.error("Eval run failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
