# ImageHost.ing

Minimal image hosting with burn-after-reading support. Images expire automatically after 24 hours.

Live at **[www.imagehost.ing](https://www.imagehost.ing)**

---

## API

Base URL: `https://api.imagehost.ing`

### Upload an image

```
POST /upload
Content-Type: multipart/form-data
```

| Field | Type | Required | Default |
|---|---|---|---|
| `file` | image file | yes | — |
| `burn` | `true` / `false` | no | `false` |

**curl:**
```bash
# Plain upload — persists for 24h
curl -X POST https://api.imagehost.ing/upload \
  -F "file=@photo.jpg"

# Burn after reading — deleted on first view
curl -X POST https://api.imagehost.ing/upload \
  -F "file=@photo.jpg" \
  -F "burn=true"
```

**Response `201`:**
```json
{
  "id": "abc123...",
  "url": "https://www.imagehost.ing/image/abc123....jpg",
  "burnOnRead": false,
  "expiresAt": "2024-01-17T10:30:00.000Z",
  "sizeBytes": 204800
}
```

**Error responses:**
| Status | Meaning |
|---|---|
| 400 | Missing or invalid form data |
| 401 | Wrong or missing `Authorization` header |
| 413 | File too large (max 5 MB) |
| 415 | Unsupported file type |
| 429 | Daily upload limit reached — try again tomorrow |

---

### Fetch an image

```
GET /image/:id
GET /image/:id.jpg
```

Returns the raw image. If `burnOnRead` was set on upload, the image is permanently deleted after this request. Subsequent requests return `410 Gone`.

---

### Status

```
GET https://api.imagehost.ing/
```

```json
{
  "status": "ok",
  "maxFileSizeMB": 5,
  "allowedTypes": ["image/jpeg", "image/png", "image/gif", "image/webp"],
  "ttlHours": 24
}
```

---

## Supported formats

JPEG, PNG, GIF, WEBP — max 5 MB per file.

## Limits

- All images expire and are permanently deleted after **24 hours**
- Burn-after-reading images are deleted immediately on first view
