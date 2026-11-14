import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import http from "node:http";
import https from "node:https";
import net from "node:net";

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
const root = mkdtempSync(join(tmpdir(), "foliate-proxy-"));
after(() => rmSync(root, { recursive: true, force: true }));
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/build/fetch_foliate_reader.mjs");
const fixture = join(root, "fixture");
mkdirSync(join(fixture, "static"), { recursive: true });
mkdirSync(join(fixture, "scripts/build"), { recursive: true });
writeFileSync(join(fixture, "scripts/build/fetch.mjs"), readFileSync(script));
writeFileSync(join(fixture, "scripts/build/foliate-local.patch.b64"), Buffer.from(
  "diff --git a/ok.txt b/ok.txt\n@@ -1 +1 @@\n-before\n+after\n"
).toString("base64"));
// Build a one-file ustar archive without requiring an external tar executable.
const header = Buffer.alloc(512);
const contents = Buffer.from("before\n");
header.write("foliate-js-rev/ok.txt");
header.write("0000644\0", 100);
header.write("0000000\0", 108);
header.write("0000000\0", 116);
header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124);
header.write("00000000000\0", 136);
header.fill(32, 148, 156);
header[156] = 48;
header.write("ustar\0", 257);
header.write("00", 263);
header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
const archive = gzipSync(Buffer.concat([header, contents, Buffer.alloc(512 - contents.length), Buffer.alloc(1024)]));
writeFileSync(join(root, "key"), TEST_KEY);
writeFileSync(join(root, "cert"), TEST_CERT);
const hits = [], connections = [], sockets = new Set();
const server = https.createServer({ key: readFileSync(join(root, "key")), cert: readFileSync(join(root, "cert")) }, (req, res) => {
  hits.push(req.url);
  if (req.url === "/redirect") res.writeHead(302, { location: "/archive" }).end();
  else res.end(archive);
});
await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
const proxy = http.createServer();
proxy.on("connect", (req, client, head) => {
  connections.push({ url: req.url, auth: req.headers["proxy-authorization"] });
  const upstream = net.connect(server.address().port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { client.destroy(); upstream.destroy(); });
  }
});
await new Promise(resolvePromise => proxy.listen(0, "127.0.0.1", resolvePromise));
after(() => { for (const socket of sockets) socket.destroy(); server.close(); proxy.close(); });
const proxyUrl = `http://secretuser:secretpass@127.0.0.1:${proxy.address().port}`;
writeFileSync(join(fixture, "static/reader-resources.js"), `module.exports = ${JSON.stringify({
  foliateRevision: "rev", foliateArchive: { url: `https://localhost:${server.address().port}/redirect`, sha256: createHash("sha256").update(archive).digest("hex") }, foliateFiles: ["ok.txt"]
})};`);

async function run(env = {}, preload) {
  const args = preload ? ["--require", preload] : [];
  const child = spawn(process.execPath, [...args, join(fixture, "scripts/build/fetch.mjs"), join(fixture, "out")], {
    cwd: fixture, env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: join(root, "cert"), ...env }
  });
  let output = "";
  child.stdout.on("data", data => output += data);
  child.stderr.on("data", data => output += data);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const result = await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code, signal, output }));
  }).finally(() => clearTimeout(timer));
  assert.equal(result.signal, null, `child timed out: ${output}`);
  assert.doesNotMatch(output, /secretuser|secretpass|c2VjcmV0dXNlcjpzZWNyZXRwYXNz/);
  return result;
}

test("version boundaries reject before modifying output or contacting the network", async () => {
  for (const version of ["18.20.0", "22.20.0", "23.11.0", "24.4.0"]) {
    const preload = join(root, "version.cjs");
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});`);
    mkdirSync(join(fixture, "out"), { recursive: true });
    writeFileSync(join(fixture, "out/sentinel"), version);
    const previousHits = hits.length;
    const result = await run({ HTTPS_PROXY: proxyUrl }, preload);
    assert.equal(result.code, 1, version);
    assert.match(result.output, /Node\.js 22\.21\+, 24\.5\+, or later is required for proxy support/);
    assert.equal(readFileSync(join(fixture, "out/sentinel"), "utf8"), version);
    assert.equal(hits.length, previousHits);
  }
});

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsProxy = !(nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 21) || nodeMajor === 23 || (nodeMajor === 24 && nodeMinor < 5));

test("supported version boundaries allow proxy download, redirect and patch", { skip: !supportsProxy }, async () => {
  for (const version of ["22.21.0", "24.5.0", "25.0.0", "26.0.0"]) {
    const preload = join(root, "version.cjs");
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});`);
    hits.length = 0; connections.length = 0;
    const result = await run({ HTTPS_PROXY: proxyUrl }, preload);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(hits, ["/redirect", "/archive"]);
    assert.equal(connections.length, 2);
    assert.ok(connections.every(connection => connection.auth === "Basic c2VjcmV0dXNlcjpzZWNyZXRwYXNz"));
    assert.equal(readFileSync(join(fixture, "out/ok.txt"), "utf8"), "after\n");
  }
});

test("NO_PROXY bypasses the proxy and lowercase https_proxy works", { skip: !supportsProxy }, async () => {
  connections.length = 0;
  let result = await run({ HTTPS_PROXY: proxyUrl, NO_PROXY: "localhost" });
  assert.equal(result.code, 0, result.output);
  assert.equal(connections.length, 0);
  result = await run({ https_proxy: proxyUrl });
  assert.equal(result.code, 0, result.output);
  assert.equal(connections.length, 2);
});
