import type { SecurityRoot } from '../../../typings/reader-security-strict';
declare const root: SecurityRoot;
const security = root.VoiceOfMLReaderSecurity!;
const raw = JSON.parse('{}');
const chapter = security.validateChapterManifest(raw);
const pdf = security.validatePdfPageManifest(raw);
const manifest = security.validatePdfOcrManifest(raw);
const page = security.validatePdfOcrPage(raw, 1);
const path: string | undefined = chapter.chapters[0]?.path;
const count: number = pdf.page_count;
const hash: string = manifest.source_sha256;
const text: string | undefined = page.blocks[0]?.t;
// @ts-expect-error Unvalidated fields are not any.
chapter.chapters[0].bytes.toFixed();
// @ts-expect-error Images are not validated for every codec.
pdf.images[0].sha256;
// @ts-expect-error Extra fields are not validated.
manifest.unchecked;
// @ts-expect-error Extra fields are not validated.
page.unchecked;
void [path, count, hash, text];
