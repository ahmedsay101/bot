/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  outputFileTracingRoot: new URL('.', import.meta.url).pathname,
  eslint: { ignoreDuringBuilds: true },
  // In dev, proxy /api and /healthz to the bot backend.
  // In production, the nginx reverse proxy handles /api and /ws upstream
  // before requests ever reach Next.js.
  async rewrites() {
    const target = process.env.BACKEND_URL || 'http://localhost:4000';
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/healthz', destination: `${target}/healthz` },
    ];
  },
};

export default nextConfig;
