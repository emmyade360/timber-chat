# Production deployment: Render API + Vercel web app

Timber is a two-service deployment: the Rust API runs on Render and the browser
application is a static Vite deployment on Vercel. The browser connects directly
to the API over HTTPS/WSS; it does not need, and must not contain, any server
secret.

## Before deploying

1. Use a stable production frontend origin, preferably a custom domain such as
   `https://app.example.com`. Do not use a wildcard CORS origin or a URL with a
   trailing slash.
2. Create the private Supabase Storage bucket `chat-files`. It must not have a
   public read policy. Timber sends it only opaque encrypted blobs.
3. Use Supabase's **session pooler** SSL connection string for `SUPABASE_DB_URL`
   (normally pooler port 5432), not the direct database host. Keep
   `DATABASE_MAX_CONNECTIONS` within the connection budget assigned by that
   pooler. Percent-encode special password characters.
4. For reliable calls outside one local network, operate a STUN/TURN service.
   Coturn with a `static-auth-secret` is the recommended setup.

Never commit the backend `.env`, a Supabase service-role key, database URL, or
TURN shared secret. `VITE_*` values are public build-time URLs, not secrets.

## 1. Deploy the backend to Render

The included [render.yaml](./render.yaml) creates one Rust Web Service with:

- root directory `backend`
- `cargo build --release --locked`
- health endpoint `/health` (including a database readiness query)
- graceful SIGTERM handling
- one instance, which is required by the current in-memory WebSocket event bus

In Render, choose **New → Blueprint**, select the repository, and supply the
prompted secret environment values:

| Variable | Production value |
| --- | --- |
| `SUPABASE_DB_URL` | Supabase **session pooler** SSL URL |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service-role secret |
| `ALLOWED_ORIGINS` | Exact frontend origin, e.g. `https://app.example.com` |
| `WEBRTC_STUN_URLS` | Your comma-separated STUN URLs |
| `WEBRTC_TURN_URLS` | Your UDP and TLS/TCP TURN URLs |
| `WEBRTC_TURN_SHARED_SECRET` | Coturn `static-auth-secret` |

Leave `DATABASE_MAX_CONNECTIONS=5` unless the pooler's budget requires a lower
number. Render supplies `PORT`; Timber binds to it on `0.0.0.0` automatically.
Set `RUST_LOG=info` and do not enable request-header logging.

After Render deploys, copy its public HTTPS URL, for example
`https://timber-chat-api.onrender.com`. Confirm:

```sh
curl --fail --silent --show-error https://timber-chat-api.onrender.com/health
```

The response must be `{"status":"ok"}`. Render terminates TLS and supports
WebSockets at this endpoint, so the client URL is the same host with `wss://`.

Do not scale this service above one instance yet. Chat backfill will recover
messages across instances, but the current WebSocket broadcast and live call
signalling are process-local. Introduce a shared pub/sub layer before horizontal
scaling.

## 2. Deploy the frontend to Vercel

1. Import the same repository in Vercel.
2. Set **Root Directory** to `frontend`.
3. Add these **Production** environment variables before the first production
   build:

   ```text
   VITE_API_URL=https://timber-chat-api.onrender.com
   VITE_WS_URL=wss://timber-chat-api.onrender.com
   ```

   Use your Render custom API domain instead if you configured one. Values must
   have no trailing slash.
4. Deploy. [frontend/vercel.json](./frontend/vercel.json) supplies the Vite
   build command, SPA fallback, no-store policy, CSP, HSTS, clickjacking
   protection, referrer policy, and camera/microphone permission policy.
5. Copy the final Vercel production origin (or attach your custom domain), then
   return to Render and set `ALLOWED_ORIGINS` to that exact origin if it differs
   from the value used in step 1. Redeploy the API after changing it.

Vite embeds `VITE_*` values into the built JavaScript. Changing either variable
requires a new Vercel deployment; editing it after a deploy does not change
already-served code. Do not add preview URLs to the production API's CORS policy
unless you intentionally run a separate preview API.

## 3. Production smoke test

From a clean browser profile at the Vercel URL:

1. Register two test accounts, then make them accepted friends.
2. Open two tabs/devices and verify an encrypted message, receipt, and friend
   change arrive without a refresh.
3. Reload one device, send more than 50 messages from the other, then unlock it;
   all missed messages must backfill.
4. Test an audio call and a video call across two different networks. Verify the
   TURN server's short-lived credential path works by testing a restrictive
   network as well as Wi-Fi.
5. Confirm `IndexedDB` contains envelopes/ciphertext, not message text or peer
   metadata, and browser storage contains no bearer token.
6. Check `/health`, Render logs, and Vercel function-free static deployment.
   User-facing failures should be generic; inspect detailed failures only in
   protected Render logs.

## Operations checklist

- Keep Render and Supabase in a region close to the largest user group.
- Keep database, Storage, and TURN credentials in their provider secret stores.
- Rotate the Supabase service-role key and TURN shared secret through a planned
  deployment if either may have been exposed.
- Back up Supabase PostgreSQL and monitor database connection/pooler limits.
- Keep the private `chat-files` bucket lifecycle cleanup enabled through the
  backend worker; do not add public bucket URLs.
- Review CI before enabling `autoDeployTrigger: checksPass`. It runs frontend
  tests/lint/build/audit, Rust tests/Clippy/audit, and empty-database migration
  checks.
