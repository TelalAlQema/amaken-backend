/**
 * Syntax check every .js file in src/.
 *
 * The backend has no working linter (see docs/runbook.md), so this is the
 * static gate. `node --check` parses without executing, so it is safe to run
 * against a half-finished refactor.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TARGET_DIRS = ["src"];

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      collect(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const files = TARGET_DIRS.flatMap((dir) => collect(path.join(ROOT, dir)));
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    const detail = (err.stderr || Buffer.alloc(0)).toString().trim();
    failures.push({ file: path.relative(ROOT, file), detail });
  }
}

if (failures.length > 0) {
  for (const { file, detail } of failures) {
    console.error(`FAIL ${file}\n${detail}\n`);
  }
  console.error(`${failures.length} of ${files.length} files failed to parse.`);
  process.exit(1);
}

console.log(`OK — ${files.length} files parsed cleanly.`);
