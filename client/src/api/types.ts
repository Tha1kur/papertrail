/** Mirrors the server's response shapes. Kept in one file so a change to
 *  the API surfaces as a type error here rather than a runtime surprise. */

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "streaming" | "incomplete" | "failed";

export interface Citation {
  documentId: string;
  chunkId: string;
  filename: string;
  page?: number;
  score?: number;
}

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
  provider?: string;
  model?: string;
  citations?: Citation[];
}

export interface Thread {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType: string;
  bytes: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  characters: number;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Usage {
  day: string;
  tokensUsed: number;
  tokenBudget: number;
  tokensRemaining: number;
  requests: number;
  percentUsed: number;
}

/** The server's uniform error envelope. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
