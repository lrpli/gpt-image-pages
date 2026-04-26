function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function promptPreview(prompt) {
  const cleaned = String(prompt || "").trim().replace(/\s+/g, " ");
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 80)}...`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function imageFormatFromKey(key, fallback) {
  const ext = String(key || "").split(".").pop()?.toLowerCase();
  if (["png", "jpeg", "webp"].includes(ext)) return ext;
  return fallback || "png";
}

async function readRecord(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const password =
    context.request.headers.get("x-ui-password") ||
    url.searchParams.get("password") ||
    "";

  if (password !== context.env.UI_PASSWORD) {
    return jsonResponse({ error: "访问口令错误 (Unauthorized)" }, 401);
  }

  const IMAGES_BUCKET = context.env.IMAGES_BUCKET;
  if (!IMAGES_BUCKET || typeof IMAGES_BUCKET.list !== "function") {
    return jsonResponse({ error: "缺少 R2 绑定：IMAGES_BUCKET" }, 500);
  }

  const id = (url.searchParams.get("id") || "").trim();
  const includeImages = url.searchParams.get("includeImages") === "1";

  if (id) {
    const record = await readRecord(IMAGES_BUCKET, `records/${id}.json`);
    if (!record) {
      return jsonResponse({ error: "记录不存在" }, 404);
    }

    if (!includeImages) {
      return jsonResponse({
        record: {
          id: record.id,
          createdAt: record.createdAt,
          prompt: record.prompt,
          promptPreview: record.promptPreview || promptPreview(record.prompt),
          size: record.size,
          quality: record.quality,
          format: record.format,
          count:
            record.count ||
            (Array.isArray(record.imageKeys) ? record.imageKeys.length : 0)
        }
      });
    }

    const imageKeys = Array.isArray(record.imageKeys) ? record.imageKeys : [];
    const images = [];

    for (const key of imageKeys) {
      const imageObject = await IMAGES_BUCKET.get(key);
      if (!imageObject) continue;
      const buffer = await imageObject.arrayBuffer();
      images.push({
        key,
        format: imageFormatFromKey(key, record.format),
        b64: arrayBufferToBase64(buffer)
      });
    }

    return jsonResponse({
      record: {
        id: record.id,
        createdAt: record.createdAt,
        prompt: record.prompt,
        promptPreview: record.promptPreview || promptPreview(record.prompt),
        size: record.size,
        quality: record.quality,
        format: record.format,
        count: record.count || images.length,
        images
      }
    });
  }

  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 30);
  const listed = await IMAGES_BUCKET.list({ prefix: "records/", limit });
  const records = [];

  for (const objectInfo of listed.objects) {
    const record = await readRecord(IMAGES_BUCKET, objectInfo.key);
    if (!record) continue;

    records.push({
      id: record.id,
      createdAt: record.createdAt,
      promptPreview: record.promptPreview || promptPreview(record.prompt),
      size: record.size,
      quality: record.quality,
      format: record.format,
      count:
        record.count ||
        (Array.isArray(record.imageKeys) ? record.imageKeys.length : 0)
    });
  }

  records.sort((a, b) => {
    const t1 = Date.parse(a.createdAt || 0);
    const t2 = Date.parse(b.createdAt || 0);
    return t2 - t1;
  });

  return jsonResponse({
    records,
    truncated: listed.truncated,
    cursor: listed.cursor || null
  });
}
