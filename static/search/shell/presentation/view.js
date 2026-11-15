// Theme, mobile chrome and sidebar accessibility share one bounded element set.
(function () {
  /** @param {HTMLElement} sidebar */
  function focusSearchSidebar(sidebar) {
    const control = Array.from(sidebar.querySelectorAll('button,a[href],input,select,[tabindex="0"]'))
      .find(node => !(/** @type {HTMLButtonElement} */ (node)).disabled && node.getClientRects().length && !node.closest('[hidden],[inert]'));
    (/** @type {HTMLElement} */ (control) || sidebar).focus({ preventScroll: true });
  }

  /** @param {() => VoiceOfMLShellElements} elements @param {boolean} zeroRippleMargins */
  function create(elements, zeroRippleMargins) {
    /** @param {boolean} isDark */
    function startThemeTransition(isDark) {
      const rect = elements().themeBtn.getBoundingClientRect();
      const ripple = document.createElement("div");
      ripple.className = "theme-ripple";
      ripple.style.left = (rect.left + rect.width / 2) + "px";
      ripple.style.top = (rect.top + rect.height / 2) + "px";
      ripple.style.background = isDark ? "#fff" : "#1a1c1e";
      if (zeroRippleMargins) {
        ripple.style.marginLeft = "-0px";
        ripple.style.marginTop = "-0px";
      }
      document.body.appendChild(ripple);
      document.body.classList.add("theme-transitioning");
      return ripple;
    }

    /** @param {HTMLElement} ripple */
    function finishThemeTransition(ripple) {
      ripple.addEventListener("animationend", () => {
        ripple.remove();
        document.body.classList.remove("theme-transitioning");
      });
    }

    /** @param {boolean} isDark */
    function applyTheme(isDark) {
      const el = elements();
      el.themeBtn.setAttribute('aria-label', isDark ? '切换到浅色主题' : '切换到深色主题');
      if (isDark) {
        document.body.classList.remove("light");
        el.themeIconLight.style.display = "none";
        el.themeIconDark.style.display = "";
      } else {
        document.body.classList.add("light");
        el.themeIconLight.style.display = "";
        el.themeIconDark.style.display = "none";
      }
    }

    /** @param {boolean} isMobile */
    function applyMobileMode(isMobile) {
      const el = elements();
      el.mobileToggleBtn.setAttribute('aria-label', isMobile ? '切换到电脑版' : '切换到手机版');
      if (isMobile) {
        document.body.classList.add("mobile");
        document.body.classList.remove("force-desktop");
        el.mobileIconPhone.style.display = "";
        el.mobileIconDesktop.style.display = "none";
      } else {
        document.body.classList.remove("mobile");
        document.body.classList.add("force-desktop");
        el.mobileIconPhone.style.display = "none";
        el.mobileIconDesktop.style.display = "";
      }
    }

    function finishMobileMode() { document.documentElement.classList.remove("mobile-boot"); }
    function collapseLeftSidebar() { elements().leftSidebar.classList.remove("expanded-wide"); }
    /** @param {'left' | 'right'} side */
    function focusSidebar(side) { focusSearchSidebar(side === 'left' ? elements().leftSidebar : elements().rightSidebar); }

    /** @param {VoiceOfMLShellState} state */
    function updateSidebarVisibility(state) {
      const el = elements();
      const main = /** @type {HTMLElement} */ (document.querySelector('#main-content'));
      const covered = state.isMobile && (state.leftSidebarOpen || state.rightSidebarOpen);
      const focusCovered = covered && main.contains(document.activeElement);
      main.inert = covered;
      /** @type {Array<[HTMLElement, HTMLElement, boolean]>} */
      const sidebars = [[el.leftSidebar, el.hamburgerBtn, state.leftSidebarOpen],
        [el.rightSidebar, el.settingsBtn, state.rightSidebarOpen]];
      for (const [sidebar, button, open] of sidebars) {
        const restoreFocus = !open && sidebar.contains(document.activeElement);
        sidebar.inert = !open;
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-label', sidebar === el.leftSidebar ? (open ? '关闭仓库导航' : '打开仓库导航') :
          (open ? '关闭搜索过滤' : '打开搜索过滤'));
        if (restoreFocus) button.focus({ preventScroll: true });
      }
      el.leftSidebar.classList.toggle("collapsed", !state.leftSidebarOpen);
      el.leftSidebar.classList.toggle("open", state.leftSidebarOpen);
      el.rightSidebar.classList.toggle("collapsed", !state.rightSidebarOpen);
      el.rightSidebar.classList.toggle("open", state.rightSidebarOpen);
      el.overlay.style.display = "";
      el.overlay.classList.toggle("open", state.isMobile && (state.leftSidebarOpen || state.rightSidebarOpen));
      if (focusCovered) focusSearchSidebar(state.rightSidebarOpen ? el.rightSidebar : el.leftSidebar);
    }

    return { startThemeTransition, finishThemeTransition, applyTheme, applyMobileMode, finishMobileMode,
      collapseLeftSidebar, focusSidebar, updateSidebarVisibility };
  }
  globalThis.VoiceOfMLShellView = { create, focusSearchSidebar };
})();
