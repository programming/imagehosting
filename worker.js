/**
 * Burn-after-reading image host on Cloudflare free tier
 *
 * Free tier budget (the bottleneck is KV writes: 1,000/day):
 *   Upload  = 2 KV writes  (counter + metadata)
 *   Burn    = 1 KV write   (delete key)
 *   Cleanup = 1 KV write   (delete key)
 *
 *   Hard cap: 400 uploads/day → 800 writes used, 200 buffer for burns/cleanup
 *
 * Bindings required (set in wrangler.toml / dashboard):
 *   KV namespace : IMAGE_META   (id → JSON metadata, counter:DATE → count)
 *   R2 bucket    : IMAGE_STORE  (id → raw image bytes)
 *   Secret var   : UPLOAD_SECRET (optional bearer token to restrict uploads)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const UPLOAD_LIMIT_PER_DAY = 400;       // max uploads before free KV writes exhausted
const MAX_FILE_SIZE_BYTES  = 5_242_880; // 5 MB per image
const TTL_MS               = 86_400_000; // 24 hours in ms
const ALLOWED_TYPES        = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// ─── Router ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin" : "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env) {
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
      return handleFetch(imageMatch[1], env);
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

  // ── Daily rate limit check (costs 1 KV read) ──
  const today        = utcDateString();
  const counterKey   = `counter:${today}`;
  const counterRaw   = await env.IMAGE_META.get(counterKey);
  const currentCount = counterRaw ? parseInt(counterRaw, 10) : 0;

  if (currentCount >= UPLOAD_LIMIT_PER_DAY) {
    return json({
      error: "Daily upload limit reached. Try again after midnight UTC.",
      limit: UPLOAD_LIMIT_PER_DAY,
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

  const file         = formData.get("file");
  const burnOnRead   = formData.get("burn") === "true"; // default false

  if (!file || typeof file === "string") {
    return json({ error: "Missing file field" }, 400);
  }

  // ── Validate type ──
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

  // ── Store in R2 ──
  const id = nanoid();
  await env.IMAGE_STORE.put(id, bytes, {
    httpMetadata: { contentType: file.type },
  });

  // ── Write metadata to KV (KV write #1) ──
  const meta = {
    contentType : file.type,
    sizeBytes   : bytes.byteLength,
    expiresAt   : Date.now() + TTL_MS,
    burnOnRead,
    burned      : false,
  };
  // KV TTL is in seconds; add a 1h grace window so cron cleanup runs first
  await env.IMAGE_META.put(id, JSON.stringify(meta), {
    expirationTtl: Math.ceil(TTL_MS / 1000) + 3600,
  });

  // ── Increment daily counter (KV write #2) ──
  await env.IMAGE_META.put(counterKey, String(currentCount + 1), {
    expirationTtl: 90000, // ~25 h, auto-expires so it never accumulates
  });

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

async function handleFetch(id, env) {
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

  // ── Burn: delete from R2 + KV immediately after read (KV write) ──
  if (meta.burnOnRead) {
    // Fire-and-forget deletion so we don't delay the response
    const ctx = { waitUntil: (p) => p }; // no ExecutionContext here, but delete is fast
    await deleteImage(id, env);
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
  // List all KV keys (excluding counter keys)
  let cursor;
  let deleted = 0;

  do {
    const result = await env.IMAGE_META.list({ cursor, prefix: "" });

    for (const key of result.keys) {
      // Skip counter keys
      if (key.name.startsWith("counter:")) continue;

      const metaRaw = await env.IMAGE_META.get(key.name);
      if (!metaRaw) continue;

      const meta = JSON.parse(metaRaw);
      if (Date.now() > meta.expiresAt || meta.burned) {
        await deleteImage(key.name, env);
        deleted++;
      }
    }

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
