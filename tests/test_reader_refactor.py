"""HF Reader regressions using GitHub's /search/ server and external API routes."""

import io
import gzip
import hashlib
import json
import unittest
import urllib.parse
import zipfile

from tests import test_reader_performance as support


@unittest.skipIf(support.sync_playwright is None, "Playwright is unavailable")
class ReaderRefactorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = support.local_server()
        cls.origin, _state = cls.server.__enter__()
        cls.playwright = support.sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        except support.PlaywrightError as error:
            cls.playwright.stop()
            cls.server.__exit__(None, None, None)
            raise unittest.SkipTest(str(error))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1100, "height": 800})
        self.context.route("**/*", lambda route: route.continue_()
                           if route.request.url.startswith(self.origin + "/")
                           else route.abort())
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_default_timeout(6000)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def reader_url(self, extension="txt", name="refactor", **params):
        source = f"https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/{name}.{extension}"
        values = {"url": source, "ext": extension, "title": name, **params}
        return self.origin + "/search/static/reader.html?" + urllib.parse.urlencode(values)

    def serve(self, body, mime="text/plain"):
        self.page.route("**/api/reader-content**", lambda route: route.fulfill(
            status=200, content_type=mime, body=body))

    def open(self, url):
        self.page.goto(url)
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")

    def search(self, query):
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill(query)
        self.page.wait_for_function("() => /个结果|未找到/.test(document.querySelector('#full-search-status').textContent)")

    def wait_for_store(self, predicate, arg=None):
        self.page.evaluate("""async arg => {
          const check = """ + predicate + """;
          const deadline = performance.now() + 6000;
          while (performance.now() < deadline) {
            if (await check(arg)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          throw new Error('Store condition did not become true');
        }""", arg)

    def serve_chapter_search(self, failure=None):
        base = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "b" * 64 + "/foliate-original-v1/epub-chapters/"
        chapters, texts, bodies = [], [], {}
        for index in range(1, 13):
            path = f"chapters/chapter-{index:04d}.xhtml"
            title = f"Chapter {index}"
            if index == 12:
                body = ('<html:html xmlns:html="http://www.w3.org/1999/xhtml"><html:head><html:meta/>'
                        '<html:title>标题</html:title></html:head><html:body><p><span>独特</span><em>词语</em></p>'
                        + ''.join(f'<p>第{i}处needle结束</p>' for i in range(155))
                        + '<p>手机 手。机</p></html:body></html:html>')
                text = '标题 独特 词语 ' + ' '.join(f'第{i}处needle结束' for i in range(155)) + ' 手机 手。机'
            else:
                body = f'<h1>{title}</h1><p style="height:12000px">普通正文</p>'
                text = title + ' 普通正文'
            bodies[base + path] = body
            chapters.append(dict(index=index, path=path, title=title, bytes=len(body.encode())))
            texts.append(dict(index=index, path=path, text=text))
        packed = gzip.compress(json.dumps(dict(version=1, kind='epub-search-index', chapters=texts), ensure_ascii=False).encode(), mtime=0)
        manifest = dict(version=1, kind='epub-chapters', chapters=chapters,
                        search_index=dict(path='epub-search-index.json.gz', bytes=len(packed), sha256=hashlib.sha256(packed).hexdigest()))
        requests = []
        def serve(route):
            raw = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)['url'][0]
            requests.append(raw)
            if raw.endswith('chapter-manifest.json'):
                route.fulfill(content_type='application/json', body=json.dumps(manifest))
            elif raw.endswith('epub-search-index.json.gz'):
                attempt = sum(item.endswith('epub-search-index.json.gz') for item in requests)
                if not failure or not failure(route, attempt, packed):
                    route.fulfill(content_type='application/gzip', body=packed)
            else:
                route.fulfill(content_type='text/html', body=bodies[raw])
        self.context.route('**/api/reader-content**', serve)
        self.open(self.reader_url('epub-chapters', url=base + 'chapter-manifest.json'))
        return requests, base

    def test_chapter_search_lazy_complete_pages_and_unloaded_highlight(self):
        requests, base = self.serve_chapter_search()
        self.assertFalse(any('epub-search-index' in url for url in requests))
        self.search('needle')
        self.assertEqual(self.page.locator('#full-search-status').text_content(), '155 个结果')
        self.assertEqual(self.page.locator('.full-search-result').count(), 50)
        self.assertNotIn(base + 'chapters/chapter-0012.xhtml', requests)
        field = self.page.locator('#full-search-page')
        field.fill('4')
        field.press('Enter')
        field.blur()
        self.page.wait_for_function("() => document.querySelectorAll('.full-search-result').length === 5")
        self.page.locator('.full-search-result').last.click()
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter mark')?.parentElement.textContent === '第154处needle结束'")
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill('独特 词语')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.page.locator('.full-search-result').click()
        self.page.wait_for_function("() => document.querySelectorAll('.reader-epub-chapter mark.full-search-highlight').length === 2")
        self.assertEqual(self.page.locator('.reader-epub-chapter mark').all_text_contents(), ['独特', '词语'])
        self.assertEqual(sum('epub-search-index' in url for url in requests), 1)

    def test_chapter_search_retry_and_corrupt_index(self):
        def failure(route, attempt, packed):
            if attempt == 1:
                route.fulfill(status=503, body='unavailable')
                return True
            if attempt == 2:
                route.fulfill(body=packed[:-1] + bytes([packed[-1] ^ 1]))
                return True
        self.serve_chapter_search(failure)
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        self.page.locator('#full-search-input').fill('needle')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('503')")
        self.page.locator('#full-search-retry').click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent.includes('校验失败')")
        self.page.locator('#full-search-retry').click()
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '155 个结果'")

    def test_chapter_search_cancel_cannot_publish_stale_results(self):
        held = []
        def hold(route, attempt, packed):
            if attempt == 1:
                held.append((route, packed))
                return True
        requests, _ = self.serve_chapter_search(hold)
        self.page.locator('#history').click()
        self.page.locator('#full-search-toggle').click()
        with self.context.expect_event('request', predicate=lambda request: 'epub-search-index' in request.url):
            self.page.locator('#full-search-input').fill('needle')
        self.page.locator('#full-search-cancel').click()
        self.page.locator('#full-search-input').fill('手机')
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        for route, packed in held:
            route.fulfill(content_type='application/gzip', body=packed)
        self.assertEqual(self.page.locator('.full-search-result').count(), 1)
        self.assertEqual(sum('epub-search-index' in url for url in requests), 2)

    def test_store_lists_preserve_limits_order_migration_and_future_records(self):
        self.page.goto(self.reader_url().split('?')[0])
        result = self.page.evaluate('''async () => {
          const store=VoiceOfMLReaderStore;
          await store.put({url:'book-a',lastReadAt:10});
          await store.put({url:'book-b',lastReadAt:20});
          await store.put({url:'book-c',lastReadAt:30});
          await store.put({url:'book-c',lastReadAt:1});
          const db=await new Promise((resolve,reject)=>{
            const request=indexedDB.open(store.DB_NAME,2);
            request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
          });
          await new Promise((resolve,reject)=>{
            const tx=db.transaction('bookmarks','readwrite'), bookmarks=tx.objectStore('bookmarks');
            for(const entry of [
              {id:'z',url:'book-a',createdAt:1}, {id:'a',url:'book-a',createdAt:3},
              {id:'b',url:'book-b',createdAt:2}, {id:'bad',url:42,createdAt:4},
              {id:'future',url:'book-a',createdAt:5,schemaVersion:2}
            ]) bookmarks.put(entry);
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
          });
          const history=(await store.list(2)).map(entry=>entry.url);
          const empty=(await store.list(0)).length;
          const all=(await store.listAllBookmarks()).map(entry=>entry.id);
          const one=(await store.listBookmarks('book-a')).map(entry=>entry.id);
          const raw=await new Promise((resolve,reject)=>{
            const tx=db.transaction('bookmarks'), request=tx.objectStore('bookmarks').getAll();
            tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);
          });
          db.close();await store.removeBookmark('a');
          return {history,empty,all,one,remaining:(await store.listBookmarks('book-a')).map(entry=>entry.id),
            migrated:raw.filter(entry=>['z','a','b'].includes(entry.id)).every(entry=>entry.schemaVersion===1),
            future:raw.some(entry=>entry.id==='future' && entry.schemaVersion===2),
            corruptRemoved:!raw.some(entry=>entry.id==='bad')};
        }''')
        self.assertEqual(result, dict(history=['book-c', 'book-b'], empty=0, all=['a', 'b', 'z'],
                                      one=['a', 'z'], remaining=['z'], migrated=True, future=True, corruptRemoved=True))

    def test_cross_book_bookmark_restores_selected_position_and_rejects_mismatch(self):
        self.serve("start\n" + "ordinary text\n" * 3000)
        book_b = self.reader_url(name="book-b")
        source_b = urllib.parse.parse_qs(urllib.parse.urlsplit(book_b).query)["url"][0]
        self.open(book_b)
        self.page.evaluate("""async ({url, readerUrl}) => {
          await VoiceOfMLReaderStore.putBookmark({id:'selected-bookmark', url, readerUrl,
            title:'Book B', label:'Selected passage', scrollTop:900, createdAt:1});
          await VoiceOfMLReaderStore.put({url, readerUrl, title:'Book B', scrollTop:2500, lastReadAt:Date.now()});
        }""", {"url": source_b, "readerUrl": book_b})
        self.open(self.reader_url(name="book-a"))
        # Override any pagehide save from the old B page before opening its bookmark.
        self.page.evaluate("""async url => VoiceOfMLReaderStore.put({url, title:'Book B',
          scrollTop:2500, lastReadAt:Date.now()+1})""", source_b)
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        self.page.locator("#bookmarks-all").click()
        self.page.locator("#bookmarks-list .panel-item-main", has_text="Selected passage").click()
        self.page.wait_for_url(book_b)
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 900) < 2")
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        self.page.evaluate("""() => { document.querySelector('#viewport').scrollTop = 2500;
          document.dispatchEvent(new Event('visibilitychange')); }""")
        self.page.wait_for_timeout(650)
        self.page.reload()
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 2500) < 2")
        self.open(self.reader_url(name="book-a"))
        self.page.locator("#history").click()
        self.page.locator("#bookmarks-tab").click()
        self.page.locator("#bookmarks-all").click()
        self.page.locator("#bookmarks-list .panel-item-main", has_text="Selected passage").click()
        self.page.wait_for_url(book_b)
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 900) < 2")
        self.page.locator("#viewport").evaluate("node => { node.scrollTop = 2500; node.dispatchEvent(new Event('scroll')); }")
        self.page.wait_for_timeout(650)
        invalid = book_b + "&bookmark=selected-bookmark&bookmark_source=wrong-source"
        self.open(invalid)
        self.page.wait_for_function("() => Math.abs(document.querySelector('#viewport').scrollTop - 2500) < 2")
        saved = self.page.evaluate("url => VoiceOfMLReaderStore.get(url)", source_b)
        self.assertNotIn("bookmark=", saved["readerUrl"])

    def test_overlay_bookmark_consumes_parent_navigation_records_and_reloads_history(self):
        self.serve("reading\n" * 3000)
        book = self.reader_url(name="overlay-book")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(book).query)["url"][0]
        self.open(book)
        self.page.evaluate("""async ({source, book}) => {
          await VoiceOfMLReaderStore.putBookmark({id:'overlay-bookmark', url:source,
            readerUrl:book, label:'Overlay', scrollTop:900, createdAt:1});
        }""", {"source": source, "book": book})
        handoff = book + "&" + urllib.parse.urlencode({
            "bookmark": "overlay-bookmark", "bookmark_source": source,
            "return": self.origin + "/search/#/Test?q=retained", "nav": "return-token"
        })
        shell = """<!doctype html><body><script>
          window.openReader = readerUrl => {
            const share = new URL(readerUrl); share.searchParams.delete('return'); share.searchParams.delete('nav');
            history.replaceState({voiceReaderOverlay:true, readerUrl, extra:'keep'}, '', share.href);
            sessionStorage.setItem('reader-navigation-current', JSON.stringify({readerUrl, shareUrl:share.href,
              returnScroll:{top:123}, extra:'keep'}));
            document.querySelector('iframe')?.remove();
            const frame = document.createElement('iframe'); frame.className='reader-overlay';
            frame.style='width:100%;height:750px'; frame.src=readerUrl; document.body.append(frame);
          };
          openReader(history.state?.readerUrl || JSON.parse(sessionStorage.getItem('reader-navigation-current') || 'null')?.readerUrl || HANDOFF);
        </script>""".replace("HANDOFF", json.dumps(handoff))
        def overlay(route):
            if route.request.is_navigation_request() and route.request.frame == self.page.main_frame:
                route.fulfill(content_type="text/html", body=shell)
            else:
                route.fallback()
        self.page.route("**/static/reader.html?**", overlay)
        self.page.goto(handoff)
        frame = self.page.frame_locator("iframe.reader-overlay")
        frame.locator("#viewport").evaluate("node => node.scrollTop")
        self.page.wait_for_function("() => !new URL(location.href).searchParams.has('bookmark')")
        state = self.page.evaluate("({state:history.state, saved:JSON.parse(sessionStorage.getItem('reader-navigation-current'))})")
        self.assertNotIn("bookmark=", state["state"]["readerUrl"])
        self.assertNotIn("bookmark=", state["saved"]["readerUrl"])
        self.assertNotIn("bookmark=", state["saved"]["shareUrl"])
        self.assertEqual(state["state"]["extra"], "keep")
        self.assertEqual(state["saved"]["returnScroll"], {"top": 123})
        self.assertIn("nav=return-token", state["state"]["readerUrl"])
        self.assertEqual(frame.locator("#viewport").evaluate("node => node.scrollTop"), 900)
        frame.locator("#viewport").evaluate("node => {node.scrollTop=2500; node.dispatchEvent(new Event('scroll'));}")
        self.wait_for_store("async source => (await document.querySelector('iframe').contentWindow.VoiceOfMLReaderStore.get(source))?.scrollTop === 2500", source)
        for session_only in (False, True):
            if session_only:
                self.page.evaluate("history.replaceState(null, '', location.href)")
            self.page.reload()
            self.page.wait_for_function("() => document.querySelector('iframe')?.contentDocument?.querySelector('#viewport')?.scrollTop === 2500")
        self.page.evaluate("url => openReader(url)", handoff)
        self.page.wait_for_function("() => document.querySelector('iframe')?.contentDocument?.querySelector('#viewport')?.scrollTop === 900 && !new URL(location.href).searchParams.has('bookmark')")

    def test_remote_history_deletion_blocks_queued_and_future_saves_until_reopen(self):
        self.serve("reading\n" * 3000)
        url = self.reader_url(name="remote-history")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["url"][0]
        peer = self.context.new_page()
        store_path = urllib.parse.urlsplit(url).path.replace("reader.html", "reader-store.js")
        peer.route("**/store-peer", lambda route: route.fulfill(content_type="text/html", body=f'<script src="{store_path}"></script>'))
        peer.goto(self.origin + "/store-peer")
        for event_type in ("history-remove", "history-clear"):
            with self.subTest(event_type=event_type):
                self.open(url)
                self.wait_for_store("async source => !!(await VoiceOfMLReaderStore.get(source))", source)
                self.page.evaluate("""() => {
                  const store=VoiceOfMLReaderStore; window.__writes=0; window.__changes=[];
                  store.subscribe(change => { if(change.remote) window.__changes.push(change.type); });
                  window.VoiceOfMLReaderStore={...store, put:async entry => {
                    ++window.__writes; await store.put(entry);
                    if(window.__writes===1) await new Promise(resolve => window.__releaseWrite=resolve);
                  }};
                  document.querySelector('#viewport').scrollTop=900;
                }""")
                self.page.wait_for_function("() => !!window.__releaseWrite")
                self.page.locator("#viewport").evaluate("node => {node.scrollTop=1500; node.dispatchEvent(new Event('scroll'));}")
                self.page.wait_for_timeout(650)
                await_event = {"type": event_type, "source": source}
                peer.evaluate("async ({type,source}) => type==='history-clear' ? VoiceOfMLReaderStore.clearHistory() : VoiceOfMLReaderStore.remove(source)", await_event)
                self.page.wait_for_function("type => window.__changes.includes(type)", arg=event_type)
                self.page.evaluate("window.__releaseWrite()")
                self.page.locator("#viewport").evaluate("node => {node.scrollTop=2200; node.dispatchEvent(new Event('scroll'));}")
                self.page.wait_for_timeout(750)
                self.assertEqual(self.page.evaluate("window.__writes"), 1)
                self.assertIsNone(peer.evaluate("source => VoiceOfMLReaderStore.get(source)", source))
                self.page.reload()
                self.wait_for_store("async source => !!(await VoiceOfMLReaderStore.get(source))", source)
        peer.close()

    def test_bookmark_cleanup_preserves_unrelated_parent_and_session_navigation(self):
        self.serve("reading\n" * 3000)
        book = self.reader_url(name="cleanup-target")
        source = urllib.parse.parse_qs(urllib.parse.urlsplit(book).query)["url"][0]
        self.open(book)
        self.page.evaluate("async ({source,book}) => VoiceOfMLReaderStore.putBookmark({id:'cleanup-mark',url:source,readerUrl:book,label:'Target',scrollTop:900,createdAt:1})", {"source": source, "book": book})
        handoff = book + "&" + urllib.parse.urlencode({"bookmark": "cleanup-mark", "bookmark_source": source})
        unrelated = self.reader_url(name="different", bookmark="other", bookmark_source="other")
        record = {"readerUrl": unrelated, "shareUrl": unrelated, "extra": "preserve"}
        shell = """<!doctype html><body><script>
          history.replaceState({voiceReaderOverlay:true, readerUrl:OTHER}, '', OTHER);
          sessionStorage.setItem('reader-navigation-current', JSON.stringify(RECORD));
          const frame=document.createElement('iframe'); frame.className='reader-overlay';
          frame.style='height:750px;width:100%'; frame.src=HANDOFF; document.body.append(frame);
        </script>""".replace("OTHER", json.dumps(unrelated)).replace("RECORD", json.dumps(record)).replace("HANDOFF", json.dumps(handoff))
        self.page.route("**/unrelated-overlay", lambda route: route.fulfill(content_type="text/html", body=shell))
        self.page.goto(self.origin + "/unrelated-overlay")
        self.page.wait_for_function("() => {const w=document.querySelector('iframe')?.contentWindow; return w?.document.querySelector('#viewport')?.scrollTop===900 && !new URL(w.location.href).searchParams.has('bookmark');}")
        self.assertEqual(self.page.url, unrelated)
        self.assertEqual(self.page.evaluate("history.state.readerUrl"), unrelated)
        self.assertEqual(self.page.evaluate("JSON.parse(sessionStorage.getItem('reader-navigation-current'))"), record)

    def test_remote_unrelated_history_removal_does_not_suppress_current_media(self):
        self.serve(support.minimal_wav(), "audio/wav")
        self.open(self.reader_url("wav", name="remote-media"))
        self.page.wait_for_function("() => document.querySelector('audio').readyState >= 1")
        self.page.evaluate("""() => {
          window.__changes=[]; VoiceOfMLReaderStore.subscribe(change => {if(change.remote) window.__changes.push(change.type);});
          const media=document.querySelector('audio');
          Object.defineProperty(media,'currentTime',{value:45,writable:true});
        }""")
        peer = self.context.new_page()
        peer.goto(self.origin + "/search/static/reader.html?ext=unsupported")
        peer.evaluate("() => VoiceOfMLReaderStore.remove('unrelated')")
        self.page.wait_for_function("() => window.__changes.includes('history-remove')")
        self.page.locator("audio").evaluate("media => media.dispatchEvent(new Event('timeupdate'))")
        self.wait_for_store("async () => (await VoiceOfMLReaderStore.get(new URL(location.href).searchParams.get('url')))?.mediaTime===45")
        peer.evaluate("() => VoiceOfMLReaderStore.clearHistory()")
        self.page.wait_for_function("() => window.__changes.includes('history-clear')")
        self.page.locator("audio").evaluate("media => {media.currentTime=60; for(const type of ['timeupdate','pause','seeked']) media.dispatchEvent(new Event(type));}")
        self.page.wait_for_timeout(750)
        self.assertIsNone(self.page.evaluate("() => VoiceOfMLReaderStore.get(new URL(location.href).searchParams.get('url'))"))
        peer.close()

    def test_search_reopen_rebuilds_live_targets(self):
        self.serve("prefix\n" * 500 + "needle" + "\nending" * 500)
        self.open(self.reader_url())
        self.search("needle")
        self.page.locator("#full-search-toggle").click()
        self.assertEqual(self.page.locator("#content .full-search-highlight").count(), 0)
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-results .full-search-result").click()
        self.page.wait_for_function("() => document.querySelector('#viewport').scrollTop > 1000")
        self.assertEqual(self.page.locator("#content .full-search-highlight").text_content(), "needle")

    def test_search_scans_beyond_20000_nodes_and_cancels_old_query(self):
        self.serve("<main>" + "<span>ordinary </span>" * 21000 + "<p>unique-tail</p></main>", "text/html")
        self.open(self.reader_url("html"))
        self.search("unique-tail")
        self.assertEqual(self.page.locator(".full-search-result").count(), 1)
        self.page.locator("#full-search-input").evaluate("""input => {
          input.value='ordinary'; input.dispatchEvent(new Event('input'));
          input.value='unique-tail'; input.dispatchEvent(new Event('input'));
        }""")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '1 个结果'")
        self.assertEqual(self.page.frame_locator(".html-frame").locator(".full-search-highlight").all_text_contents(), ["unique-tail"])

    def test_search_retains_matches_across_character_batches_and_result_cap(self):
        text = "x" * 65533 + "boundary-needle" + " y" * 100
        self.serve(text)
        self.open(self.reader_url())
        self.search("boundary-needle")
        self.assertEqual(self.page.locator(".full-search-result").count(), 1)
        self.page.locator("#full-search-input").fill("x")
        self.page.wait_for_function("() => document.querySelector('#full-search-status').textContent === '100+ 个结果'")
        self.assertEqual(self.page.locator("#content mark").count(), 100)

    def test_html_preserves_css_prose_and_tracks_progress_and_headings(self):
        html = "<p>Examples: url(icon.png) and @import theme.css;</p>" + "".join(
            f"<h1 id='chapter-{i}'>Chapter {i}</h1><p style='height:1100px'>text</p>" for i in range(4))
        self.serve(html, "text/html")
        self.open(self.reader_url("html"))
        frame = self.page.frame_locator(".html-frame")
        self.assertIn("url(icon.png) and @import theme.css;", frame.locator("body").inner_text())
        self.assertTrue(self.page.locator(".html-frame").get_attribute("title"))
        frame.locator("#chapter-2").evaluate("node => node.scrollIntoView()")
        self.page.locator("#history").click()
        self.page.wait_for_function("() => Number(document.querySelector('.reader-progress-range').value) > 40")
        self.page.wait_for_function("() => document.querySelectorAll('.toc-item')[2].classList.contains('is-current')")
        self.page.locator(".reader-chapter-next").click()
        self.page.wait_for_function("() => document.querySelectorAll('.toc-item')[3].classList.contains('is-current')")

    def test_html_keyboard_turns_use_iframe_and_reduced_motion(self):
        self.context.clear_permissions()
        self.page.emulate_media(reduced_motion="reduce")
        self.serve("<p style='height:8000px'>Long document</p>", "text/html")
        self.open(self.reader_url("html"))
        self.page.locator(".html-frame").evaluate("""frame => {
          const original = frame.contentWindow.scrollBy.bind(frame.contentWindow);
          frame.contentWindow.scrollBy = options => { window.__turn = options; original(options); };
        }""")
        self.page.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'PageDown', bubbles:true, cancelable:true}))")
        self.assertEqual(self.page.evaluate("window.__turn.behavior"), "instant")
        self.assertGreater(self.page.locator(".html-frame").evaluate("frame => frame.contentWindow.scrollY"), 100)
        self.page.frame_locator(".html-frame").locator("body").evaluate("node => node.dispatchEvent(new KeyboardEvent('keydown', {key:'PageUp', bubbles:true, cancelable:true}))")
        self.assertEqual(self.page.locator(".html-frame").evaluate("frame => frame.contentWindow.scrollY"), 0)

    def test_bookmark_dialog_focus_inert_and_invoker_restoration(self):
        self.serve("A document\n" * 200)
        self.open(self.reader_url())
        self.page.evaluate("document.querySelector('#download').inert = true")
        self.page.locator("#history").click()
        invoker = self.page.locator(".reader-progress-bookmark")
        invoker.click()
        self.assertEqual(self.page.locator("#bookmark-popover").get_attribute("aria-labelledby"), "bookmark-prompt")
        self.assertTrue(self.page.locator("#history-panel").evaluate("node => node.inert"))
        self.page.keyboard.press("Shift+Tab")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "bookmark-cancel")
        self.page.keyboard.press("Tab")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "bookmark-label")
        self.page.keyboard.press("Tab")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "bookmark-excerpt-input")
        self.page.keyboard.press("Escape")
        self.assertTrue(invoker.evaluate("node => node === document.activeElement"))
        self.assertEqual(invoker.get_attribute("aria-expanded"), "false")
        self.assertFalse(self.page.locator("#history-panel").evaluate("node => node.inert"))
        self.assertTrue(self.page.locator("#download").evaluate("node => node.inert"))

    def test_media_updates_percentage_and_saves_during_continuous_updates(self):
        self.serve(support.minimal_wav(), "audio/wav")
        self.open(self.reader_url("wav"))
        self.page.wait_for_function("() => document.querySelector('audio').readyState >= 1")
        self.page.evaluate("""() => {
          const media = document.querySelector('audio');
          Object.defineProperty(media, 'duration', {value:100});
          Object.defineProperty(media, 'currentTime', {value:45, writable:true});
          media.dispatchEvent(new Event('timeupdate'));
          window.__tick = setInterval(() => media.dispatchEvent(new Event('timeupdate')), 100);
        }""")
        self.page.locator("#history").click()
        self.page.wait_for_function("() => document.querySelector('.reader-progress-range').value === '45'")
        self.assertEqual(self.page.locator("#media-tab").get_attribute("aria-controls"), "media-panel")
        self.assertEqual(self.page.locator("#media-panel").get_attribute("role"), "tabpanel")
        self.assertTrue(self.page.locator("audio").get_attribute("aria-label"))
        self.wait_for_store("""async () => {
          const url = new URL(location.href).searchParams.get('url');
          return (await VoiceOfMLReaderStore.get(url))?.mediaTime === 45;
        }""")
        self.page.evaluate("clearInterval(window.__tick)")

    def test_image_disposal_removes_handlers_before_fallback(self):
        self.page.add_init_script("""(() => {
          const NativeImage = window.Image;
          window.Image = function(...args) { const image = new NativeImage(...args); window.__image = image; return image; };
        })()""")
        held = []
        self.page.route("**/api/reader-content**", lambda route: held.append(route))
        self.page.goto(self.reader_url("png"), wait_until="domcontentloaded")
        self.page.wait_for_function("() => window.__image?.getAttribute('src')")
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:false}))")
        self.assertEqual(self.page.evaluate("[window.__image.onload, window.__image.onerror, window.__image.getAttribute('src')]"), [None, None, None])
        for route in held:
            route.abort()
        self.assertEqual(self.page.locator("html").get_attribute("data-reader-phase"), "disposed")

    def test_folder_navigation_has_one_handler_and_preserves_explicit_target(self):
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/folder.txt"
        folder = self.origin + "/search/#/Test?folder_self=explicit"
        self.page.add_init_script("sessionStorage.setItem('reader-resolve:folder-id', " + json.dumps(json.dumps({
            "url": source, "extension": "txt", "title": "Folder", "repo": "Test", "folder": ["metadata"]
        })) + ")")
        self.serve("Folder document")
        self.page.goto(self.origin + "/search/static/reader.html?" + urllib.parse.urlencode({
            "id": "folder-id", "ext": "txt", "path": "Test/explicit", "folder_url": folder
        }))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        # With a top-level Reader, the explicit folder URL must win after metadata resolves.
        self.page.route(self.origin + "/search/", lambda route: route.fulfill(content_type="text/html", body="Folder"))
        self.page.locator("#reader-path").click()
        self.page.wait_for_url(folder)
        self.assertEqual(self.page.url, folder)

    def test_chapter_manifest_restores_structured_history_and_bookmark(self):
        source = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/chapter-manifest.json"
        manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
            {"index": i, "path": f"chapter-{i}.xhtml", "title": f"Chapter {i}", "bytes": 100} for i in range(1, 5)
        ]}
        def serve(route):
            raw = urllib.parse.parse_qs(urllib.parse.urlsplit(route.request.url).query)["url"][0]
            if raw.endswith("chapter-manifest.json"):
                route.fulfill(content_type="application/json", body=json.dumps(manifest))
            else:
                number = raw.rsplit("chapter-", 1)[-1].split(".")[0]
                route.fulfill(content_type="text/html", body=f"<h1>Chapter {number}</h1><p style='height:2000px'>Body</p>")
        self.page.route("**/api/reader-content**", serve)
        url = self.reader_url("epub-chapters", url=source)
        self.open(url)
        self.page.locator("#history").click()
        self.page.locator("#toc-list .panel-item-main").nth(2).click()
        self.page.locator('.reader-epub-chapter[data-chapter="3"]').evaluate("node => { const v=document.querySelector('#viewport'); v.scrollTop += node.getBoundingClientRect().top - v.getBoundingClientRect().top + 250; }")
        self.page.locator("#bookmark-ribbon").click()
        self.page.locator("#bookmark-add").click()
        self.wait_for_store("async source => (await VoiceOfMLReaderStore.listBookmarks(source)).length === 1", source)
        bookmark = self.page.evaluate("async source => (await VoiceOfMLReaderStore.listBookmarks(source))[0]", source)
        self.assertEqual(bookmark["chapterIndex"], 3)
        self.page.wait_for_timeout(700)
        self.open(url)
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter[data-chapter=\"3\"]')")
        offset = self.page.locator('.reader-epub-chapter[data-chapter="3"]').evaluate("node => document.querySelector('#viewport').getBoundingClientRect().top + 8 - node.getBoundingClientRect().top")
        self.assertAlmostEqual(offset, bookmark["chapterOffset"], delta=3)
        self.open(url + "&" + urllib.parse.urlencode({"bookmark": bookmark["id"], "bookmark_source": source}))
        self.page.wait_for_function("() => document.querySelector('.reader-epub-chapter[data-chapter=\"3\"]')")

    def test_github_bucket_source_uses_external_content_download_and_ocr(self):
        source = "/api/reader-bucket-resource?" + urllib.parse.urlencode({
            "path": "objects/aa/" + "a" * 64 + "/pages/page-000001.webp"
        })
        external = "https://voiceofml-search.hf.space"
        requests = []
        self.page.on("request", lambda request: requests.append(request.url))
        self.serve(support.PNG_BYTES, "image/png")
        self.open(self.reader_url("png", url=source, ocr=external + "/txt/test.txt"))
        content_requests = [url for url in requests if "/api/reader-content?" in url]
        self.assertEqual(len(content_requests), 1)
        self.assertTrue(content_requests[0].startswith(external + "/api/reader-content?"))
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(content_requests[0]).query)["url"], [external + source])
        download = self.page.locator("#download").get_attribute("href")
        self.assertTrue(download.startswith(external + "/api/download?"))
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(download).query)["link"], [external + source])
        self.assertEqual(self.page.locator("#ocr").get_attribute("href"), external + "/txt/test.txt")
        self.assertFalse(any(url.startswith(self.origin + "/api/") for url in requests))

    def test_github_back_preserves_hash_return_and_defaults_to_search(self):
        self.serve("Return navigation")
        self.page.route(self.origin + "/search/", lambda route: route.fulfill(content_type="text/html", body="Search"))
        for target in ("", "/", "/search/#/Test?folder_self=books"):
            with self.subTest(target=target):
                self.open(self.reader_url(**{"return": target}))
                self.page.locator("#back").click()
                expected = self.origin + (target if target.startswith("/search/") else "/search/")
                self.page.wait_for_url(expected)

    def test_github_metadata_folder_return_uses_hash_query(self):
        source = "https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/folder.txt"
        self.page.add_init_script("sessionStorage.setItem('reader-resolve:folder-id', " + json.dumps(json.dumps({
            "url": source, "extension": "txt", "title": "Folder", "repo": "Test", "folder": ["books", "with spaces"]
        })) + ")")
        self.serve("Folder document")
        self.open(self.origin + "/search/static/reader.html?id=folder-id&ext=txt")
        self.page.route(self.origin + "/search/", lambda route: route.fulfill(content_type="text/html", body="Folder"))
        self.page.locator("#reader-path").click()
        self.page.wait_for_url(self.origin + "/search/#/Test?folder_self=books%2Fwith+spaces")

    def test_foliate_cfi_selects_accented_and_inline_ranges_after_repeated_search(self):
        with zipfile.ZipFile(io.BytesIO(support.epub_with_many_chapters())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        chapter = next(name for name in files if name.endswith("chapter-1.xhtml"))
        files[chapter] = b'''<?xml version="1.0" encoding="UTF-8"?>
          <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Search</title></head><body>
          <h1>Search</h1><p style="height:1300px">Before</p>
          <p id="accent">caf&#233;</p><p style="height:1300px">Between</p>
          <p id="plain">cafe</p><p id="inline">inter<b>national</b></p><p style="height:1300px">After</p>
          </body></html>'''
        self.serve(support.zip_bytes(files), "application/epub+zip")
        self.open(self.reader_url("epub"))
        self.search("cafe")
        self.assertEqual(self.page.locator(".full-search-result").count(), 2)
        self.page.locator(".full-search-result").first.click()
        self.assertEqual(self.page.locator("#accent .full-search-highlight").text_content(), "caf\u00e9")
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator(".full-search-result").nth(1).click()
        self.assertEqual(self.page.locator("#plain .full-search-highlight").text_content(), "cafe")
        self.page.locator("#history").click()
        self.page.locator("#full-search-toggle").click()
        self.page.locator("#full-search-input").fill("international")
        self.page.locator(".full-search-result").click()
        self.page.locator("#inline .full-search-highlight").first.wait_for()
        self.assertEqual("".join(self.page.locator("#inline .full-search-highlight").all_text_contents()), "international")

    def test_chapter_resources_allow_siblings_within_manifest_family_only(self):
        object_root = "https://huggingface.co/datasets/vomebook/Reader-Assets/resolve/main/objects/aa/" + "a" * 64 + "/"
        for variant in ("", "epub-chapters/"):
            with self.subTest(variant=variant):
                base = object_root + variant
                source = base + "chapter-manifest.json"
                manifest = {"version": 1, "kind": "epub-chapters", "chapters": [
                    {"index": 1, "path": "chapters/chapter-1.xhtml", "bytes": 100}
                ]}
                self.page.route("**/api/reader-content**", lambda route: route.fulfill(
                    content_type="application/json" if "chapter-manifest.json" in route.request.url else "text/html",
                    body=json.dumps(manifest) if "chapter-manifest.json" in route.request.url else """
                      <h1>Chapter</h1><img id='cover' src='../resources/cover.svg'>
                      <img id='escape' src='../../resources/outside.svg'>
                      <img id='external' src='https://evil.test/cover.svg'>
                    """))
                self.open(self.reader_url("epub-chapters", url=source))
                self.assertEqual(self.page.locator("#cover").get_attribute("src"), base + "resources/cover.svg")
                self.assertIsNone(self.page.locator("#escape").get_attribute("src"))
                self.assertIsNone(self.page.locator("#external").get_attribute("src"))


if __name__ == "__main__":
    unittest.main()
