/* @ts-self-types="./djvu_rs.d.ts" */

/**
 * A parsed DjVu document.
 *
 * Created from raw bytes via [`WasmDocument::from_bytes`].
 */
export class WasmDocument {
    static __wrap(ptr) {
        const obj = Object.create(WasmDocument.prototype);
        obj.__wbg_ptr = ptr;
        WasmDocumentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmDocumentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmdocument_free(ptr, 0);
    }
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
     * @param {Uint8Array} data
     * @returns {WasmDocument}
     */
    static from_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmdocument_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmDocument.__wrap(ret[0]);
    }
    /**
     * Total number of pages in the document.
     * @returns {number}
     */
    page_count() {
        const ret = wasm.wasmdocument_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Return a handle to page `index` (0-based).
     *
     * Throws if `index >= page_count()`.
     * @param {number} index
     * @returns {WasmPage}
     */
    page(index) {
        const ret = wasm.wasmdocument_page(this.__wbg_ptr, index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPage.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    reader_cache_bytes() {
        const ret = wasm.wasmdocument_reader_cache_bytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Reader integration, 2026-10-28: validate native page and input bounds
     * before constructing a document, and bound the shared decoded cache.
     * The cache limit does not include the source, in-progress render or the
     * WebAssembly linear-memory high-water mark.
     * @param {Uint8Array} data
     * @param {number} cache_bytes
     * @returns {WasmDocument}
     */
    static reader_open(data, cache_bytes) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmdocument_reader_open(ptr0, len0, cache_bytes);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmDocument.__wrap(ret[0]);
    }
    /**
     * Reader integration: preserve the original embedded NAVM hierarchy.
     * @returns {Array<any>}
     */
    reader_outline() {
        const ret = wasm.wasmdocument_reader_outline(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Return page component IDs in page order to resolve named NAVM links.
     * @returns {Array<any>}
     */
    reader_page_ids() {
        const ret = wasm.wasmdocument_reader_page_ids(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Release least-recently-used decoded layers after a finished render.
     * This does not shrink WASM linear memory or account for in-flight pages.
     * @param {number} max_bytes
     * @returns {number}
     */
    reader_trim_cache(max_bytes) {
        const ret = wasm.wasmdocument_reader_trim_cache(this.__wbg_ptr, max_bytes);
        return ret >>> 0;
    }
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
     * @param {number} target_dpi
     * @param {number} start
     * @param {number} count
     * @returns {WasmPixmap[]}
     */
    render_pages_batch(target_dpi, start, count) {
        const ret = wasm.wasmdocument_render_pages_batch(this.__wbg_ptr, target_dpi, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) WasmDocument.prototype[Symbol.dispose] = WasmDocument.prototype.free;

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
    static __wrap(ptr) {
        const obj = Object.create(WasmLazyDocument.prototype);
        obj.__wbg_ptr = ptr;
        WasmLazyDocumentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmLazyDocumentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmlazydocument_free(ptr, 0);
    }
    /**
     * Index a document of `total_len` bytes through the `fetch` callback.
     * @param {number} total_len
     * @param {Function} fetch
     * @param {number} cache_bytes
     * @returns {Promise<WasmLazyDocument>}
     */
    static open(total_len, fetch, cache_bytes) {
        const ret = wasm.wasmlazydocument_open(total_len, fetch, cache_bytes);
        return ret;
    }
    /**
     * Number of pages in the index.
     * @returns {number}
     */
    page_count() {
        const ret = wasm.wasmlazydocument_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Fetch (or reuse) page `index` and return `[width_px, height_px, dpi]`
     * at the page's native resolution.
     * @param {number} index
     * @returns {Promise<Uint32Array>}
     */
    page_info(index) {
        const ret = wasm.wasmlazydocument_page_info(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * Parsed page count, visible raw page chunks and decoded cache only.
     * Not WASM high-water, dictionaries, canvas or browser total memory.
     * @returns {Promise<Float64Array>}
     */
    reader_cache_stats() {
        const ret = wasm.wasmlazydocument_reader_cache_stats(this.__wbg_ptr);
        return ret;
    }
    /**
     * Reader-oriented geometry after applying the source INFO rotation.
     * @param {number} index
     * @returns {Promise<Uint32Array>}
     */
    reader_geometry(index) {
        const ret = wasm.wasmlazydocument_reader_geometry(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * Original hierarchical bookmarks; requested only when the UI asks.
     * @returns {Promise<Array<any>>}
     */
    reader_outline() {
        const ret = wasm.wasmlazydocument_reader_outline(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    reader_outline_needs_full_source() {
        const ret = wasm.wasmlazydocument_reader_outline_needs_full_source(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Original page identifiers used to resolve named NAVM destinations.
     * @returns {Array<any>}
     */
    reader_page_ids() {
        const ret = wasm.wasmlazydocument_reader_page_ids(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Isolated Reader experiment: decode a complete native page strictly.
     * No progressive preview, no output on a failed or unsupported layer.
     * @param {number} index
     * @returns {Promise<WasmPixmap>}
     */
    reader_render_strict(index) {
        const ret = wasm.wasmlazydocument_reader_render_strict(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * Embedded text in the same source order as the eager Reader path.
     * @param {number} index
     * @returns {Promise<string | undefined>}
     */
    reader_text(index) {
        const ret = wasm.wasmlazydocument_reader_text(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * Leaf text zones transformed to the native rotated page geometry.
     * @param {number} index
     * @returns {Promise<string | undefined>}
     */
    reader_text_zones_json(index) {
        const ret = wasm.wasmlazydocument_reader_text_zones_json(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * Fetch (or reuse) page `index` and render it at `target_dpi` into a
     * [`WasmPixmap`] (zero-copy `view()` / owned `to_bytes()`).
     * @param {number} index
     * @param {number} target_dpi
     * @returns {Promise<WasmPixmap>}
     */
    render_page(index, target_dpi) {
        const ret = wasm.wasmlazydocument_render_page(this.__wbg_ptr, index, target_dpi);
        return ret;
    }
    /**
     * Progressive variant of [`render_page`](Self::render_page): decode at
     * most `chunk_n` BG44 refinement chunks (0 ⇒ mask/foreground only) for
     * a fast blurry-to-sharp first paint. Fetching is unchanged (the page
     * range is one transfer); only decode work is bounded.
     * @param {number} index
     * @param {number} target_dpi
     * @param {number} chunk_n
     * @returns {Promise<WasmPixmap>}
     */
    render_page_progressive(index, target_dpi, chunk_n) {
        const ret = wasm.wasmlazydocument_render_page_progressive(this.__wbg_ptr, index, target_dpi, chunk_n);
        return ret;
    }
}
if (Symbol.dispose) WasmLazyDocument.prototype[Symbol.dispose] = WasmLazyDocument.prototype.free;

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
    static __wrap(ptr) {
        const obj = Object.create(WasmLazyIndirectDocument.prototype);
        obj.__wbg_ptr = ptr;
        WasmLazyIndirectDocumentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmLazyIndirectDocumentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmlazyindirectdocument_free(ptr, 0);
    }
    /**
     * Read the directory of an indirect index file. No component is
     * fetched here.
     * @param {Uint8Array} index
     * @param {Function} resolve
     * @returns {WasmLazyIndirectDocument}
     */
    static open(index, resolve) {
        const ptr0 = passArray8ToWasm0(index, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmlazyindirectdocument_open(ptr0, len0, resolve);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmLazyIndirectDocument.__wrap(ret[0]);
    }
    /**
     * Number of pages in the index.
     * @returns {number}
     */
    page_count() {
        const ret = wasm.wasmlazyindirectdocument_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Fetch (or reuse) page `index` and return `[width_px, height_px, dpi]`
     * at the page's native resolution.
     * @param {number} index
     * @returns {Promise<Uint32Array>}
     */
    page_info(index) {
        const ret = wasm.wasmlazyindirectdocument_page_info(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * The file name of page `index`, as passed to `resolve`, or
     * `undefined` when `index` is out of range.
     * @param {number} index
     * @returns {string | undefined}
     */
    page_name(index) {
        const ret = wasm.wasmlazyindirectdocument_page_name(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Fetch (or reuse) page `index` and render it at `target_dpi` into a
     * [`WasmPixmap`].
     * @param {number} index
     * @param {number} target_dpi
     * @returns {Promise<WasmPixmap>}
     */
    render_page(index, target_dpi) {
        const ret = wasm.wasmlazyindirectdocument_render_page(this.__wbg_ptr, index, target_dpi);
        return ret;
    }
    /**
     * Progressive variant of [`render_page`](Self::render_page): decode at
     * most `chunk_n` BG44 refinement chunks (0 ⇒ mask/foreground only).
     * @param {number} index
     * @param {number} target_dpi
     * @param {number} chunk_n
     * @returns {Promise<WasmPixmap>}
     */
    render_page_progressive(index, target_dpi, chunk_n) {
        const ret = wasm.wasmlazyindirectdocument_render_page_progressive(this.__wbg_ptr, index, target_dpi, chunk_n);
        return ret;
    }
}
if (Symbol.dispose) WasmLazyIndirectDocument.prototype[Symbol.dispose] = WasmLazyIndirectDocument.prototype.free;

/**
 * A single page within a [`WasmDocument`].
 */
export class WasmPage {
    static __wrap(ptr) {
        const obj = Object.create(WasmPage.prototype);
        obj.__wbg_ptr = ptr;
        WasmPageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPageFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmpage_free(ptr, 0);
    }
    /**
     * Number of BG44 background chunks on this page.
     *
     * Determines how many refinement steps are available via
     * [`render_progressive`](Self::render_progressive). Returns `0` for bilevel-only pages.
     * @returns {number}
     */
    bg44_chunk_count() {
        const ret = wasm.wasmpage_bg44_chunk_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Native DPI stored in the INFO chunk.
     * @returns {number}
     */
    dpi() {
        const ret = wasm.wasmpage_dpi(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Output height in pixels when rendered at `target_dpi` (after the
     * page's INFO rotation).
     * @param {number} target_dpi
     * @returns {number}
     */
    height_at(target_dpi) {
        const ret = wasm.wasmpage_height_at(this.__wbg_ptr, target_dpi);
        return ret >>> 0;
    }
    /**
     * A complete native page: never return permissive partial decoding.
     * @returns {Uint8ClampedArray}
     */
    reader_render_strict() {
        const ret = wasm.wasmpage_reader_render_strict(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Reader integration: report original INFO rotation, clockwise degrees.
     * @returns {number}
     */
    reader_rotation() {
        const ret = wasm.wasmpage_reader_rotation(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
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
     * @param {number} target_dpi
     * @returns {Uint8ClampedArray | undefined}
     */
    render_coarse(target_dpi) {
        const ret = wasm.wasmpage_render_coarse(this.__wbg_ptr, target_dpi);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Render the page at `target_dpi` and return raw RGBA pixels
     * (`Uint8ClampedArray`, suitable for `new ImageData(pixels, w, h)`).
     *
     * Throws on decode error.
     * @param {number} target_dpi
     * @returns {Uint8ClampedArray}
     */
    render(target_dpi) {
        const ret = wasm.wasmpage_render(this.__wbg_ptr, target_dpi);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Render into a caller-owned [`WasmPixmap`], reusing its Rust-side
     * allocation (#611).
     *
     * @deprecated Use `render_request(new WasmRenderRequest(target_dpi), out)`.
     * @param {number} target_dpi
     * @param {WasmPixmap} out
     */
    render_into_pixmap(target_dpi, out) {
        _assertClass(out, WasmPixmap);
        const ret = wasm.wasmpage_render_into_pixmap(this.__wbg_ptr, target_dpi, out.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
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
     * @param {number} target_dpi
     * @param {number} chunk_n
     * @returns {Uint8ClampedArray}
     */
    render_progressive(target_dpi, chunk_n) {
        const ret = wasm.wasmpage_render_progressive(this.__wbg_ptr, target_dpi, chunk_n);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Progressive render into a caller-owned [`WasmPixmap`] (#611): the same
     * refinement semantics as [`render_progressive`](Self::render_progressive).
     *
     * @deprecated Use `render_request` with `set_step(chunk_n)`.
     * @param {number} target_dpi
     * @param {number} chunk_n
     * @param {WasmPixmap} out
     */
    render_progressive_into_pixmap(target_dpi, chunk_n, out) {
        _assertClass(out, WasmPixmap);
        const ret = wasm.wasmpage_render_progressive_into_pixmap(this.__wbg_ptr, target_dpi, chunk_n, out.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Render `request` into a caller-owned [`WasmPixmap`], reusing its
     * Rust-side allocation (#611): the page or a region of it, at full,
     * progressive, or coarse quality (see [`WasmRenderRequest`]). No
     * JS-side allocation, no wasm→JS copy — consume the pixels via
     * [`WasmPixmap::view`], or copy them with [`WasmPixmap::to_bytes`].
     *
     * Throws on decode error, a step past the last chunk, or a coarse
     * render of a page without a background.
     * @param {WasmRenderRequest} request
     * @param {WasmPixmap} out
     */
    render_request(request, out) {
        _assertClass(request, WasmRenderRequest);
        _assertClass(out, WasmPixmap);
        const ret = wasm.wasmpage_render_request(this.__wbg_ptr, request.__wbg_ptr, out.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Render one full-quality tile, returning a [`WasmPixmap`] whose
     * `width()`/`height()` give the (possibly clipped) tile dimensions.
     *
     * Byte-identical to the matching rectangle of [`render`](Self::render);
     * assembled from the page's composited-tile cache (cache state never
     * changes bytes, only latency).
     *
     * Throws on decode error or a grid violation.
     * @param {number} target_dpi
     * @param {number} tile_size
     * @param {number} col
     * @param {number} row
     * @returns {WasmPixmap}
     */
    render_tile(target_dpi, tile_size, col, row) {
        const ret = wasm.wasmpage_render_tile(this.__wbg_ptr, target_dpi, tile_size, col, row);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPixmap.__wrap(ret[0]);
    }
    /**
     * Render one full-quality tile into a caller-owned [`WasmPixmap`]
     * (#611 pattern): a pan/zoom session reuses one Rust-side allocation
     * per on-screen tile slot instead of allocating per frame.
     * @param {number} target_dpi
     * @param {number} tile_size
     * @param {number} col
     * @param {number} row
     * @param {WasmPixmap} out
     */
    render_tile_into_pixmap(target_dpi, tile_size, col, row, out) {
        _assertClass(out, WasmPixmap);
        const ret = wasm.wasmpage_render_tile_into_pixmap(this.__wbg_ptr, target_dpi, tile_size, col, row, out.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Render one tile at progressive quality step `chunk_n` (BG44 chunks
     * `0..=chunk_n` only), byte-identical to the tile's rectangle of
     * [`render_progressive`](Self::render_progressive) with the same
     * `chunk_n`. Partial-quality tiles are never cached.
     *
     * On bilevel pages (no BG44 data) `chunk_n = 0` is the full render.
     * Throws on decode error, a grid violation, or `chunk_n` out of range.
     * @param {number} target_dpi
     * @param {number} tile_size
     * @param {number} col
     * @param {number} row
     * @param {number} chunk_n
     * @returns {WasmPixmap}
     */
    render_tile_progressive(target_dpi, tile_size, col, row, chunk_n) {
        const ret = wasm.wasmpage_render_tile_progressive(this.__wbg_ptr, target_dpi, tile_size, col, row, chunk_n);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPixmap.__wrap(ret[0]);
    }
    /**
     * Extract the plain text content of this page from the TXTz/TXTa layer.
     *
     * Returns `undefined` (JS `None`) if the page has no text layer.
     * Throws a JavaScript `Error` on decode failure.
     * @returns {string | undefined}
     */
    text() {
        const ret = wasm.wasmpage_text(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
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
     * @param {number} target_dpi
     * @returns {string | undefined}
     */
    text_zones_json(target_dpi) {
        const ret = wasm.wasmpage_text_zones_json(this.__wbg_ptr, target_dpi);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Number of tile columns at `target_dpi` for `tile_size`-pixel tiles.
     *
     * Tiles live in display space: tile `(col, row)` starts at canvas pixel
     * `(col * tile_size, row * tile_size)`; edge tiles are clipped, never
     * padded, so blitting every tile covers the canvas exactly once.
     * @param {number} target_dpi
     * @param {number} tile_size
     * @returns {number}
     */
    tile_cols(target_dpi, tile_size) {
        const ret = wasm.wasmpage_tile_cols(this.__wbg_ptr, target_dpi, tile_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Number of tile rows at `target_dpi` for `tile_size`-pixel tiles.
     * @param {number} target_dpi
     * @param {number} tile_size
     * @returns {number}
     */
    tile_rows(target_dpi, tile_size) {
        const ret = wasm.wasmpage_tile_rows(this.__wbg_ptr, target_dpi, tile_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Output width in pixels when rendered at `target_dpi` (after the
     * page's INFO rotation).
     * @param {number} target_dpi
     * @returns {number}
     */
    width_at(target_dpi) {
        const ret = wasm.wasmpage_width_at(this.__wbg_ptr, target_dpi);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmPage.prototype[Symbol.dispose] = WasmPage.prototype.free;

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
    static __wrap(ptr) {
        const obj = Object.create(WasmPixmap.prototype);
        obj.__wbg_ptr = ptr;
        WasmPixmapFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPixmapFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmpixmap_free(ptr, 0);
    }
    /**
     * RGBA byte length (`width * height * 4`).
     * @returns {number}
     */
    byte_length() {
        const ret = wasm.wasmpixmap_byte_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pixel height of the last render written into this pixmap.
     * @returns {number}
     */
    height() {
        const ret = wasm.wasmpixmap_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * An empty pixmap for use with the `*_into_pixmap` methods.
     */
    constructor() {
        const ret = wasm.wasmpixmap_new();
        this.__wbg_ptr = ret;
        WasmPixmapFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Copy the pixels into a fresh, independently owned
     * `Uint8ClampedArray` (same guarantee as the plain `render` API).
     * @returns {Uint8ClampedArray}
     */
    to_bytes() {
        const ret = wasm.wasmpixmap_to_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * Zero-copy `Uint8ClampedArray` view into wasm memory.
     *
     * Valid only until the next wasm memory growth, the next render into
     * this pixmap, or the pixmap being freed — consume it immediately and
     * never store it. `new ImageData(view, w, h)` copies, so canvas
     * consumption is safe.
     * @returns {Uint8ClampedArray}
     */
    view() {
        const ret = wasm.wasmpixmap_view(this.__wbg_ptr);
        return ret;
    }
    /**
     * Pixel width of the last render written into this pixmap.
     * @returns {number}
     */
    width() {
        const ret = wasm.wasmpixmap_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmPixmap.prototype[Symbol.dispose] = WasmPixmap.prototype.free;

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmRenderRequestFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmrenderrequest_free(ptr, 0);
    }
    /**
     * Render the whole page again (undo [`set_region`](Self::set_region)).
     */
    clear_region() {
        wasm.wasmrenderrequest_clear_region(this.__wbg_ptr);
    }
    /**
     * A full-quality render of the whole page at `target_dpi`.
     * @param {number} target_dpi
     */
    constructor(target_dpi) {
        const ret = wasm.wasmrenderrequest_new(target_dpi);
        this.__wbg_ptr = ret;
        WasmRenderRequestFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * A fast, blurry preview from the first background chunk only. Throws
     * on a page without a background (`bg44_chunk_count() == 0`).
     */
    set_coarse() {
        wasm.wasmrenderrequest_set_coarse(this.__wbg_ptr);
    }
    /**
     * Full quality: every background chunk (the default).
     */
    set_full() {
        wasm.wasmrenderrequest_set_full(this.__wbg_ptr);
    }
    /**
     * Render only the rectangle `(x, y, width, height)` of the page at
     * `target_dpi`, in canvas pixels after the page's INFO rotation. The
     * output is `width × height`; pixels outside the page are white. A
     * full-quality region comes from the page's composited-tile cache, so
     * a viewer's pans cost only their new tiles.
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     */
    set_region(x, y, width, height) {
        wasm.wasmrenderrequest_set_region(this.__wbg_ptr, x, y, width, height);
    }
    /**
     * A progressive step: background chunks `0..=chunk_n` plus every other
     * layer. `chunk_n = bg44_chunk_count() - 1` is the full render; a step
     * past it throws.
     * @param {number} chunk_n
     */
    set_step(chunk_n) {
        wasm.wasmrenderrequest_set_step(this.__wbg_ptr, chunk_n);
    }
}
if (Symbol.dispose) WasmRenderRequest.prototype[Symbol.dispose] = WasmRenderRequest.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_dcc1a90847f04c41: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_call_1875a20c43a36133: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_instanceof_Error_80a725f81f2e102d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Error;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_b5d0ffc9b832763b: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_message_5f8387f0c32b90a7: function(arg0) {
            const ret = arg0.message;
            return ret;
        },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_37a3c3a194266cb8: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_f545fd22ddc142b8: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_b01cb72a8af741a3: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_length_cd84da398f2a287d: function(arg0) {
            const ret = new Uint8ClampedArray(arg0 >>> 0);
            return ret;
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_2baf45db356cf468: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_9833f9a49df95a49: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_a72f977e97f23c5f: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_resolve_0076e10020304ede: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_c2baa06365903d3b: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_then_c949d5a25a4e78f8: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_e71170d78fcf8954: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_wasmlazydocument_new: function(arg0) {
            const ret = WasmLazyDocument.__wrap(arg0);
            return ret;
        },
        __wbg_wasmpixmap_new: function(arg0) {
            const ret = WasmPixmap.__wrap(arg0);
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 155, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___wasm_bindgen_de83182ede39dfe6___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_de83182ede39dfe6___JsError___true_);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8ClampedArray")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./djvu_rs_bg.js": import0,
    };
}

function wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___wasm_bindgen_de83182ede39dfe6___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_de83182ede39dfe6___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___wasm_bindgen_de83182ede39dfe6___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_de83182ede39dfe6___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_de83182ede39dfe6___convert__closures_____invoke___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined___js_sys_ff62395b4a713ba7___Function_fn_wasm_bindgen_de83182ede39dfe6___JsValue_____wasm_bindgen_de83182ede39dfe6___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}

const WasmDocumentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmdocument_free(ptr, 1));
const WasmLazyDocumentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmlazydocument_free(ptr, 1));
const WasmLazyIndirectDocumentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmlazyindirectdocument_free(ptr, 1));
const WasmPageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmpage_free(ptr, 1));
const WasmPixmapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmpixmap_free(ptr, 1));
const WasmRenderRequestFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmrenderrequest_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('djvu_rs_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
