const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a cached shell without the speech panel keeps the planner and disables the player', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../static/tts-client.js'), 'utf8');
  const document = { querySelector: () => null };
  const context = vm.createContext({ document, window: {}, Intl });
  vm.runInContext(source, context);
  assert.equal(context.window.CCRDSpeech, null);
  assert.equal(typeof context.CCRDSpeechPlan.batch, 'function');
});
