// Media hosting via Supabase Storage — replaces container-local file
// hosting entirely. Direct instruction: container-local files are not
// reliable across DigitalOcean replicas (confirmed: the reported
// "text/html" content-type was the website's own SPA/route fallback
// answering for a file that simply didn't exist on the replica
// actually serving the request). Supabase Storage is external to any
// single app instance, so the object is reachable regardless of which
// replica rendered it or which replica (if any) later serves traffic.
//
// Uses the SAME server-side Supabase admin client the rest of the
// worker already has — no new credential, and the service-role key
// itself is never read, logged, or returned by anything here.

const BUCKET_NAME = "social-creatives";
const ALLOWED_MIME_TYPES = ["image/png"];
const SAFE_SEGMENT = /^[a-zA-Z0-9-]+$/;

function assertSafeSegment(value, label) {
  if (!value || !SAFE_SEGMENT.test(value)) {
    throw new Error(`Unsafe ${label} for a Storage object path: ${JSON.stringify(value)}`);
  }
}

/**
 * Creates the bucket if it doesn't already exist — idempotent, safe
 * to call on every run. Configured public (objects fetchable without
 * an Authorization header) and restricted to image/png only.
 */
async function ensureBucketExists(supabaseAdmin) {
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) throw new Error(`Could not list Storage buckets: ${listError.message}`);

  if ((buckets || []).some((b) => b.name === BUCKET_NAME)) return;

  const { error: createError } = await supabaseAdmin.storage.createBucket(BUCKET_NAME, {
    public: true,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
  });
  if (createError) {
    // A concurrent run creating the same bucket a moment earlier is
    // not a real failure — idempotent by design, not by luck.
    const alreadyExists = /already exists/i.test(createError.message || "");
    if (!alreadyExists) {
      throw new Error(`Could not create Storage bucket "${BUCKET_NAME}": ${createError.message}`);
    }
  }
}

/**
 * Object path — job ID, content version, and run slot only. Never the
 * employer name (this function never even receives it), matching the
 * same discipline as every other public-facing identifier in this
 * system. Rejects anything that isn't a safe, simple path segment.
 */
function buildObjectPath({ dateStr, slot, jobId, contentVersion }) {
  assertSafeSegment(dateStr.replace(/-/g, ""), "date");
  assertSafeSegment(slot, "slot");
  assertSafeSegment(jobId, "job_id");
  assertSafeSegment(contentVersion, "content_version");
  return `${dateStr}/${slot}-${jobId}-${contentVersion}.png`;
}

/**
 * Uploads the rendered PNG buffer to the social-creatives bucket and
 * returns its stable, non-expiring public URL (via Storage's own
 * getPublicUrl — never a signed/expiring URL). upsert: true makes a
 * retry of the identical job+slot+date+version idempotent — it
 * overwrites the same object with the same bytes rather than erroring.
 */
async function uploadGraphicToStorage(supabaseAdmin, { dateStr, slot, jobId, contentVersion, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Cannot upload an empty or invalid graphic buffer");
  }
  await ensureBucketExists(supabaseAdmin);
  const objectPath = buildObjectPath({ dateStr, slot, jobId, contentVersion });

  const { error: uploadError } = await supabaseAdmin.storage.from(BUCKET_NAME).upload(objectPath, buffer, {
    contentType: "image/png",
    upsert: true,
  });
  if (uploadError) {
    throw new Error(`Could not upload graphic to Supabase Storage: ${uploadError.message}`);
  }

  const { data: publicUrlData } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(objectPath);
  const publicUrl = publicUrlData?.publicUrl;
  if (!publicUrl) {
    throw new Error("Supabase Storage did not return a public URL for the uploaded object");
  }

  return { bucket: BUCKET_NAME, objectPath, publicUrl };
}

module.exports = { BUCKET_NAME, ALLOWED_MIME_TYPES, ensureBucketExists, buildObjectPath, uploadGraphicToStorage };
