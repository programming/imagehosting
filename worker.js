/**
 * Burn-after-reading image host on Cloudflare free tier
 *
 * Free tier budget (the bottleneck is KV writes: 1,000/day):
 *   Upload  = 3 KV writes  (global counter + per-IP counter + metadata)
 *   Burn    = 1 KV write   (delete key)
 *   Cleanup = 1 KV write   (delete key)
 *
 *   Hard cap: ~266 uploads/day → 798 writes used, 202 buffer for burns/cleanup
 *
 * Bindings required (set in wrangler.toml / dashboard):
 *   KV namespace : IMAGE_META   (id → JSON metadata, counter:DATE → count, ip:DATE:IP → count)
 *   R2 bucket    : IMAGE_STORE  (id → raw image bytes)
 *   Secret var   : UPLOAD_SECRET (optional bearer token to restrict uploads)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const UPLOAD_LIMIT_PER_DAY    = 266;  // global daily cap (3 KV writes/upload)
const IP_UPLOAD_LIMIT_PER_DAY = 20;   // per-IP daily cap
const MAX_FILE_SIZE_BYTES     = 5_242_880; // 5 MB per image
const TTL_MS                  = 86_400_000; // 24 hours in ms
const ALLOWED_TYPES           = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// ─── Router ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /upload
    if (method === "POST" && url.pathname === "/upload") {
      return handleUpload(request, env);
    }

    // GET /image/:id
    const imageMatch = url.pathname.match(/^\/image\/([a-zA-Z0-9_-]{21})(?:\.[a-zA-Z]+)?$/);
    if (method === "GET" && imageMatch) {
      return handleFetch(imageMatch[1], env, ctx);
    }

    // GET / — simple status page
    if (method === "GET" && url.pathname === "/") {
      return handleStatus();
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },

  // Cron trigger: runs every hour to delete expired images
  async scheduled(_event, env) {
    await runCleanup(env);
  },
};

// ─── Upload ──────────────────────────────────────────────────────────────────

async function handleUpload(request, env) {
  // Optional: protect uploads with a bearer token
  if (env.UPLOAD_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.UPLOAD_SECRET}`) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  // ── Daily rate limit check (global + per-IP, 2 KV reads in parallel) ──
  const today      = utcDateString();
  const ip         = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const counterKey   = `counter:${today}`;
  const ipCounterKey = `ip:${today}:${ip}`;

  const [counterRaw, ipCounterRaw] = await Promise.all([
    env.IMAGE_META.get(counterKey),
    env.IMAGE_META.get(ipCounterKey),
  ]);
  const currentCount = counterRaw   ? parseInt(counterRaw,   10) : 0;
  const ipCount      = ipCounterRaw ? parseInt(ipCounterRaw, 10) : 0;

  if (currentCount >= UPLOAD_LIMIT_PER_DAY) {
    return json({
      error: "Daily upload limit reached. Try again after midnight UTC.",
      limit: UPLOAD_LIMIT_PER_DAY,
      resets: nextMidnightUTC(),
    }, 429);
  }

  if (ipCount >= IP_UPLOAD_LIMIT_PER_DAY) {
    return json({
      error: "Per-IP daily upload limit reached. Try again after midnight UTC.",
      limit: IP_UPLOAD_LIMIT_PER_DAY,
      resets: nextMidnightUTC(),
    }, 429);
  }

  // ── Parse multipart form ──
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  const file       = formData.get("file");
  const burnOnRead = formData.get("burn") === "true"; // default false

  if (!file || typeof file === "string") {
    return json({ error: "Missing file field" }, 400);
  }

  // ── Validate declared MIME type ──
  if (!ALLOWED_TYPES.has(file.type)) {
    return json({
      error: "Unsupported file type",
      allowed: [...ALLOWED_TYPES],
    }, 415);
  }

  // ── Validate size ──
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    return json({
      error: `File too large. Max ${MAX_FILE_SIZE_BYTES / 1_048_576} MB`,
    }, 413);
  }

  // ── Validate magic bytes (prevents MIME type spoofing) ──
  const detectedType = detectMimeType(bytes);
  if (!detectedType) {
    return json({ error: "File content does not match a supported image type" }, 415);
  }
  if (detectedType !== file.type) {
    return json({
      error: "Declared Content-Type does not match file content",
      detected: detectedType,
    }, 415);
  }

  // ── Store in R2 ──
  const id = nanoid();
  await env.IMAGE_STORE.put(id, bytes, {
    httpMetadata: { contentType: file.type },
  });

  // ── Write metadata to KV + increment both counters (3 KV writes in parallel) ──
  const meta = {
    contentType : file.type,
    sizeBytes   : bytes.byteLength,
    expiresAt   : Date.now() + TTL_MS,
    burnOnRead,
    burned      : false,
  };
  // KV TTL is in seconds; add a 1h grace window so cron cleanup runs first
  await Promise.all([
    env.IMAGE_META.put(id, JSON.stringify(meta), {
      expirationTtl: Math.ceil(TTL_MS / 1000) + 3600,
    }),
    env.IMAGE_META.put(counterKey, String(currentCount + 1), {
      expirationTtl: 90000, // ~25 h, auto-expires so it never accumulates
    }),
    env.IMAGE_META.put(ipCounterKey, String(ipCount + 1), {
      expirationTtl: 90000,
    }),
  ]);

  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[file.type] ?? "";
  const imageUrl = `https://imagehost.ing/${id}${ext ? "." + ext : ""}`;

  return json({
    id,
    url      : imageUrl,
    burnOnRead,
    expiresAt: new Date(meta.expiresAt).toISOString(),
    sizeBytes: bytes.byteLength,
  }, 201);
}

// ─── Fetch / Burn ─────────────────────────────────────────────────────────────

async function handleFetch(id, env, ctx) {
  // ── Read metadata (KV read) ──
  const metaRaw = await env.IMAGE_META.get(id);
  if (!metaRaw) {
    return new Response("Image not found", { status: 404 });
  }

  const meta = JSON.parse(metaRaw);

  // Already burned
  if (meta.burned) {
    return new Response("Image already viewed and deleted", { status: 410 });
  }

  // Expired (shouldn't normally reach here, but be safe)
  if (Date.now() > meta.expiresAt) {
    await deleteImage(id, env);
    return new Response("Image expired", { status: 410 });
  }

  // ── Fetch from R2 ──
  const object = await env.IMAGE_STORE.get(id);
  if (!object) {
    // R2 and KV out of sync — clean up KV
    await env.IMAGE_META.delete(id);
    return new Response("Image not found", { status: 404 });
  }

  const imageData = await object.arrayBuffer();

  // ── Burn: schedule deletion via waitUntil so it runs after the response is sent ──
  if (meta.burnOnRead) {
    ctx.waitUntil(deleteImage(id, env));
  }

  return new Response(imageData, {
    status: 200,
    headers: {
      "Content-Type"              : meta.contentType,
      "Content-Length"            : String(meta.sizeBytes),
      "Cache-Control"             : "no-store, no-cache, must-revalidate",
      "Pragma"                    : "no-cache",
      "Referrer-Policy"           : "no-referrer",
      "X-Burn-On-Read"            : String(meta.burnOnRead),
      "X-Expires-At"              : new Date(meta.expiresAt).toISOString(),
      ...CORS_HEADERS,
    },
  });
}

// ─── Status page ─────────────────────────────────────────────────────────────

async function handleStatus() {
  return json({
    status      : "ok",
    maxFileSizeMB: MAX_FILE_SIZE_BYTES / 1_048_576,
    allowedTypes : [...ALLOWED_TYPES],
    ttlHours     : TTL_MS / 3_600_000,
  });
}

// ─── Cron cleanup ────────────────────────────────────────────────────────────

async function runCleanup(env) {
  let cursor;

  do {
    const result = await env.IMAGE_META.list({ cursor });

    // Filter to image keys only (skip counter: and ip: keys)
    const imageKeys = result.keys.filter(
      (k) => !k.name.startsWith("counter:") && !k.name.startsWith("ip:")
    );

    // Fetch all metadata for this page in parallel
    const entries = await Promise.all(
      imageKeys.map(async (key) => {
        const metaRaw = await env.IMAGE_META.get(key.name);
        return { id: key.name, meta: metaRaw ? JSON.parse(metaRaw) : null };
      })
    );

    // Delete expired/burned images in parallel
    const toDelete = entries.filter(
      ({ meta }) => meta && (Date.now() > meta.expiresAt || meta.burned)
    );
    await Promise.all(toDelete.map(({ id }) => deleteImage(id, env)));

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // no logging — avoid writing request data to Cloudflare logs
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function deleteImage(id, env) {
  await Promise.all([
    env.IMAGE_STORE.delete(id),
    env.IMAGE_META.delete(id),
  ]);
}

/**
 * Detect MIME type from file magic bytes.
 * Returns the detected MIME type string, or null if unrecognised.
 */
function detectMimeType(buffer) {
  const b = new Uint8Array(buffer, 0, 12);

  // JPEG: FF D8 FF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return "image/png";

  // GIF: GIF87a (47 49 46 38 37 61) or GIF89a (47 49 46 38 39 61)
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";

  // WebP: RIFF????WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function utcDateString() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function nextMidnightUTC() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

/** URL-safe nano ID (21 chars, ~126 bits of entropy) */
function nanoid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => chars[b & 63]).join("");
}
