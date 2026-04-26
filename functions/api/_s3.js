const encoder = new TextEncoder();
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function encodeRfc3986(input) {
  return encodeURIComponent(input).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function decodeXmlEntities(input) {
  return input
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function toUint8Array(body) {
  if (body === undefined || body === null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === "string") return encoder.encode(body);
  throw new Error("Unsupported body type for S3 request");
}

function toHex(uint8Array) {
  return Array.from(uint8Array)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bodyBytes) {
  if (!bodyBytes.length) return EMPTY_SHA256;
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes);
  return toHex(new Uint8Array(digest));
}

async function hmacRaw(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message)
  );
  return new Uint8Array(signature);
}

function buildCanonicalQuery(query) {
  const pairs = [];
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    pairs.push([encodeRfc3986(key), encodeRfc3986(String(value))]);
  });
  pairs.sort((a, b) => {
    if (a[0] === b[0]) return a[1].localeCompare(b[1]);
    return a[0].localeCompare(b[0]);
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function buildCanonicalUri(basePath, bucket, objectKey) {
  const parts = [];
  if (basePath) {
    parts.push(
      ...basePath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeRfc3986(segment))
    );
  }
  parts.push(encodeRfc3986(bucket));
  if (objectKey) {
    parts.push(
      ...objectKey
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeRfc3986(segment))
    );
  }
  return `/${parts.join("/")}`;
}

function parseListV2(xmlText) {
  const keyMatches = [...xmlText.matchAll(/<Key>([\s\S]*?)<\/Key>/g)];
  const keys = keyMatches.map((match) => decodeXmlEntities(match[1]));

  const isTruncatedMatch = xmlText.match(
    /<IsTruncated>([\s\S]*?)<\/IsTruncated>/
  );
  const nextTokenMatch = xmlText.match(
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/
  );

  return {
    keys,
    truncated:
      (isTruncatedMatch?.[1] || "").trim().toLowerCase() === "true",
    cursor: nextTokenMatch ? decodeXmlEntities(nextTokenMatch[1]) : null
  };
}

function requireEnvValue(value, keyName) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`缺少环境变量: ${keyName}`);
}

export function createS3Client(env) {
  try {
    const endpointRaw = requireEnvValue(
      env.R2_S3_ENDPOINT || env.S3_ENDPOINT,
      "R2_S3_ENDPOINT"
    );
    const bucket = requireEnvValue(
      env.R2_S3_BUCKET || env.S3_BUCKET,
      "R2_S3_BUCKET"
    );
    const accessKeyId = requireEnvValue(
      env.R2_S3_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID,
      "R2_S3_ACCESS_KEY_ID"
    );
    const secretAccessKey = requireEnvValue(
      env.R2_S3_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY,
      "R2_S3_SECRET_ACCESS_KEY"
    );
    const region = String(env.R2_S3_REGION || env.S3_REGION || "auto").trim();

    let endpoint;
    try {
      endpoint = new URL(endpointRaw);
    } catch {
      throw new Error("R2_S3_ENDPOINT 不是合法 URL");
    }

    const endpointPath = endpoint.pathname.replace(/\/+$/, "");

    async function s3Request(method, objectKey = "", options = {}) {
      const bodyBytes = toUint8Array(options.body);
      const payloadHash = await sha256Hex(bodyBytes);
      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
      const dateStamp = amzDate.slice(0, 8);
      const canonicalUri = buildCanonicalUri(endpointPath, bucket, objectKey);
      const canonicalQuery = buildCanonicalQuery(options.query || {});
      const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
      const canonicalHeaders =
        `host:${endpoint.host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`;

      const canonicalRequest =
        `${method.toUpperCase()}\n` +
        `${canonicalUri}\n` +
        `${canonicalQuery}\n` +
        `${canonicalHeaders}\n` +
        `${signedHeaders}\n` +
        `${payloadHash}`;

      const canonicalRequestHash = await sha256Hex(encoder.encode(canonicalRequest));
      const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
      const stringToSign =
        `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

      const kSecret = encoder.encode(`AWS4${secretAccessKey}`);
      const kDate = await hmacRaw(kSecret, dateStamp);
      const kRegion = await hmacRaw(kDate, region);
      const kService = await hmacRaw(kRegion, "s3");
      const kSigning = await hmacRaw(kService, "aws4_request");
      const signature = toHex(await hmacRaw(kSigning, stringToSign));

      const authorization =
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

      const requestHeaders = {
        host: endpoint.host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        Authorization: authorization,
        ...(options.headers || {})
      };

      const queryPart = canonicalQuery ? `?${canonicalQuery}` : "";
      const url = `${endpoint.origin}${canonicalUri}${queryPart}`;

      return fetch(url, {
        method,
        headers: requestHeaders,
        body: bodyBytes.length ? bodyBytes : undefined
      });
    }

    async function throwIfNotOk(response, action) {
      if (response.ok) return;
      const text = await response.text();
      throw new Error(`${action} 失败 (${response.status}): ${text || "unknown"}`);
    }

    return {
      ok: true,
      client: {
        async putBytes(key, bytes, contentType) {
          const response = await s3Request("PUT", key, {
            body: bytes,
            headers: contentType ? { "Content-Type": contentType } : {}
          });
          await throwIfNotOk(response, `S3 PUT ${key}`);
        },
        async putJson(key, data) {
          const response = await s3Request("PUT", key, {
            body: JSON.stringify(data),
            headers: { "Content-Type": "application/json" }
          });
          await throwIfNotOk(response, `S3 PUT ${key}`);
        },
        async getJson(key) {
          const response = await s3Request("GET", key);
          if (response.status === 404) return null;
          await throwIfNotOk(response, `S3 GET ${key}`);
          return response.json();
        },
        async getBytes(key) {
          const response = await s3Request("GET", key);
          if (response.status === 404) return null;
          await throwIfNotOk(response, `S3 GET ${key}`);
          return response.arrayBuffer();
        },
        async listKeys(prefix, maxKeys, cursor) {
          const response = await s3Request("GET", "", {
            query: {
              "list-type": 2,
              prefix,
              "max-keys": maxKeys,
              "continuation-token": cursor
            }
          });
          await throwIfNotOk(response, `S3 LIST ${prefix}`);
          const xmlText = await response.text();
          return parseListV2(xmlText);
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "S3 配置错误"
    };
  }
}
