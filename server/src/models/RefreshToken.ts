import mongoose, { Schema, type InferSchemaType } from "mongoose";

/**
 * A single issued refresh token.
 *
 * Tokens are stored as SHA-256 hashes, never in plaintext. A refresh token
 * is a password equivalent: anyone holding one can mint access tokens
 * indefinitely. If the database leaks and they are stored raw, every session
 * is compromised — hashing means a leak yields nothing usable.
 *
 * SHA-256 rather than bcrypt here, unlike passwords: these are 256 bits of
 * generated randomness, not a human-chosen secret, so there is no dictionary
 * to attack and no need to be slow. Making refresh slow would be a
 * self-inflicted latency cost on every session renewal.
 */
const RefreshTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },

    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /**
     * All tokens descended from one login share a family id.
     *
     * This is what makes theft detectable. Tokens rotate on every use, so a
     * given token should be presented exactly once. If an already-rotated
     * token shows up again, either an attacker stole it or the legitimate
     * user is replaying an old one — and we cannot tell which. The safe
     * response is to revoke the whole family, forcing a fresh login.
     */
    family: { type: String, required: true, index: true },

    expiresAt: { type: Date, required: true },

    /** Set when rotated or revoked. A token with this set must never be
     *  accepted again — presenting one is the reuse signal. */
    revokedAt: { type: Date },

    /** Audit trail: which token replaced this one during rotation. */
    replacedByHash: { type: String },

    /** Recorded to help a user recognise a session that is not theirs. */
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 45 },
  },
  { timestamps: true },
);

/**
 * MongoDB deletes documents once expiresAt passes. Without this the
 * collection grows forever with tokens nobody can use — on a 512MB tier,
 * dead session records are not a rounding error.
 *
 * Note the sweeper runs roughly every 60s, so expiry is not instant. That is
 * fine because expiry is also checked at read time; the index is housekeeping,
 * not the security boundary.
 */
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshToken = InferSchemaType<typeof RefreshTokenSchema>;

export const RefreshTokenModel = mongoose.model("RefreshToken", RefreshTokenSchema);
export default RefreshTokenModel;
