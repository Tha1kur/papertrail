import mongoose, { Schema, type InferSchemaType } from "mongoose";

/**
 * A passage of a document, with its embedding.
 *
 * Chunks are separate documents rather than an array on Document for the
 * same reason messages left Thread: the array is unbounded, and here each
 * element also carries 768 floats. A few hundred pages would blow the 16MB
 * document cap on its own.
 *
 * More importantly, Atlas Vector Search indexes fields on documents. The
 * vector has to live on its own document to be searchable at chunk
 * granularity — which is the whole point, since we want to retrieve the
 * paragraph that answers the question, not the book that contains it.
 */
const ChunkSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /** Position within the document, so retrieved passages can be shown in
     *  order and neighbouring context can be pulled in if needed. */
    index: { type: Number, required: true, min: 0 },

    content: { type: String, required: true },

    /**
     * Unit-length embedding. Length must match the vector index definition
     * exactly — Atlas rejects a query vector of the wrong size, and stored
     * vectors of the wrong size simply never match.
     *
     * Not selected by default anywhere: 768 floats is roughly 6KB of JSON
     * per chunk, and no caller outside retrieval ever needs it.
     */
    embedding: { type: [Number], required: true, select: false },

    /** Page number where known. PDFs have them; plain text does not. */
    page: { type: Number, min: 1 },

    /** Estimated tokens, used when fitting retrieved passages into the
     *  context budget without re-measuring every time. */
    tokens: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// Deleting a document deletes its chunks; listing shows them in order.
ChunkSchema.index({ documentId: 1, index: 1 });

// Belt and braces for tenant isolation on any non-vector query path.
ChunkSchema.index({ userId: 1 });

export type Chunk = InferSchemaType<typeof ChunkSchema>;

export const ChunkModel = mongoose.model("Chunk", ChunkSchema);
export default ChunkModel;
