import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db.js";

let app: Express;
let MessageModel: typeof import("../../src/models/Message.js").MessageModel;
let RefreshTokenModel: typeof import("../../src/models/RefreshToken.js").RefreshTokenModel;

beforeAll(async () => {
  await startTestDatabase();
  // Imported after the database is up so model index creation has somewhere
  // to go, and after setup.ts has populated the environment.
  ({ buildApp: buildAppFn } = await import("../../src/app.js"));
  ({ MessageModel } = await import("../../src/models/Message.js"));
  ({ RefreshTokenModel } = await import("../../src/models/RefreshToken.js"));
  app = buildAppFn();
});

let buildAppFn: typeof import("../../src/app.js").buildApp;

afterEach(async () => {
  await clearTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

const PASSWORD = "correct-horse-battery";

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function cookie(jar: string[], name: string): string {
  return jar.find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";
}

async function newUser(): Promise<{ jar: string[]; access: string; id: string; email: string }> {
  const email = `user-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email, password: PASSWORD });

  const jar = cookiesOf(response);
  return { jar, access: cookie(jar, "pt_access"), id: response.body.user.id, email };
}

describe("auth", () => {
  it("registers and returns a user without the password hash", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .send({ email: `a-${randomUUID()}@example.com`, password: PASSWORD });

    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(JSON.stringify(response.body)).not.toContain("$2b$");
  });

  it("sets httpOnly cookies and scopes the refresh token to the auth routes", async () => {
    const jar = cookiesOf(
      await request(app)
        .post("/api/auth/register")
        .send({ email: `b-${randomUUID()}@example.com`, password: PASSWORD }),
    );

    const access = jar.find((c) => c.startsWith("pt_access="))!;
    const refresh = jar.find((c) => c.startsWith("pt_refresh="))!;

    expect(access).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/HttpOnly/i);
    // Not attached to ordinary API calls — only where it is consumed.
    expect(refresh).toMatch(/Path=\/api\/auth/i);
  });

  it("treats emails as case-insensitive", async () => {
    const email = `c-${randomUUID()}@example.com`;
    await request(app).post("/api/auth/register").send({ email, password: PASSWORD });

    const duplicate = await request(app)
      .post("/api/auth/register")
      .send({ email: email.toUpperCase(), password: PASSWORD });

    expect(duplicate.status).toBe(409);
  });

  it("rejects short passwords", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .send({ email: `d-${randomUUID()}@example.com`, password: "short" });

    expect(response.status).toBe(422);
  });

  /**
   * Different messages here turn the login form into an account enumeration
   * oracle: an attacker learns which addresses are registered without ever
   * guessing a password.
   */
  it("gives identical errors for a wrong password and an unknown account", async () => {
    const { email } = await newUser();

    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "definitely-not-it" });

    const unknownUser = await request(app)
      .post("/api/auth/login")
      .send({ email: `ghost-${randomUUID()}@example.com`, password: "definitely-not-it" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it("rejects an unsigned alg:none token", async () => {
    const forged = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJoYWNrZXIifQ.";
    const response = await request(app).get("/api/threads").set("Cookie", `pt_access=${forged}`);

    expect(response.status).toBe(401);
  });

  it("rotates the refresh token on use", async () => {
    const { jar } = await newUser();
    const original = cookie(jar, "pt_refresh");

    const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", original);
    const next = cookie(cookiesOf(refreshed), "pt_refresh");

    expect(refreshed.status).toBe(200);
    expect(next).not.toBe(original);
  });

  /**
   * Tokens rotate, so each should be presented exactly once. A second
   * presentation means two parties hold the same credential and there is no
   * way to tell which is legitimate — so the whole family dies.
   */
  it("revokes the entire session family when a rotated token is replayed", async () => {
    const { jar, id } = await newUser();
    const original = cookie(jar, "pt_refresh");

    const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", original);
    const successor = cookie(cookiesOf(refreshed), "pt_refresh");

    const replay = await request(app).post("/api/auth/refresh").set("Cookie", original);
    expect(replay.status).toBe(401);

    // The legitimate successor must die too — we cannot tell which party is real.
    const afterReplay = await request(app).post("/api/auth/refresh").set("Cookie", successor);
    expect(afterReplay.status).toBe(401);

    const live = await RefreshTokenModel.countDocuments({
      userId: id,
      revokedAt: { $exists: false },
    });
    expect(live).toBe(0);
  });

  it("invalidates existing access tokens on logout-all", async () => {
    const { access } = await newUser();

    expect((await request(app).get("/api/threads").set("Cookie", access)).status).toBe(200);
    await request(app).post("/api/auth/logout-all").set("Cookie", access);

    // Immediately, not whenever the access token happens to expire.
    expect((await request(app).get("/api/threads").set("Cookie", access)).status).toBe(401);
  });

  it("requires authentication on protected routes", async () => {
    for (const path of ["/api/threads", "/api/documents", "/api/usage"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});

describe("tenant isolation", () => {
  /**
   * Thread ids are client-generated UUIDs, so knowing an id must never be
   * sufficient to reach a thread. Every repository call filters on the
   * owner, so a mistake fails closed as a 404 rather than serving someone
   * else's conversation.
   */
  it("hides one user's thread from another for every operation", async () => {
    const alice = await newUser();
    const bob = await newUser();

    const threadId = randomUUID();
    await request(app)
      .post("/api/chat")
      .set("Cookie", alice.access)
      .send({ threadId, message: "alice's private question" });

    expect((await request(app).get(`/api/threads/${threadId}`).set("Cookie", bob.access)).status).toBe(404);
    expect(
      (await request(app).get(`/api/threads/${threadId}/messages`).set("Cookie", bob.access)).status,
    ).toBe(404);
    expect(
      (await request(app).patch(`/api/threads/${threadId}`).set("Cookie", bob.access).send({ title: "hijacked" })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/threads/${threadId}`).set("Cookie", bob.access)).status).toBe(404);

    // ...and the owner is unaffected throughout.
    expect((await request(app).get(`/api/threads/${threadId}`).set("Cookie", alice.access)).status).toBe(200);
  });

  it("lists only the caller's own threads", async () => {
    const alice = await newUser();
    const bob = await newUser();

    await request(app).post("/api/chat").set("Cookie", alice.access).send({ threadId: randomUUID(), message: "hers" });
    await request(app).post("/api/chat").set("Cookie", bob.access).send({ threadId: randomUUID(), message: "his" });

    const list = await request(app).get("/api/threads").set("Cookie", bob.access);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].title).toContain("his");
  });
});

describe("chat", () => {
  it("persists both the question and the reply", async () => {
    const { access } = await newUser();
    const threadId = randomUUID();

    const response = await request(app)
      .post("/api/chat")
      .set("Cookie", access)
      .send({ threadId, message: "what is the deployment window?" });

    expect(response.status).toBe(200);
    expect(response.body.reply).toBeTruthy();

    const messages = await request(app).get(`/api/threads/${threadId}/messages`).set("Cookie", access);
    expect(messages.body.items).toHaveLength(2);
    expect(messages.body.items[0].role).toBe("user");
    expect(messages.body.items[1].role).toBe("assistant");
  });

  /**
   * Without this, a request that times out on the client but succeeds on the
   * server produces a duplicate message and a duplicate model charge when the
   * client retries.
   */
  it("is idempotent for a repeated clientMessageId", async () => {
    const { access } = await newUser();
    const threadId = randomUUID();
    const clientMessageId = randomUUID();

    await request(app).post("/api/chat").set("Cookie", access).send({ threadId, message: "hello", clientMessageId });
    await request(app).post("/api/chat").set("Cookie", access).send({ threadId, message: "hello", clientMessageId });

    const userMessages = await MessageModel.countDocuments({ threadId, role: "user" });
    expect(userMessages).toBe(1);
  });

  it("keeps the thread counter consistent with the stored messages", async () => {
    const { access } = await newUser();
    const threadId = randomUUID();

    for (let i = 0; i < 3; i += 1) {
      await request(app).post("/api/chat").set("Cookie", access).send({ threadId, message: `question ${i}` });
    }

    const thread = await request(app).get(`/api/threads/${threadId}`).set("Cookie", access);
    const stored = await MessageModel.countDocuments({ threadId });

    // The denormalised count is maintained in the same transaction as the
    // message write, so it cannot drift.
    expect(thread.body.messageCount).toBe(stored);
    expect(stored).toBe(6);
  });

  it("truncates a long first message into a readable title", async () => {
    const { access } = await newUser();
    const threadId = randomUUID();

    await request(app)
      .post("/api/chat")
      .set("Cookie", access)
      .send({ threadId, message: "word ".repeat(200) });

    const thread = await request(app).get(`/api/threads/${threadId}`).set("Cookie", access);
    expect(thread.body.title.length).toBeLessThanOrEqual(64);
  });

  it("validates the request body", async () => {
    const { access } = await newUser();

    const badId = await request(app).post("/api/chat").set("Cookie", access).send({ threadId: "not-a-uuid", message: "hi" });
    const empty = await request(app).post("/api/chat").set("Cookie", access).send({ threadId: randomUUID(), message: "   " });

    expect(badId.status).toBe(422);
    expect(empty.status).toBe(422);
  });

  it("deletes a thread and its messages together", async () => {
    const { access } = await newUser();
    const threadId = randomUUID();

    await request(app).post("/api/chat").set("Cookie", access).send({ threadId, message: "hello" });
    expect(await MessageModel.countDocuments({ threadId })).toBeGreaterThan(0);

    const deleted = await request(app).delete(`/api/threads/${threadId}`).set("Cookie", access);

    expect(deleted.status).toBe(204);
    // Orphaned messages would be invisible to the UI and count against quota
    // forever, with nothing left to link them to.
    expect(await MessageModel.countDocuments({ threadId })).toBe(0);
  });
});

describe("streaming", () => {
  it("emits a message event, deltas, then done", async () => {
    const { access } = await newUser();

    const response = await request(app)
      .post("/api/chat/stream")
      .set("Cookie", access)
      .send({ threadId: randomUUID(), message: "stream this please" });

    const events = response.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string });

    expect(events[0]?.type).toBe("message");
    expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("persists the streamed reply as a complete message", async () => {
    const { access } = await newUser();
    const threadId = randomUUID();

    await request(app).post("/api/chat/stream").set("Cookie", access).send({ threadId, message: "stream and store" });

    const assistant = await MessageModel.findOne({ threadId, role: "assistant" }).lean();

    expect(assistant?.status).toBe("complete");
    expect(assistant?.content.length).toBeGreaterThan(0);
  });
});

describe("errors", () => {
  it("returns a consistent envelope with a request id", async () => {
    const { access } = await newUser();
    const response = await request(app).get(`/api/threads/${randomUUID()}`).set("Cookie", access);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(response.body.error.requestId).toBeTruthy();
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("404s an unknown route through the same handler", async () => {
    const response = await request(app).get("/api/nope");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed JSON with a 400 rather than a 500", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("MALFORMED_JSON");
  });
});

describe("health", () => {
  it("reports liveness and readiness separately", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);

    const ready = await request(app).get("/health");
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database).toBe("up");
  });
});
