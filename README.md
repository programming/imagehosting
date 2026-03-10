# 🔥 Burnhost — free image hosting on Cloudflare

Burn-after-reading image hosting that runs entirely on Cloudflare's free tier.
Your only cost is domain registration (~$10–15/yr).

---

## Free tier budget

| Resource | Free allowance | Used per upload | Daily capacity |
|---|---|---|---|
| **KV writes** | 1,000 / day | 2 (meta + counter) | **400 uploads** ← bottleneck |
| KV reads | 100,000 / day | 1–2 | ~50,000 fetches |
| Workers requests | 100,000 / day | 1 per request | fine |
| R2 storage | 10 GB | image size | fine |
| R2 egress | **free** | — | free forever |

The worker hard-caps uploads at **400/day** and returns HTTP 429 when hit.

---

## Setup

### 1. Prerequisites
```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace
```bash
npx wrangler kv namespace create IMAGE_META
# Copy the printed ID into wrangler.toml → kv_namespaces[0].id
```

### 3. Create R2 bucket
```bash
npx wrangler r2 bucket create image-store
```

### 4. (Optional) Set upload secret
```bash
npx wrangler secret put UPLOAD_SECRET
# Paste your secret when prompted
```

### 5. Deploy
```bash
npx wrangler deploy
```

### 6. Add your domain
In the Cloudflare dashboard → Workers → your worker → Triggers → Custom Domains,
add `img.yourdomain.com`. Uncomment the `[[routes]]` block in wrangler.toml.

---

## API

### Check status
```
GET /
```
Returns current upload count, remaining quota, and reset time.

```json
{
  "status": "ok",
  "uploadsToday": 12,
  "uploadsRemaining": 388,
  "dailyLimit": 400,
  "resetsAt": "2024-01-16T00:00:00.000Z",
  "maxFileSizeMB": 5,
  "allowedTypes": ["image/jpeg","image/png","image/gif","image/webp"],
  "ttlHours": 24
}
```

---

### Upload an image
```
POST /upload
Content-Type: multipart/form-data

file   = <image file>          (required)
burn   = true | false          (optional, default: true)
```

If `UPLOAD_SECRET` is set:
```
Authorization: Bearer <your-secret>
```

**curl example:**
```bash
curl -X POST https://img.yourdomain.com/upload \
  -H "Authorization: Bearer mysecret" \
  -F "file=@photo.jpg" \
  -F "burn=true"
```

**Response 201:**
```json
{
  "id": "abc123...",
  "url": "https://img.yourdomain.com/image/abc123...",
  "burnOnRead": true,
  "expiresAt": "2024-01-17T10:30:00.000Z",
  "sizeBytes": 204800,
  "uploadsToday": 13,
  "dailyLimit": 400
}
```

**Error responses:**
| Status | Meaning |
|---|---|
| 400 | Missing or invalid form data |
| 401 | Wrong or missing UPLOAD_SECRET |
| 413 | File too large (> 5 MB) |
| 415 | File type not allowed |
| 429 | Daily upload limit reached |

---

### Fetch an image
```
GET /image/:id
```

- Returns the raw image bytes with appropriate `Content-Type`
- If `burnOnRead: true`, the image is **deleted from R2 + KV immediately** after serving
- Subsequent requests return **410 Gone**
- Expired images return **410 Gone**
- `Cache-Control: no-store` is set on every response so browsers never cache

---

## Burn-after-read flow

```
Upload ──► R2 (bytes) + KV (metadata: burned=false)
                │
Fetch ──────────┤
                ▼
            burned? ──yes──► 410 Gone
                │
               no
                │
            expired? ──yes──► delete + 410 Gone
                │
               no
                │
          serve image ──► delete R2 + KV ──► 410 on next request
```

---

## Staying within limits

If you want to increase the cap, upgrade to **Workers Paid ($5/mo)** which gives
unlimited KV writes. Everything else (R2 storage, egress) stays free.

To monitor usage:
```bash
npx wrangler kv get --namespace-id=<ID> "counter:$(date +%Y-%m-%d)"
```
