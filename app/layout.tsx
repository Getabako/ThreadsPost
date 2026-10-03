import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Threads Post",
  description: "Codex が Threads の投稿の下書き（本文・画像）を作るローカルツール（アシュラ秘奥義）",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
