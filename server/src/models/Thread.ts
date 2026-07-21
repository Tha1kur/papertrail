import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * A conversation. Messages are NOT stored here — see models/Message.ts for
 * why the embedded array had to go.
 *
 * `_id` is the client-generated UUID rather than a Mongo ObjectId. That
 * choice buys optimistic UI: the browser can mint an id, render the new
 * thread and start showing the user's message before the server has replied,
 * with no reconciliation step when the real id comes back. It also makes the
 * create path idempotent — a retried request upserts the same thread instead
 * of creating a second one.
 */
const ThreadSchema = new Schema(
  {
    _id: { type: String, required: true },

    /**
     * Owner. Required, and every query in threadRepository filters on it.
     *
     * Because thread ids are client-generated, an id is guessable-ish and
     * must never be sufficient on its own to reach a thread — otherwise any
     * signed-in user could read someone else's conversation by supplying
     * their UUID. Ownership is checked in the query itself rather than after
     * loading, so a missing filter fails closed as a 404.
     */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    title: { type: String, default: "New chat", trim: true, maxlength: 200 },

    /**
     * Denormalised counters. They duplicate what a query over Message could
     * derive, which is a deliberate trade: rendering the sidebar would
     * otherwise need an aggregation across the whole message collection on
     * every load. They are maintained with $inc inside the same transaction
     * as the message write, so they cannot drift.
     */
    messageCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date },

    /**
     * Running summary of the turns that have aged out of the context window,
     * so a long conversation keeps its gist without carrying its full token
     * cost on every request.
     */
    summary: { type: String, default: "", maxlength: 4000 },

    /**
     * Everything created at or before this instant is already represented in
     * `summary`. Stored as a timestamp rather than a message id because it is
     * used directly as a range query bound when loading history.
     */
    summarisedThrough: { type: Date },
  },
  {
    timestamps: true,
    // We supply _id ourselves; stop Mongoose casting it to ObjectId.
    _id: false,
  },
);

// The sidebar reads one user's threads, newest-first. userId leads because
// every query filters on it; without that prefix the index cannot serve the
// query and it degrades to a scan of every user's threads.
ThreadSchema.index({ userId: 1, lastMessageAt: -1, _id: -1 });

export type Thread = InferSchemaType<typeof ThreadSchema>;
export type ThreadDocument = HydratedDocument<Thread>;

export const ThreadModel = mongoose.model("Thread", ThreadSchema);
export default ThreadModel;
