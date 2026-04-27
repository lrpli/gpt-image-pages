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

function getPassword(request, requestBody) {
  return request.headers.get("x-ui-password") || requestBody.password || "";
}

function getOutputFormat(format) {
  const normalized = String(format || "png").toLowerCase();
  return ["png", "jpeg", "webp"].includes(normalized) ? normalized : "png";
}

function getMimeType(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function base64ToUint8Array(base64String) {
  const clean = base64String.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toPromptPreview(prompt) {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 80)}...`;
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
    promptPreview: record.promptPreview || toPromptPreview(record.prompt || ""),
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

async function runGenerationJob({
  s3,
  recordKey,
  baseRecord,
  url,
  azureApiKey,
  azurePayload,
  outputFormat,
  mimeType
}) {
  const azureResponse = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": azureApiKey
    },
    body: JSON.stringify(azurePayload)
  });

  let data = {};
  try {
    data = await azureResponse.json();
  } catch {
    data = {};
  }

  if (!azureResponse.ok) {
    throw new Error(data.error?.message || "Azure API 调用失败");
  }

  const rawImages = Array.isArray(data.data)
    ? data.data
        .map((item) => item?.b64_json)
        .filter((img) => typeof img === "string" && img.length > 0)
    : [];

  if (!rawImages.length) {
    throw new Error("Azure 返回里没有 b64_json 图片数据");
  }

  const dayPrefix = baseRecord.createdAt.slice(0, 10);
  const imageKeys = new Array(rawImages.length);

  await Promise.all(
    rawImages.map(async (imageBase64, idx) => {
      const imageKey = `images/${dayPrefix}/${baseRecord.id}_${idx + 1}.${outputFormat}`;
      imageKeys[idx] = imageKey;
      await s3.putBytes(imageKey, base64ToUint8Array(imageBase64), mimeType);
    })
  );

  const completedRecord = {
    ...baseRecord,
    status: "completed",
    completedAt: new Date().toISOString(),
    count: imageKeys.length,
    imageKeys,
    error: null
  };

  await s3.putJson(recordKey, completedRecord);
  return completedRecord;
}

export async function onRequestPost(context) {
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch {
    return jsonResponse({ error: "请求体必须是合法 JSON" }, 400);
  }

  const password = getPassword(context.request, requestBody);
  const prompt = String(requestBody.prompt || "").trim();
  const size = String(requestBody.size || "1024x1024");
  const quality = String(requestBody.quality || "medium");
  const outputFormat = getOutputFormat(requestBody.format);
  const n = clampInt(requestBody.n, 1, 8, 1);

  const UI_PASSWORD = context.env.UI_PASSWORD;
  const AZURE_ENDPOINT = context.env.AZURE_ENDPOINT;
  const AZURE_API_KEY = context.env.AZURE_API_KEY;
  const DEPLOYMENT = context.env.DEPLOYMENT || "gpt-image-2";
  const API_VERSION = context.env.API_VERSION || "2024-02-01";
  const s3Result = createS3Client(context.env);

  if (password !== UI_PASSWORD) {
    return jsonResponse({ error: "访问口令错误 (Unauthorized)" }, 401);
  }

  if (!prompt) {
    return jsonResponse({ error: "prompt 不能为空" }, 400);
  }

  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    return jsonResponse({ error: "缺少 Azure 配置（AZURE_ENDPOINT/AZURE_API_KEY）" }, 500);
  }

  if (!s3Result.ok) {
    return jsonResponse(
      { error: `缺少或错误的 S3 配置: ${s3Result.error}` },
      500
    );
  }
  const s3 = s3Result.client;

  const url = `${AZURE_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${DEPLOYMENT}/images/generations?api-version=${API_VERSION}`;
  const azurePayload = {
    prompt,
    size,
    quality,
    output_format: outputFormat,
    n
  };
  let persistedRecord = null;
  let persistedRecordKey = null;

  try {
    const createdAt = new Date().toISOString();
    const recordId = `${createdAt.replace(/[-:.TZ]/g, "")}_${crypto
      .randomUUID()
      .slice(0, 8)}`;
    const mimeType = getMimeType(outputFormat);
    const recordKey = `records/${recordId}.json`;
    const record = {
      id: recordId,
      createdAt,
      queuedAt: createdAt,
      prompt,
      promptPreview: toPromptPreview(prompt),
      size,
      quality,
      format: outputFormat,
      status: "processing",
      requestedCount: n,
      count: n,
      imageKeys: [],
      error: null
    };
    persistedRecord = record;
    persistedRecordKey = recordKey;

    await s3.putJson(recordKey, record);

    // 用 waitUntil 在后台执行生成任务，立即返回 processing 状态
    // 避免 Cloudflare Worker 请求超时（图片生成通常超过30s）
    context.waitUntil(
      runGenerationJob({
        s3,
        recordKey,
        baseRecord: record,
        url,
        azureApiKey: AZURE_API_KEY,
        azurePayload,
        outputFormat,
        mimeType
      }).catch(async (error) => {
        try {
          const failedRecord = {
            ...record,
            status: "failed",
            failedAt: new Date().toISOString(),
            count: 0,
            imageKeys: [],
            error: error?.message || String(error)
          };
          await s3.putJson(recordKey, failedRecord);
        } catch {
          // 忽略二次写失败
        }
      })
    );

    return jsonResponse({
      ok: true,
      recordId,
      summary: summarizeRecord(record)
    });
  } catch (error) {
    // 若任务已入队(写了processing记录)但后续失败，尽量回写失败状态
    try {
      if (persistedRecord && persistedRecordKey) {
        const failedRecord = {
          ...persistedRecord,
          status: "failed",
          failedAt: new Date().toISOString(),
          count: 0,
          imageKeys: [],
          error: error?.message || String(error)
        };
        await s3.putJson(persistedRecordKey, failedRecord);
      }
    } catch {
      // 忽略二次写失败，优先返回原始错误
    }
    return jsonResponse(
      { error: "服务器内部错误", details: error.message || String(error) },
      500
    );
  }
}
