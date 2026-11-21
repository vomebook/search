"""Focused browser keyboard/accessible-name regressions for the floating Reader UI.

Controlled Chromium verifies DOM/AX contracts, not actual screen-reader speech or
universal WCAG conformance. Uses the existing pinned two-site Reader fixtures.
"""
import unittest
from io import BytesIO
from urllib.parse import urlencode

from PIL import Image
from tests.reader.browser import test_reader_pdf_followup as support


class ReaderAccessibilityTests(unittest.TestCase):
    setUpClass = classmethod(support.PdfFollowupTests.setUpClass.__func__)
    setUp = support.PdfFollowupTests.setUp

    def open_book(self, extension='md', body=None, open_panel=True):
        self.page.emulate_media(reduced_motion='reduce')
        self.page.route('**/api/reader-content**', lambda route: route.fulfill(
            content_type='text/plain', body=body or '# Chapter one\n\n' + 'needle body\n\n' * 600 + '# Chapter two\n\nEnd'))
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/accessibility.' + extension,
            ext=extension)))
        self.page.wait_for_function("()=>['ready','failed'].includes(document.documentElement.dataset.readerPhase)")
        if extension == 'md':
            self.assertEqual(self.page.locator('html').get_attribute('data-reader-phase'), 'ready')
            # A two-heading document is intentionally too short to open the
            # directory hint. Exercise the ordinary accessible panel control.
            self.page.wait_for_function("()=>document.querySelectorAll('#toc-list .toc-item').length===2")
            self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'false')
            if open_panel:
                self.page.locator('#history').click()
                self.page.wait_for_function("()=>document.querySelector('#history').getAttribute('aria-expanded')==='true'")

    def open_with_keyboard(self):
        if self.page.locator('#history').get_attribute('aria-expanded') == 'true':
            self.page.locator('#history').press('Enter')
        self.page.locator('#history').press('Enter')

    def test_saved_theme_colors_both_shells_before_app_and_reader_scripts(self):
        # Hold the main entry out of the test entirely: a post-init assertion
        # would miss the dark frame while modules or IndexedDB are pending.
        self.page.route('**/static/app.js', lambda route: route.abort())
        self.page.route('**/static/reader.js', lambda route: route.abort())
        search_url = self.origin + support.PREFIX + '/'
        index = (support.ROOT / 'static/index.html').read_text()
        self.page.route(search_url, lambda route: route.fulfill(content_type='text/html', body=index))
        reader_url = self.origin + support.PREFIX + '/static/reader.html?ext=txt'
        self.page.route(self.origin + '/theme-test-setup', lambda route: route.fulfill(body='setup'))
        self.page.goto(self.origin + '/theme-test-setup')
        self.page.evaluate("localStorage.setItem('theme', 'light')")
        def colors():
            return self.page.evaluate('''() => {
              const root = getComputedStyle(document.documentElement);
              const shell = document.querySelector('.reader-toolbar') || document.body;
              return [root.colorScheme, root.backgroundColor, getComputedStyle(shell).backgroundColor,
                      document.querySelector('meta[name="theme-color"]').content];
            }''')
        light_search = ['light', 'rgb(253, 251, 255)', 'rgb(253, 251, 255)', '#fdfbff']
        light_reader = ['light', 'rgb(244, 245, 246)', 'rgb(255, 255, 255)', '#f4f5f6']
        cdp = self.context.new_cdp_session(self.page)
        for width, agent in ((390, 'Mozilla/5.0 (Linux; Android 14) Chrome/145 Mobile'),
                             (1280, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/145')):
            cdp.send('Network.setUserAgentOverride', {'userAgent': agent})
            self.page.set_viewport_size(dict(width=width, height=800))
            self.page.goto(search_url)
            self.assertEqual(colors(), light_search)
            self.assertEqual(self.page.locator('html').evaluate("el => el.classList.contains('mobile-boot')"), width == 390)
            self.page.goto(reader_url)
            self.assertEqual(colors(), light_reader)
            self.page.go_back()
            self.assertEqual(colors(), light_search)
            self.page.reload()
            self.assertEqual(colors(), light_search)
        self.page.evaluate("localStorage.setItem('theme', 'dark')")
        self.page.reload()
        self.assertEqual(colors(), ['dark', 'rgb(26, 28, 30)', 'rgb(26, 28, 30)', '#1a1c1e'])
        self.page.goto(reader_url)
        self.assertEqual(colors(), ['dark', 'rgb(17, 19, 21)', 'rgb(27, 30, 33)', '#111315'])

    def test_reader_history_restore_applies_theme_without_transition(self):
        self.open_book(open_panel=False)
        state = self.page.evaluate('''() => {
          const root = document.documentElement;
          localStorage.setItem('theme', 'light');
          root.classList.add('theme-transition');
          window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
          return [root.dataset.theme, root.classList.contains('theme-transition'),
                  document.querySelector('meta[name="theme-color"]').content, localStorage.getItem('theme')];
        }''')
        self.assertEqual(state, ['light', False, '#f4f5f6', 'light'])

    def test_compact_number_editors_hide_default_outline_only(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        # Use the existing offline PDF engine and real toolbar controls.
        self.page.goto(self.origin + support.PREFIX + '/static/reader.html?' + urlencode(dict(
            url='https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/accessible.pdf', ext='pdf')))
        self.page.wait_for_function("() => document.documentElement.dataset.readerPhase === 'ready'")
        outline = '''node => [node.matches(':focus-visible'), getComputedStyle(node).outlineStyle]'''
        for mode in (dict(forced_colors='none', contrast='no-preference'),
                     dict(forced_colors='none', contrast='more'), dict(forced_colors='active', contrast='no-preference')):
            self.page.emulate_media(**mode)
            expected = 'none' if mode == dict(forced_colors='none', contrast='no-preference') else 'solid'
            for selector in ('#page-number', '#zoom'):
                field = self.page.locator(selector)
                field.click()
                self.assertEqual(field.evaluate(outline), [True, expected])
            self.page.keyboard.press('Tab')
            self.assertEqual(self.page.locator('#zoom-in').evaluate(outline), [True, 'solid'])

    def test_forced_colors_keeps_bookmark_and_selected_controls_visible(self):
        self.open_book()
        self.page.emulate_media(forced_colors='active', reduced_motion='reduce')
        ribbon = self.page.locator('#bookmark-ribbon')
        self.page.wait_for_function('()=>getComputedStyle(document.querySelector("#bookmark-ribbon")).clipPath==="none"')
        self.assertGreater(float(ribbon.evaluate('node=>parseFloat(getComputedStyle(node).borderTopWidth)')), 0)
        self.assertIn('书签', ribbon.evaluate('node=>getComputedStyle(node,"::after").content'))
        for theme in ('dark', 'light'):
            self.page.evaluate('theme=>{document.documentElement.dataset.theme=theme}', theme)
            self.open_with_keyboard()
            self.assertNotEqual(self.page.locator('#toc-tab').evaluate('node=>getComputedStyle(node).outlineStyle'), 'none')
            self.page.keyboard.press('Escape')
            ribbon.focus()
            self.assertNotEqual(ribbon.evaluate('node=>getComputedStyle(node).outlineStyle'), 'none')
            self.assertEqual(self.page.locator('.reader-markdown').evaluate('node=>getComputedStyle(node).filter'), 'none')

    def test_names_relations_auto_open_and_keyboard_focus(self):
        self.page.set_viewport_size({'width': 1200, 'height': 800})
        self.open_book(open_panel=False)
        self.assertFalse(self.page.evaluate("document.querySelector('#history-panel').contains(document.activeElement)"))
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('.reader-skip-link').evaluate('node=>node===document.activeElement'))
        self.page.keyboard.press('Tab')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'back')
        self.open_with_keyboard()
        self.assertEqual(self.page.get_by_role('complementary', name='阅读选项').count(), 1)
        self.assertEqual(self.page.get_by_role('button', name='关闭阅读选项', exact=True).count(), 1)
        self.assertEqual(self.page.locator('#history').get_attribute('aria-controls'), 'history-panel')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'toc-tab')
        self.page.keyboard.press('ArrowRight')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'bookmarks-tab')
        self.page.keyboard.press('Home')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'toc-tab')
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history')
        self.assertTrue(self.page.locator('#history-panel').evaluate('node=>node.inert'))
        self.page.locator('#full-search-toggle').evaluate('node=>node.focus()')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history')

    def test_skip_link_reaches_reading_surface_without_changing_position(self):
        self.open_book()
        self.page.locator('#history-close').click()
        self.page.locator('#viewport').evaluate('node=>{node.scrollTop=450}')
        before = self.page.locator('#viewport').evaluate('node=>node.scrollTop')
        link = self.page.get_by_role('link', name='跳转到正文')
        link.focus()
        self.assertGreaterEqual(link.bounding_box()['y'], 0)
        self.assertNotEqual(link.evaluate('node=>getComputedStyle(node).outlineStyle'), 'none')
        link.press('Enter')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'viewport')
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'), before)
        self.page.keyboard.press('PageDown')
        self.page.wait_for_function('top=>document.querySelector("#viewport").scrollTop>top', arg=before)
        before = self.page.locator('#viewport').evaluate('node=>node.scrollTop')
        self.page.evaluate('''()=>{const host=document.createElement('span');
          document.querySelector('#content').append(host);
          const root=host.attachShadow({mode:'open'}),button=document.createElement('button');
          button.textContent='Chapter action';button.onclick=()=>window.__chapterAction=true;
          root.append(button);button.focus({preventScroll:true});}''')
        self.page.keyboard.press('Space')
        self.assertTrue(self.page.evaluate('!!window.__chapterAction'))
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'), before)

    def test_html_contrast_and_legacy_bookmark_on_initial_view(self):
        self.open_book('html', '''<!doctype html><meta charset="utf-8">
            <h1>Opening chapter</h1>
            <p id="light" style="color:#eee;background:#fff">Low contrast on light</p>
            <p id="dark" style="color:#222;background:#111">Low contrast on dark</p>
            <p id="same" style="color:#eee;background:#111">Already readable</p>
            <p style="height:1200px">Opening text</p>
            <h2>Later chapter</h2><p style="height:1200px">Later text</p>''')
        opening = self.page.evaluate('''async () => {
            const opening = new URL(location.href), url = opening.searchParams.get('url');
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(VoiceOfMLReaderStore.DB_NAME);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            // Seed the legacy record as written, without current store normalization.
            await new Promise((resolve, reject) => {
                const tx = db.transaction('bookmarks', 'readwrite');
                tx.objectStore('bookmarks').put({id:'legacy', url, label:'Old place', createdAt:1, htmlScrollTop:1300});
                tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error);
            });
            db.close();
            opening.searchParams.set('bookmark', 'legacy');
            opening.searchParams.set('bookmark_source', url);
            return opening.href;
        }''')
        self.page.goto(opening)
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.assertEqual(self.page.locator('.reader-loading-indicator').count(), 0)
        iframe = self.page.locator('iframe.html-frame')
        self.assertTrue(iframe.get_attribute('title').endswith('正文'))
        self.assertEqual(iframe.get_attribute('sandbox'), 'allow-same-origin')
        frame = self.page.frame_locator('iframe.html-frame')
        self.assertEqual(frame.get_by_role('heading', name='Later chapter').count(), 1)
        self.assertEqual(iframe.evaluate('frame => frame.contentWindow.scrollY'), 1300)
        self.assertNotIn('bookmark=', self.page.url)
        for element, color in (('light', 'rgb(17, 17, 17)'), ('dark', 'rgb(245, 245, 245)'), ('same', 'rgb(238, 238, 238)')):
            self.assertEqual(frame.locator(f'#{element}').evaluate('n => getComputedStyle(n).color'), color)

    def legacy_web_book(self, extension, digest):
        source = 'https://voiceofml-search.hf.space/api/reader-bucket-resource?path=' + (
            f'documents%2Fweb%2F{extension}%2F{digest * 64}%2Fdocument.html')
        self.page.route(source, lambda route: route.fulfill(content_type='text/html', body=(
            '<h1>Legacy article</h1>' + '<p>Readable paragraph</p>' * 120)))
        url = self.origin + support.PREFIX + '/static/reader.html?' + urlencode(dict(url=source, ext='html'))
        return source, url

    def assert_html_zoom(self, percent):
        self.page.locator('html[data-reader-phase="ready"]').wait_for()
        self.assertEqual(self.page.locator('#zoom').input_value(), str(percent))
        self.assertEqual(self.page.locator('iframe.html-frame').evaluate(
            'frame => Number(frame.contentDocument.documentElement.style.zoom)'), percent / 100)

    def test_latest_explicit_zoom_survives_next_legacy_web_book_and_reload(self):
        _, htm = self.legacy_web_book('htm', 'a')
        mht_source, mht = self.legacy_web_book('mht', 'b')
        _, unread = self.legacy_web_book('mht', 'c')
        self.page.goto(htm)
        self.assert_html_zoom(100)
        zoom = self.page.locator('#zoom')
        zoom.fill('80')
        zoom.press('Enter')
        self.page.goto(mht)
        self.assert_html_zoom(80)
        iframe = self.page.locator('iframe.html-frame')
        iframe.evaluate('frame => frame.contentWindow.scrollTo(0, 520)')
        self.page.wait_for_function('''async source => {
          const entry = await VoiceOfMLReaderStore.get(source);
          return entry?.zoom === 80 && entry.htmlScrollTop === 520;
        }''', arg=mht_source)

        self.page.goto(htm)
        self.assert_html_zoom(80)
        zoom.fill('100')
        zoom.press('Enter')
        self.assert_html_zoom(100)
        self.assertEqual(self.page.evaluate("localStorage.getItem('reader-zoom')"), '100')
        self.page.goto(unread)
        self.assert_html_zoom(100)
        # Insert the conflicting history just before opening so delayed pagehide
        # saves from the setup cannot mask which zoom the new Reader consumes.
        self.page.evaluate('url => VoiceOfMLReaderStore.put({url, extension:"html", zoom:80, htmlScrollTop:520})',
                           mht_source)
        self.page.goto(mht)
        self.assert_html_zoom(100)
        self.page.wait_for_function('document.querySelector("iframe.html-frame").contentWindow.scrollY === 520')
        self.page.reload()
        self.assert_html_zoom(100)
        self.page.wait_for_function('document.querySelector("iframe.html-frame").contentWindow.scrollY === 520')

        self.page.goto(unread)
        self.assert_html_zoom(100)
        self.page.evaluate('''async url => {
          localStorage.removeItem('reader-zoom');
          await VoiceOfMLReaderStore.put({url, extension:'html', zoom:80, htmlScrollTop:520});
        }''', mht_source)
        self.page.goto(mht)
        self.assert_html_zoom(80)

    def test_search_escape_restores_focus_and_expansion_state(self):
        self.open_book()
        self.open_with_keyboard()
        self.page.locator('#full-search-toggle').press('Enter')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'full-search-input')
        self.assertEqual(self.page.locator('#full-search-toggle').get_attribute('aria-controls'), 'full-search-view')
        self.assertEqual(self.page.locator('#full-search-toggle').get_attribute('aria-expanded'), 'true')
        self.page.locator('#full-search-input').fill('needle')
        self.page.wait_for_function("()=>document.querySelector('#full-search-status').textContent==='600 个结果'")
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'full-search-toggle')
        self.assertEqual(self.page.locator('#full-search-toggle').get_attribute('aria-expanded'), 'false')
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'true')
        self.page.locator('#full-search-toggle').press('Enter')
        self.page.locator('#bookmarks-tab').click()
        self.assertEqual(self.page.locator('#full-search-toggle').get_attribute('aria-expanded'), 'false')
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history')

    def test_directory_current_location_and_keys_do_not_scroll_the_book(self):
        self.open_book()
        current = self.page.locator('#toc-list [aria-current="location"]')
        self.assertEqual(current.count(), 0, 'the opening viewport is before the first chapter')
        self.assertEqual(self.page.locator('.toc-current-mark[aria-hidden="true"]').count(), 2)
        link = self.page.locator('#toc-list [role="link"]').first
        link.focus()
        before = self.page.locator('#viewport').evaluate('node=>node.scrollTop')
        self.page.keyboard.press('ArrowDown')
        self.assertEqual(self.page.locator('#viewport').evaluate('node=>node.scrollTop'), before)
        self.page.locator('#toc-list [role="link"]').last.press('Enter')
        self.page.wait_for_function('()=>document.querySelector("#history").getAttribute("aria-expanded")==="false"')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history')
        self.page.locator('#history').press('Enter')
        self.page.wait_for_function('()=>document.querySelector("#toc-list .toc-item:last-child [aria-current=location]")')
        self.assertEqual(current.count(), 1)
        self.page.get_by_role('button', name='搜索目录', exact=True).press('Enter')
        field = self.page.locator('#toc-panel .panel-search')
        self.assertTrue(field.evaluate('node=>node===document.activeElement'))
        self.assertEqual(self.page.locator('#toc-panel .panel-search-toggle').get_attribute('aria-controls'), field.get_attribute('id'))

    def test_no_directory_tabs_reach_bookmarks_and_history_with_keyboard(self):
        self.open_book('txt', 'Long plain text\n' * 2000)
        self.open_with_keyboard()
        reading = self.page.get_by_role('tab', name='阅读', exact=True)
        self.assertTrue(reading.evaluate('node => node === document.activeElement'))
        self.assertEqual(reading.get_attribute('aria-selected'), 'true')
        self.page.keyboard.press('ArrowRight')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'bookmarks-tab')
        self.assertTrue(self.page.locator('#bookmarks-panel').is_visible())
        self.page.keyboard.press('ArrowRight')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history-tab')
        self.assertTrue(self.page.locator('#history-view').is_visible())
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('#history-view').evaluate('node => node.contains(document.activeElement)'))
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'history')

    def test_keyboard_progress_can_undo_without_pointer_events(self):
        self.open_book('txt', 'Long plain text\n' * 2000)
        self.page.locator('#history').press('Enter')
        slider = self.page.get_by_role('slider', name='阅读进度')
        before = self.page.locator('#viewport').evaluate('node=>node.scrollTop')
        slider.press('End')
        self.page.wait_for_function('top=>document.querySelector("#viewport").scrollTop>top+100', arg=before)
        self.assertEqual(slider.get_attribute('aria-valuetext'), '100.0%')
        self.page.get_by_role('button', name='撤销进度调整').press('Enter')
        self.page.wait_for_function('top=>Math.abs(document.querySelector("#viewport").scrollTop-top)<2', arg=before)
        self.assertEqual(self.page.locator('.reader-progress-undo').count(), 1)
        self.assertTrue(self.page.locator('.reader-progress-undo').evaluate('node=>node.hidden'))
        self.assertTrue(slider.evaluate('node=>node===document.activeElement'))

    def test_restore_icon_matches_reference_shape_in_reader_panel(self):
        self.open_book('txt', 'Long plain text\n' * 2000)
        self.page.locator('#history').press('Enter')
        self.page.get_by_role('slider', name='阅读进度').press('End')
        button = self.page.get_by_role('button', name='撤销进度调整', exact=True)
        button.wait_for(state='visible')
        svg = button.locator('svg')
        self.assertEqual(svg.get_attribute('aria-hidden'), 'true')
        self.assertEqual(svg.get_attribute('focusable'), 'false')
        self.assertEqual(svg.get_attribute('viewBox'), '0 0 100 100')
        for width in (320, 390, 1280):
            self.page.set_viewport_size({'width': width, 'height': 844})
            for theme in ('dark', 'light'):
                with self.subTest(width=width, theme=theme):
                    self.page.evaluate("theme=>document.documentElement.dataset.theme=theme", theme)
                    info = button.evaluate('''node=>{
                      const r=node.getBoundingClientRect(),s=node.querySelector('svg').getBoundingClientRect();
                      const svg=node.querySelector('svg');
                      return {button:[r.width,r.height],svg:[s.width,s.height],
                        left:r.left,right:r.right,inner:s.left>=r.left&&s.right<=r.right&&s.top>=r.top&&s.bottom<=r.bottom,
                        fills:[...svg.querySelectorAll('path,circle')].map(n=>getComputedStyle(n).fill)};
                    }''')
                    self.assertEqual(info['button'], [28, 28])
                    self.assertEqual(info['svg'], [22, 22])
                    self.assertTrue(info['inner'] and info['left'] >= 0 and info['right'] <= width, info)
                    self.assertEqual(len(set(info['fills'])), 1)
                    self.assertNotEqual(info['fills'][0], 'none')
        # Raster geometry: a gap at lower left, broad downward arrow at left,
        # and a separate central dot. This distinguishes the reference from a
        # generic counterclockwise arrow without depending on platform fonts.
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.evaluate("document.documentElement.dataset.theme='dark'")
        image = Image.open(BytesIO(svg.screenshot(scale='css'))).convert('RGB')
        ink = lambda x, y: max(image.getpixel((x, y))) > 100
        self.assertTrue(ink(11, 11), 'central dot')
        self.assertTrue(ink(6, 6), 'upper-left ring')
        self.assertTrue(ink(18, 11), 'right ring')
        self.assertTrue(ink(10, 17), 'bottom ring')
        self.assertTrue(ink(2, 11) and ink(3, 12) and max(image.getpixel((4, 13))) > 60, 'downward arrow')
        self.assertFalse(ink(4, 17), 'gap below arrow')
        self.page.emulate_media(forced_colors='active', reduced_motion='reduce')
        forced = button.evaluate('''node=>{
          const paths=[...node.querySelectorAll('path,circle')];
          return {color:getComputedStyle(node).color,fills:paths.map(n=>getComputedStyle(n).fill)};
        }''')
        self.assertTrue(all(fill == forced['color'] for fill in forced['fills']), forced)

    def test_bookmark_names_delete_focus_and_modal_priority(self):
        self.open_book('txt', 'A document\n' * 200)
        self.page.evaluate('''async()=>{const url=new URL(location.href).searchParams.get('url');
          for(const [id,label] of [['one','First bookmark'],['two','Second bookmark']])
            await VoiceOfMLReaderStore.putBookmark({id,url,label,createdAt:id==='one'?2:1});}''')
        self.page.locator('#history').press('Enter')
        self.page.locator('#bookmarks-tab').press('Enter')
        self.page.get_by_role('button', name='编辑书签：First bookmark', exact=True).press('Enter')
        self.assertEqual(self.page.get_by_role('dialog').count(), 1)
        self.page.keyboard.press('Shift+Tab')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'bookmark-cancel')
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.locator('#history').get_attribute('aria-expanded'), 'true')
        self.page.get_by_role('button', name='删除书签：First bookmark', exact=True).press('Enter')
        self.page.wait_for_function("()=>document.querySelectorAll('#bookmarks-list .panel-item').length===1")
        self.assertTrue(self.page.get_by_role('button', name='Second bookmark', exact=True).evaluate('node=>node===document.activeElement'))
        self.page.get_by_role('button', name='删除书签：Second bookmark', exact=True).press('Enter')
        self.page.wait_for_function("()=>!document.querySelector('#bookmarks-list .panel-item')")
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'bookmarks-all')

    def test_pending_bookmark_delete_survives_switch_to_all_bookmarks(self):
        self.open_book('txt', 'A document\n' * 200)
        self.page.evaluate('''async () => {
          const url = new URL(location.href).searchParams.get('url');
          await VoiceOfMLReaderStore.putBookmark({id:'one', url, label:'Remove me', title:'This book'});
          await VoiceOfMLReaderStore.putBookmark({id:'two', url:url+'/other', label:'Keep me', title:'Other book'});
          const store = VoiceOfMLReaderStore;
          window.VoiceOfMLReaderStore = {...store, async removeBookmark(id) {
            await new Promise(resolve => { window.releaseBookmarkDelete = resolve; });
            await store.removeBookmark(id);
            window.bookmarkDeleteCompleted = true;
          }};
        }''')
        self.page.locator('#history').press('Enter')
        self.page.locator('#bookmarks-tab').press('Enter')
        self.page.get_by_role('button', name='删除书签：Remove me', exact=True).click()
        self.page.wait_for_function('() => typeof window.releaseBookmarkDelete === "function"')
        toggle = self.page.locator('#bookmarks-all')
        toggle.click()
        self.page.get_by_role('button', name='Other book · Keep me', exact=True).wait_for()
        self.page.evaluate('window.releaseBookmarkDelete()')
        self.page.wait_for_function('() => window.bookmarkDeleteCompleted === true')
        self.page.locator('#bookmarks-list [data-bookmark-id="one"]').wait_for(state='detached', timeout=2500)
        self.assertTrue(self.page.get_by_role('button', name='Other book · Keep me', exact=True).is_visible())
        self.assertTrue(toggle.evaluate('node => node === document.activeElement'))

    def check_stale_bookmark_save(self, reject):
        self.open_book('txt', 'A document\n' * 200)
        self.page.evaluate('''reject => {
          const store = VoiceOfMLReaderStore;
          window.VoiceOfMLReaderStore = {...store, async putBookmark(entry) {
            await new Promise(resolve => { window.releaseBookmarkSave = resolve; });
            if (reject) throw new Error('Delayed save failure');
            await store.putBookmark(entry);
          }};
        }''', reject)
        ribbon = self.page.locator('#bookmark-ribbon')
        label = self.page.locator('#bookmark-label')
        ribbon.click()
        label.fill('First bookmark')
        self.page.locator('#bookmark-add').click()
        self.page.wait_for_function('() => typeof window.releaseBookmarkSave === "function"')
        self.page.locator('#bookmark-cancel').click()
        ribbon.click()
        label.fill('Second draft')
        prompt = self.page.locator('#bookmark-prompt').text_content()
        self.page.evaluate('window.releaseBookmarkSave()')
        # Wait for a real write on success. On rejection, let the rejected
        # promise and the original save handler drain before inspecting UI.
        if not reject:
            self.page.wait_for_function('''async () => (await VoiceOfMLReaderStore.listAllBookmarks())
              .some(entry => entry.label === 'First bookmark')''')
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        self.assertTrue(self.page.get_by_role('dialog').is_visible())
        self.assertEqual(self.page.locator('#bookmark-prompt').text_content(), prompt)
        self.assertEqual(label.input_value(), 'Second draft')
        self.assertTrue(label.evaluate('node => node === document.activeElement'))
        self.assertTrue(self.page.locator('#bookmark-add').is_enabled())

    def test_stale_bookmark_save_does_not_close_new_editor(self):
        self.check_stale_bookmark_save(reject=False)

    def test_stale_bookmark_save_error_does_not_change_new_editor(self):
        self.check_stale_bookmark_save(reject=True)

    def test_failure_is_announced_without_stealing_keyboard_focus(self):
        self.open_book('unsupported', 'not supported')
        self.assertEqual(self.page.get_by_role('alert').count(), 1)
        self.assertIn('此文件暂不支持在线阅读', self.page.get_by_role('alert').inner_text())
        self.assertFalse(self.page.evaluate("document.querySelector('.reader-error').contains(document.activeElement)"))
