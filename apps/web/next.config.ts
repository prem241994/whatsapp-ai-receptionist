import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keep `next dev` isolated from production builds run in the shared workspace.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
};

export default nextConfig;
