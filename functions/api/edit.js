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

export async function onRequestPost(context) {
  const password = context.request.headers.get("x-ui-password") || "";

  const UI_PASSWORD = context.env.UI_PASSWORD;
  const AZURE_ENDPOINT = context.env.AZURE_ENDPOINT;
  const AZURE_API_KEY = context.env.AZURE_API_KEY;
  const DEPLOYMENT = context.env.DEPLOYMENT || "gpt-image-2";
  const API_VERSION = context.env.API_VERSION || "2024-02-01";

  if (password !== UI_PASSWORD) {
    return jsonResponse({ error: "访问口令错误 (Unauthorized)" }, 401);
  }

  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    return jsonResponse({ error: "缺少 Azure 配置（AZURE_ENDPOINT/AZURE_API_KEY）" }, 500);
  }

  const s3Result = createS3Client(context.env);
  if (!s3Result.ok) {
    return jsonResponse({ error: `缺少或错误的 S3 配置: ${s3Result.error}` }, 500);
  }
  const s3 = s3Result.client;

  let formData;
  try {
    formData = await context.request.formData();
  } catch {
    return jsonResponse({ error: "请求体解析失败，需要 multipart/form-data" }, 400);
  }

  const prompt = String(formData.get("prompt") || "").trim();
  const size = String(formData.get("size") || "1024x1024");
  const quality = String(formData.get("quality") || "medium");
  const outputFormat = getOutputFormat(formData.get("format"));
  const n = clampInt(formData.get("n"), 1, 4, 1);
  const imageFile = formData.get("image");
  const maskFile = formData.get("mask");

  if (!prompt) return jsonResponse({ error: "prompt 不能为空" }, 400);
  if (!imageFile) return jsonResponse({ error: "image 文件不能为空" }, 400);

  // 转发给 Azure /images/edits（multipart）
  const azureForm = new FormData();
  azureForm.append("prompt", prompt);
  azureForm.append("size", size);
  azureForm.append("quality", quality);
  azureForm.append("output_format", outputFormat);
  azureForm.append("n", String(n));
  azureForm.append("image", imageFile);
  if (maskFile) azureForm.append("mask", maskFile);

  const url = `${AZURE_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${DEPLOYMENT}/images/edits?api-version=${API_VERSION}`;

  try {
    const azureResponse = await fetch(url, {
      method: "POST",
      headers: { "api-key": AZURE_API_KEY },
      body: azureForm
    });

    let data = {};
    try { data = await azureResponse.json(); } catch { data = {}; }

    if (!azureResponse.ok) {
      return jsonResponse({ error: data.error?.message || "Azure API 调用失败" }, 500);
    }

    const rawImages = Array.isArray(data.data)
      ? data.data.map((item) => item?.b64_json).filter((img) => typeof img === "string" && img.length > 0)
      : [];

    if (!rawImages.length) {
      return jsonResponse({ error: "Azure 返回里没有 b64_json 图片数据" }, 500);
    }

    const createdAt = new Date().toISOString();
    const recordId = `${createdAt.replace(/[-:.TZ]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
    const dayPrefix = createdAt.slice(0, 10);
    const mimeType = getMimeType(outputFormat);
    const imageKeys = new Array(rawImages.length);

    await Promise.all(
      rawImages.map(async (imageBase64, idx) => {
        const imageKey = `images/${dayPrefix}/${recordId}_${idx + 1}.${outputFormat}`;
        imageKeys[idx] = imageKey;
        await s3.putBytes(imageKey, base64ToUint8Array(imageBase64), mimeType);
      })
    );

    const record = {
      id: recordId,
      createdAt,
      prompt,
      promptPreview: toPromptPreview(prompt),
      size,
      quality,
      format: outputFormat,
      mode: "edit",
      status: "completed",
      count: imageKeys.length,
      imageKeys
    };

    await s3.putJson(`records/${recordId}.json`, record);

    return jsonResponse({
      ok: true,
      recordId,
      summary: {
        id: record.id,
        createdAt: record.createdAt,
        promptPreview: record.promptPreview,
        size: record.size,
        quality: record.quality,
        format: record.format,
        mode: "edit",
        status: "completed",
        count: record.count
      }
    });
  } catch (error) {
    return jsonResponse({ error: "服务器内部错误", details: error.message || String(error) }, 500);
  }
}
