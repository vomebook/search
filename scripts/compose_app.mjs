import { readFileSync } from "node:fs";

// Keep the classic-script globals while making cached old HTML safe with a new app.
process.stdout.write("if (!globalThis.VoiceOfMLReaderNavigation) {\n" +
  readFileSync("static/reader-navigation.js", "utf8") + "\n}\n" +
  readFileSync("static/search-session.js", "utf8") + "\n" +
  readFileSync("static/download-controller.js", "utf8") + "\n" +
  readFileSync("static/app.js", "utf8"));
