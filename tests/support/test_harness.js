const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run(suite) {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`ok - ${suite}: ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${suite}: ${item.name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log(`${suite}: ${tests.length} cases, ${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

module.exports = { test, run };
