/**
 * A fixed evaluation set for the retrieval pipeline.
 *
 * Every fact here is invented. That is the entire point: a model cannot
 * answer "what is the change freeze identifier" from training data, so a
 * correct answer is proof the retrieval pipeline worked rather than proof
 * the model is well-read. Evaluating RAG on real-world facts measures the
 * wrong thing and always looks better than it is.
 */

export interface EvalDocument {
  filename: string;
  content: string;
}

export interface EvalCase {
  id: string;
  question: string;
  /** Strings the answer must contain. Case-insensitive. */
  expectedFacts: string[];
  /** A phrase from the passage that should be retrieved, used to score
   *  retrieval independently of what the model then does with it. */
  expectedPassage: string;
  /** True when the documents genuinely cannot answer — the system should
   *  retrieve nothing rather than confabulate from the nearest passage. */
  unanswerable?: boolean;
}

export const documents: EvalDocument[] = [
  {
    filename: "operations-handbook.txt",
    content: `Meridian Systems Operations Handbook, Revision 7

Section 1: Deployment Windows
Production deploys occur between 02:00 and 04:00 IST on Tuesdays only. The
change freeze identifier for this period is FRZ-8842. Deploys outside this
window require written sign-off from the on-call lead and must be logged
against cost centre KX-119. Emergency patches are exempt but must be
reconciled within 48 hours.

Section 2: Incident Severity
A Sev-1 incident is declared when the error rate exceeds 4.7 percent
sustained over nine minutes, or when checkout latency passes 2,300
milliseconds at the 99th percentile. The escalation pager rotation is named
ORCHID-DELTA. Mean time to acknowledge for a Sev-1 is capped at eleven
minutes. Sev-2 uses the pager rotation named JUNIPER-SEVEN.

Section 3: Data Retention
Conversation transcripts are retained for 43 days. Embedding vectors are
retained for 180 days. Audit logs are written to the cold storage bucket
pt-audit-glacier-03 and held for seven years. Deletion requests are
processed within 30 days by the team known internally as Ledger Group.`,
  },
  {
    filename: "engineering-standards.txt",
    content: `Meridian Systems Engineering Standards, Version 3.2

Code Review
Every change requires two approvals, except documentation-only changes which
require one. Reviews must begin within four working hours. The review SLA
dashboard is hosted at the internal address board.meridian.invalid/rv-22.

Testing Requirements
New services must reach 74 percent line coverage before their first
production deploy. Integration tests run against an ephemeral replica set
provisioned by the tool named Harbourmaster. Load tests target 1,850
requests per second per instance.

Dependency Policy
Third-party packages must be reviewed by the Platform Guild before adoption.
Packages with fewer than 400 weekly downloads require a written exception
recorded under form DP-17. Security patches are applied within five working
days; critical advisories within 24 hours.`,
  },
];

export const cases: EvalCase[] = [
  {
    id: "freeze-id",
    question: "What is the change freeze identifier for the deployment window?",
    expectedFacts: ["FRZ-8842"],
    expectedPassage: "change freeze identifier",
  },
  {
    id: "cost-centre",
    question: "Which cost centre must out-of-window deploys be logged against?",
    expectedFacts: ["KX-119"],
    expectedPassage: "cost centre",
  },
  {
    id: "sev1-threshold",
    question: "What error rate triggers a Sev-1 incident, and over what period?",
    expectedFacts: ["4.7", "nine minutes"],
    expectedPassage: "Sev-1 incident is declared",
  },
  {
    id: "pager-rotation",
    question: "What is the name of the Sev-1 escalation pager rotation?",
    expectedFacts: ["ORCHID-DELTA"],
    expectedPassage: "escalation pager rotation",
  },
  {
    // Two similar facts in one passage — checks the answer does not blur them.
    id: "pager-disambiguation",
    question: "Which pager rotation is used for Sev-2, not Sev-1?",
    expectedFacts: ["JUNIPER-SEVEN"],
    expectedPassage: "JUNIPER-SEVEN",
  },
  {
    id: "vector-retention",
    question: "How long are embedding vectors retained?",
    expectedFacts: ["180"],
    expectedPassage: "Embedding vectors are",
  },
  {
    id: "audit-bucket",
    question: "Where are audit logs stored and for how long?",
    expectedFacts: ["pt-audit-glacier-03", "seven years"],
    expectedPassage: "cold storage bucket",
  },
  {
    // Answer lives in the second document — checks retrieval spans documents.
    id: "coverage-threshold",
    question: "What line coverage must a new service reach before its first deploy?",
    expectedFacts: ["74"],
    expectedPassage: "line coverage",
  },
  {
    id: "review-approvals",
    question: "How many approvals does a documentation-only change need?",
    expectedFacts: ["one"],
    expectedPassage: "documentation-only changes",
  },
  {
    id: "dependency-exception",
    question: "Which form records an exception for a low-download package?",
    expectedFacts: ["DP-17"],
    expectedPassage: "written exception",
  },
  {
    id: "critical-advisory",
    question: "How quickly must critical security advisories be applied?",
    expectedFacts: ["24 hours"],
    expectedPassage: "critical advisories",
  },
  {
    // Multi-hop: requires combining the window with the sign-off rule.
    id: "multi-hop-deploy",
    question: "If I want to deploy on a Thursday afternoon, what do I need?",
    expectedFacts: ["sign-off"],
    expectedPassage: "require written sign-off",
  },

  // --- Questions the documents cannot answer ---
  // The system must retrieve nothing rather than build an answer out of the
  // least-irrelevant passage. This is the case a naive RAG system fails
  // silently and confidently.
  {
    id: "unanswerable-capital",
    question: "What is the capital city of Portugal?",
    expectedFacts: [],
    expectedPassage: "",
    unanswerable: true,
  },
  {
    id: "unanswerable-adjacent",
    question: "What is the on-call compensation rate for weekend shifts?",
    expectedFacts: [],
    expectedPassage: "",
    unanswerable: true,
  },
  {
    id: "unanswerable-plausible",
    question: "What is the change freeze identifier for the December holiday period?",
    expectedFacts: [],
    expectedPassage: "",
    unanswerable: true,
  },
];
