const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load the actual feature; expose private selection operations only in this VM
// so the exhaustive membership tests retain their original coverage.
function installSidebarTree(root, context) {
  vm.runInContext(fs.readFileSync(path.join(root, 'static/search/sidebar/domain/folder-selection.js'), 'utf8'), context);
  let source = fs.readFileSync(path.join(root, 'static/search/sidebar/presentation/folder-tree.js'), 'utf8');
  source = source.replace('return { render: renderFilterFolderTree,',
    'return { normalizeFolderSelection, setNodeSubtreeSelection, splitFolderSelection, getFolderSelfSet, render: renderFilterFolderTree,');
  vm.runInContext(source, context);
  const tree = context.VoiceOfMLSidebarFolderTree.create({
    readView: () => ({tree: context.STATE.folderTree || [], subtrees: context.STATE.filterFolderSubtrees || [],
      selfs: context.STATE.filterFolderSelfs || [], collapsed: {}, mode: 'repo', routeId: 1}),
    selection: context.VoiceOfMLSearchFolderSelection,
    notify: message => context.showToast(message),
    commitSelection(subtrees, selfs) {
      context.STATE.filterFolderSubtrees = subtrees;
      context.STATE.filterFolderSelfs = selfs;
      context.updateFilterCancelButtons();
      if (context.syncStateToURL) context.syncStateToURL(true);
      context.scheduleFilterSearch();
    },
  });
  Object.assign(context, tree, {persistFolderSelection: tree.persistSelection});
  return tree;
}
module.exports = {installSidebarTree};
