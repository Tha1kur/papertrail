import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * NOTE: messages are still embedded here. That is a known problem — a
 * MongoDB document is capped at 16MB and this array is unbounded, so a long
 * enough conversation eventually fails to save, and every append rewrites
 * the whole document. Moving messages to their own collection is the next
 * change (see docs/adr/0002-message-storage.md).
 */
const MessageSchema = new Schema(
  {
    role: { type: String, enum: MESSAGE_ROLES, required: true },
    content: { type: String, required: true },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

const ThreadSchema = new Schema(
  {
    threadId: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "New Chat", trim: true, maxlength: 200 },
    messages: { type: [MessageSchema], default: [] },
  },
  {
    // Mongoose maintains createdAt/updatedAt itself. The original code set
    // them by hand, which meant any write that forgot to touch updatedAt
    // silently broke the "most recent first" ordering in the sidebar.
    timestamps: true,
  },
);

// The sidebar always reads threads newest-first; without this index that is
// a collection scan plus an in-memory sort on every page load.
ThreadSchema.index({ updatedAt: -1 });

export type Thread = InferSchemaType<typeof ThreadSchema>;
export type ThreadDocument = HydratedDocument<Thread>;

export const ThreadModel = mongoose.model("Thread", ThreadSchema);
export default ThreadModel;
