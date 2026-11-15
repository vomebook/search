"""The local converted-reader pool must yield and publish only complete data."""
import unittest

from tests.search.browser import test_paging_recovery as paging


class ConvertedReaderResponsivenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paging.PagingRecoveryTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        paging.PagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.fixture = paging.PagingRecoveryTests()
        self.fixture.setUp()
        self.page = self.fixture.page

    def tearDown(self):
        self.assertEqual(self.fixture.errors, [])
        self.fixture.tearDown()

    def test_build_yields_and_shares_complete_repository_snapshots(self):
        value = self.page.evaluate(r'''async () => {
          const saved = {assets: readerAssetController.state.assets, converted: readerAssetController.state.converted,
            byRepo: readerAssetController.state.byRepo, pending: readerAssetController.state.convertedPending};
          const digest = 'a'.repeat(64), map = {};
          for (let i=0; i<2000; i++) {
            const repo = i % 2 ? 'VoiceOfML/Other' : 'VoiceOfML/Test';
            map[repo+'\0folder/book'+i+'.ps'] = {s:2,m:'p',
              p:'documents/pdf/ps/'+digest+'/document.pdf',b:'vomebook/reader-assets-v2'};
          }
          try {
            readerAssetController.state.assets=map;readerAssetController.state.converted=null;readerAssetController.state.byRepo=null;readerAssetController.state.convertedPending=null;
            const first=getConvertedReaderRecords('VoiceOfML/Test');
            const job=readerAssetController.state.convertedPending;
            const second=getConvertedReaderRecords('VoiceOfML/Other');
            const shared=readerAssetController.state.convertedPending===job;
            const incomplete=readerAssetController.state.converted===null;
            let intervened=false;
            const timer=new Promise(resolve=>setTimeout(()=>{intervened=readerAssetController.state.converted===null;resolve()},0));
            const [a,b]=await Promise.all([first,second]);await timer;
            const same=await getConvertedReaderRecords('VoiceOfML/Test');
            return {shared,incomplete,intervened,counts:[a.length,b.length,readerAssetController.state.converted.length],
              cached:a===same,first:{extension:a[0].Extension,reader:a[0].ReaderExtension,
              download:a[0].DownloadLink,source:buildRecordLink(a[0])}};
          } finally {
            readerAssetController.state.assets=saved.assets;readerAssetController.state.converted=saved.converted;
            readerAssetController.state.byRepo=saved.byRepo;readerAssetController.state.convertedPending=saved.pending;
          }
        }''')
        self.assertTrue(value['shared'] and value['incomplete'] and value['intervened'], value)
        self.assertEqual(value['counts'], [1000, 1000, 2000])
        self.assertTrue(value['cached'])
        self.assertEqual(value['first']['extension'], 'ps')
        self.assertEqual(value['first']['reader'], 'pdf')
        self.assertEqual(value['first']['download'], value['first']['source'])

    def test_replacement_while_yielded_cannot_publish_or_return_stale_results(self):
        value = self.page.evaluate(r'''async () => {
          const saved = {assets:readerAssetController.state.assets, converted:readerAssetController.state.converted,
            byRepo:readerAssetController.state.byRepo, pending:readerAssetController.state.convertedPending};
          const old={}, sha='a'.repeat(64), nextSha='b'.repeat(64);
          for(let i=0;i<1200;i++) old['VoiceOfML/Test\0old'+i+'.ps']={s:2,m:'p',
            p:'documents/pdf/ps/'+sha+'/document.pdf',b:'vomebook/reader-assets-v2'};
          const next={'VoiceOfML/Test\0new.ps':{s:2,m:'p',
            p:'documents/pdf/ps/'+nextSha+'/document.pdf',b:'vomebook/reader-assets-v2'}};
          try {
            readerAssetController.state.assets=old;readerAssetController.state.converted=null;readerAssetController.state.byRepo=null;readerAssetController.state.convertedPending=null;
            const oldWait=getConvertedReaderRecords('VoiceOfML/Test');
            readerAssetController.state.assets=next;readerAssetController.state.converted=null;readerAssetController.state.byRepo=null;
            const newWait=getConvertedReaderRecords('VoiceOfML/Test');
            const [a,b]=await Promise.all([oldWait,newWait]);
            return {first:a.map(r=>r.File),second:b.map(r=>r.File),all:readerAssetController.state.converted.map(r=>r.File),
              firstUrl:a[0].ReaderLink, pending:readerAssetController.state.convertedPending===null};
          } finally {
            readerAssetController.state.assets=saved.assets;readerAssetController.state.converted=saved.converted;
            readerAssetController.state.byRepo=saved.byRepo;readerAssetController.state.convertedPending=saved.pending;
          }
        }''')
        self.assertEqual(value['first'], ['new'])
        self.assertEqual(value['second'], ['new'])
        self.assertEqual(value['all'], ['new'])
        self.assertIn('b' * 64, value['firstUrl'])
        self.assertTrue(value['pending'])

    def test_repository_change_during_build_never_reveals_old_status(self):
        value = self.page.evaluate(r'''async () => {
          const saved = {assets:readerAssetController.state.assets, converted:readerAssetController.state.converted, byRepo:readerAssetController.state.byRepo,
            pending:readerAssetController.state.convertedPending, repo:STATE.repoFull, loaded:STATE.dataLoaded,
            metadata:readerMetadata, style:DOM.randomTxtBtn.style.display};
          const map={}, sha='a'.repeat(64);
          for(let i=0;i<1200;i++) map['VoiceOfML/Old\0old'+i+'.ps']={s:2,m:'p',
            p:'documents/pdf/ps/'+sha+'/document.pdf',b:'vomebook/reader-assets-v2'};
          try {
            readerAssetController.state.assets=map;readerAssetController.state.converted=null;readerAssetController.state.byRepo=null;readerAssetController.state.convertedPending=null;
            STATE.dataLoaded=true;readerMetadata={count:0,byRepo:{}};STATE.repoFull='VoiceOfML/Old';
            const old=updateRandomTxtVisibility();
            STATE.repoFull='VoiceOfML/Missing';const current=updateRandomTxtVisibility();
            await Promise.all([old,current]);return {display:DOM.randomTxtBtn.style.display};
          } finally {
            readerAssetController.state.assets=saved.assets;readerAssetController.state.converted=saved.converted;readerAssetController.state.byRepo=saved.byRepo;
            readerAssetController.state.convertedPending=saved.pending;STATE.repoFull=saved.repo;STATE.dataLoaded=saved.loaded;
            readerMetadata=saved.metadata;DOM.randomTxtBtn.style.display=saved.style;
          }
        }''')
        self.assertEqual(value['display'], 'none')

    def test_native_random_action_does_not_wait_for_slow_sidecar(self):
        value = self.page.evaluate(r'''async () => {
          const saved={assets:readerAssetController.state.assets,pending:readerAssetController.state.pending,retry:readerAssetController.state.retryAt,
            repo:STATE.repoFull,loaded:STATE.dataLoaded,metadata:readerMetadata,style:DOM.randomTxtBtn.style.display};
          let release;const pending=new Promise(resolve=>{release=resolve});
          try {
            readerAssetController.state.assets=null;readerAssetController.state.pending=pending;readerAssetController.state.retryAt=0;
            STATE.dataLoaded=true;STATE.repoFull='VoiceOfML/Test';
            readerMetadata={count:1,byRepo:{'VoiceOfML/Test':1}};
            await updateRandomTxtVisibility();
            return {display:DOM.randomTxtBtn.style.display,stillPending:readerAssetController.state.pending===pending};
          } finally {
            release({});readerAssetController.state.assets=saved.assets;readerAssetController.state.pending=saved.pending;readerAssetController.state.retryAt=saved.retry;
            STATE.repoFull=saved.repo;STATE.dataLoaded=saved.loaded;readerMetadata=saved.metadata;
            DOM.randomTxtBtn.style.display=saved.style;
          }
        }''')
        self.assertEqual(value, {'display': '', 'stillPending': True})

    def test_cancelled_random_intent_stops_before_a_second_selection(self):
        value = self.page.evaluate(r'''async () => {
          const saved={assets:readerAssetController.state.assets, converted:readerAssetController.state.converted, byRepo:readerAssetController.state.byRepo,
            pending:readerAssetController.state.convertedPending,repo:STATE.repoFull,loaded:STATE.dataLoaded,metadata:readerMetadata,
            getLocal:getRandomLocal,open:openReaderRecord};
          let localCalls=0,opened=0;const map={},sha='a'.repeat(64);
          for(let i=0;i<1200;i++) map['VoiceOfML/Test\0b'+i+'.ps']={s:2,m:'p',
            p:'documents/pdf/ps/'+sha+'/document.pdf',b:'vomebook/reader-assets-v2'};
          try {
            readerAssetController.state.assets=map;readerAssetController.state.converted=null;readerAssetController.state.byRepo=null;readerAssetController.state.convertedPending=null;
            STATE.repoFull='VoiceOfML/Test';STATE.dataLoaded=true;readerMetadata={count:1,byRepo:{'VoiceOfML/Test':1}};
            getRandomLocal=async()=>{localCalls++;return null};openReaderRecord=()=>{opened++;return true};
            const old=randomTxt();randomReaderRequestId++;await old;
            return {localCalls,opened};
          } finally {
            readerAssetController.state.assets=saved.assets;readerAssetController.state.converted=saved.converted;readerAssetController.state.byRepo=saved.byRepo;
            readerAssetController.state.convertedPending=saved.pending;STATE.repoFull=saved.repo;STATE.dataLoaded=saved.loaded;
            readerMetadata=saved.metadata;getRandomLocal=saved.getLocal;openReaderRecord=saved.open;
          }
        }''')
        self.assertEqual(value, {'localCalls': 0, 'opened': 0})

    def test_stale_local_failure_does_not_replace_new_reader_status(self):
        value = self.page.evaluate(r'''async () => {
          const saved = {assets:readerAssetController.state.assets, converted:readerAssetController.state.converted,
            byRepo:readerAssetController.state.byRepo, pending:readerAssetController.state.convertedPending,
            repo:STATE.repoFull, loaded:STATE.dataLoaded, metadata:readerMetadata,
            getLocal:getRandomLocal, open:openReaderRecord, id:randomReaderRequestId};
          let oldReject, localCalls=0, opened=0;
          try {
            readerAssetController.state.assets={}; readerAssetController.state.converted=[]; readerAssetController.state.byRepo={};
            readerAssetController.state.convertedPending=null; STATE.repoFull='VoiceOfML/Test'; STATE.dataLoaded=true;
            readerMetadata={count:0,byRepo:{'VoiceOfML/Test':0}};
            getRandomLocal=async()=>{localCalls++; if(localCalls===1) return new Promise((_,reject)=>oldReject=reject);
              return {Repo:'VoiceOfML/Test',File:'new',Extension:'txt',Folder:[],HasTxt:false,
                Link:'https://huggingface.co/datasets/VoiceOfML/Test/resolve/main/new.txt'};};
            openReaderRecord=()=>{opened++;return true;};
            const messages=[];const original=showToast;showToast=message=>messages.push(message);
            const old=randomTxt(); await Promise.resolve();
            const newer=randomTxt(); await Promise.resolve(); await newer;
            oldReject(new TypeError('obsolete local source failed')); await old;
            showToast=original;
            return {messages,localCalls,opened};
          } finally {
            readerAssetController.state.assets=saved.assets;readerAssetController.state.converted=saved.converted;
            readerAssetController.state.byRepo=saved.byRepo;readerAssetController.state.convertedPending=saved.pending;
            STATE.repoFull=saved.repo;STATE.dataLoaded=saved.loaded;readerMetadata=saved.metadata;
            getRandomLocal=saved.getLocal;openReaderRecord=saved.open;randomReaderRequestId=saved.id;
          }
        }''')
        self.assertEqual(value['localCalls'], 2)
        self.assertEqual(value['opened'], 1)
        self.assertNotIn('暂无可读书籍', value['messages'])
        self.assertNotIn('随机打开失败', value['messages'])
