# AIRIS Frontend (Next.js App Router)

MVP frontend scaffold connected to the existing FastAPI backend.

## Run locally

1. Copy env values:
   - `cp .env.example .env.local` (or create `.env.local` manually on Windows)
2. Install dependencies:
   - `npm install`
3. Start dev server:
   - `npm run dev`
4. Open:
   - `http://localhost:3000`

## Required backend

- Backend should be running and accessible at `NEXT_PUBLIC_API_BASE_URL`
- Default expected base URL (origin only): `http://localhost:8000`
- Login uses `POST /auth/login` and stores access token in browser local storage.

### Vercel production (avoid HTML 404 on API calls)

If the browser calls `/api/v1` on the Vercel host but no proxy is configured, Next.js returns a **Page not found** HTML page instead of JSON.

**Recommended (Option A — no CORS):**

```env
NEXT_PUBLIC_API_BASE_URL=/api/v1
API_PROXY_TARGET=https://<your-railway-backend>.up.railway.app
```

**Alternative (Option B — direct to Railway):**

```env
NEXT_PUBLIC_API_BASE_URL=https://<your-railway-backend>.up.railway.app
```

Set Railway `CORS_ORIGINS=https://airis-sample1.vercel.app` when using Option B.

Redeploy Vercel after changing any `NEXT_PUBLIC_*` variable.
