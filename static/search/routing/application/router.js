// Navigation owns URL effects; route application and result ownership stay in the host.
(function () {
  /** @param {VoiceOfMLRouterDependencies} deps */
  function create(deps) {
    /** @param {string} mode @param {string | null} [repo] @param {string} [folder] */
    function navigate(mode, repo, folder) {
      const state = deps.readState();
      const params = deps.buildParams({ includeQuery: false, displaySizes: true });
      if (mode === "repo" && state.mode === "repo" && repo === state.repo) {
        state.filterFolderSelfs.forEach(path => params.append("folder_self", path));
        state.filterFolderSubtrees.forEach(path => params.append("folder_subtree", path));
      }
      if (mode !== "global" && folder) params.set("path", folder);
      else if (mode !== "global" && folder === undefined && state.browserPath) params.set("path", state.browserPath);
      const url = VoiceOfMLRoute.url(mode, repo, params);
      if (mode === "global") deps.clearBrowserPath();
      deps.setHash(url);
    }

    function sync() {
      if (deps.readerOpen()) return;
      const state = deps.readState();
      const params = deps.buildParams();
      if (state.mode === "global") state.filterRepos.forEach(repo => params.append("repo", repo.split("/").pop() || ""));
      if (state.mode !== "global" && state.browserPath) params.set("path", state.browserPath);
      if (state.mode !== "global") {
        state.filterFolderSelfs.forEach(folder => params.append("folder_self", folder));
        state.filterFolderSubtrees.forEach(folder => params.append("folder_subtree", folder));
      }
      const url = VoiceOfMLRoute.url(state.mode, state.repo, params);
      if (deps.currentURL() !== url) deps.replaceURL(url);
      deps.commitAppliedURL(deps.currentURL());
      deps.persistSession();
    }
    return { navigate, sync };
  }
  globalThis.VoiceOfMLRouter = { create };
})();
