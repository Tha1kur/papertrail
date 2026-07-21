import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

const UserSchema = new Schema(
  {
    /**
     * Stored lowercased and trimmed so "Ada@Example.com" and
     * "ada@example.com" cannot become two accounts. The unique index is on
     * the normalised value, which is the only way that guarantee actually
     * holds — normalising in application code alone loses the race.
     */
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    /**
     * `select: false` keeps the hash out of every query that does not
     * explicitly ask for it. Defence in depth: a future route that returns a
     * user object cannot leak it by accident.
     */
    passwordHash: { type: String, required: true, select: false },

    displayName: { type: String, trim: true, maxlength: 80 },

    /**
     * Bumping this invalidates every access token issued before it, without
     * needing a token blocklist. Used on password change and on refresh-token
     * reuse detection — the two moments where outstanding sessions are
     * suspect.
     */
    tokenVersion: { type: Number, default: 0 },

    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof UserSchema>;
export type UserDocument = HydratedDocument<User>;

export const UserModel = mongoose.model("User", UserSchema);
export default UserModel;
