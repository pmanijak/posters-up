import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: import.meta.dirname
  }
  /* config options here */
};

export default nextConfig;
