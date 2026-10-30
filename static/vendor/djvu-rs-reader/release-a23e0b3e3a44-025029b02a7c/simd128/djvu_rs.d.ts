/* tslint:disable */
/* eslint-disable */

/**
 * A parsed DjVu document.
 *
 * Created from raw bytes via [`WasmDocument::from_bytes`].
 */
export class WasmDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse a DjVu document from a byte buffer.
     *
     * The buffer is moved into a shared backing store and bundled pages
     * materialize lazily on first access (#609) — the same owned-bytes path
     * as the native `Document::from_bytes` (LAZY_PAGE_CONSTRUCT), instead of
     * the eager parser that copied every page at open time. The JS-visible
     * signature is unchanged (pass a `Uint8Array`); the JS→wasm transfer is
     * the single unavoidable copy.
     *
     * Throws a JavaScript `Error` if the bytes are not a valid DjVu file.
     */
    static from_bytes(data: Uint8Array): WasmDocument;
    /**
     * Total number of pages in the document.
     */
    page_count(): number;
    /**
     * Return a handle to page `index` (0-based).
     *
     * Throws if `index >= page_count()`.
     */
    page(index: number): WasmPage;
    reader_cache_bytes(): number;
    /**
     * Reader integration, 2026-10-28: validate native page and input bounds
     * before constructing a document, and bound the shared decoded cache.
     * The cache limit does not include the source, in-progress render or the
     * WebAssembly linear-memory high-water mark.
     */
    static reader_open(data: Uint8Array, cache_bytes: number): WasmDocument;
    /**
     * Reader integration: preserve the original embedded NAVM hierarchy.
     */
    reader_outline(): Array<any>;
    /**
     * Return page component IDs in page order to resolve named NAVM links.
     */
    reader_page_ids(): Array<any>;
    /**
     * Release least-recently-used decoded layers after a finished render.
     * This does not shrink WASM linear memory or account for in-flight pages.
     */
    reader_trim_cache(max_bytes: number): number;
    /**
     * Render a contiguous batch of pages at `target_dpi`, returning one
     * [`WasmPixmap`] per page in input order (#610).
     *
     * With the opt-in `wasm-threads` build (rayon Web-Worker pool via
     * `initThreadPool`), pages render concurrently as coarse one-page tasks —
     * the threading shape WASM_THREADS measured as viable (fine-grained
     * compositor parallelism regressed ~9× and stays disabled). Without the
     * pool the batch renders sequentially with identical results.
     *
     * Memory is bounded by the caller-chosen batch size: `count` full-size
     * pixmaps are alive at once. Failed pages yield an error for the whole
     * batch (all-or-nothing keeps the ordering contract simple).
     */
    render_pages_batch(target_dpi: number, start: number, count: number): WasmPixmap[];
}

/**
 * Lazily opened DjVu document driven by a JS range-fetch callback (#588).
 *
 * `open(totalLen, fetch)` indexes the document from ~one block of head
 * bytes; each `page(i)` / `render_page(i, dpi)` then fetches only that
 * page's byte range (plus any shared dictionary it references, cached).
 * The `fetch` callback receives `(offset, len)` and must resolve to a
 * `Uint8Array` of exactly `len` bytes — e.g. an HTTP `Range` request:
 *
 * ```js
 * const doc = await WasmLazyDocument.open(totalLen, async (offset, len) => {
 *   const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + len - 1}` } });
 *   return new Uint8Array(await r.arrayBuffer());
 * });
 * ```
 */
export class WasmLazyDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Index a document of `total_len` bytes through the `fetch` callback.
     */
    static open(total_len: number, fetch: Function, cache_bytes: number): Promise<WasmLazyDocument>;
    /**
     * Number of pages in the index.
     */
    page_count(): number;
    /**
     * Fetch (or reuse) page `index` and return `[width_px, height_px, dpi]`
     * at the page's native resolution.
     */
    page_info(index: number): Promise<Uint32Array>;
    /**
     * Parsed page count, visible raw page chunks and decoded cache only.
     * Not WASM high-water, dictionaries, canvas or browser total memory.
     */
    reader_cache_stats(): Promise<Float64Array>;
    /**
     * Reader-oriented geometry after applying the source INFO rotation.
     */
    reader_geometry(index: number): Promise<Uint32Array>;
    /**
     * Original hierarchical bookmarks; requested only when the UI asks.
     */
    reader_outline(): Promise<Array<any>>;
    reader_outline_needs_full_source(): boolean;
    /**
     * Original page identifiers used to resolve named NAVM destinations.
     */
    reader_page_ids(): Array<any>;
    /**
     * Isolated Reader experiment: decode a complete native page strictly.
     * No progressive preview, no output on a failed or unsupported layer.
     */
    reader_render_strict(index: number): Promise<WasmPixmap>;
    /**
     * Embedded text in the same source order as the eager Reader path.
     */
    reader_text(index: number): Promise<string | undefined>;
    /**
     * Leaf text zones transformed to the native rotated page geometry.
     */
    reader_text_zones_json(index: number): Promise<string | undefined>;
    /**
     * Fetch (or reuse) page `index` and render it at `target_dpi` into a
     * [`WasmPixmap`] (zero-copy `view()` / owned `to_bytes()`).
     */
    render_page(index: number, target_dpi: number): Promise<WasmPixmap>;
    /**
     * Progressive variant of [`render_page`](Self::render_page): decode at
     * most `chunk_n` BG44 refinement chunks (0 ⇒ mask/foreground only) for
     * a fast blurry-to-sharp first paint. Fetching is unchanged (the page
     * range is one transfer); only decode work is bounded.
     */
    render_page_progressive(index: number, target_dpi: number, chunk_n: number): Promise<WasmPixmap>;
}

/**
 * Lazily opened indirect DjVu document: the index file lists the pages,
 * and each page lives in its own file.
 *
 * `open(indexBytes, resolve)` reads only the directory. Each
 * `render_page(i, dpi)` then asks `resolve` for that page file, and for a
 * shared symbol dictionary the page includes (fetched once, cached).
 * `resolve` receives `(name, kind)` — the file name from the index and
 * `"page"` or `"shared"` — and resolves to the file's bytes as a
 * `Uint8Array`, or to `null` when the file does not exist:
 *
 * ```js
 * const base = new URL("book/", location.href);
 * const index = new Uint8Array(await (await fetch(new URL("index.djvu", base))).arrayBuffer());
 * const doc = WasmLazyIndirectDocument.open(index, async (name, kind) => {
 *   const r = await fetch(new URL(name, base));
 *   return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
 * });
 * ```
 *
 * A bundled or single-page file is not an index: open it with
 * [`WasmLazyDocument`].
 */
export class WasmLazyIndirectDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Read the directory of an indirect index file. No component is
     * fetched here.
     */
    static open(index: Uint8Array, resolve: Function): WasmLazyIndirectDocument;
    /**
     * Number of pages in the index.
     */
    page_count(): number;
    /**
     * Fetch (or reuse) page `index` and return `[width_px, height_px, dpi]`
     * at the page's native resolution.
     */
    page_info(index: number): Promise<Uint32Array>;
    /**
     * The file name of page `index`, as passed to `resolve`, or
     * `undefined` when `index` is out of range.
     */
    page_name(index: number): string | undefined;
    /**
     * Fetch (or reuse) page `index` and render it at `target_dpi` into a
     * [`WasmPixmap`].
     */
    render_page(index: number, target_dpi: number): Promise<WasmPixmap>;
    /**
     * Progressive variant of [`render_page`](Self::render_page): decode at
     * most `chunk_n` BG44 refinement chunks (0 ⇒ mask/foreground only).
     */
    render_page_progressive(index: number, target_dpi: number, chunk_n: number): Promise<WasmPixmap>;
}

/**
 * A single page within a [`WasmDocument`].
 */
export class WasmPage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Number of BG44 background chunks on this page.
     *
     * Determines how many refinement steps are available via
     * [`render_progressive`](Self::render_progressive). Returns `0` for bilevel-only pages.
     */
    bg44_chunk_count(): number;
    /**
     * Native DPI stored in the INFO chunk.
     */
    dpi(): number;
    /**
     * Output height in pixels when rendered at `target_dpi` (after the
     * page's INFO rotation).
     */
    height_at(target_dpi: number): number;
    /**
     * A complete native page: never return permissive partial decoding.
     */
    reader_render_strict(): Uint8ClampedArray;
    /**
     * Reader integration: report original INFO rotation, clockwise degrees.
     */
    reader_rotation(): number;
    /**
     * Fast coarse render — decodes only the first BG44 chunk (~5 ms for a
     * typical color page).
     *
     * @deprecated Use `render_request` with `set_coarse()`.
     *
     * Returns `undefined` for bilevel-only pages (no BG44 data); use
     * [`render`](Self::render) for those.  For color pages the result is a blurry but
     * instantly visible preview; call [`render_progressive`](Self::render_progressive) or [`render`](Self::render)
     * on a Web Worker to produce the final image.
     *
     * Throws on decode error.
     */
    render_coarse(target_dpi: number): Uint8ClampedArray | undefined;
    /**
     * Render the page at `target_dpi` and return raw RGBA pixels
     * (`Uint8ClampedArray`, suitable for `new ImageData(pixels, w, h)`).
     *
     * Throws on decode error.
     */
    render(target_dpi: number): Uint8ClampedArray;
    /**
     * Render into a caller-owned [`WasmPixmap`], reusing its Rust-side
     * allocation (#611).
     *
     * @deprecated Use `render_request(new WasmRenderRequest(target_dpi), out)`.
     */
    render_into_pixmap(target_dpi: number, out: WasmPixmap): void;
    /**
     * Progressive render — decodes BG44 chunks 0..=`chunk_n` plus all
     * foreground layers (JB2 mask, text).
     *
     * @deprecated Use `render_request` with `set_step(chunk_n)`.
     *
     * `chunk_n = 0` is equivalent to [`render_coarse`](Self::render_coarse) but also composites
     * the mask. Each subsequent call with `chunk_n += 1` adds one more
     * wavelet refinement pass. After the last chunk the result is identical
     * to [`render`](Self::render).
     *
     * Use [`bg44_chunk_count`](Self::bg44_chunk_count) to find the maximum valid `chunk_n`
     * (`bg44_chunk_count() - 1`).
     *
     * Throws on decode error or if `chunk_n` is out of range.
     */
    render_progressive(target_dpi: number, chunk_n: number): Uint8ClampedArray;
    /**
     * Progressive render into a caller-owned [`WasmPixmap`] (#611): the same
     * refinement semantics as [`render_progressive`](Self::render_progressive).
     *
     * @deprecated Use `render_request` with `set_step(chunk_n)`.
     */
    render_progressive_into_pixmap(target_dpi: number, chunk_n: number, out: WasmPixmap): void;
    /**
     * Render `request` into a caller-owned [`WasmPixmap`], reusing its
     * Rust-side allocation (#611): the page or a region of it, at full,
     * progressive, or coarse quality (see [`WasmRenderRequest`]). No
     * JS-side allocation, no wasm→JS copy — consume the pixels via
     * [`WasmPixmap::view`], or copy them with [`WasmPixmap::to_bytes`].
     *
     * Throws on decode error, a step past the last chunk, or a coarse
     * render of a page without a background.
     */
    render_request(request: WasmRenderRequest, out: WasmPixmap): void;
    /**
     * Render one full-quality tile, returning a [`WasmPixmap`] whose
     * `width()`/`height()` give the (possibly clipped) tile dimensions.
     *
     * Byte-identical to the matching rectangle of [`render`](Self::render);
     * assembled from the page's composited-tile cache (cache state never
     * changes bytes, only latency).
     *
     * Throws on decode error or a grid violation.
     */
    render_tile(target_dpi: number, tile_size: number, col: number, row: number): WasmPixmap;
    /**
     * Render one full-quality tile into a caller-owned [`WasmPixmap`]
     * (#611 pattern): a pan/zoom session reuses one Rust-side allocation
     * per on-screen tile slot instead of allocating per frame.
     */
    render_tile_into_pixmap(target_dpi: number, tile_size: number, col: number, row: number, out: WasmPixmap): void;
    /**
     * Render one tile at progressive quality step `chunk_n` (BG44 chunks
     * `0..=chunk_n` only), byte-identical to the tile's rectangle of
     * [`render_progressive`](Self::render_progressive) with the same
     * `chunk_n`. Partial-quality tiles are never cached.
     *
     * On bilevel pages (no BG44 data) `chunk_n = 0` is the full render.
     * Throws on decode error, a grid violation, or `chunk_n` out of range.
     */
    render_tile_progressive(target_dpi: number, tile_size: number, col: number, row: number, chunk_n: number): WasmPixmap;
    /**
     * Extract the plain text content of this page from the TXTz/TXTa layer.
     *
     * Returns `undefined` (JS `None`) if the page has no text layer.
     * Throws a JavaScript `Error` on decode failure.
     */
    text(): string | undefined;
    /**
     * Return text zone data for this page, scaled to match a render at `target_dpi`.
     *
     * Returns a JSON string — array of `{"t":"…","x":N,"y":N,"w":N,"h":N}` objects,
     * one per leaf text zone, with pixel coordinates identical to the canvas produced
     * by `render(target_dpi)`.  Leaf zones are the finest granularity stored in the
     * text layer (word-level for richly OCR'd files, line-level otherwise).
     *
     * Returns `undefined` (JS `None`) if the page has no text layer.
     * Throws a JavaScript `Error` on decode failure.
     */
    text_zones_json(target_dpi: number): string | undefined;
    /**
     * Number of tile columns at `target_dpi` for `tile_size`-pixel tiles.
     *
     * Tiles live in display space: tile `(col, row)` starts at canvas pixel
     * `(col * tile_size, row * tile_size)`; edge tiles are clipped, never
     * padded, so blitting every tile covers the canvas exactly once.
     */
    tile_cols(target_dpi: number, tile_size: number): number;
    /**
     * Number of tile rows at `target_dpi` for `tile_size`-pixel tiles.
     */
    tile_rows(target_dpi: number, tile_size: number): number;
    /**
     * Output width in pixels when rendered at `target_dpi` (after the
     * page's INFO rotation).
     */
    width_at(target_dpi: number): number;
}

/**
 * A Rust-owned RGBA pixel buffer that stays alive as long as JS holds the
 * handle, so pixels can be consumed **without** the per-frame
 * `Uint8ClampedArray` allocation + full-buffer copy the plain `render*`
 * methods pay.
 *
 * Two usage modes:
 * - **Zero-copy view**: [`view`](WasmPixmap::view) returns a typed-array view
 *   directly into wasm linear memory. Consume it immediately (e.g.
 *   `ctx.putImageData(new ImageData(pm.view(), pm.width(), pm.height()), 0, 0)`
 *   — `ImageData` copies). The view is invalidated by wasm memory growth and
 *   by dropping/re-rendering the pixmap; never store it.
 * - **Buffer reuse**: pass the same `WasmPixmap` back to
 *   [`render_request`](WasmPage::render_request)
 *   — the Rust-side allocation is reused across frames (a progressive
 *   session allocates once instead of once per refinement pass).
 *
 * The existing copying `render*` methods are unchanged for callers that need
 * independently owned JS bytes.
 */
export class WasmPixmap {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * RGBA byte length (`width * height * 4`).
     */
    byte_length(): number;
    /**
     * Pixel height of the last render written into this pixmap.
     */
    height(): number;
    /**
     * An empty pixmap for use with the `*_into_pixmap` methods.
     */
    constructor();
    /**
     * Copy the pixels into a fresh, independently owned
     * `Uint8ClampedArray` (same guarantee as the plain `render` API).
     */
    to_bytes(): Uint8ClampedArray;
    /**
     * Zero-copy `Uint8ClampedArray` view into wasm memory.
     *
     * Valid only until the next wasm memory growth, the next render into
     * this pixmap, or the pixmap being freed — consume it immediately and
     * never store it. `new ImageData(view, w, h)` copies, so canvas
     * consumption is safe.
     */
    view(): Uint8ClampedArray;
    /**
     * Pixel width of the last render written into this pixmap.
     */
    width(): number;
}

/**
 * What to render: the page at a DPI, optionally one rectangle of it, at a
 * chosen quality. Pass it to [`WasmPage::render_request`], the one render
 * call that covers a viewport, a progressive step, and a coarse preview.
 *
 * ```js
 * const req = new WasmRenderRequest(150);
 * req.set_region(0, 200, 800, 600); // a viewport, from the tile cache
 * req.set_step(0);                  // background chunk 0 only
 * page.render_request(req, pixmap);
 * ```
 */
export class WasmRenderRequest {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Render the whole page again (undo [`set_region`](Self::set_region)).
     */
    clear_region(): void;
    /**
     * A full-quality render of the whole page at `target_dpi`.
     */
    constructor(target_dpi: number);
    /**
     * A fast, blurry preview from the first background chunk only. Throws
     * on a page without a background (`bg44_chunk_count() == 0`).
     */
    set_coarse(): void;
    /**
     * Full quality: every background chunk (the default).
     */
    set_full(): void;
    /**
     * Render only the rectangle `(x, y, width, height)` of the page at
     * `target_dpi`, in canvas pixels after the page's INFO rotation. The
     * output is `width × height`; pixels outside the page are white. A
     * full-quality region comes from the page's composited-tile cache, so
     * a viewer's pans cost only their new tiles.
     */
    set_region(x: number, y: number, width: number, height: number): void;
    /**
     * A progressive step: background chunks `0..=chunk_n` plus every other
     * layer. `chunk_n = bg44_chunk_count() - 1` is the full render; a step
     * past it throws.
     */
    set_step(chunk_n: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmdocument_free: (a: number, b: number) => void;
    readonly __wbg_wasmlazydocument_free: (a: number, b: number) => void;
    readonly __wbg_wasmlazyindirectdocument_free: (a: number, b: number) => void;
    readonly __wbg_wasmpage_free: (a: number, b: number) => void;
    readonly __wbg_wasmpixmap_free: (a: number, b: number) => void;
    readonly __wbg_wasmrenderrequest_free: (a: number, b: number) => void;
    readonly djvu_doc_free: (a: number) => void;
    readonly djvu_doc_open: (a: number, b: number, c: number) => number;
    readonly djvu_doc_page_count: (a: number) => number;
    readonly djvu_error_free: (a: number) => void;
    readonly djvu_page_dpi: (a: number, b: number, c: number) => number;
    readonly djvu_page_height: (a: number, b: number, c: number) => number;
    readonly djvu_page_render: (a: number, b: number, c: number, d: number) => number;
    readonly djvu_page_text: (a: number, b: number, c: number) => number;
    readonly djvu_page_width: (a: number, b: number, c: number) => number;
    readonly djvu_pixmap_data: (a: number) => number;
    readonly djvu_pixmap_data_len: (a: number) => number;
    readonly djvu_pixmap_free: (a: number) => void;
    readonly djvu_pixmap_height: (a: number) => number;
    readonly djvu_pixmap_width: (a: number) => number;
    readonly djvu_text_free: (a: number) => void;
    readonly wasmdocument_from_bytes: (a: number, b: number) => [number, number, number];
    readonly wasmdocument_page: (a: number, b: number) => [number, number, number];
    readonly wasmdocument_page_count: (a: number) => number;
    readonly wasmdocument_reader_cache_bytes: (a: number) => number;
    readonly wasmdocument_reader_open: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmdocument_reader_outline: (a: number) => [number, number, number];
    readonly wasmdocument_reader_page_ids: (a: number) => [number, number, number];
    readonly wasmdocument_reader_trim_cache: (a: number, b: number) => number;
    readonly wasmdocument_render_pages_batch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasmlazydocument_open: (a: number, b: any, c: number) => any;
    readonly wasmlazydocument_page_count: (a: number) => number;
    readonly wasmlazydocument_page_info: (a: number, b: number) => any;
    readonly wasmlazydocument_reader_cache_stats: (a: number) => any;
    readonly wasmlazydocument_reader_geometry: (a: number, b: number) => any;
    readonly wasmlazydocument_reader_outline: (a: number) => any;
    readonly wasmlazydocument_reader_outline_needs_full_source: (a: number) => number;
    readonly wasmlazydocument_reader_page_ids: (a: number) => [number, number, number];
    readonly wasmlazydocument_reader_render_strict: (a: number, b: number) => any;
    readonly wasmlazydocument_reader_text: (a: number, b: number) => any;
    readonly wasmlazydocument_reader_text_zones_json: (a: number, b: number) => any;
    readonly wasmlazydocument_render_page: (a: number, b: number, c: number) => any;
    readonly wasmlazydocument_render_page_progressive: (a: number, b: number, c: number, d: number) => any;
    readonly wasmlazyindirectdocument_open: (a: number, b: number, c: any) => [number, number, number];
    readonly wasmlazyindirectdocument_page_count: (a: number) => number;
    readonly wasmlazyindirectdocument_page_info: (a: number, b: number) => any;
    readonly wasmlazyindirectdocument_page_name: (a: number, b: number) => [number, number];
    readonly wasmlazyindirectdocument_render_page: (a: number, b: number, c: number) => any;
    readonly wasmlazyindirectdocument_render_page_progressive: (a: number, b: number, c: number, d: number) => any;
    readonly wasmpage_bg44_chunk_count: (a: number) => number;
    readonly wasmpage_dpi: (a: number) => number;
    readonly wasmpage_height_at: (a: number, b: number) => number;
    readonly wasmpage_reader_render_strict: (a: number) => [number, number, number];
    readonly wasmpage_reader_rotation: (a: number) => [number, number, number];
    readonly wasmpage_render: (a: number, b: number) => [number, number, number];
    readonly wasmpage_render_coarse: (a: number, b: number) => [number, number, number];
    readonly wasmpage_render_into_pixmap: (a: number, b: number, c: number) => [number, number];
    readonly wasmpage_render_progressive: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmpage_render_progressive_into_pixmap: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasmpage_render_request: (a: number, b: number, c: number) => [number, number];
    readonly wasmpage_render_tile: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmpage_render_tile_into_pixmap: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly wasmpage_render_tile_progressive: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmpage_text: (a: number) => [number, number, number, number];
    readonly wasmpage_text_zones_json: (a: number, b: number) => [number, number, number, number];
    readonly wasmpage_tile_cols: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmpage_tile_rows: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmpage_width_at: (a: number, b: number) => number;
    readonly wasmpixmap_byte_length: (a: number) => number;
    readonly wasmpixmap_height: (a: number) => number;
    readonly wasmpixmap_new: () => number;
    readonly wasmpixmap_to_bytes: (a: number) => any;
    readonly wasmpixmap_view: (a: number) => any;
    readonly wasmpixmap_width: (a: number) => number;
    readonly wasmrenderrequest_clear_region: (a: number) => void;
    readonly wasmrenderrequest_new: (a: number) => number;
    readonly wasmrenderrequest_set_coarse: (a: number) => void;
    readonly wasmrenderrequest_set_full: (a: number) => void;
    readonly wasmrenderrequest_set_region: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmrenderrequest_set_step: (a: number, b: number) => void;
    readonly wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___wasm_bindgen_de83182ede39dfe6___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_de83182ede39dfe6___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
