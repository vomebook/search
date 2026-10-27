"""Focused browser keyboard/accessible-name regressions for the floating Reader UI.

Controlled Chromium verifies DOM/AX contracts, not actual screen-reader speech or
universal WCAG conformance. Uses the existing pinned two-site Reader fixtures.
"""
import unittest
from urllib.parse import urlencode

from tests import test_reader_pdf_followup as support


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
        self.assertEqual(self.page.locator('#toc-list [aria-current="location"]').count(), 1)
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
        self.page.get_by_role('button', name='搜索目录', exact=True).press('Enter')
        field = self.page.locator('#toc-panel .panel-search')
        self.assertTrue(field.evaluate('node=>node===document.activeElement'))
        self.assertEqual(self.page.locator('#toc-panel .panel-search-toggle').get_attribute('aria-controls'), field.get_attribute('id'))

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

    def test_failure_is_announced_without_stealing_keyboard_focus(self):
        self.open_book('unsupported', 'not supported')
        self.assertEqual(self.page.get_by_role('alert').count(), 1)
        self.assertIn('此文件暂不支持在线阅读', self.page.get_by_role('alert').inner_text())
        self.assertFalse(self.page.evaluate("document.querySelector('.reader-error').contains(document.activeElement)"))
