function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestPost(context) {
  let requestBody = {};
  try {
    requestBody = await context.request.json();
  } catch {
    requestBody = {};
  }

  const password =
    context.request.headers.get("x-ui-password") || requestBody.password || "";

  if (password !== context.env.UI_PASSWORD) {
    return jsonResponse({ error: "访问口令错误 (Unauthorized)" }, 401);
  }

  return jsonResponse({ ok: true });
}
