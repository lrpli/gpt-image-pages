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
  const IMAGES_BUCKET = context.env.IMAGES_BUCKET;

  if (password !== UI_PASSWORD) {
    return jsonResponse({ error: "访问口令错误 (Unauthorized)" }, 401);
  }

  if (!prompt) {
    return jsonResponse({ error: "prompt 不能为空" }, 400);
  }

  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    return jsonResponse({ error: "缺少 Azure 配置（AZURE_ENDPOINT/AZURE_API_KEY）" }, 500);
  }

  if (!IMAGES_BUCKET || typeof IMAGES_BUCKET.put !== "function") {
    return jsonResponse({ error: "缺少 R2 绑定：IMAGES_BUCKET" }, 500);
  }

  const url = `${AZURE_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${DEPLOYMENT}/images/generations?api-version=${API_VERSION}`;
  const azurePayload = {
    prompt,
    size,
    quality,
    output_format: outputFormat,
    n
  };

  try {
    const azureResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_API_KEY
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
      return jsonResponse(
        { error: data.error?.message || "Azure API 调用失败" },
        500
      );
    }

    const rawImages = Array.isArray(data.data)
      ? data.data
          .map((item) => item?.b64_json)
          .filter((img) => typeof img === "string" && img.length > 0)
      : [];

    if (!rawImages.length) {
      return jsonResponse({ error: "Azure 返回里没有 b64_json 图片数据" }, 500);
    }

    const createdAt = new Date().toISOString();
    const recordId = `${createdAt.replace(/[-:.TZ]/g, "")}_${crypto
      .randomUUID()
      .slice(0, 8)}`;
    const dayPrefix = createdAt.slice(0, 10);
    const mimeType = getMimeType(outputFormat);
    const imageKeys = new Array(rawImages.length);

    await Promise.all(
      rawImages.map(async (imageBase64, idx) => {
        const imageKey = `images/${dayPrefix}/${recordId}_${idx + 1}.${outputFormat}`;
        imageKeys[idx] = imageKey;
        await IMAGES_BUCKET.put(imageKey, base64ToUint8Array(imageBase64), {
          httpMetadata: { contentType: mimeType }
        });
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
      count: imageKeys.length,
      imageKeys
    };

    await IMAGES_BUCKET.put(`records/${recordId}.json`, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" }
    });

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
        count: record.count
      }
    });
  } catch (error) {
    return jsonResponse(
      { error: "服务器内部错误", details: error.message || String(error) },
      500
    );
  }
}
