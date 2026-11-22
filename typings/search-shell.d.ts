interface VoiceOfMLShellState {
  isDark: boolean; isMobile: boolean; leftSidebarOpen: boolean; rightSidebarOpen: boolean;
}
interface VoiceOfMLShellEvent { detail?: number; type?: string }
interface VoiceOfMLShellElements {
  themeBtn: HTMLElement; themeIconLight: HTMLElement | SVGElement; themeIconDark: HTMLElement | SVGElement;
  mobileToggleBtn: HTMLElement; mobileIconPhone: HTMLElement | SVGElement; mobileIconDesktop: HTMLElement | SVGElement;
  leftSidebar: HTMLElement; rightSidebar: HTMLElement; hamburgerBtn: HTMLElement;
  settingsBtn: HTMLElement; overlay: HTMLElement;
}
interface VoiceOfMLShellViewInstance {
  startThemeTransition(isDark: boolean): HTMLElement;
  finishThemeTransition(ripple: HTMLElement): void;
  applyTheme(isDark: boolean): void;
  applyMobileMode(isMobile: boolean): void;
  finishMobileMode(): void;
  collapseLeftSidebar(): void;
  focusSidebar(side: 'left' | 'right'): void;
  updateSidebarVisibility(state: VoiceOfMLShellState): void;
}
interface VoiceOfMLShellDependencies {
  view: VoiceOfMLShellViewInstance;
  readState(): VoiceOfMLShellState;
  setDark(value: boolean): void;
  setMobile(value: boolean): void;
  setSidebars(left: boolean, right: boolean): void;
  writePreference(key: 'theme' | 'mobileMode', value: string): void;
  notifyReaderTheme(isDark: boolean): void;
  updateSidebarHeader(): void;
  updateSelectionUI(): void;
  scheduleScrollTrack(): void;
  syncURL(): void;
  collapseLeftSidebar?(): void;
}
declare var VoiceOfMLShellView: {
  create(elements: () => VoiceOfMLShellElements, zeroRippleMargins: boolean): VoiceOfMLShellViewInstance;
};
declare var VoiceOfMLShell: { create(deps: VoiceOfMLShellDependencies): {
  toggleTheme(): void; applyTheme(): void; toggleMobile(): void; applyMobileMode(): void;
  toggleLeftSidebar(event?: VoiceOfMLShellEvent): void;
  toggleRightSidebar(event?: VoiceOfMLShellEvent): void;
  closeLeftSidebar(): void; closeRightSidebar(): void; updateSidebarVisibility(): void;
}};
