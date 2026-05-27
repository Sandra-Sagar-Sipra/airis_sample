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
