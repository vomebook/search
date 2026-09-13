"""Lazy directory UI and keyboard ownership in real Chromium."""
import unittest
from tests import test_paging_recovery as paging


class SidebarKeyboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paging.PagingRecoveryTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        paging.PagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.fixture = paging.PagingRecoveryTests()
        self.fixture.setUp()
        self.page = self.fixture.page

    def tearDown(self):
        self.assertEqual(self.fixture.errors, [])
        self.fixture.tearDown()

    def test_collapsed_tree_avoids_hidden_dom_and_keeps_selection(self):
        result = self.page.evaluate('''() => {
          STATE.folderTree=[{name:'root',path:'root',count:1000,selfCount:0,children:
            Array.from({length:1000},(_,i)=>({name:'child'+i,path:'root/'+i,count:1,selfCount:1,children:[]}))}];
          STATE.folderTreeCollapsed={root:true};
          STATE.filterFolderSubtrees=[]; STATE.filterFolderSelfs=[]; STATE.filterFolders=[];
          renderFilterFolderTree();
          const initial=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const root=DOM.filterFolderTree.querySelector('.filter-folder-item');
          root.querySelector('input').click();
          root.querySelector('.tree-toggle').click();
          const expanded=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          const child=DOM.filterFolderTree.querySelector('[data-path="root/0"] input');
          const inherited=child.checked; child.click();
          const partial=root.querySelector('input').indeterminate;
          const excluded=!child.checked;
          root.querySelector('.tree-toggle').click(); root.querySelector('.tree-toggle').click();
          return {initial,expanded,inherited,partial,excluded,
            final:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length,
            siblings:DOM.filterFolderTree.querySelector('[data-path="root/1"] input').checked};
        }''')
        self.assertEqual(result, dict(initial=1, expanded=1001, inherited=True, partial=True,
                                      excluded=True, final=1001, siblings=True))

    def test_tree_rerender_has_one_delegated_action_and_respects_nested_collapse(self):
        result = self.page.evaluate('''() => {
          STATE.folderTree=[{name:'a',path:'a',count:3,selfCount:1,showSelfToggle:true,children:[
            {name:'b',path:'a/b',count:2,selfCount:1,children:[{name:'c',path:'a/b/c',count:1,selfCount:1,children:[]}]}]}];
          STATE.folderTreeCollapsed={'a':false,'a/b':true};
          STATE.filterFolderSubtrees=[];STATE.filterFolderSelfs=[];STATE.filterFolders=[];
          renderFilterFolderTree();renderFilterFolderTree();
          const rows=DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length;
          DOM.filterFolderTree.querySelector('.folder-self-toggle').click();
          const selected=STATE.filterFolderSelfs.includes('a');
          DOM.filterFolderTree.querySelector('[data-path="a/b"] .tree-toggle').click();
          return {rows,selected,final:DOM.filterFolderTree.querySelectorAll('.filter-folder-item').length,
            childChecked:DOM.filterFolderTree.querySelector('[data-path="a/b/c"] input').checked};
        }''')
        self.assertEqual(result, dict(rows=2, selected=True, final=3, childChecked=False))

    def test_form_controls_and_composition_keep_their_keys(self):
        result = self.page.evaluate('''() => {
          const dispatch=(el,key,extra={})=>{
            const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});
            el.dispatchEvent(event);return event.defaultPrevented;
          };
          const editor=document.createElement('div');editor.contentEditable='true';document.body.appendChild(editor);
          keyboardResultIndex=-1;
          const blocked=[DOM.searchInput,DOM.filterMinSize,DOM.sortSelect,DOM.themeBtn,editor]
            .flatMap(el=>['ArrowDown','ArrowUp'].map(key=>dispatch(el,key)));
          DOM.searchInput.value='keep'; STATE.query='keep';
          blocked.push(dispatch(DOM.searchInput,'Escape',{isComposing:true}));
          blocked.push(dispatch(DOM.searchInput,'Enter',{isComposing:true}));
          blocked.push(dispatch(document.body,'ArrowDown',{ctrlKey:true}));
          const untouched=keyboardResultIndex===-1 && STATE.query==='keep';
          const navigated=dispatch(document.body,'ArrowDown') && keyboardResultIndex===0;
          editor.remove();return {blocked,untouched,navigated};
        }''')
        self.assertFalse(any(result['blocked']))
        self.assertTrue(result['untouched'])
        self.assertTrue(result['navigated'])

    def test_enter_submits_search_once_and_buttons_do_not_open_results(self):
        result = self.page.evaluate('''() => {
          let searches=0,opened=0;
          doSearch=()=>{searches++}; openExternalWindow=()=>{opened++};
          DOM.searchInput.value='new query'; DOM.searchInput.focus();
          DOM.searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          keyboardResultIndex=0;
          DOM.themeBtn.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          return {searches,opened,query:STATE.query};
        }''')
        self.assertEqual(result, dict(searches=1, opened=0, query='new query'))
