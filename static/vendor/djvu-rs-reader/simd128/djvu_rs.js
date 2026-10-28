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
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_length_b5d0ffc9b832763b: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
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
        __wbg_new_with_length_cd84da398f2a287d: function(arg0) {
            const ret = new Uint8ClampedArray(arg0 >>> 0);
            return ret;
        },
        __wbg_push_2baf45db356cf468: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_c2baa06365903d3b: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_wasmpixmap_new: function(arg0) {
            const ret = WasmPixmap.__wrap(arg0);
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8ClampedArray")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
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

const WasmDocumentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmdocument_free(ptr, 1));
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

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
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

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
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

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
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
