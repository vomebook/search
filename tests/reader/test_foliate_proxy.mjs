import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";

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
mkdirSync(join(root, "tree/foliate-js-rev"), { recursive: true });
writeFileSync(join(root, "tree/foliate-js-rev/ok.txt"), "before\n");
execFileSync("tar", ["-czf", join(root, "archive.tgz"), "-C", join(root, "tree"), "foliate-js-rev"]);
const archive = readFileSync(join(root, "archive.tgz"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key"), "-out", join(root, "cert"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
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
