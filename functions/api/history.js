import { createS3Client } from "./_s3.js";

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

function normalizeStatus(status) {
  if (status === "processing" || status === "completed" || status === "failed") {
    return status;
  }
  return "completed";
}

function summarizeRecord(record) {
  const status = normalizeStatus(record.status);
  return {
    id: record.id,
    createdAt: record.createdAt,
    promptPreview: record.promptPreview || promptPreview(record.prompt),
    size: record.size,
    quality: record.quality,
    format: record.format,
    status,
    count:
      typeof record.count === "number"
        ? record.count
        : typeof record.requestedCount === "number"
          ? record.requestedCount
          : Array.isArray(record.imageKeys)
            ? record.imageKeys.length
            : 0,
    error: record.error || null
  };
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

async function readRecord(s3, key) {
  try {
    return await s3.getJson(key);
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

  const s3Result = createS3Client(context.env);
  if (!s3Result.ok) {
    return jsonResponse(
      { error: `缺少或错误的 S3 配置: ${s3Result.error}` },
      500
    );
  }
  const s3 = s3Result.client;

  const id = (url.searchParams.get("id") || "").trim();
  const includeImages = url.searchParams.get("includeImages") === "1";

  if (id) {
    const record = await readRecord(s3, `records/${id}.json`);
    if (!record) {
      return jsonResponse({ error: "记录不存在" }, 404);
    }
    const status = normalizeStatus(record.status);

    if (!includeImages) {
      return jsonResponse({
        record: {
          ...summarizeRecord(record),
          prompt: record.prompt,
          promptPreview: record.promptPreview || promptPreview(record.prompt)
        }
      });
    }

    const imageKeys = Array.isArray(record.imageKeys) ? record.imageKeys : [];
    const images = [];

    if (status === "completed") {
      for (const key of imageKeys) {
        const buffer = await s3.getBytes(key);
        if (!buffer) continue;
        images.push({
          key,
          format: imageFormatFromKey(key, record.format),
          b64: arrayBufferToBase64(buffer)
        });
      }
    }

    return jsonResponse({
      record: {
        ...summarizeRecord(record),
        prompt: record.prompt,
        promptPreview: record.promptPreview || promptPreview(record.prompt),
        images
      }
    });
  }

  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 30);
  let listed;
  try {
    listed = await s3.listKeys("records/", limit);
  } catch (error) {
    return jsonResponse(
      { error: `读取历史列表失败: ${error.message || String(error)}` },
      500
    );
  }
  const records = [];

  for (const key of listed.keys) {
    const record = await readRecord(s3, key);
    if (!record) continue;
    records.push(summarizeRecord(record));
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
