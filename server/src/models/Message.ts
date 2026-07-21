import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * Lifecycle of an assistant message.
 *
 * `streaming` and `incomplete` exist because a streamed response can die
 * halfway. Without a status field the only options are to write nothing
 * until the stream finishes — losing everything on a disconnect — or to
 * write a truncated answer that is indistinguishable from a complete one.
 */
export const MESSAGE_STATUSES = ["complete", "streaming", "incomplete", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const UsageSchema = new Schema(
  {
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/**
 * Messages live in their own collection rather than embedded in Thread.
 *
 * The embedded version had three problems, in increasing order of severity:
 *   1. Every append rewrote the entire document, so cost grew with
 *      conversation length rather than staying constant.
 *   2. Reading a thread list dragged every message along with it unless
 *      explicitly projected away.
 *   3. A BSON document is capped at 16MB. The array was unbounded, so a
 *      sufficiently long conversation simply stops being saveable — and it
 *      fails at write time, on a message the user has already sent.
 *
 * The trade is losing single-document atomicity between a thread and its
 * messages, which is why the repository layer uses a transaction where that
 * consistency actually matters.
 */
const MessageSchema = new Schema(
  {
    // References Thread._id, which is a client-generated UUID string.
    threadId: { type: String, required: true },

    /**
     * Denormalised from the parent thread.
     *
     * Strictly redundant — ownership could be derived by loading the thread
     * first — but that makes every message read a two-step operation where
     * forgetting step one is a silent cross-tenant data leak. Carrying the
     * owner on the row means the filter is impossible to omit.
     */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    role: { type: String, enum: MESSAGE_ROLES, required: true },

    /**
     * Deliberately NOT `required`. Mongoose treats an empty string as absent,
     * and a streaming assistant message is created empty by design, before
     * the first token arrives. Marking this required made every streamed
     * reply fail validation at the moment it was created.
     *
     * Non-empty user input is enforced at the route boundary instead, which
     * is where a caller can actually be told what they did wrong.
     */
    content: { type: String, default: "" },

    status: { type: String, enum: MESSAGE_STATUSES, required: true, default: "complete" },

    // Which provider actually served this. Recorded because the request may
    // have failed over, and cost accounting needs to know who to bill.
    provider: { type: String },
    model: { type: String },
    usage: { type: UsageSchema, default: () => ({}) },

    /**
     * Passages retrieved for this reply, in the order they were numbered in
     * the prompt.
     *
     * Stored on the message rather than recomputed on read because the
     * document could later be deleted or re-indexed — and an answer that
     * cited page 14 must keep saying page 14. A citation that silently
     * changes meaning after the fact is worse than no citation.
     */
    citations: {
      type: [
        new Schema(
          {
            documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true },
            chunkId: { type: Schema.Types.ObjectId, required: true },
            filename: { type: String, required: true },
            page: { type: Number },
            score: { type: Number },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    /**
     * Supplied by the client and unique per thread, so a retry after a
     * network blip does not create a duplicate message — or a duplicate
     * charge. Without this, "send" plus a flaky connection means the user
     * pays twice and sees their question echoed back at them.
     */
    clientMessageId: { type: String },
  },
  { timestamps: true },
);

// Every read of a conversation is "this thread's messages, oldest first".
// Without this index that is a full collection scan plus an in-memory sort,
// on every single page load.
// threadId leads rather than userId: it is far more selective, and every
// message query names it. userId is applied as an additional filter over the
// already-narrow result, so it does not need to be in the index.
MessageSchema.index({ threadId: 1, createdAt: 1, _id: 1 });

// Enforces the idempotency guarantee above. Partial so that messages without
// a client id (server-generated ones) are not forced into a single slot.
MessageSchema.index(
  { threadId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } },
);

export type Message = InferSchemaType<typeof MessageSchema>;
export type MessageDocument = HydratedDocument<Message>;

export const MessageModel = mongoose.model("Message", MessageSchema);
export default MessageModel;
