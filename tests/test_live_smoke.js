const assert = require("assert");
const https = require("https");

const BASE_URL = (process.env.GITHUB_SEARCH_LIVE_BASE_URL || "").replace(/\/$/, "");
const API_BASE_URL = (process.env.GITHUB_SEARCH_API_BASE_URL || "https://voiceofml-search.hf.space").replace(/\/$/, "");
if (!BASE_URL) {
  console.log("github live smoke skipped: set GITHUB_SEARCH_LIVE_BASE_URL");
  process.exit(0);
}

async function requestJson(path, options = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await request(API_BASE_URL + path, options);
      if (response.statusCode >= 500 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
        continue;
      }
      assert.strictEqual(response.statusCode, 200, `${path}: ${response.statusCode}`);
      return JSON.parse(response.body.toString("utf8"));
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
  throw new Error("request retries exhausted");
}

function requestOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body || "";
    const requestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: Object.assign({}, options.headers || {}, body ? {
        "Content-Length": Buffer.byteLength(body),
      } : {}),
    };
    const req = https.request(requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => { chunks.push(chunk); });
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(45000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function request(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await requestOnce(url, options); }
    catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
  throw new Error("request retries exhausted");
}

(async () => {
  const page = await request(BASE_URL + "/search/");
  assert.strictEqual(page.statusCode, 200);
  const html = page.body.toString("utf8");
  assert.match(html, /VoiceOfML Search|search\/static\/app\.js/);

  for (const asset of ["static/style.css", "static/app.js", "static/index-worker.js", "sw.js", "manifest.json"]) {
    const response = await request(`${BASE_URL}/search/${asset}`);
    assert.strictEqual(response.statusCode, 200, asset);
    assert.ok(response.body.length > 0, `${asset}: empty response`);
  }
  for (const area of ["initial", "sidebar"]) {
    const response = await request(`${BASE_URL}/search/data/${area}/manifest.json`);
    assert.strictEqual(response.statusCode, 200);
    const manifest = JSON.parse(response.body.toString("utf8"));
    assert.strictEqual(manifest.version, 2);
    assert.ok(Array.isArray(manifest.urls) && manifest.urls.length > 0);
    assert.ok(manifest.urls.every((url) => url.startsWith(`/search/data/${area}/`)));
    const firstPayload = await request(BASE_URL + manifest.urls[0]);
    assert.strictEqual(firstPayload.statusCode, 200, manifest.urls[0]);
    JSON.parse(firstPayload.body.toString("utf8"));
  }
  for (const file of ["search_data.json.gz"]) {
    const response = await request(`${BASE_URL}/search/data/${file}`);
    assert.strictEqual(response.statusCode, 200, file);
    assert.ok(response.body.length > 2, `${file}: empty response`);
    if (response.headers["content-encoding"] !== "gzip") {
      assert.strictEqual(response.body[0], 0x1f, `${file}: gzip magic byte 1`);
      assert.strictEqual(response.body[1], 0x8b, `${file}: gzip magic byte 2`);
    }
  }

  const repos = await requestJson("/api/repos");
  assert.ok(Array.isArray(repos));
  const result = await requestJson("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: "README", page: 1, page_size: 5 }),
  });
  assert.strictEqual(result.page, 1);
  assert.strictEqual(result.page_size, 5);
  assert.ok(Number.isInteger(result.total));
  assert.ok(result.results.length <= 5);
  const extensions = await requestJson("/api/extensions");
  assert.ok(Array.isArray(extensions));
  console.log("github live smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
