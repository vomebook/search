"""Concrete search-UI keyboard/DOM accessibility regressions, not AT speech certification."""
import unittest
from tests import test_paging_recovery as support


class SearchAccessibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.PagingRecoveryTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        support.PagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.fixture = support.PagingRecoveryTests()
        self.fixture.setUp()
        self.page = self.fixture.page
        self.page.emulate_media(reduced_motion='reduce')

    def tearDown(self):
        self.assertEqual(self.fixture.errors, [])
        self.fixture.tearDown()

    def test_scrolling_never_rewrites_an_exposed_text_editor_or_live_status(self):
        self.page.evaluate('''()=>{
          window.positionWrites=[];window.liveChanges=0;
          const input=DOM.currentResultPosition;
          const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
          Object.defineProperty(input,'value',{get(){return descriptor.get.call(this)},set(value){
            positionWrites.push({hidden:this.hidden,value});descriptor.set.call(this,value);
          }});
          new MutationObserver(rows=>liveChanges+=rows.length).observe(document.querySelector('#search-announcement'),{childList:true});
        }''')
        self.page.wait_for_timeout(300)
        self.page.evaluate('liveChanges=0')
        for index in (10, 30, 5, 40):
            self.page.evaluate('i=>setResultScrollTop(getVirtualOffset(i))', index)
        self.assertTrue(self.page.locator('#current-result-position').is_hidden())
        self.assertEqual(self.page.get_by_role('textbox', name='跳转条目号').count(), 0)
        self.assertEqual(self.page.get_by_role('button', name='跳转到指定结果', exact=True).count(), 1)
        self.assertTrue(self.page.evaluate('positionWrites.length>0&&positionWrites.every(row=>row.hidden)'))
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.evaluate('liveChanges'), 0)
        self.page.get_by_role('button', name='跳转到指定结果', exact=True).press('Enter')
        field = self.page.get_by_role('textbox', name='跳转条目号')
        self.assertTrue(field.evaluate('node=>node===document.activeElement'))
        field.fill('3')
        field.press('Escape')
        self.assertTrue(self.page.locator('#current-result-position').is_hidden())
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'edit-result-position')

    def test_repository_display_and_accessible_names_keep_original_english_ids(self):
        expected = ['A-Historical-Learning-Data', 'GPCREducation', 'Japanese-Materials',
            'MLMRL-Hub', 'MLMRL-Library', 'Omnibus', 'SovMaterials', 'Teachers', 'VOMEBOOK']
        observed = self.page.evaluate('''names=>{
          routeRenderId++;
          STATE.leftSidebarOpen=true;updateSidebarVisibility();
          renderRepoListItems(names.map(name=>({name:'VoiceOfML/'+name,count:1})));
          return Array.from(DOM.sidebarContent.querySelectorAll('.repo-list-item'),node=>
            ({id:node.dataset.repo,text:node.querySelector('.repo-name').textContent,label:node.getAttribute('aria-label')}));
        }''', expected)
        self.assertEqual(observed, [dict(id=key,text=key,label='打开仓库：'+key) for key in expected])
        self.assertFalse(self.page.evaluate("'repositoryLabel' in VoiceOfMLReader"))
        self.page.evaluate("()=>{STATE.mode='global';const host=document.createElement('div');document.body.append(host);host.append(createResultRow({Repo:'VoiceOfML/Teachers',File:'book',Extension:'txt',Folder:[],Size:1},101))}")
        row = self.page.locator('.result-item[data-index="101"]')
        self.assertEqual(row.locator('.result-repo-tag').inner_text(), 'Teachers')
        self.assertEqual(row.locator('.result-repo-tag').get_attribute('aria-label'), '打开仓库：Teachers')
        self.assertEqual(row.locator('.result-repo-tag').get_attribute('data-repo'), 'Teachers')
        self.assertIn('Teachers', row.locator('.result-path').inner_text())

    def test_toolbar_actions_have_chinese_function_names_and_no_svg_noise(self):
        self.assertIn(self.page.locator('#hamburger-btn').get_attribute('aria-label'), ['打开仓库导航','关闭仓库导航'])
        self.assertEqual(self.page.locator('#settings-btn').get_attribute('aria-label'), '打开搜索过滤')
        self.assertEqual(self.page.locator('#theme-btn').get_attribute('aria-label'), '切换到浅色主题')
        self.assertEqual(self.page.locator('#mobile-toggle-btn').get_attribute('aria-label'), '切换到手机版')
        self.assertEqual(self.page.locator('#header svg:not([aria-hidden="true"])').count(), 0)

    def test_folder_bulk_controls_preserve_filters_and_cancel_superseded_rendering(self):
        self.page.locator('#settings-btn').click()
        self.page.evaluate('''()=>{
          const node=(path,children=[])=>({path,name:path||'根目录',children,count:1,
            isRoot:!path,hasChildren:!!children.length,hasDirectFiles:true,showSelfToggle:!!children.length});
          STATE.mode='repo';STATE.folderTree=[node('',[node('alpha',[node('alpha/deep',[node('alpha/deep/hit')])]),node('beta')])];
          STATE.folderTreeCollapsed={};STATE.filterFolderSubtrees=['alpha/deep/hit'];STATE.filterFolderSelfs=['beta'];
          STATE.filterFolders=['alpha/deep/hit','beta'];DOM.filterFolderSection.style.display='';renderFilterFolderTree();
        }''')
        self.page.wait_for_function('!folderTreeRenderQueue.length')
        before = self.page.evaluate('''()=>({selfs:STATE.filterFolderSelfs.slice(),subtrees:STATE.filterFolderSubtrees.slice(),
          filters:STATE.filterFolders.slice(),total:STATE.total,ids:STATE.results.map(r=>r.ID),url:location.href,request:searchRequestId})''')
        toggle = self.page.locator('#folder-toggle-all')
        self.assertEqual(toggle.count(), 1)
        self.assertEqual(self.page.locator('#folder-collapse-all, #folder-expand-all').count(), 0)
        self.assertEqual(toggle.inner_text(), '收起')
        toggle.press('Enter')
        self.assertEqual(toggle.inner_text(), '展开')
        self.assertEqual(toggle.get_attribute('aria-label'), '展开所有子目录')
        self.assertEqual(toggle.get_attribute('aria-expanded'), 'false')
        self.page.wait_for_function('!folderTreeRenderQueue.length')
        self.assertEqual(self.page.locator('#filter-folder-tree .filter-folder-item').count(), 1)
        self.assertTrue(self.page.evaluate('Object.values(STATE.folderTreeCollapsed).every(Boolean)'))
        self.page.locator('#filter-folder-tree .tree-toggle').first.click()
        self.assertEqual(toggle.inner_text(), '收起')
        self.page.wait_for_function('!folderTreeRenderQueue.length')
        self.assertEqual(self.page.locator('#filter-folder-tree .filter-folder-item').count(), 3)
        self.assertTrue(self.page.locator('[data-path="alpha"] input').evaluate('n=>n.indeterminate'))
        self.assertTrue(self.page.locator('[data-path="beta"] input').is_checked())
        toggle.press('Space')
        self.assertEqual(toggle.inner_text(), '展开')
        toggle.press('Space')
        self.assertEqual(toggle.inner_text(), '收起')
        self.assertEqual(toggle.get_attribute('aria-label'), '收起所有子目录')
        self.assertEqual(toggle.get_attribute('aria-expanded'), 'true')
        self.page.wait_for_function('!folderTreeRenderQueue.length')
        self.assertEqual(self.page.locator('#filter-folder-tree .filter-folder-item').count(), 5)
        self.assertTrue(self.page.locator('[data-path="alpha/deep/hit"] input').is_checked())
        self.assertTrue(self.page.evaluate('Object.values(STATE.folderTreeCollapsed).every(v=>!v)'))
        after = self.page.evaluate('''()=>({selfs:STATE.filterFolderSelfs.slice(),subtrees:STATE.filterFolderSubtrees.slice(),
          filters:STATE.filterFolders.slice(),total:STATE.total,ids:STATE.results.map(r=>r.ID),url:location.href,request:searchRequestId})''')
        self.assertEqual(after, before)
        self.assertTrue(toggle.evaluate('n=>document.activeElement===n'))
        self.page.locator('#filter-folder-tree .tree-toggle').first.click()
        self.assertEqual(toggle.inner_text(), '展开')
        toggle.press('Enter')
        self.page.wait_for_function('!folderTreeRenderQueue.length')
        self.assertEqual(self.page.locator('#filter-folder-tree .filter-folder-item').count(), 5)

        # Interrupt an unfinished large expansion, then replace the route/tree.
        self.page.evaluate('''()=>{
          STATE.folderTree=[{path:'wide',name:'wide',hasChildren:true,children:Array.from({length:256},(_,i)=>
            ({path:'wide/'+i,name:String(i),hasChildren:false,children:[],hasDirectFiles:true}))}];
          renderFilterFolderTree();setAllFoldersCollapsed(false);setAllFoldersCollapsed(true);
          routeRenderId++;STATE.folderTree=[{path:'new',name:'new',hasChildren:false,children:[],hasDirectFiles:true}];
          renderFilterFolderTree();
        }''')
        self.page.wait_for_function('!folderTreeRenderQueue.length')
        self.assertEqual(self.page.locator('#filter-folder-tree .filter-folder-item').count(), 1)
        self.assertEqual(self.page.locator('#filter-folder-tree .filter-folder-item').get_attribute('data-path'), 'new')
        self.assertTrue(toggle.is_disabled())

    def test_landmarks_names_and_skip_preserve_result_position(self):
        for role, name in [('searchbox', '搜索文件'), ('combobox', '结果排序:')]:
            self.assertEqual(self.page.get_by_role(role, name=name, exact=True).count(), 1)
        self.page.locator('#settings-btn').press('Enter')
        for role, name in [('spinbutton', '最小文件大小'), ('spinbutton', '最大文件大小'),
                           ('combobox', '最小文件大小单位'), ('combobox', '最大文件大小单位')]:
            self.assertEqual(self.page.get_by_role(role, name=name, exact=True).count(), 1)
        self.page.locator('#close-filters-btn').press('Enter')
        before = self.page.evaluate('getResultScrollTop()')
        url = self.page.url
        self.page.get_by_role('link', name='跳转到搜索结果').press('Enter')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'results-container')
        self.assertEqual(self.page.evaluate('getResultScrollTop()'), before)
        self.assertEqual(self.page.url, url)

    def test_switches_have_real_keyboard_and_visible_focus_in_both_themes(self):
        self.page.locator('#settings-btn').press('Enter')
        # The exact-search switch is visible and focusable in both backends. If
        # the section is ever collapsed it must also be inert and untabbable.
        section = self.page.locator('#exact-search-section')
        self.assertFalse(section.evaluate('node=>node.inert'))
        self.assertNotEqual(self.page.locator('#exact-search-toggle').evaluate('node=>node.tabIndex'), -1)
        self.page.evaluate('setExactSearchSectionVisible(false, false)')
        self.assertTrue(section.evaluate('node=>node.inert'))
        self.assertEqual(section.get_attribute('aria-hidden'), 'true')
        self.assertEqual(self.page.locator('#exact-search-toggle').evaluate('node=>node.tabIndex'), -1)
        self.page.locator('#exact-search-toggle').evaluate('node=>node.focus()')
        self.assertNotEqual(self.page.evaluate('document.activeElement.id'), 'exact-search-toggle')
        self.page.evaluate('setExactSearchSectionVisible(true, false)')
        self.assertFalse(section.evaluate('node=>node.inert'))
        for theme in ('dark', 'light'):
            self.page.evaluate("dark=>{STATE.isDark=dark;applyTheme()}", theme == 'dark')
            for selector in ('#mirror-links-toggle', '#history-toggle', '#search-folders-toggle', '#exact-search-toggle'):
                control = self.page.locator(selector)
                before = control.is_checked()
                control.focus()
                self.assertTrue(control.evaluate('node=>document.activeElement===node'), selector)
                self.assertNotEqual(control.evaluate('node=>getComputedStyle(node.nextElementSibling).outlineStyle'), 'none')
                control.press('Space')
                self.assertEqual(control.is_checked(), not before)
                control.press('Space')
        self.page.emulate_media(forced_colors='active')
        control = self.page.locator('#history-toggle')
        self.page.wait_for_function('()=>document.querySelector("#history-toggle").getBoundingClientRect().width>10')
        self.assertGreater(control.bounding_box()['width'], 10)
        self.assertNotEqual(control.evaluate('node=>getComputedStyle(node).opacity'), '0')
        self.assertEqual(self.page.locator('#history-toggle + .toggle-switch').evaluate('node=>getComputedStyle(node).display'), 'none')

    def test_sidebar_keyboard_entry_closed_inert_and_escape_from_editor(self):
        self.page.locator('#settings-btn').press('Enter')
        self.assertTrue(self.page.locator('#right-sidebar').evaluate('node=>node.contains(document.activeElement)'))
        self.assertEqual(self.page.locator('#settings-btn').get_attribute('aria-expanded'), 'true')
        self.page.locator('#filter-min-size').focus()
        query = self.page.locator('#search-input').input_value()
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'settings-btn')
        self.assertTrue(self.page.locator('#right-sidebar').evaluate('node=>node.inert'))
        self.assertEqual(self.page.locator('#search-input').input_value(), query)
        self.page.locator('#filter-min-size').evaluate('node=>node.focus()')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'settings-btn')
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.evaluate('STATE.isMobile=true;applyMobileMode()')
        self.assertTrue(self.page.locator('#left-sidebar').evaluate('node=>node.inert'))
        self.page.locator('#hamburger-btn').press('Enter')
        self.assertEqual(self.page.locator('#hamburger-btn').get_attribute('aria-expanded'), 'true')
        self.assertTrue(self.page.locator('#main-content').evaluate('node=>node.inert'))
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'hamburger-btn')
        self.assertFalse(self.page.locator('#main-content').evaluate('node=>node.inert'))
        self.page.locator('#settings-btn').press('Enter')
        self.page.get_by_role('link', name='跳转到搜索结果').press('Enter')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'results-container')
        self.assertFalse(self.page.locator('#main-content').evaluate('node=>node.inert'))

    def test_history_native_buttons_keep_focus_delete_clear_and_escape(self):
        self.page.evaluate("saveHistory(['first query','second query'])")
        field = self.page.locator('#search-input')
        field.focus()
        self.assertEqual(self.page.get_by_role('button', name='搜索：first query', exact=True).count(), 1)
        field.press('ArrowDown')
        self.assertTrue(self.page.get_by_role('button', name='搜索：first query', exact=True).evaluate('node=>node===document.activeElement'))
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.get_by_role('button', name='删除搜索历史：first query', exact=True).evaluate('node=>node===document.activeElement'))
        self.page.wait_for_timeout(180)
        self.assertTrue(self.page.locator('#search-history-dropdown').is_visible())
        self.page.keyboard.press('Enter')
        self.assertEqual(self.page.evaluate('getHistory()'), ['second query'])
        self.assertTrue(self.page.get_by_role('button', name='搜索：second query', exact=True).evaluate('node=>node===document.activeElement'))
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'search-input')
        self.assertEqual(field.input_value(), 'paging')
        field.blur()
        field.focus()
        self.page.get_by_role('button', name='清空历史', exact=True).press('Enter')
        self.assertEqual(self.page.evaluate('getHistory()'), [])
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'search-input')
        self.assertTrue(self.page.locator('#search-history-dropdown').is_hidden())

    def test_history_keyboard_submission_uses_existing_restore_contract_once(self):
        self.page.evaluate("()=>{saveHistory(['paging remembered']);window.submissions=[];submitSearchQuery=(...args)=>submissions.push(args)}")
        self.page.locator('#search-input').focus()
        self.page.get_by_role('button', name='搜索：paging remembered', exact=True).press('Enter')
        self.assertEqual(self.page.evaluate('submissions'), [['paging remembered', dict(restore=True, blur=True)]])

    def test_global_repository_sidebar_orders_by_count_ascending(self):
        observed = self.page.evaluate("""()=>{
          routeRenderId++;
          STATE.leftSidebarOpen=true;updateSidebarVisibility();
          renderRepoListItems([
            {name:'VoiceOfML/Large',count:30},
            {name:'VoiceOfML/Small',count:2},
            {name:'VoiceOfML/Medium',count:10},
          ]);
          return Array.from(DOM.sidebarContent.querySelectorAll('.repo-list-item'),node=>node.dataset.repo);
        }""")
        self.assertEqual(observed, ['Small', 'Medium', 'Large'])

    def test_single_repository_browser_order_is_not_count_sorted(self):
        observed = self.page.evaluate("""()=>{
          const list=document.createElement('div');
          renderBrowserListItems(list,{folders:[
            {name:'large',path:'large',count:30},
            {name:'small',path:'small',count:2},
            {name:'medium',path:'medium',count:10},
          ],files:[]},'Test','');
          return Array.from(list.querySelectorAll('.browser-item .browser-name'),node=>node.textContent);
        }""")
        self.assertEqual(observed, ['large', 'small', 'medium'])

    def test_global_repository_filter_orders_by_count_ascending(self):
        observed = self.page.evaluate("""async()=>{
          repoList=[{name:'VoiceOfML/Large',count:30},{name:'VoiceOfML/Small',count:2},{name:'VoiceOfML/Medium',count:10}];
          STATE.filterRepos=[];routeRenderId++;
          await renderRepoFilter(routeRenderId);
          return Array.from(DOM.filterRepoList.querySelectorAll('input'),node=>node.value);
        }""")
        self.assertEqual(observed, ['VoiceOfML/Small', 'VoiceOfML/Medium', 'VoiceOfML/Large'])

    def test_sidebar_native_repository_directory_file_and_breadcrumb_actions(self):
        self.page.evaluate('''()=>{
          routeRenderId++;
          STATE.leftSidebarOpen=true;updateSidebarVisibility();
          renderRepoListItems([{name:'VoiceOfML/Test',count:1}]);
          window.navigations=[];ROUTER.navigate=(...args)=>navigations.push(args);
        }''')
        self.page.locator('#sidebar-content').get_by_role('button', name='打开仓库：Test', exact=True).press('Enter')
        self.assertEqual(self.page.evaluate('navigations'), [['repo', 'Test']])
        self.page.evaluate('''()=>{
          STATE.repo='Test';const list=document.createElement('div');list.className='browser-list';
          DOM.sidebarContent.replaceChildren(createSidebarBreadcrumb('docs/sub'),list);
          renderBrowserListItems(list,{folders:[{name:'inner',path:'docs/sub/inner',count:1}],
            files:[{name:'book',ext:'txt',size:1}]},'Test','docs/sub');
          window.downloads=[];list.addEventListener('click',event=>{
            if(event.target.closest('.browser-action')){downloads.push(event.target.textContent);event.stopImmediatePropagation();}
          },true);
          navigateToReader=()=>true;
        }''')
        self.page.get_by_role('button', name='打开文件夹：inner', exact=True).press('Enter')
        self.page.locator('.crumb-item').first.press('Enter')
        self.assertEqual(self.page.evaluate('navigations.slice(1)'), [['repo', 'Test', 'docs/sub/inner'], ['repo', 'Test', '']])
        self.page.get_by_role('button', name='下载：book.txt', exact=True).press('Enter')
        self.assertEqual(len(self.page.evaluate('downloads')), 1)
        self.assertEqual(self.page.locator('.crumb-item.current').get_attribute('aria-current'), 'location')

    def test_virtual_results_are_list_items_with_exact_positions_and_keyboard_focus(self):
        self.assertEqual(self.page.get_by_role('list', name='搜索结果', exact=True).count(), 1)
        row = self.page.locator('.result-item[data-index="0"]')
        self.assertEqual(row.get_attribute('role'), 'listitem')
        self.assertEqual(row.get_attribute('aria-posinset'), '1')
        self.assertEqual(row.get_attribute('aria-setsize'), '301')
        for label in ('选择文件：paging-0.txt', '复制链接：paging-0.txt', '下载：paging-0.txt', '在线阅读：paging-0.txt'):
            self.assertEqual(self.page.get_by_label(label, exact=True).count(), 1)
        self.page.get_by_role('link', name='跳转到搜索结果').press('Enter')
        self.page.keyboard.press('ArrowDown')
        self.assertTrue(row.evaluate('node=>node===document.activeElement'))
        self.page.keyboard.press('ArrowDown')
        self.assertEqual(self.page.evaluate('document.activeElement.dataset.index'), '1')
        self.page.evaluate('setResultScrollTop(getVirtualOffset(85));VSCROLL.renderStart=-1;renderVisible()')
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'results-container')
        self.assertLess(self.page.locator('.result-item').count(), 100)
        self.assertEqual(self.page.evaluate('[STATE.results.length,STATE.total]'), [100, 301])

    def test_directory_checkbox_names_and_immediate_collapse_respect_motion(self):
        self.page.locator('#settings-btn').press('Enter')
        self.page.evaluate('''()=>{
          DOM.filterFolderSection.style.display='';
          STATE.folderTree=[{name:'docs',path:'docs',count:1,showSelfToggle:true,children:[
            {name:'child',path:'docs/child',count:1,children:[]}]}];
          STATE.folderTreeCollapsed={docs:false};renderFilterFolderTree();
        }''')
        self.assertEqual(self.page.get_by_role('checkbox', name='选择文件夹：docs', exact=True).count(), 1)
        self.assertEqual(self.page.get_by_role('checkbox', name='选择文件夹：docs/child', exact=True).count(), 1)
        toggle = self.page.get_by_role('button', name='收起子文件夹：docs', exact=True)
        toggle.press('Enter')
        self.assertTrue(self.page.locator('#filter-folder-tree .tree-children').first.evaluate('node=>node.inert'))
        self.assertEqual(self.page.locator('#filter-folder-tree .tree-children').first.evaluate('node=>getComputedStyle(node).display'), 'none')
        self.page.get_by_role('button', name='展开子文件夹：docs', exact=True).press('Enter')
        self.assertFalse(self.page.locator('#filter-folder-tree .tree-children').first.evaluate('node=>node.inert'))

    def test_complete_result_status_and_toast_use_stable_polite_announcements(self):
        status = self.page.locator('#search-announcement')
        self.assertEqual(status.get_attribute('role'), 'status')
        self.assertEqual(status.get_attribute('aria-atomic'), 'true')
        self.page.evaluate('updateStatusBar()')
        self.page.wait_for_function('()=>document.querySelector("#search-announcement").textContent.includes("301")')
        self.page.evaluate('''()=>{
          window.statusMutations=0;
          new MutationObserver(rows=>statusMutations+=rows.length).observe(document.querySelector('#search-announcement'),{childList:true});
          for(let i=0;i<20;i++)updateStatusBar();
        }''')
        self.page.wait_for_timeout(350)
        self.assertEqual(self.page.evaluate('statusMutations'), 0)
        self.page.evaluate("showToast('复制失败，请重试')")
        self.page.wait_for_function('()=>document.querySelector("#search-announcement").textContent.includes("复制失败")')
        self.assertEqual(self.page.evaluate('document.querySelector("#results-container").getAttribute("aria-busy")'), 'false')
