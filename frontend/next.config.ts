import type { NextConfig } from "next";

const backendOrigin = process.env.HANNISHUB_BACKEND_ORIGIN || "http://127.0.0.1:8081";

const developmentConfig: NextConfig = process.env.NODE_ENV === "development" ? {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${backendOrigin}/api/:path*` },
      { source: "/llama-manager/api/:path*", destination: `${backendOrigin}/llama-manager/api/:path*` },
      { source: "/server/api/:path*", destination: `${backendOrigin}/server/api/:path*` },
      { source: "/prompt/api/:path*", destination: `${backendOrigin}/prompt/api/:path*` },
      { source: "/llama-manager/llama-process/:path*", destination: `${backendOrigin}/llama-manager/llama-process/:path*` },
      { source: "/llama-manager/llama/:path*", destination: `${backendOrigin}/llama-manager/llama/:path*` },
    ];
  },
} : {};

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  ...developmentConfig,
};

export default nextConfig;
