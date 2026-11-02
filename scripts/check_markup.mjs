import fs from "node:fs";
import path from "node:path";
import { parse } from "parse5";
import * as espree from "espree";
import postcss from "postcss";

// Parse own HTML/CSS as well as inline styles. External/vendor assets are
// checksum-checked by the Reader release gate, not treated as project source.
const root = path.resolve(process.argv[2] || ".");
const sources = path.join(root, "static");
let count = 0;
let errors = 0;

function report(file, detail) {
  errors++;
  console.error(`${path.relative(root, file)}: ${detail}`);
}

function css(file, text, label = "") {
  try {
    postcss.parse(text, { from: file });
    count++;
  } catch (error) {
    report(file, `${label}CSS ${error.line}:${error.column}: ${error.reason || error.message}`);
  }
}

function html(file) {
  const ids = new Set();
  const document = parse(fs.readFileSync(file, "utf8"), {
    sourceCodeLocationInfo: true,
    onParseError(error) { report(file, `HTML ${error.startLine}:${error.startCol}: ${error.code}`); }
  });
  count++;
  function visit(node) {
    const loc = node.sourceCodeLocation?.startTag;
    const label = loc ? `HTML ${loc.startLine}:${loc.startCol}: ` : "";
    for (const attribute of node.attrs || []) {
      if (attribute.name === "id" && attribute.value) {
        if (ids.has(attribute.value)) report(file, `${label}duplicate id ${JSON.stringify(attribute.value)}`);
        ids.add(attribute.value);
      }
      if (attribute.name === "style") css(file, `x{${attribute.value}}`, label);
    }
    if (node.tagName === "style") css(file,
      (node.childNodes || []).filter(child => child.nodeName === "#text").map(child => child.value).join(""), label);
    if (node.tagName === "script" && !(node.attrs || []).some(attribute => attribute.name === "src")) {
      const type = (node.attrs || []).find(attribute => attribute.name === "type")?.value.toLowerCase() || "";
      const text = (node.childNodes || []).filter(child => child.nodeName === "#text").map(child => child.value).join("");
      if (type === "application/ld+json") {
        try { JSON.parse(text); count++; }
        catch (error) { report(file, `${label}invalid JSON-LD: ${error.message}`); }
      } else if (!type || ["text/javascript", "application/javascript", "module"].includes(type)) {
        try { espree.parse(text, { ecmaVersion: "latest", sourceType: type === "module" ? "module" : "script" }); count++; }
        catch (error) { report(file, `${label}inline JavaScript ${error.lineNumber}:${error.column}: ${error.message}`); }
      } else report(file, `${label}unrecognized inline script type ${JSON.stringify(type)}`);
    }
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(document);
}

function visitDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "vendor" || entry.name === "foliate-reader") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visitDirectory(file);
    else if (entry.isFile() && entry.name.endsWith(".html")) html(file);
    else if (entry.isFile() && entry.name.endsWith(".css")) css(file, fs.readFileSync(file, "utf8"));
  }
}

if (!fs.statSync(sources).isDirectory()) throw new Error("Static source directory is missing");
visitDirectory(sources);
if (errors) process.exitCode = 1;
else console.log(`Markup syntax and unique IDs: ${count} HTML/CSS, inline script and JSON-LD units checked`);
