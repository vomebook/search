"""Controlled application races with an actual browser Worker and corpus bootstrap."""
import unittest

from tests.search.browser import test_api_integration as api


@unittest.skipIf(api.sync_playwright is None, "install requirements-test.txt to run Worker lifecycle tests")
class WorkerLifecycleTest(unittest.TestCase):
    setUpClass = classmethod(api.ApiIntegrationTest.setUpClass.__func__)
    tearDownClass = classmethod(api.ApiIntegrationTest.tearDownClass.__func__)
    setUp = api.ApiIntegrationTest.setUp
    tearDown = api.ApiIntegrationTest.tearDown
    api_route = api.ApiIntegrationTest.api_route
    load = api.ApiIntegrationTest.load

    def test_failed_waiters_share_real_bootstrap_and_ignore_retired_worker_events(self):
        self.load()
        self.page.wait_for_function("STATE.dataLoaded", timeout=30000)
        observed = self.page.evaluate("""async () => {
          const old = corpusWorker, before = corpusWorkerRestartCount;
          // Hold two requests at the transport boundary, then fail their owner.
          old.postMessage = () => {};
          const a = corpusWorkerRequest('metadata', {});
          const b = corpusWorkerRequest('folder-tree', {repo:'VoiceOfML/VOMEBOOK'});
          await Promise.resolve();
          old.dispatchEvent(new ErrorEvent('error', {message:'controlled failure'}));
          // Let recovery create its instance, then deliver a delayed old callback.
          for (let i=0;i<5;i++) await Promise.resolve();
          const replacement = corpusWorker;
          old.dispatchEvent(new MessageEvent('messageerror'));
          const [metadata, tree] = await Promise.all([a,b]);
          return {count:metadata.count, hasTree:!!tree.tree,
            same:replacement===corpusWorker, replaced:old!==replacement,
            restarts:corpusWorkerRestartCount-before, pending:corpusWorkerPending.size};
        }""")
        self.assertGreater(observed.pop('count'), 0)
        self.assertEqual(observed, {'hasTree': True, 'same': True, 'replaced': True,
                                    'restarts': 1, 'pending': 0})

    def test_abort_while_real_replacement_bootstrap_waits_does_not_retry_search(self):
        self.load()
        self.page.wait_for_function("STATE.dataLoaded", timeout=30000)
        observed = self.page.evaluate("""async () => {
          const NativeWorker = window.Worker, old = corpusWorker;
          let release, entered;
          const bootstrapEntered = new Promise(resolve => { entered = resolve; });
          const posted = [];
          window.Worker = class extends NativeWorker {
            postMessage(message) {
              posted.push(message.type);
              if (message.type === 'load-corpus') {
                release = () => super.postMessage(message);
                entered();
              } else super.postMessage(message);
            }
          };
          try {
            old.postMessage = () => {};
            const controller = new AbortController();
            const stale = corpusWorkerRequest('local-search', {q:'alpha'}, 10000, controller.signal)
              .then(()=>'unexpected success', error=>error.name);
            const current = corpusWorkerRequest('metadata', {});
            await Promise.resolve();
            old.dispatchEvent(new ErrorEvent('error', {message:'controlled failure'}));
            await bootstrapEntered;
            controller.abort();
            release();
            const [cancelled, metadata] = await Promise.all([stale, current]);
            return {cancelled, count:metadata.count,
              bootstraps:posted.filter(type=>type==='load-corpus').length,
              searches:posted.filter(type=>type==='local-search').length,
              pending:corpusWorkerPending.size};
          } finally { window.Worker = NativeWorker; }
        }""")
        self.assertGreater(observed.pop('count'), 0)
        self.assertEqual(observed, {'cancelled':'AbortError', 'bootstraps':1,
                                    'searches':0, 'pending':0})


if __name__ == '__main__':
    unittest.main(verbosity=2)
