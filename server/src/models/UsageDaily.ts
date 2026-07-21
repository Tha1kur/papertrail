import mongoose, { Schema, type InferSchemaType } from "mongoose";

/**
 * Token spend per user per day.
 *
 * One document per user-day rather than a row per request: the question
 * being asked is always "how much has this person spent today", and
 * aggregating thousands of request rows to answer it on every message would
 * cost more than the request being metered.
 */
const UsageDailySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /**
     * UTC date as YYYY-MM-DD.
     *
     * A string rather than a Date because the unit here is a calendar day,
     * not an instant, and storing an instant invites timezone bugs where a
     * user's budget resets at a different time than intended. UTC is chosen
     * so the reset moment is unambiguous and identical everywhere.
     */
    day: { type: String, required: true },

    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    embedTokens: { type: Number, default: 0, min: 0 },
    requests: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// The lookup and the upsert both key on this pair; unique so concurrent
// requests cannot create two rows for the same day and lose half the count.
UsageDailySchema.index({ userId: 1, day: 1 }, { unique: true });

// Old usage rows have no purpose beyond a rolling window of history.
UsageDailySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });

export type UsageDaily = InferSchemaType<typeof UsageDailySchema>;

export const UsageDailyModel = mongoose.model("UsageDaily", UsageDailySchema);
export default UsageDailyModel;
