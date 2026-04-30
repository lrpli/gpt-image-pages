import { createS3Client } from "./_s3.js";

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function contentTypeFromKey(key) {
  const ext = String(key || "")
    .split(".")
    .pop()
    ?.toLowerCase();

  if (ext === "jpeg" || ext === "jpg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "png") return "image/png";
  return "application/octet-stream";
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const password =
    context.request.headers.get("x-ui-password") ||
    url.searchParams.get("password") ||
    "";

  if (password !== context.env.UI_PASSWORD) {
    return textResponse("访问口令错误 (Unauthorized)", 401);
  }

  const key = String(url.searchParams.get("key") || "").trim();
  if (!key) {
    return textResponse("缺少 key 参数", 400);
  }

  // 仅允许读取图片目录，避免泄露 records 等其他对象。
  if (!key.startsWith("images/")) {
    return textResponse("非法 key 参数", 400);
  }

  const s3Result = createS3Client(context.env);
  if (!s3Result.ok) {
    return textResponse(`缺少或错误的 S3 配置: ${s3Result.error}`, 500);
  }

  try {
    const buffer = await s3Result.client.getBytes(key);
    if (!buffer) {
      return textResponse("图片不存在", 404);
    }
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFromKey(key),
        "Cache-Control": "private, max-age=60"
      }
    });
  } catch (error) {
    return textResponse(
      `读取图片失败: ${error.message || String(error)}`,
      500
    );
  }
}
