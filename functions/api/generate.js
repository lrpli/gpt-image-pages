export async function onRequestPost(context) {
  // 从请求体中解析参数
  const requestBody = await context.request.json();
  const { password, prompt, size, quality, format, n } = requestBody;
  const normalizedFormat = String(format || "png").toLowerCase();
  const outputFormat = ["png", "jpeg", "webp"].includes(normalizedFormat)
    ? normalizedFormat
    : "png";

  // 从 Cloudflare Pages 的环境变量中读取机密信息
  const UI_PASSWORD = context.env.UI_PASSWORD;
  const AZURE_ENDPOINT = context.env.AZURE_ENDPOINT; 
  const AZURE_API_KEY = context.env.AZURE_API_KEY;
  const DEPLOYMENT = context.env.DEPLOYMENT || "gpt-image-2";
  const API_VERSION = context.env.API_VERSION || "2024-02-01";

  // 1. 验证访问口令
  if (password !== UI_PASSWORD) {
    return new Response(JSON.stringify({ error: "访问口令错误 (Unauthorized)" }), { 
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 2. 构建 Azure 调用的 URL
  const url = `${AZURE_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${DEPLOYMENT}/images/generations?api-version=${API_VERSION}`;

  // 3. 构建发送给 Azure 的请求参数
  const azurePayload = {
    prompt: prompt,
    size: size,
    quality: quality,
    output_format: outputFormat,
    response_format: "b64_json", // 强制要求返回 Base64
    n: n || 1
  };

  try {
    // 4. 调用 Azure OpenAI API (原 PHP 使用 curl，这里使用原生的 fetch)
    const azureResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_API_KEY
      },
      body: JSON.stringify(azurePayload)
    });

    const data = await azureResponse.json();

    if (!azureResponse.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || "Azure API 调用失败" }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 5. 提取 Base64 编码的图片
    const images = data.data.map(item => item.b64_json);

    return new Response(JSON.stringify({ images: images }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: "服务器内部错误", details: error.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
