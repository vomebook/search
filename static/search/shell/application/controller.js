// Shell transitions use a bounded state snapshot; the app owns preferences and routing.
(function () {
  /** @param {VoiceOfMLShellDependencies} deps */
  function create(deps) {
    const view = deps.view;

    function applyTheme() {
      const { isDark } = deps.readState();
      view.applyTheme(isDark);
      deps.notifyReaderTheme(isDark);
    }

    function toggleTheme() {
      const ripple = view.startThemeTransition(deps.readState().isDark);
      deps.setDark(!deps.readState().isDark);
      applyTheme();
      deps.writePreference("theme", deps.readState().isDark ? "dark" : "light");
      view.finishThemeTransition(ripple);
    }

    function updateSidebarVisibility() { view.updateSidebarVisibility(deps.readState()); }

    function applyMobileMode() {
      const { isMobile } = deps.readState();
      view.applyMobileMode(isMobile);
      deps.setSidebars(!isMobile, false);
      updateSidebarVisibility();
      view.finishMobileMode();
      deps.updateSidebarHeader();
      deps.updateSelectionUI();
      deps.scheduleScrollTrack();
    }

    function toggleMobile() {
      deps.setMobile(!deps.readState().isMobile);
      applyMobileMode();
      deps.writePreference("mobileMode", deps.readState().isMobile ? "mobile" : "desktop");
    }

    function closeLeftSidebar() {
      deps.setSidebars(false, deps.readState().rightSidebarOpen);
      if (deps.collapseLeftSidebar) deps.collapseLeftSidebar();
      else view.collapseLeftSidebar();
      updateSidebarVisibility();
      deps.syncURL();
    }

    function closeRightSidebar() {
      deps.setSidebars(deps.readState().leftSidebarOpen, false);
      updateSidebarVisibility();
      deps.syncURL();
    }

    /** @param {VoiceOfMLShellEvent} [event] */
    function toggleLeftSidebar(event) {
      const state = deps.readState();
      if (state.leftSidebarOpen) return closeLeftSidebar();
      deps.setSidebars(true, state.isMobile ? false : state.rightSidebarOpen);
      updateSidebarVisibility();
      deps.updateSidebarHeader();
      deps.syncURL();
      if (event?.detail === 0 || event?.type === 'keydown') view.focusSidebar('left');
    }

    /** @param {VoiceOfMLShellEvent} [event] */
    function toggleRightSidebar(event) {
      const state = deps.readState();
      if (state.rightSidebarOpen) return closeRightSidebar();
      deps.setSidebars(state.isMobile ? false : state.leftSidebarOpen, true);
      updateSidebarVisibility();
      deps.syncURL();
      if (event?.detail === 0 || event?.type === 'keydown') view.focusSidebar('right');
    }

    return { toggleTheme, applyTheme, toggleMobile, applyMobileMode, toggleLeftSidebar,
      toggleRightSidebar, closeLeftSidebar, closeRightSidebar, updateSidebarVisibility };
  }
  globalThis.VoiceOfMLShell = { create };
})();
