// テスト用の一時データ置き場。macOS の一時フォルダの下に作るので、
// openDb には allowTempRootForTests: true を渡す。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @returns {{ root: string, cleanup(): void }} */
export function makeTempRoot(prefix = "threadspost-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
