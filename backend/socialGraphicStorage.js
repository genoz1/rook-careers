// Completes the deterministic-graphic foundation: turns a rendered PNG
// buffer into a stable, validated, publicly-servable file. Buffer
// publishing itself is out of scope — this only produces the file and
// its public URL; nothing here talks to Buffer/Facebook/LinkedIn.

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
// Same lazy-loading reasoning as backend/socialGraphic.js — see that
// file's comment.
let sharp = null;
function getSharp() {
  if (!sharp) sharp = require("sharp");
  return sharp;
}

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SOCIAL_SUBDIR = path.join("social", "featured");
const PUBLIC_BASE_URL = "https://rookcareers.com";

// Conservative, well-known-safe limits — verify against Buffer's/each
// platform's current API docs before relying on these in production;
// they're intentionally well under commonly-cited real limits (a few
// MB and standard image-post dimensions) rather than pushed to the
// edge of what might technically be accepted.
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
// The composition is fixed-size again: top and bottom are locked
// assets of known dimensions, and the middle section is bounded to
// exactly 621px — so the final output is deterministically 1024x1536,
// unlike the previous free-height design. Exact match is correct here.
const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 1536;

// Only characters that are already guaranteed safe in a job_id (a
// UUID) or a content_version (a hex string) are ever allowed into a
// filename — anything else is rejected outright rather than escaped,
// closing off path traversal or injection via a malformed ID before
// it's ever used to build a filesystem path.
const SAFE_SEGMENT = /^[a-zA-Z0-9-]+$/;

function assertSafeSegment(value, label) {
  if (!value || !SAFE_SEGMENT.test(value)) {
    throw new Error(`Unsafe ${label} for a social graphic filename: ${JSON.stringify(value)}`);
  }
}

/**
 * Builds the filename/path/URL for a given job's graphic — pure,
 * deterministic, no filesystem access. Same job_id + content_version +
 * slot + date always produces the identical filename, which is
 * exactly what makes a retry idempotent rather than a "collision" to
 * avoid: re-rendering unchanged content is SUPPOSED to reuse the same
 * file, not create a new one next to it.
 */
function buildGraphicPaths({ dateStr, slot, jobId, contentVersion }) {
  assertSafeSegment(dateStr.replace(/-/g, ""), "date"); // dateStr itself contains hyphens (YYYY-MM-DD), checked without them
  assertSafeSegment(slot, "slot");
  assertSafeSegment(jobId, "job_id");
  assertSafeSegment(contentVersion, "content_version");

  const filename = `${slot}-${jobId}-${contentVersion}.png`;
  const relativeDir = path.join(SOCIAL_SUBDIR, dateStr);
  const relativePath = path.join(relativeDir, filename);
  const absoluteDir = path.join(PUBLIC_DIR, relativeDir);
  const absolutePath = path.join(PUBLIC_DIR, relativePath);
  const publicUrl = `${PUBLIC_BASE_URL}/${relativePath.split(path.sep).join("/")}`;

  return { filename, relativeDir, relativePath, absoluteDir, absolutePath, publicUrl };
}

/**
 * Validates a PNG buffer against real-world platform constraints
 * before it's ever written to disk or considered "ready." Fails
 * loudly rather than silently accepting a corrupt or oversized file.
 */
async function validateGraphicBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Graphic buffer is empty or not a real buffer");
  }
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`Graphic is ${buffer.length} bytes, over the ${MAX_FILE_SIZE_BYTES}-byte platform-safe limit`);
  }

  let metadata;
  try {
    metadata = await getSharp()(buffer).metadata();
  } catch (err) {
    throw new Error(`Graphic buffer is not a readable image: ${err.message}`);
  }
  if (metadata.format !== "png") {
    throw new Error(`Expected a PNG, got: ${metadata.format}`);
  }
  if (metadata.width !== EXPECTED_WIDTH || metadata.height !== EXPECTED_HEIGHT) {
    throw new Error(`Expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}, got ${metadata.width}x${metadata.height}`);
  }
  return metadata;
}

/**
 * Writes a validated PNG buffer to its stable public path and returns
 * the public HTTPS URL. Idempotent: if a file with this exact name
 * already exists (same job, same content_version, same slot/date), it
 * is reused as-is rather than re-rendered/re-written — this is the
 * "collision prevention" for a retry, since content_version changing
 * is what SHOULD produce a different filename, and an unchanged
 * version producing an unchanged file is correct, not a bug to guard
 * against with a random suffix.
 *
 * Uses a write-then-atomic-rename so a process crash mid-write can
 * never leave a truncated, partially-written file visible at the
 * public URL — readers only ever see the file after the rename
 * completes, which is atomic on the same filesystem.
 */
async function writeGraphicFile({ dateStr, slot, jobId, contentVersion, buffer }) {
  await validateGraphicBuffer(buffer);
  const paths = buildGraphicPaths({ dateStr, slot, jobId, contentVersion });

  try {
    await fs.access(paths.absolutePath);
    // Already exists — same job+slot+date+content_version means
    // identical intended content; reuse it rather than re-write.
    return { ...paths, reused: true };
  } catch {
    // Doesn't exist yet — proceed to render and write it.
  }

  await fs.mkdir(paths.absoluteDir, { recursive: true });
  const tempPath = path.join(paths.absoluteDir, `.tmp-${crypto.randomBytes(8).toString("hex")}-${paths.filename}`);
  await fs.writeFile(tempPath, buffer);
  await fs.rename(tempPath, paths.absolutePath); // atomic on the same filesystem/directory

  return { ...paths, reused: false };
}

/**
 * Confirms a written file is genuinely present, readable, and still
 * valid — a final proof step distinct from validateGraphicBuffer
 * above (which checks the in-memory buffer before writing); this
 * checks the actual file that landed on disk.
 */
async function verifyWrittenFile(absolutePath) {
  const stat = await fs.stat(absolutePath); // throws if missing
  if (stat.size === 0) throw new Error("Written graphic file is empty");
  const buffer = await fs.readFile(absolutePath);
  await validateGraphicBuffer(buffer); // re-validates the file as actually written, not just the buffer that was intended
  return stat;
}

/**
 * Retention/cleanup — deletes generated graphics older than
 * retentionDays (default 30, comfortably longer than "must remain
 * accessible until after Buffer has published it," which happens
 * within hours of generation, not weeks). A separate, manually-run
 * utility, same pattern as backend/archiveOldJobs.js — not triggered
 * automatically by rendering/writing a new graphic, so a slow cleanup
 * run can never block or slow down the actual posting path.
 */
async function cleanupOldGraphics({ retentionDays = 30, now = new Date() } = {}) {
  const socialDir = path.join(PUBLIC_DIR, SOCIAL_SUBDIR);
  let dateDirs;
  try {
    dateDirs = await fs.readdir(socialDir);
  } catch (err) {
    if (err.code === "ENOENT") return { deletedDirs: [] }; // nothing generated yet at all
    throw err;
  }

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deletedDirs = [];

  for (const dirName of dateDirs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dirName)) continue; // ignore anything that isn't one of our own YYYY-MM-DD directories
    const dirDate = new Date(`${dirName}T00:00:00Z`);
    if (dirDate < cutoff) {
      await fs.rm(path.join(socialDir, dirName), { recursive: true, force: true });
      deletedDirs.push(dirName);
    }
  }
  return { deletedDirs };
}

module.exports = {
  buildGraphicPaths,
  validateGraphicBuffer,
  writeGraphicFile,
  verifyWrittenFile,
  cleanupOldGraphics,
  MAX_FILE_SIZE_BYTES,
  EXPECTED_WIDTH,
  EXPECTED_HEIGHT,
};
