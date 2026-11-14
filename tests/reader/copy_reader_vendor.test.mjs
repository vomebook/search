import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { gzipSync, gunzipSync } from "node:zlib";

// Fixed self-signed credentials for local tests only; public and not secret.
// SAN: example.test, localhost, 127.0.0.1; expires 2046-11-09 UTC.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/73saPTntjwNm
odAEUTt7sytZpJkW6Wc7si8xxVHLzHlD/LTwLl+dDAj6OW6O1Weomp5lTat9Huho
YtDT9CvMDoHJz5Kd6Q6vI6VdKoJOLk2vocK1XYYs0VoQPYe8JIiQZihqEAGMdMHC
UCVGBBVxgNLFTPu1PMkadCS3t4DeMF78Y23g8NgPXXJKqvSo12nxKfLpSS11kzjC
OswbmRT2hbArVQBfff9soJVhHsNAhr94XYke9/JRESRWCZ1lNW6E9mriLLscDmU+
VdMOqPOOvN8xQmbPaCc+aOHSaMETdEqeSy8ajq6GX6EZnGM1ELSrm/DrtuKUP/w8
PfzfgsARAgMBAAECggEABurQrF/VA4qs2XPO9/zdJdvi8yfeDD1CBxzTRm9Wqj+M
BkcoVo32obBnmWxc9OuxgO9+R7yJHT5c1g2WT5vkQTDWUh7iPpaB544jZ/cVJk//
ukBG8LuLuffwj5ccGiEp7879ZAyAIHRWcFRBnPie343q6rPtJWQTrlmjDMuhqsA8
5Q7KsgAi/6X5FakG0qd4qlaIEeYO5CWs7qrVPKzdiDjpPMGLgtmd53QzXOZblEjd
R0pYeLkkOqgA1TtLAcj9qJUP++wXMULlhsTo/DqOcK6XjRYsxn98w7AXfTPk8aKv
xRBMpLF4iZ43t5pQK2GjG8pJwi6xGIv8ZV+7lwn+zQKBgQD/Qr4aRmBf01M/v4t0
FXFyT9Rai4I1WsEr/xxx8tlE2DFtUWHhMZBhNgK5BmqHFNZexwKI/K25kX68JwEW
JtasqqqiknZBCxwjCo+b1KVYbvv4Hg7Ob05lhcAWbwTDxfghCYe87F3Y2n68eP8f
4oRkwztquPhF4UCkjaGTvga7zQKBgQDAfcmEsHMUNUAtAFS/vItVxos2Gnkt7rxv
qfQCsLonhdE+hl8CfIWMZOeHfqxqWJEuwUZcUXriJG1wdXiOWkC44oS7fw+DUnvC
y0BZTJRtnvpQLns+oXKBgqmNVQYg/qfhK3n7j6m97yQMIG0E/0YkWB3hF7LQHu66
vEfkIQz5VQKBgDvWZn/8TW1JObOw8DznJe/5HLuZBo4BV1U7+WwQ1LPZxkRtFnfW
yZSwN5UuFtzRmqsfFc4NBaCBpebvccbClgJmA5gWo1f+BbuFJ0MNZzFC2xg/25Ky
7vrHjs7zeXd3OgJsnIBCHIHQPnNqHcxYqlaAmbYb5D9lXWT1upHKswNlAoGAOar1
no0GTP2PFmxM94xS6gWrWzAfMcWeKo3uDohHnOOYRnUXLbWEhQUN4CfxG4MhK7K3
k5zNhcaICvMGhQ9A6KLkRQ/R4/PoI/mkc5xfs1+3eiISxja0CVzN0wuv5F6miOzv
hJALuF1WnVNxldeseeL0QKVK6tL5jnQtzYihTGkCgYEAy7gXvl5pnQf2e/p32JPq
CwXgphw1Aao9ACwzvYZt6mjQOrb+8FVmvlAHf2Mdp/Uh6SVz6FuzxZbCg15M0hnU
29AofQyG3KAq0v7eBN78vLbLu08UzbMVu1X0cRvlhDbD1ZlYUD2p+Z3Wjc05oMLD
57q9Hg+w7PmwDN4W7XPpick=
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUV+JfkJNDAADEo1ISGQwiagOQ0WYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTExNDE2MTEzMFoXDTQ2MTEw
OTE2MTEzMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAv+97Gj057Y8DZqHQBFE7e7MrWaSZFulnO7IvMcVRy8x5
Q/y08C5fnQwI+jlujtVnqJqeZU2rfR7oaGLQ0/QrzA6Byc+SnekOryOlXSqCTi5N
r6HCtV2GLNFaED2HvCSIkGYoahABjHTBwlAlRgQVcYDSxUz7tTzJGnQkt7eA3jBe
/GNt4PDYD11ySqr0qNdp8Sny6UktdZM4wjrMG5kU9oWwK1UAX33/bKCVYR7DQIa/
eF2JHvfyUREkVgmdZTVuhPZq4iy7HA5lPlXTDqjzjrzfMUJmz2gnPmjh0mjBE3RK
nksvGo6uhl+hGZxjNRC0q5vw67bilD/8PD3834LAEQIDAQABo30wezAdBgNVHQ4E
FgQUss6walah2y6xHk0DCPHWJodsy40wHwYDVR0jBBgwFoAUss6walah2y6xHk0D
CPHWJodsy40wDwYDVR0TAQH/BAUwAwEB/zAoBgNVHREEITAfggxleGFtcGxlLnRl
c3SCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAHFb0Y3zhzQ3s
VrJGrgX+3jR8hfQNn6cJgXlhEtgZcJvRjSDO3MM1UNVZD5CkXqUZy8OF5/3+eJNj
lYWxmA8PVgeHO/SF4cjPQdvYYTIvD4zqbSVVivgLsieTcSqrFPFyogPrOemW03WW
WBMGCce3D92r+B3KCGdwO70oDofFe7/Bi3soffQ0mVOKFA9otVV3QVxD2NEOo1Ym
vZ/NjRre6WexUaICRXtKNoPnFp4UdlCnZDDqnW7oTvaxKzVDczMYNgtbVtOZ6+EQ
eh06pGOd4MtLpXZSfos+FUnL4y6R1p6gRSacT6Y7ffwU3jqrE8y/4m5g0bjlEDz0
momx60pAKw==
-----END CERTIFICATE-----
`;
const script = resolve("scripts/build/copy_reader_vendor.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

function tarGzip(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function run(cwd, env, scriptPath = script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "out", "--foliate-output", "foliate"], { cwd, env });
    let stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`vendor subprocess timed out: ${stderr}`));
      else resolve({ code, stderr });
    });
  });
}

test("environment proxy, bounded concurrent downloads, bypass and hash failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-vendor-test-"));
  let server, proxy;
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  try {
    const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
    writeFileSync(key, TEST_KEY);
    writeFileSync(cert, TEST_CERT);
    const ruffleFiles = { "ruffle.js": "ruffle loader", "core.js": "ruffle core", "core.wasm": "wasm bytes", "LICENSE": "license" };
    const pdfFiles = { "cmaps/existing": "new pdf", "standard_fonts/font": "font", "wasm/decoder": "wasm" };
    const bodies = { "/archive": tarGzip(pdfFiles), "/ruffle": tarGzip({ ...ruffleFiles, "ignored.txt": "ignored" }), "/a": Buffer.from("a"), "/b": Buffer.from("b"), "/c": Buffer.from("c"), "/d": Buffer.from("d"), "/f": Buffer.from("f") };
    let active = 0, maxActive = 0, connects = 0, failureMode = false, limitMode = "";
    let limitRequests = 0, limitClosed = 0;
    const seen = [], blockedClosed = [];
    server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      if (limitMode) {
        if (req.url !== "/archive" && req.url !== "/slow") { res.end(bodies[req.url]); return; }
        limitRequests++;
        res.on("close", () => { limitClosed++; });
        if (limitMode === "declared") { res.writeHead(200, { "Content-Length": "2048" }); res.flushHeaders(); }
        else if (limitMode === "stream") { res.writeHead(200); res.write(Buffer.alloc(600)); res.write(Buffer.alloc(600)); }
        else if (req.url === "/archive") { res.writeHead(302, { Location: "/slow" }); setTimeout(() => res.end(), 100); }
        else {
          res.writeHead(200);
          const interval = setInterval(() => res.write("x"), 20);
          res.on("close", () => clearInterval(interval));
        }
        return;
      }
      if (failureMode) {
        seen.push(req.url);
        if (req.url === "/a") { res.writeHead(503); res.end(); }
        else if (req.url === "/archive") setTimeout(() => res.end(bodies[req.url]), 300);
        else { res.on("close", () => blockedClosed.push(req.url)); }
        return;
      }
      active++; maxActive = Math.max(active, maxActive);
      setTimeout(() => { active--; res.end(bodies[req.url]); }, 80);
    });
    server.on("connection", track);
    await listen(server);
    proxy = http.createServer();
    proxy.on("connection", track);
    proxy.on("connect", (_req, client, head) => {
      connects++;
      const upstream = net.connect(server.address().port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      track(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
    await listen(proxy);
    mkdirSync(join(dir, "static"));
    const resources = (host) => {
      const url = (name) => `https://${host}:${server.address().port}/${name}`;
      const entry = (name) => ({ url: url(name), sha256: hash(bodies[`/${name}`]), file: `${name}.js`, path: `vendor/${name}.js` });
      return { pdfArchive: entry("archive"), vendors: { a: entry("a"), b: entry("b"), c: entry("c"), d: entry("d") }, foliateVendors: { f: entry("f") }, ruffleArchive: { ...entry("ruffle"), directory: "vendor/ruffle/release-test", files: Object.keys(ruffleFiles) } };
    };
    const save = (value) => writeFileSync(join(dir, "static/reader-resources.js"), `module.exports = ${JSON.stringify(value)};`);
    const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, https_proxy: "", NO_PROXY: "", no_proxy: "", HTTP_PROXY: "", http_proxy: "" };
    save(resources("example.test"));
    let result = await run(dir, env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(connects > 0, "HTTPS traffic passed through the proxy");
    assert.ok(maxActive > 1 && maxActive <= 4, `concurrency: ${maxActive}`);
    assert.equal(readFileSync(join(dir, "foliate/f.js"), "utf8"), "f");
    for (const [file, content] of Object.entries(pdfFiles)) {
      assert.equal(readFileSync(join(dir, "out", file), "utf8"), content);
      assert.equal(readFileSync(join(dir, "foliate/pdfjs", file), "utf8"), content);
    }
    for (const [file, content] of Object.entries(ruffleFiles)) {
      assert.equal(readFileSync(join(dir, "out/ruffle/release-test", file), "utf8"), content);
    }
    assert.throws(() => readFileSync(join(dir, "out/ruffle/release-test/ignored.txt")), { code: "ENOENT" });

    const bad = resources("example.test");
    bad.vendors.d.sha256 = "0".repeat(64);
    save(bad);
    writeFileSync(join(dir, "out/a.js"), "old");
    writeFileSync(join(dir, "foliate/f.js"), "old foliate");
    writeFileSync(join(dir, "out/ruffle/release-test/ruffle.js"), "old ruffle");
    result = await run(dir, env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SHA-256/);
    assert.equal(readFileSync(join(dir, "out/a.js"), "utf8"), "old");
    assert.equal(readFileSync(join(dir, "foliate/f.js"), "utf8"), "old foliate");
    assert.equal(readFileSync(join(dir, "out/ruffle/release-test/ruffle.js"), "utf8"), "old ruffle");

    // The hash matches, but a later PDF tar entry is malformed after a valid file.
    const originalArchive = bodies["/archive"];
    const malformedTar = gunzipSync(tarGzip({ "cmaps/existing": "new pdf", "wasm/broken": "broken" }));
    malformedTar.write("not-octal!!\0", 1024 + 124);
    bodies["/archive"] = gzipSync(malformedTar);
    save(resources("example.test"));
    mkdirSync(join(dir, "out/cmaps"), { recursive: true });
    mkdirSync(join(dir, "foliate/pdfjs/cmaps"), { recursive: true });
    writeFileSync(join(dir, "out/cmaps/existing"), "old pdf");
    writeFileSync(join(dir, "foliate/pdfjs/cmaps/existing"), "old foliate pdf");
    result = await run(dir, env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Invalid PDF archive entry size/);
    assert.equal(readFileSync(join(dir, "out/cmaps/existing"), "utf8"), "old pdf");
    assert.equal(readFileSync(join(dir, "foliate/pdfjs/cmaps/existing"), "utf8"), "old foliate pdf");
    assert.equal(readFileSync(join(dir, "out/ruffle/release-test/ruffle.js"), "utf8"), "old ruffle");
    assert.equal(readFileSync(join(dir, "out/a.js"), "utf8"), "old");
    assert.equal(readFileSync(join(dir, "foliate/f.js"), "utf8"), "old foliate");
    // Each required group must contain a regular file, not just a directory or link.
    for (const group of ["cmaps", "standard_fonts", "wasm"]) {
      const files = Object.fromEntries(Object.entries(pdfFiles).filter(([name]) => !name.startsWith(group + "/")));
      for (const type of ["missing", "directory", "symlink"]) {
        const tar = gunzipSync(tarGzip({ ...files, ...(type === "missing" ? {} : { [group + (type === "directory" ? "/" : "/link")]: "" }) }));
        if (type === "symlink") tar[2048 + 156] = 50;
        bodies["/archive"] = gzipSync(tar);
        save(resources("example.test"));
        result = await run(dir, env);
        assert.notEqual(result.code, 0, `${group}: ${type}`);
        assert.match(result.stderr, type === "symlink" ? /Invalid PDF archive entry/ : new RegExp(`PDF archive missing required files: ${group}`));
        assert.equal(readFileSync(join(dir, "out/cmaps/existing"), "utf8"), "old pdf");
        assert.equal(readFileSync(join(dir, "foliate/pdfjs/cmaps/existing"), "utf8"), "old foliate pdf");
        assert.equal(readFileSync(join(dir, "out/ruffle/release-test/ruffle.js"), "utf8"), "old ruffle");
      }
    }
    bodies["/archive"] = originalArchive;

    // Exercise the production gzip cap on each archive with a reduced test-only limit.
    const archiveLimitScript = join(dir, "archive-limit.mjs");
    const archiveSource = readFileSync(script, "utf8");
    assert.match(archiveSource, /const MAX_ARCHIVE_BYTES = 128 \* 1024 \* 1024;/);
    writeFileSync(archiveLimitScript, archiveSource.replace("const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;", "const MAX_ARCHIVE_BYTES = 8192;"));
    for (const path of ["/archive", "/ruffle"]) {
      const original = bodies[path];
      bodies[path] = gzipSync(Buffer.alloc(16384));
      save(resources("example.test"));
      result = await run(dir, env, archiveLimitScript);
      assert.notEqual(result.code, 0, path);
      assert.match(result.stderr, /ERR_BUFFER_TOO_LARGE|larger than 8192 bytes/);
      assert.equal(readFileSync(join(dir, "out/cmaps/existing"), "utf8"), "old pdf");
      assert.equal(readFileSync(join(dir, "out/ruffle/release-test/ruffle.js"), "utf8"), "old ruffle");
      bodies[path] = original;
    }

    const blocked = resources("example.test");
    blocked.pdfArchive.sha256 = "0".repeat(64);
    save(blocked);
    failureMode = true;
    const started = Date.now();
    result = await run(dir, { ...env, HTTPS_PROXY: `http://proxy-user:proxy-secret@127.0.0.1:${proxy.address().port}` });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Resource 0 download failed: SHA-256 mismatch/);
    assert.doesNotMatch(result.stderr, /proxy-user|proxy-secret/);
    assert.ok(Date.now() - started < 3000, "failure interrupts blocked requests and retry delay");
    assert.deepEqual([...seen].sort(), ["/a", "/archive", "/b", "/c"]);
    assert.deepEqual([...blockedClosed].sort(), ["/b", "/c"]);
    failureMode = false;

    // Exercise production logic with smaller constants, without a runtime override in production.
    const fastScript = join(dir, "limits.mjs");
    const source = readFileSync(script, "utf8");
    assert.match(source, /const DOWNLOAD_DEADLINE_MS = 180000;/);
    assert.match(source, /const MAX_DOWNLOAD_BYTES = 128 \* 1024 \* 1024;/);
    writeFileSync(fastScript, source.replace("const DOWNLOAD_DEADLINE_MS = 180000;", "const DOWNLOAD_DEADLINE_MS = 200;")
      .replace("const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;", "const MAX_DOWNLOAD_BYTES = 1024;"));
    save(resources("example.test"));
    const secretEnv = { ...env, HTTPS_PROXY: `http://proxy-user:proxy-secret@127.0.0.1:${proxy.address().port}` };
    for (const mode of ["declared", "stream", "slow"]) {
      limitMode = mode; limitRequests = 0; limitClosed = 0;
      const start = Date.now();
      result = await run(dir, secretEnv, fastScript);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, mode === "slow" ? /Download deadline exceeded/ : /Download response too large/);
      assert.doesNotMatch(result.stderr, /proxy-user|proxy-secret|example\.test/);
      assert.ok(Date.now() - start < 12000, `${mode} retries are bounded`);
      assert.equal(limitRequests, mode === "slow" ? 8 : 4, `${mode} retries`);
      assert.equal(limitClosed, limitRequests, `${mode} responses closed`);
    }
    limitMode = "";

    save(resources("127.0.0.1"));
    const before = connects;
    result = await run(dir, { ...env, NO_PROXY: "127.0.0.1" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(connects, before, "NO_PROXY bypassed the proxy");
  } finally {
    for (const socket of sockets) socket.destroy();
    if (proxy) await close(proxy);
    if (server) await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
