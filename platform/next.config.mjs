/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // postgres.js 在伺服器端執行，不打包進前端
  serverExternalPackages: ['postgres'],
};
export default nextConfig;
