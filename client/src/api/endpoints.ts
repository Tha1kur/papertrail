import { apiRequest } from "./client";
import type {
  DocumentSummary,
  Message,
  Page,
  Thread,
  Usage,
  User,
} from "./types";

export const auth = {
  register: (email: string, password: string, displayName?: string) =>
    apiRequest<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: { email, password, ...(displayName ? { displayName } : {}) },
    }),

  login: (email: string, password: string) =>
    apiRequest<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  logout: () => apiRequest<void>("/api/auth/logout", { method: "POST" }),

  logoutAll: () => apiRequest<void>("/api/auth/logout-all", { method: "POST" }),

  me: () => apiRequest<{ user: User }>("/api/auth/me"),
};

export const threads = {
  list: (cursor?: string) =>
    apiRequest<Page<Thread>>(`/api/threads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),

  get: (id: string) => apiRequest<Thread>(`/api/threads/${id}`),

  messages: (id: string, cursor?: string) =>
    apiRequest<Page<Message>>(
      `/api/threads/${id}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),

  rename: (id: string, title: string) =>
    apiRequest<Thread>(`/api/threads/${id}`, { method: "PATCH", body: { title } }),

  remove: (id: string) => apiRequest<void>(`/api/threads/${id}`, { method: "DELETE" }),
};

export const documents = {
  list: () =>
    apiRequest<{ items: DocumentSummary[]; supportedTypes: string[] }>("/api/documents"),

  get: (id: string) => apiRequest<DocumentSummary>(`/api/documents/${id}`),

  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiRequest<{ id: string; filename: string; status: string }>("/api/documents", {
      method: "POST",
      body: form,
    });
  },

  remove: (id: string) => apiRequest<void>(`/api/documents/${id}`, { method: "DELETE" }),
};

export const usage = {
  today: () => apiRequest<Usage>("/api/usage"),
};
