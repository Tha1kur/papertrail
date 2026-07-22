# Deployment

Everything here is free tier. No payment details are required at any step.

| Piece | Where | Free tier |
| --- | --- | --- |
| API | Render | 750 hours/month, sleeps after 15 min idle |
| Web client | Vercel | Hobby |
| Database + vector search | MongoDB Atlas M0 | 512MB |
| Rate limiting | Upstash Redis | 10k commands/day |
| Error tracking | Sentry | 5k events/month |

---

## 1. MongoDB Atlas

1. Create a free **M0** cluster.
2. **Database Access** → add a user with a generated password.
3. **Network Access** → add `0.0.0.0/0`. Render's free tier has no static
   outbound IP, so there is nothing narrower to allow. The database is still
   protected by credentials; this is a deliberate trade, not an oversight.
4. Copy the connection string and append the database name: `.../papertrail`.
   Without it, Mongoose silently writes everything to a database called `test`.

---

## 2. API on Render

1. **New → Blueprint**, point it at the repo. Render reads [`render.yaml`](../render.yaml).
2. Set the secrets marked `sync: false` in the dashboard. To avoid
   transcribing them by hand, print them from your local `.env`:

   ```bash
   bash server/scripts/print-deploy-env.sh
   ```

   The values are:

   | Key | Value |
   | --- | --- |
   | `MONGODB_URI` | from Atlas, with `/papertrail` |
   | `JWT_ACCESS_SECRET` | `openssl rand -base64 48` |
   | `GEMINI_API_KEY` | aistudio.google.com/apikey |
   | `GROQ_API_KEY` | console.groq.com |
   | `CORS_ORIGINS` | your Vercel URL |
   | `UPSTASH_REDIS_REST_URL` / `_TOKEN` | optional but recommended |
   | `SENTRY_DSN` | optional |

3. After the first deploy, create the vector index once:

   ```bash
   MONGODB_URI="<your atlas uri>" GEMINI_API_KEY="<key>" \
   GROQ_API_KEY="<key>" JWT_ACCESS_SECRET="$(openssl rand -base64 48)" \
   npm run ensure-index --prefix server
   ```

   It is idempotent, so re-running it is safe. Without it the app still runs —
   chat works, retrieval returns nothing — and `/health` reports
   `vectorIndex: unavailable`.

---

## 3. Web client on Vercel

1. **New Project** → import the repo → set **Root Directory** to `client`.
2. `client/vercel.json` already points at the deployed API
   (`papertrail-api-njcy.onrender.com`). Change it only if the API moves.
3. Deploy.

### Why rewrites instead of calling the API directly

The client uses relative `/api` paths, and Vercel proxies them to Render. The
browser therefore only ever talks to one origin.

That is not a convenience — it is what keeps the auth cookies **first-party**.
Calling Render directly from the browser would make every request cross-site,
which forces `SameSite=None`, adds a CORS preflight to each one, and puts the
session at the mercy of third-party-cookie restrictions that browsers keep
tightening. Same-origin sidesteps all of it.

It also mirrors local development, where Vite proxies `/api` the same way — so
cookie behaviour is identical in both environments rather than being a class of
bug that only appears in production.

---

## 4. Keeping the API awake

Render's free tier sleeps after 15 minutes idle, and the next request pays a
cold start of roughly 50 seconds — long enough that an interviewer clicking your
link will assume the site is broken.

Create a free [UptimeRobot](https://uptimerobot.com) HTTP monitor against
`https://your-api.onrender.com/health/live` at a 5-minute interval.

`/health/live` and not `/health` on purpose: liveness answers cheaply without
touching the database, so the keep-warm ping does not spend Atlas operations
every five minutes, all month.

---

## Verifying a deploy

```bash
curl -s https://your-api.onrender.com/health | jq
```

```json
{
  "status": "ok",
  "uptimeSeconds": 42,
  "checks": { "database": "up", "vectorIndex": "ready" }
}
```

`status: degraded` with `vectorIndex: unavailable` means step 2.3 has not been
run — chat will work and document search will silently return nothing.

Then, in the browser: register, upload a small text file, wait for it to show a
passage count, and ask something only that file could answer. A cited answer
means the whole path works — auth, upload, chunking, embedding, vector search,
streaming, persistence.

---

## Cost controls before going public

The defaults assume a small number of users. If you post the link anywhere:

- lower `DAILY_TOKEN_BUDGET` (default 150,000 tokens per user per day)
- lower `RATE_LIMIT_CHAT_PER_MINUTE` (default 12)
- set the Upstash variables, so limits are shared across instances instead of
  counted per process
- set a billing alert on the Google Cloud project behind your Gemini key, even
  on the free tier
