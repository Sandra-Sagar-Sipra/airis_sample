import path from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";

/** Directory containing this config (the `frontend` app root). */
const appRoot = path.dirname(fileURLToPath(import.meta.url));

const apiProxyTarget =
  process.env.API_PROXY_TARGET?.replace(/\/$/, "") ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // livekit-client ships as ESM — Next.js must transpile it for Webpack.
  transpilePackages: ["livekit-client"],
  // Keeps file tracing anchored to this app (Vercel root directory = frontend). Prevents Next from
  // walking up to the repo root and mis-detecting the workspace when backend/ exists alongside.
  outputFileTracingRoot: appRoot,
  experimental: {
    // Avoids dev-only "SegmentViewNode" / React Client Manifest errors from the App Router segment explorer (Next 15.5+).
    devtoolSegmentExplorer: false,
  },
  async headers() {
    return [
      {
        // Tell browsers never to cache HTML pages.
        // _next/static/* assets are served with immutable content-hash URLs
        // and are NOT matched here — they keep their long-lived cache headers.
        // Without this, a clean rebuild (new CSS hash) + cached HTML = no CSS.
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store",
          },
        ],
      },
    ];
  },
  // Dev: browser calls same-origin /api/v1 → Next proxies to FastAPI (avoids cross-port connection issues).
  async rewrites() {
    if (process.env.NODE_ENV === "production" && !process.env.API_PROXY_TARGET) {
      return [];
    }
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiProxyTarget}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
