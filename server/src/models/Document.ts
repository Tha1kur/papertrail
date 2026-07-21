import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * Ingestion is multi-step and fallible — extract, chunk, embed, index — and
 * embedding in particular is a network call that can rate-limit halfway
 * through a large file. The status field is what lets the UI say "still
 * working" or "this one failed and why", rather than showing an empty
 * document with no explanation.
 */
export const DOCUMENT_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const DocumentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    filename: { type: String, required: true, trim: true, maxlength: 300 },
    mimeType: { type: String, required: true },
    /** Size of the original upload, for quota accounting and display. */
    bytes: { type: Number, required: true, min: 0 },

    status: { type: String, enum: DOCUMENT_STATUSES, required: true, default: "pending" },

    /** Populated when status is "failed" — shown to the user, so it must
     *  stay readable and must never contain internals. */
    error: { type: String, maxlength: 500 },

    chunkCount: { type: Number, default: 0, min: 0 },
    /** Characters of extracted text. Zero means extraction found nothing,
     *  which is the common outcome for a scanned PDF with no OCR layer. */
    characters: { type: Number, default: 0, min: 0 },

    /**
     * Content hash of the uploaded bytes. Uploading the same file twice is
     * common — and re-embedding it costs quota, storage and quality (the
     * same passage appearing twice crowds out other results in retrieval).
     */
    contentHash: { type: String, required: true },
  },
  { timestamps: true },
);

// Newest-first listing, per user.
DocumentSchema.index({ userId: 1, createdAt: -1 });

// One copy of a given file per user. Scoped per user rather than globally so
// two people uploading the same public PDF each keep their own.
DocumentSchema.index({ userId: 1, contentHash: 1 }, { unique: true });

export type DocumentRecord = InferSchemaType<typeof DocumentSchema>;
export type DocumentDoc = HydratedDocument<DocumentRecord>;

export const DocumentModel = mongoose.model("Document", DocumentSchema);
export default DocumentModel;
