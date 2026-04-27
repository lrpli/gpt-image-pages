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

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function buildEditCandidates(endpoint, deployments, apiVersions) {
  const base = endpoint.replace(/\/$/, "");
  const candidates = [];
  for (const deployment of deployments) {
    for (const apiVersion of apiVersions) {
      candidates.push({
        deployment,
        apiVersion,
        url: `${base}/openai/deployments/${deployment}/images/edits?api-version=${encodeURIComponent(apiVersion)}`
      });
    }
  }
  return candidates;
}

export async function onRequestPost(context) {
  const password = context.request.headers.get("x-ui-password") || "";

  const UI_PASSWORD = context.env.UI_PASSWORD;
  const AZURE_ENDPOINT = context.env.AZURE_ENDPOINT;
  const AZURE_API_KEY = context.env.AZURE_API_KEY;
  const DEPLOYMENT = context.env.DEPLOYMENT || "gpt-image-2";
  const EDIT_DEPLOYMENT = context.env.EDIT_DEPLOYMENT || DEPLOYMENT;
  const API_VERSION = context.env.API_VERSION || "2024-02-01";
  const EDIT_API_VERSION = context.env.EDIT_API_VERSION || API_VERSION;

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

  function createAzureForm() {
    const azureForm = new FormData();
    azureForm.append("prompt", prompt);
    azureForm.append("size", size);
    azureForm.append("quality", quality);
    azureForm.append("output_format", outputFormat);
    azureForm.append("n", String(n));
    azureForm.append("image", imageFile);
    if (maskFile) azureForm.append("mask", maskFile);
    return azureForm;
  }

  const deploymentCandidates = uniqueStrings([EDIT_DEPLOYMENT, DEPLOYMENT]);
  const versionCandidates = uniqueStrings([EDIT_API_VERSION, API_VERSION, "2025-04-01-preview"]);
  const azureCandidates = buildEditCandidates(AZURE_ENDPOINT, deploymentCandidates, versionCandidates);

  try {
    let data = null;
    let lastErrorMessage = "";
    let triedAnyCandidate = false;

    for (const candidate of azureCandidates) {
      triedAnyCandidate = true;

      const azureResponse = await fetch(candidate.url, {
        method: "POST",
        headers: { "api-key": AZURE_API_KEY },
        body: createAzureForm()
      });

      let responseData = {};
      try {
        responseData = await azureResponse.json();
      } catch {
        responseData = {};
      }

      if (azureResponse.ok) {
        data = responseData;
        break;
      }

      const message = String(responseData.error?.message || "").trim();
      lastErrorMessage =
        message ||
        `Azure API 调用失败 (${azureResponse.status}) [deployment=${candidate.deployment}, apiVersion=${candidate.apiVersion}]`;

      const isResourceNotFound =
        azureResponse.status === 404 || /resource not found/i.test(message);

      if (!isResourceNotFound) {
        return jsonResponse({ error: lastErrorMessage }, 500);
      }
    }

    if (!data) {
      if (!triedAnyCandidate) {
        return jsonResponse({ error: "缺少可用的编辑请求候选配置" }, 500);
      }

      const triedList = azureCandidates
        .map((item) => `${item.deployment}@${item.apiVersion}`)
        .join(", ");
      const fallbackMessage = lastErrorMessage || "Resource not found";
      return jsonResponse(
        {
          error:
            `${fallbackMessage}。` +
            `已尝试: ${triedList}。` +
            "请检查 EDIT_DEPLOYMENT / DEPLOYMENT 与 EDIT_API_VERSION / API_VERSION 是否正确，且当前部署支持 images/edits。"
        },
        500
      );
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
