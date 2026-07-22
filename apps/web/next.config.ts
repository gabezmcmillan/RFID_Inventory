import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@rfid/domain"],
};

export default nextConfig;
