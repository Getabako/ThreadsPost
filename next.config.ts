import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd()),
  // sharp はネイティブ部品を持つので、バンドルせずに node_modules から読む
  serverExternalPackages: ["sharp"],
  // 投稿の作法（public/docs）は実行時にリポジトリの場所から読むので、standalone に写さなくてよいものを外す
  outputFileTracingExcludes: {
    "/*": ["./test/**", "./ops/**", "./scripts/**", "./*.md", "./tsconfig.tsbuildinfo", "./.ashura/**"],
  },
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};

export default nextConfig;
