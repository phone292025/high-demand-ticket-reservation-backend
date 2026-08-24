/**
 * Copies the PWA assets and stamps the service worker with a build id, so a new
 * deploy invalidates the old shell cache instead of leaving installed clients
 * on a stale bundle forever.
 *
 *   node scripts/copy-public.js            -> dist/public      (Node server)
 *   node scripts/copy-public.js <dir>      -> <dir>            (Vercel static)
 */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const sourceDir = path.join(repoRoot, "src", "public");
const targetDir = process.argv[2]
  ? path.resolve(repoRoot, process.argv[2])
  : path.join(repoRoot, "dist", "public");

function computeBuildId() {
  if (process.env.BUILD_ID) {
    return process.env.BUILD_ID;
  }

  // Content hash of the shell, so identical assets keep the same cache name.
  const hash = createHash("sha256");

  for (const fileName of fs.readdirSync(sourceDir).sort()) {
    if (fileName === "sw.js") {
      continue;
    }

    hash.update(fileName);
    hash.update(fs.readFileSync(path.join(sourceDir, fileName)));
  }

  return hash.digest("hex").slice(0, 12);
}

function main() {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });

  const buildId = computeBuildId();
  const serviceWorkerPath = path.join(targetDir, "sw.js");
  const serviceWorker = fs.readFileSync(serviceWorkerPath, "utf8");

  fs.writeFileSync(
    serviceWorkerPath,
    serviceWorker.replace(/__BUILD_ID__/g, buildId)
  );

  console.log(
    `Copied PWA assets to ${path.relative(repoRoot, targetDir)} (build id ${buildId})`
  );
}

main();
