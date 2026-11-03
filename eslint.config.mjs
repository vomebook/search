import globals from "globals";
import js from "@eslint/js";

// Project JS includes classic-script globals, ES modules, workers and Node
// tools. Model those environments separately; never lint vendored sources.

const rules = Object.fromEntries([
  "no-undef", "no-unreachable", "no-constant-binary-expression", "no-duplicate-case",
  "no-dupe-args", "no-dupe-keys", "no-unsafe-finally", "no-self-assign",
  "no-unexpected-multiline", "use-isnan", "valid-typeof"
].map(name => [name, "error"]));

export default [
  // ESLint's global ignore also prevents parsing third-party minified files.
  { ignores: ["**/vendor/**", "**/foliate-reader/**", "**/node_modules/**"] },
  {
    files: ["static/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.worker,
        module: "readonly", require: "readonly",
        ...Object.fromEntries(["VoiceOfMLReaderSecurity", "VoiceOfMLReader", "VoiceOfMLReaderResources",
          "VoiceOfMLReaderStore", "VoiceOfMLReaderChapters", "VoiceOfMLReaderVirtual", "VoiceOfMLReaderNavigation",
          "VoiceOfMLDownloadController", "VoiceOfMLSearchSession", "VoiceOfMLReaderRequests", "VoiceOfMLReaderRuntime",
          "VoiceOfMLReaderAdapters", "VoiceOfMLReaderScroll", "DOMPurify", "marked"]
          .map(name => [name, "readonly"])) }
    },
    rules: { ...js.configs.recommended.rules, ...rules,
      // Classic hosts/tests intentionally expose globals; security filters use
      // control-character regexes. These noisy rules are not zero-baselined yet.
      "no-unused-vars": "off", "no-useless-assignment": "off", "no-control-regex": "off",
      "no-useless-escape": "off", "preserve-caught-error": "off", "no-ex-assign": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }]
    }
  },
  { files: ["static/**/*.js"], languageOptions: { sourceType: "script" } },
  { files: ["static/app.js"], languageOptions: { globals: {
    bytesToDisplay: "readonly", fmtSizeUrl: "readonly", parseSizeStr: "readonly",
    buildRecordRelativePath: "readonly", encodeRecordPath: "readonly"
  } } },
  { files: ["static/**/*.mjs", "static/**/reader.js", "static/**/reader-pdf-text.js", "static/**/reader-book-text.js"],
    languageOptions: { sourceType: "module" } },
  { files: ["static/**/tts-client.js"], languageOptions: { globals: { CCRDSpeechPlan: "readonly", openPreview: "readonly", showToast: "readonly" } } },
  {
    files: ["{scripts,tests}/**/*.{js,mjs}"],
    languageOptions: { ecmaVersion: "latest", globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, ...rules,
      "no-unused-vars": "off", "no-useless-assignment": "off", "no-control-regex": "off",
      "no-useless-escape": "off", "preserve-caught-error": "off", "no-ex-assign": "off",
      "no-regex-spaces": "off", "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }]
    }
  },
  { files: ["{scripts,tests}/**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { files: ["tests/test_reader_djvu_only.mjs"], languageOptions: { globals: { VoiceOfMLReader: "readonly" } } },
  { files: ["tests/test_reader_djvu_png.mjs"], languageOptions: { globals: { VoiceOfMLReaderSecurity: "readonly" } } },
  { files: ["tests/test_reader_image_memory.mjs"], languageOptions: { globals: { window: "readonly" } } },
  { files: ["tests/test_reader_pdf_scroll_scheduling.mjs"], languageOptions: { globals: { document: "readonly" } } }
];
