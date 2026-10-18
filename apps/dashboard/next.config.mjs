/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Monorepo runs root eslint flat config via `pnpm run lint`
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
