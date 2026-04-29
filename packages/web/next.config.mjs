/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages compile from source rather than via prebuilt dist; tell Next to
  // run them through swc so it doesn't choke on TS imports across package boundaries.
  transpilePackages: ["@filter-fun/oracle", "@filter-fun/scheduler"],
};

export default nextConfig;
