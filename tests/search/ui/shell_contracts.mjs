import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';
import {APP_DEPENDENCIES, stripBundledScripts} from '../../../scripts/build/compose_app.mjs';
import {installPrecachePaths, shellScriptPaths} from '../../support/shell_assets.mjs';

const names = ['search/shell/presentation/view.js', 'search/shell/application/controller.js'];
const app = fs.readFileSync('static/app.js', 'utf8');
const space = fs.existsSync('pyrightconfig.json');
const functions = ['getShell', 'toggleTheme', 'applyTheme', 'toggleMobile', 'applyMobileMode',
  'toggleLeftSidebar', 'toggleRightSidebar', 'closeLeftSidebar',
  'closeRightSidebar', 'updateSidebarVisibility'];

function fixture() {
  const events = [], nodes = [], frames = [], messages = [];
  const document = {activeElement: null};
  function element(name, parent = null) {
    const classes = new Set(), attributes = {}, listeners = {};
    const node = {name, parent, classes, attributes, listeners, disabled: false, hidden: false, inert: false,
      style: {}, controls: [],
      classList: {add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, on) { if (on) classes.add(value); else classes.delete(value); }},
      setAttribute(key, value) { attributes[key] = value; events.push([name, key, value]); },
      contains(other) { return !!other && (other === node || node.contains(other.parent)); },
      focus(options) { assert.equal(options.preventScroll, true); document.activeElement = node; events.push(['focus', name]); },
      querySelectorAll() { return node.controls; },
      getClientRects() { return node.hidden ? [] : [{}]; },
      closest() { for (let el = node; el; el = el.parent) if (el.hidden || el.inert) return el; return null; },
      getBoundingClientRect() { return {left: 10, top: 20, width: 40, height: 60}; },
      appendChild(child) { child.parent = node; nodes.push(child); events.push(['append', child.className]); },
      addEventListener(type, fn) { listeners[type] = fn; events.push(['listen', type]); },
      remove() { node.removed = true; }
    };
    return node;
  }
  const DOM = Object.fromEntries(['themeBtn', 'themeIconLight', 'themeIconDark', 'mobileToggleBtn',
    'mobileIconPhone', 'mobileIconDesktop', 'leftSidebar', 'rightSidebar', 'hamburgerBtn', 'settingsBtn', 'overlay']
    .map(name => [name, element(name)]));
  const main = element('main'), mainControl = element('mainControl', main);
  const leftControl = element('leftControl', DOM.leftSidebar), rightControl = element('rightControl', DOM.rightSidebar);
  DOM.leftSidebar.controls = [leftControl]; DOM.rightSidebar.controls = [rightControl];
  document.body = element('body'); document.documentElement = element('html');
  const themeColor = element('theme-color');
  document.querySelector = selector => selector === 'meta[name="theme-color"]' ? themeColor : main;
  document.createElement = () => element('ripple');
  const c = vm.createContext({shell: null, DOM, document,
    STATE: {isDark: true, isMobile: false, leftSidebarOpen: true, rightSidebarOpen: false},
    readerHost: {overlay: {contentWindow: {postMessage(message, origin) {
      messages.push(JSON.parse(JSON.stringify([message, origin]))); events.push(['reader', message.theme]);
    }}}}, location: {origin: 'https://shell.test'},
    writeSearchPreference: (...args) => events.push(['preference', ...args]),
    syncStateToURL: (...args) => events.push(['url', ...args]),
    updateSidebarHeader: () => events.push(['header']), updateSelectionUI: () => events.push(['selection']),
    updateScrollTrack: () => events.push(['scroll']),
    requestAnimationFrame: fn => { frames.push(fn); events.push(['frame']); },
    setSidebarExpanded: value => { DOM.leftSidebar.classList.toggle('expanded-wide', value); events.push(['header']); }
  });
  for (const name of names) vm.runInContext(fs.readFileSync('static/' + name, 'utf8'), c);
  for (const name of functions) {
    const match = app.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    // Single-line forwarding functions must not consume the following function.
    const single = app.match(new RegExp('^function ' + name + '\\([^\\n]*\\}\\s*$', 'm'));
    assert.ok(single || match, name); vm.runInContext((single || match)[0], c);
  }
  return {c, events, nodes, frames, messages, document, DOM, main, mainControl, leftControl, rightControl, element, themeColor};
}

test('shell modules are registered once in source, bundle, offline, resources and strict projects', async () => {
  const html = fs.readFileSync('static/index.html', 'utf8');
  const worker = fs.readFileSync('static/sw.js', 'utf8');
  const resources = createRequire(import.meta.url)('../../../static/reader-resources.js');
  const staticBase = space ? '/static/' : '/search/static/';
  const scripts = shellScriptPaths(html, staticBase);
  const bundled = shellScriptPaths(stripBundledScripts(html), staticBase);
  const precache = await installPrecachePaths(worker, resources, staticBase);
  assert.equal(scripts.filter(path => path === 'app.js').length, 1);
  assert.equal(bundled.filter(path => path === 'app.js').length, 1);
  for (const name of names) {
    assert.equal(APP_DEPENDENCIES.filter(item => item === name).length, 1);
    assert.equal(scripts.filter(path => path === name).length, 1, name);
    assert.ok(scripts.indexOf(name) < scripts.indexOf('app.js'), `${name} must precede app.js`);
    assert.ok(!bundled.includes(name), `${name} must not load separately after bundling`);
    for (const project of ['github', 'hf']) assert.equal(resources.buildFiles(project).filter(item => item === name).length, 1);
    assert.equal(precache.filter(path => path === name).length, 1, name);
    for (const project of ['check', 'strict', 'search-exact']) {
      const files = JSON.parse(fs.readFileSync(`config/types/jsconfig.${project}.json`, 'utf8')).files;
      assert.ok(files.includes('../../static/' + name));
      assert.ok(files.includes('../../typings/search-shell.d.ts'));
    }
    assert.doesNotMatch(fs.readFileSync('static/' + name, 'utf8'), /\bSTATE\b|\bDOM\b|\bVSCROLL\b|syncStateToURL|localStorage/);
  }
});

test('theme ripple, reader message, persistence and animation cleanup retain ordering', () => {
  const f = fixture();
  f.c.toggleTheme();
  assert.equal(f.c.STATE.isDark, false);
  assert.equal(f.document.body.classes.has('light'), true);
  assert.equal(f.document.documentElement.attributes['data-theme'], 'light');
  assert.equal(f.themeColor.attributes.content, '#fdfbff');
  assert.equal(f.DOM.themeIconDark.style.display, 'none');
  assert.deepEqual(f.messages, [[{type: 'voice-reader-theme-state', theme: 'light'}, 'https://shell.test']]);
  assert.deepEqual(f.events.slice(-3), [['reader', 'light'], ['preference', 'theme', 'light'], ['listen', 'animationend']]);
  const ripple = f.nodes[0];
  assert.equal(ripple.style.left, '30px'); assert.equal(ripple.style.top, '50px');
  assert.equal(ripple.style.background, '#fff');
  assert.equal(ripple.style.marginLeft, space ? undefined : '-0px');
  ripple.listeners.animationend();
  assert.equal(ripple.removed, true); assert.equal(f.document.body.classes.has('theme-transitioning'), false);
  f.c.readerHost.overlay = null; f.events.length = 0; f.c.applyTheme();
  assert.ok(!f.events.some(event => event[0] === 'preference'));
  f.c.toggleTheme(); assert.equal(f.c.STATE.isDark, true);
  assert.equal(f.nodes[1].style.background, '#1a1c1e');
  assert.equal(f.document.body.classes.has('light'), false);
  assert.equal(f.document.documentElement.attributes['data-theme'], 'dark');
  assert.equal(f.themeColor.attributes.content, '#1a1c1e');
});

test('mobile defaults apply before header, selection, scheduled scroll and preference write', () => {
  const f = fixture(); f.document.documentElement.classes.add('mobile-boot');
  f.c.STATE.rightSidebarOpen = true; f.c.toggleMobile();
  assert.equal(f.c.STATE.isMobile, true);
  assert.equal(f.c.STATE.leftSidebarOpen, false); assert.equal(f.c.STATE.rightSidebarOpen, false);
  assert.equal(f.document.body.classes.has('mobile'), true);
  assert.equal(f.document.documentElement.classes.has('mobile-boot'), false);
  assert.deepEqual(f.events.slice(-4), [['header'], ['selection'], ['frame'], ['preference', 'mobileMode', 'mobile']]);
  assert.equal(f.frames[0], f.c.updateScrollTrack);
  assert.ok(!f.events.some(event => event[0] === 'scroll' || event[0] === 'url'));
  f.c.toggleMobile();
  assert.equal(f.c.STATE.leftSidebarOpen, true); assert.equal(f.c.STATE.rightSidebarOpen, false);
  assert.equal(f.document.body.classes.has('force-desktop'), true);
  f.events.length = 0; f.c.applyMobileMode();
  assert.ok(!f.events.some(event => event[0] === 'preference'));
});

test('sidebar event detail and keyboard rules focus only after URL sync, preserving site route mode', () => {
  for (const side of ['Left', 'Right']) for (const event of [undefined, {detail: 1}, {detail: 0}, {type: 'keydown'}]) {
    const f = fixture(); f.c.STATE.leftSidebarOpen = false;
    f.c['toggle' + side + 'Sidebar'](event);
    const keyboard = event?.detail === 0 || event?.type === 'keydown';
    const tail = [...(side === 'Left' ? [['header']] : []), ['url', ...(space ? [true] : [])],
      ...(keyboard ? [['focus', side === 'Left' ? 'leftControl' : 'rightControl']] : [])];
    assert.deepEqual(f.events.slice(-tail.length), tail);
    assert.equal(f.document.activeElement, keyboard ? (side === 'Left' ? f.leftControl : f.rightControl) : null);
  }
});

test('mobile coverage, mutually exclusive sidebars, inert, ARIA and focus restoration stay synchronized', () => {
  const f = fixture(); f.c.STATE.isMobile = true; f.c.applyMobileMode();
  f.document.activeElement = f.mainControl; f.c.toggleLeftSidebar({detail: 1});
  assert.equal(f.main.inert, true); assert.equal(f.document.activeElement, f.leftControl);
  assert.equal(f.DOM.leftSidebar.inert, false); assert.equal(f.DOM.rightSidebar.inert, true);
  assert.equal(f.DOM.hamburgerBtn.attributes['aria-expanded'], 'true');
  assert.equal(f.DOM.hamburgerBtn.attributes['aria-label'], '关闭仓库导航');
  assert.equal(f.DOM.overlay.classes.has('open'), true);
  f.c.toggleRightSidebar({detail: 0});
  assert.equal(f.c.STATE.leftSidebarOpen, false); assert.equal(f.document.activeElement, f.rightControl);
  assert.equal(f.DOM.leftSidebar.inert, true); assert.equal(f.DOM.settingsBtn.attributes['aria-expanded'], 'true');
  f.c.closeRightSidebar();
  assert.equal(f.document.activeElement, f.DOM.settingsBtn); assert.equal(f.main.inert, false);
  assert.equal(f.DOM.overlay.classes.has('open'), false);
  assert.equal(f.DOM.settingsBtn.attributes['aria-label'], '打开搜索过滤');
  f.c.toggleLeftSidebar({type: 'keydown'}); f.DOM.leftSidebar.classes.add('expanded-wide');
  f.events.length = 0; f.c.toggleLeftSidebar();
  assert.equal(f.DOM.leftSidebar.classes.has('expanded-wide'), false);
  assert.equal(f.document.activeElement, f.DOM.hamburgerBtn);
  assert.deepEqual(f.events.at(-1), ['url', ...(space ? [true] : [])]);
  assert.equal(f.events.filter(event => event[0] === 'header').length, space ? 1 : 0);
  if (space) assert.deepEqual(f.events[0], ['header']);
});

test('sidebar focus skips disabled, invisible and hidden or inert controls and falls back to the sidebar', () => {
  const f = fixture(), sidebar = f.DOM.leftSidebar;
  const disabled = f.element('disabled', sidebar); disabled.disabled = true;
  const invisible = f.element('invisible', sidebar); invisible.hidden = true;
  const inertParent = f.element('inertParent', sidebar); inertParent.inert = true;
  const inert = f.element('inert', inertParent);
  sidebar.controls = [disabled, invisible, inert, f.leftControl];
  const view = f.c.VoiceOfMLShellView;
  view.focusSearchSidebar(sidebar); assert.equal(f.document.activeElement, f.leftControl);
  sidebar.controls.pop(); view.focusSearchSidebar(sidebar); assert.equal(f.document.activeElement, sidebar);
});
