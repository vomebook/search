// Search view identity, independent of DOM, storage, networking and clocks.
// The host supplies its own sort and legacy serialization callbacks.
(function () {
  /**
   * @typedef {{mode: string, repoFull: string, query: string, filterMinSize: number | null,
   *   filterMaxSize: number | null, searchFolders: boolean, exact: boolean,
   *   useLocalMode?: boolean, pageSize: number, filterRepos: string[], filterExtensions: string[],
   *   filterFolderSelfs: string[], filterFolderSubtrees: string[], filterFolders: string[]}} SearchViewState
   * @typedef {{key: string, scalars: (string | number | boolean | null | undefined)[], filters: string[][]}} SearchViewMemo
   * @typedef {{mode: string, repo: string, query: string, repos: string[], extensions: string[],
   *   folders: {self: string[], subtree: string[]}, plainFolders: string[], minSize: number | null,
   *   maxSize: number | null, sort: string, searchFolders: boolean, exact: boolean, pageSize: number,
   *   useLocalMode?: boolean | undefined}} SearchViewProjection
   * @typedef {{readonly state: SearchViewState, readonly surface: 'pages' | 'space', readonly getSort: () => string}} SearchViewSource
   * @typedef {(current: readonly (string | number | boolean | null | undefined)[], saved: readonly (string | number | boolean | null | undefined)[] | null | undefined) => boolean} Compare
   */

  /** @param {SearchViewState} state @param {'pages' | 'space'} surface @param {() => string} getSort */
  function scalarsOf(state, surface, getSort) {
    /** @type {(string | number | boolean | null | undefined)[]} */
    const values = [state.mode, state.repoFull || "", state.query || "", state.filterMinSize,
      state.filterMaxSize, getSort(), state.searchFolders, state.exact];
    if (surface === "pages") values.push(state.useLocalMode);
    values.push(state.pageSize);
    return values;
  }

  /** @param {SearchViewState} state */
  function filtersOf(state) {
    return [state.filterRepos, state.filterExtensions, state.filterFolderSelfs, state.filterFolderSubtrees,
      state.filterFolderSelfs.length || state.filterFolderSubtrees.length ? [] : state.filterFolders];
  }

  /** @param {string[]} values @param {'pages' | 'space'} surface */
  function sortedValues(values, surface) {
    return (surface === "pages" ? values.slice() : [...values]).sort();
  }

  /** @param {SearchViewState} state @param {'pages' | 'space'} surface @param {() => string} getSort @param {string[][]} filters */
  function projectionOf(state, surface, getSort, filters) {
    const common = {
      mode: state.mode,
      repo: state.repoFull || "",
      query: state.query || "",
      repos: sortedValues(state.filterRepos, surface),
      extensions: sortedValues(state.filterExtensions, surface),
      folders: {self: sortedValues(state.filterFolderSelfs, surface), subtree: sortedValues(state.filterFolderSubtrees, surface)},
      plainFolders: /** @type {string[]} */ (filters[4]).slice().sort(),
      minSize: state.filterMinSize,
      maxSize: state.filterMaxSize,
      sort: getSort(),
      searchFolders: state.searchFolders,
      exact: state.exact,
    };
    // Keep both property insertion order and getter evaluation order.
    return surface === "pages"
      ? {...common, useLocalMode: state.useLocalMode, pageSize: state.pageSize}
      : {...common, pageSize: state.pageSize};
  }

  /**
   * Return the original memo on a hit; callers decide when to replace it.
   * @param {() => SearchViewSource} getSource
   * @param {() => SearchViewMemo | null} getPrevious
   * @param {() => Compare} getCompare
   * @param {() => (projection: SearchViewProjection) => string} getEncoder
   * @returns {SearchViewMemo}
   */
  function resolve(getSource, getPrevious, getCompare, getEncoder) {
    const {state, surface, getSort} = getSource();
    const scalars = scalarsOf(state, surface, getSort);
    const filters = filtersOf(state);
    const previous = getPrevious();
    if (previous && getCompare()(scalars, previous.scalars)
        && filters.every((values, index) => getCompare()(values, /** @type {SearchViewMemo} */ (getPrevious()).filters[index]))) return /** @type {SearchViewMemo} */ (getPrevious());
    const key = getEncoder()(projectionOf(state, surface, getSort, filters));
    return {key, scalars, filters: filters.map(values => values.slice())};
  }

  /** @type {typeof globalThis & {VoiceOfMLSearchViewKey: typeof VoiceOfMLSearchViewKey}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchViewKey = {resolve};
})();
