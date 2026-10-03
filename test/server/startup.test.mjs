import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("should bind the dev server and the production server only to 127.0.0.1", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.dev, /--hostname 127\.0\.0\.1/);
  const cli = fs.readFileSync(path.join(root, "bin/cli.mjs"), "utf8");
  assert.match(cli, /HOSTNAME: "127\.0\.0\.1"/);
  assert.match(cli, /listen\(p, "127\.0\.0\.1"/);
});
