import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth, currentUser } from "../middleware/requireAuth.js";
import { validate } from "../middleware/validate.js";
import { env } from "../config/env.js";
import { BadRequestError, NotFoundError, PayloadTooLargeError } from "../lib/errors.js";
import DocumentModel from "../models/Document.js";
import { isSupported, SUPPORTED_MIME_TYPES } from "../services/rag/extract.js";
import { deleteDocument, holdBuffer, processDocument, registerUpload } from "../services/rag/ingest.js";

const router = Router();
router.use(requireAuth);

/**
 * Memory storage rather than a temp file.
 *
 * Uploads are capped at a few megabytes and are read exactly once, so a
 * round trip through disk buys nothing — and on a free tier with an
 * ephemeral filesystem, a written file may not survive to be read anyway.
 * The limit is what makes this safe: without it, memory storage is a
 * trivial denial of service.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!isSupported(file.mimetype)) {
      callback(new BadRequestError(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    callback(null, true);
  },
});

const DocumentIdParams = z.object({
  documentId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid document id"),
});

router.get("/", async (req, res) => {
  const documents = await DocumentModel.find(
    { userId: currentUser(req).id },
    // The embedding-bearing chunks are elsewhere; this is metadata only.
    { filename: 1, mimeType: 1, bytes: 1, status: 1, error: 1, chunkCount: 1, characters: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json({
    items: documents.map((d) => ({
      id: String(d._id),
      filename: d.filename,
      mimeType: d.mimeType,
      bytes: d.bytes,
      status: d.status,
      error: d.error ?? null,
      chunkCount: d.chunkCount,
      characters: d.characters,
      createdAt: d.createdAt,
    })),
    supportedTypes: SUPPORTED_MIME_TYPES,
  });
});

router.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) throw new BadRequestError("No file uploaded — send one under the field name 'file'");

  const userId = currentUser(req).id;

  const document = await registerUpload({
    userId,
    // The browser-supplied name is display-only and never touches the
    // filesystem, but it is still user input that will be rendered.
    filename: file.originalname.slice(0, 300),
    mimeType: file.mimetype,
    buffer: file.buffer,
  });

  const documentId = String(document._id);
  holdBuffer(documentId, file.buffer);

  /**
   * Processing runs after the response. Extraction plus embedding takes tens
   * of seconds on a large file — longer than proxies will hold a connection
   * open — so the client gets a 202 and polls status instead.
   *
   * void, with the rejection handled inside processDocument: an unhandled
   * rejection here would take the whole process down under our own
   * unhandledRejection handler.
   */
  void processDocument(documentId, userId);

  req.log?.info({ documentId, bytes: file.size, mimeType: file.mimetype }, "document uploaded");

  res.status(202).json({
    id: documentId,
    filename: document.filename,
    status: document.status,
  });
});

router.get("/:documentId", validate({ params: DocumentIdParams }), async (req, res) => {
  const document = await DocumentModel.findOne({
    _id: req.params.documentId,
    userId: currentUser(req).id,
  }).lean();

  if (!document) throw new NotFoundError("Document");

  res.json({
    id: String(document._id),
    filename: document.filename,
    status: document.status,
    error: document.error ?? null,
    chunkCount: document.chunkCount,
    characters: document.characters,
    createdAt: document.createdAt,
  });
});

router.delete("/:documentId", validate({ params: DocumentIdParams }), async (req, res) => {
  const deleted = await deleteDocument(req.params.documentId as string, currentUser(req).id);
  if (!deleted) throw new NotFoundError("Document");

  res.status(204).end();
});

/**
 * Multer signals an oversized upload with its own error type, which would
 * otherwise fall through as a generic 500. Mounted on this router so the
 * translation lives next to the limit it explains.
 */
router.use(((err: unknown, _req: never, _res: never, next: (e: unknown) => void) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    const mb = Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024));
    next(new PayloadTooLargeError(`File is too large — the limit is ${mb}MB`));
    return;
  }
  next(err);
}) as never);

export default router;
