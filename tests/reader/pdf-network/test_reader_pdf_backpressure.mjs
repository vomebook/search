import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createPdfFetchPolicy, preparePdfInitialRange} from '../../../static/reader/pdf/reader-pdf-network.mjs';

// Local transport fixture only: no upstream connection is made.
globalThis.location = {href:'https://reader.test/'};
const native = globalThis.fetch;
const bytes = new Uint8Array([1,2,3,4]);
const headers = {ETag:'"stable"','Content-Range':'bytes 0-3/4'};
const opts = {idleMs:1000,attemptMs:3000,rateLimitDelayMs:30,rateLimitSpacingMs:20,maxRateLimitDelayMs:300};
const tick = () => new Promise(resolve=>setTimeout(resolve,0));

async function withClock(run) {
  // Node's timer mocks don't advance performance.now() or AbortSignal.timeout().
  // Keep both on the scheduler's clock and let fetch/stream microtasks settle at
  // the current instant before advancing again.
  let now=0;
  mock.timers.enable({apis:['setTimeout']});
  try {
    mock.method(performance,'now',()=>now);
    mock.method(AbortSignal,'timeout',ms=>{
      const controller=new AbortController();
      setTimeout(()=>controller.abort(new DOMException('Timeout','TimeoutError')),ms);
      return controller.signal;
    });
    await run(async ms=>{
      now+=ms;
      mock.timers.tick(ms);
      await new Promise(resolve=>setImmediate(resolve));
    });
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
}

async function checkAdmissionDeadline(options,init,deadline) {
  await withClock(async advance=>{
    let calls=0,expired=false;
    globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:150,...options});policy.add(['/a.pdf']);
    try {
      const result=fetch('/a.pdf',init).then(()=>null,error=>{expired=true;return error;});
      await advance(0);
      assert.equal(policy.queuedAdmissions,1);
      await advance(deadline-1);
      assert.equal(expired,false,'the admission budget must not expire early');
      assert.equal(calls,1);
      await advance(1);
      assert.equal(expired,true,'the admission budget must expire before the cooldown ends');
      assert.equal((await result)?.name,'TimeoutError');
      assert.equal(policy.queuedAdmissions,0);
      await advance(150-deadline);
      assert.equal(calls,1,'expired work must not issue an upstream retry');
    } finally {policy.dispose();}
  });
}

try {
  // Native PDF staging awaits the bootstrap before the outer Reader timer
  // exists. When the first Range gets a 200, the policy hands off the body.
  for (const scenario of ['stall','close','complete']) await withClock(async advance=>{
    const owner=new AbortController(), requests=[];
    const closeReason=new DOMException('caller closed','AbortError'), bodyDeadline=120000;
    let body, upstream, waitingForMore=false, outcome;
    globalThis.fetch=async (_input,init)=>{
      requests.push(new Headers(init.headers).get('Range'));
      upstream=init.signal;
      return new Response(new ReadableStream({
        start(controller){
          body=controller;
          controller.enqueue(bytes.slice(0,2));
          upstream.addEventListener('abort',()=>controller.error(upstream.reason),{once:true});
        },
        pull(){waitingForMore=true;}
      },{highWaterMark:0}),{status:200});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    try {
      const url=new URL('/a.pdf',globalThis.location.href).href;
      void preparePdfInitialRange({url,rangeChunkSize:2},{signal:owner.signal,limit:64,rangeCache:null,
        readBytes:async response=>new Uint8Array(await response.arrayBuffer())})
        .then(first=>{outcome={first};},error=>{outcome={error};});
      await advance(0);
      assert.deepEqual(requests,['bytes=0-1']);
      assert.equal(waitingForMore,true,'the body has already delivered bytes and is waiting for more');
      await advance(scenario==='close' ? 1 : bodyDeadline-1);
      assert.equal(outcome,undefined,'the bootstrap must not settle early or publish a prefix');
      assert.equal(upstream.aborted,false);
      if (scenario==='stall') {
        await advance(1);
        assert.equal(outcome?.error?.name,'TimeoutError','the 200 body must time out before the outer Reader timer starts');
        assert.equal(upstream.aborted,true);
        assert.equal(upstream.reason,outcome.error);
        assert.equal(owner.signal.aborted,false);
      } else if (scenario==='close') {
        owner.abort(closeReason);
        await advance(0);
        assert.equal(outcome?.error,closeReason);
        assert.equal(upstream.reason,closeReason);
      } else {
        body.enqueue(bytes.slice(2));body.close();
        await advance(0);
        assert.equal(outcome?.first?.complete,true);
        assert.deepEqual(outcome.first.bytes,bytes);
        await advance(1);
        assert.equal(upstream.aborted,false,'completion clears the body deadline');
      }
      assert.deepEqual(requests,['bytes=0-1'],'the bootstrap needs no second request');
    } finally {owner.abort(closeReason);policy.dispose();}
  });
  // A genuine 429 triggers one bounded retry after the shared pause, then a
  // correctly versioned body is delivered without reopening the document.
  {
    const times=[];
    globalThis.fetch=async()=>{
      times.push(performance.now());
      if(times.length===1)return new Response('',{status:429});
      return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    const result=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3,4]);
    assert.equal(times.length,2);assert.ok(times[1]-times[0]>=20);
    assert.ok(policy.identity);policy.dispose();
  }
  // A browser pause between fetch headers and first body pull is not a stall.
  // The pre-existing contract starts the body deadline only when pull begins.
  {
    globalThis.fetch=async()=>new Response(bytes,{status:206,headers});
    const policy=createPdfFetchPolicy({...opts,attemptMs:40,idleMs:40});policy.add(['/a.pdf']);
    const response=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3,4]);policy.dispose();
  }
  // A long server-specified Retry-After must not be retried early or capped
  // into an unsafe immediate retry.
  {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});};
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    await assert.rejects(fetch('/a.pdf',{headers:{Range:'bytes=0-3'}}),/rate limited/);
    await assert.rejects(fetch('/a.pdf',{headers:{Range:'bytes=0-3'}}),/rate limited/);
    assert.equal(calls,1,'a new demand must not retry an origin before a long Retry-After');policy.dispose();
  }
  // A stalled body after response headers may outlast the server's delay.
  // Admission timeout must cover retry waiting, but not kill active body reads.
  {
    let calls=0,body;
    globalThis.fetch=async()=>{
      calls++;
      if(calls===1)return new Response('',{status:429});
      return new Response(new ReadableStream({start(c){body=c;}}),{status:206,headers});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:30,attemptMs:100,idleMs:80});policy.add(['/a.pdf']);
    const response=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});const reader=response.body.getReader();
    const part=reader.read();body.enqueue(bytes);body.close();assert.deepEqual([...((await part).value)],[1,2,3,4]);
    assert.equal((await reader.read()).done,true);assert.equal(calls,2);policy.dispose();
  }
  // A later long Retry-After also cancels already-queued requests for the same
  // original rather than allowing them to run under the earlier short pause.
  {
    let release, calls=0;
    globalThis.fetch=async (_input,init)=>{
      calls++;const range=new Headers(init.headers).get('Range');
      if(range==='bytes=0-3')return new Response('',{status:429});
      if(range==='bytes=4-7'){
        await new Promise(resolve=>{release=resolve;});
        return new Response('',{status:429,headers:{'Retry-After':'60'}});
      }
      throw new Error('queued or blocked range reached server');
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:150});policy.add(['/a.pdf']);
    const short=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});const shortRejected=assert.rejects(short);
    const long=fetch('/a.pdf',{headers:{Range:'bytes=4-7'}});const longRejected=assert.rejects(long);
    await tick();
    const queued=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});const queuedRejected=assert.rejects(queued);
    release();await Promise.all([shortRejected,longRejected,queuedRejected]);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,2);policy.dispose();
  }
  // A long successful body that is being consumed incrementally must not be
  // killed by a feedback admission deadline after it has already started.
  {
    let body;
    globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){body=controller;controller.enqueue(bytes.slice(0,2));}}),
      {status:206,headers});
    const policy=createPdfFetchPolicy({...opts,idleMs:100,attemptMs:40});policy.add(['/a.pdf']);
    const reader=(await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}})).body.getReader();
    assert.deepEqual([...((await reader.read()).value)],[1,2]);
    await new Promise(resolve=>setTimeout(resolve,100));
    body.enqueue(bytes.slice(2));body.close();
    assert.deepEqual([...((await reader.read()).value)],[3,4]);
    assert.equal((await reader.read()).done,true);policy.dispose();
  }
  // A completely consumed body cannot be retried if it is truncated: only
  // validated bytes from the same source may be replayed.
  {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response(new Uint8Array([1,2]),{status:206,headers});};
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    const response=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    await assert.rejects(response.arrayBuffer());assert.ok(calls<=2);policy.dispose();
  }
  // A same-validator retry may change chunk boundaries. PDF.js reads the
  // entire value.buffer, so skipped bytes and backing-buffer padding must
  // never appear in the delivered data.
  {
    const ranges=[];
    globalThis.fetch=async (_input,init)=>{
      ranges.push(new Headers(init.headers).get('Range'));
      const chunks=ranges.length===1 ? [Uint8Array.of(90,1,2,91).subarray(1,3)] :
        [Uint8Array.of(1),Uint8Array.of(92,2,3,4,93).subarray(1,4)];
      return new Response(new ReadableStream({start(controller){
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }}),{status:206,headers});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    const reader=(await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}})).body.getReader();
    try {
      const first=await reader.read();
      assert.deepEqual([...new Uint8Array(first.value.buffer)],[1,2]);
      assert.deepEqual(ranges,['bytes=0-3']);
      const replayed=await reader.read();
      assert.deepEqual([...new Uint8Array(replayed.value.buffer)],[3,4]);
      assert.equal((await reader.read()).done,true);
      assert.deepEqual(ranges,['bytes=0-3','bytes=0-3']);
      assert.ok(policy.identity,'a same-source retry must retain the validated identity');
    } finally {reader.releaseLock();policy.dispose();}
  }
  // A valid prefix is already with PDF.js. Do not read any bytes from a retry
  // until its status, byte range and original-file identity all match.
  for (const [label,status,replayHeaders,error] of [
    ['full body instead of a range',200,{ETag:'"stable"','Content-Length':'4'},/PDF_RANGE_INVALID/],
    ['missing range',206,{ETag:'"stable"'},/PDF_RANGE_INVALID/],
    ['shifted range',206,{...headers,'Content-Range':'bytes 1-3/4'},/PDF_RANGE_INVALID/],
    ['different document length',206,{...headers,'Content-Range':'bytes 0-3/5'},/PDF_SOURCE_CHANGED/],
    ['different ETag',206,{...headers,ETag:'"changed"'},/PDF_SOURCE_CHANGED/],
    ['lost strong validator',206,{...headers,ETag:'W/"stable"'},/PDF_SOURCE_CHANGED/],
  ]) {
    const ranges=[];
    let pulls=0,cancellations=0;
    globalThis.fetch=async (_input,init)=>{
      ranges.push(new Headers(init.headers).get('Range'));
      if (ranges.length===1) return new Response(bytes.slice(0,2),{status:206,headers});
      assert.equal(ranges.length,2,label);
      const retryBody=new ReadableStream({pull(controller){pulls++;controller.enqueue(bytes);controller.close();},
        cancel(){cancellations++;}},{highWaterMark:0});
      return new Response(retryBody,{status,headers:replayHeaders});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    try {
      const reader=(await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}})).body.getReader();
      try {
        assert.deepEqual([...(await reader.read()).value],[1,2],label);
        assert.deepEqual(ranges,['bytes=0-3'],label);
        await assert.rejects(reader.read(),error,label);
        assert.deepEqual(ranges,['bytes=0-3','bytes=0-3'],label);
        assert.equal(pulls,0,label);
        assert.equal(cancellations,1,label);
      } finally {reader.releaseLock();}
    } finally {policy.dispose();}
  }
  // An empty 206 can retry, but the returned stream still represents a range.
  // Even with the same validator a full 200 must not silently finish that range.
  {
    const ranges=[];
    let pulls=0,cancellations=0;
    globalThis.fetch=async (_input,init)=>{
      ranges.push(new Headers(init.headers).get('Range'));
      if (ranges.length===1) return new Response(new Uint8Array(0),{status:206,headers});
      assert.equal(ranges.length,2);
      const whole=new ReadableStream({pull(controller){pulls++;controller.enqueue(bytes);controller.close();},
        cancel(){cancellations++;}},{highWaterMark:0});
      return new Response(whole,{status:200,headers:{ETag:'"stable"','Content-Length':'4'}});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    try {
      const response=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
      assert.equal(response.status,206);
      assert.deepEqual(ranges,['bytes=0-3']);
      await assert.rejects(response.arrayBuffer(),/PDF_RANGE_INVALID/);
      assert.deepEqual(ranges,['bytes=0-3','bytes=0-3']);
      assert.equal(pulls,0);assert.equal(cancellations,1);
    } finally {policy.dispose();}
  }
  // With bytes already delivered but no strong ETag, even a truncated 206
  // must fail without scheduling a replay.
  for (const tag of [null,'W/"stable"']) {
    let calls=0;
    globalThis.fetch=async()=>{
      calls++;
      const responseHeaders=new Headers({'Content-Range':'bytes 0-3/4'});
      if (tag) responseHeaders.set('ETag',tag);
      return new Response(bytes.slice(0,2),{status:206,headers:responseHeaders});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    try {
      const reader=(await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}})).body.getReader();
      try {
        assert.deepEqual([...(await reader.read()).value],[1,2]);
        await assert.rejects(reader.read(),/PDF_RANGE_TRUNCATED/);
        assert.equal(calls,1);
        assert.equal(policy.identity,null);
      } finally {reader.releaseLock();}
    } finally {policy.dispose();}
  }
  // Foreground promotion must be scoped to a document URL; identical byte
  // offsets in a different hybrid/secondary source are unrelated.
  {
    const arrivals=[];let first=true;
    globalThis.fetch=async (input,init)=>{
      const range=new Headers(init.headers).get('Range');arrivals.push([String(input),range]);
      if(first){first=false;return new Response('',{status:429});}
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range);
      return new Response(new Uint8Array(Number(b)-Number(a)+1),{status:206,headers:{
        ETag:'"stable"','Content-Range':`bytes ${a}-${b}/16`}});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:60});policy.add(['/a.pdf','/b.pdf']);
    const firstFetch=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});await tick();
    const secondary=fetch('/b.pdf',{headers:{Range:'bytes=8-11'}});
    const primary=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});
    policy.prioritizeRange(8,12,'/a.pdf');
    for(const response of await Promise.all([firstFetch,secondary,primary]))await response.arrayBuffer();
    assert.deepEqual(arrivals.slice(1),[['/a.pdf','bytes=8-11'],['/a.pdf','bytes=0-3'],['/b.pdf','bytes=8-11']]);
    policy.dispose();
  }
  // Conditional/HEAD requests are outside recovery policy and retain their
  // original method, headers, and untouched 429 response.
  {
    const calls=[];
    globalThis.fetch=async (input,init)=>{calls.push({input,method:init?.method,headers:new Headers(init?.headers)});
      return new Response(null,{status:429});};
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    const response=await fetch('/a.pdf',{method:'HEAD',headers:{'If-None-Match':'"stable"'}});
    assert.equal(response.status,429);assert.equal(calls.length,1);assert.equal(calls[0].method,'HEAD');
    assert.equal(calls[0].headers.get('If-None-Match'),'"stable"');policy.dispose();
  }
  // Three callers rejected in the same burst resume one by one rather than
  // immediately reissuing all their requests together.
  {
    const calls=new Map(),retries=[];
    globalThis.fetch=async input=>{
      const key=String(input), count=(calls.get(key)||0)+1;calls.set(key,count);
      if(count===1)return new Response('',{status:429});
      retries.push(performance.now());return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf','/b.pdf','/c.pdf']);
    const responses=await Promise.all(['/a.pdf','/b.pdf','/c.pdf'].map(url=>fetch(url,{headers:{Range:'bytes=0-3'}})));
    for(const response of responses)assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3,4]);
    assert.equal(retries.length,3);
    assert.ok(retries[1]-retries[0]>=12);assert.ok(retries[2]-retries[1]>=12);
    policy.dispose();
  }
  // Cancelled waiters are removed immediately even if an origin asks for a
  // long cooldown. Retaining dead queue entries scales with prior navigation.
  {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:500});policy.add(['/a.pdf']);
    const owner=new AbortController();const pending=fetch('/a.pdf',{headers:{Range:'bytes=0-3'},signal:owner.signal});
    const rejected=assert.rejects(pending);await tick();owner.abort();await rejected;await tick();
    assert.equal(policy.queuedAdmissions,0);assert.equal(calls,1);policy.dispose();
  }
  // A promoted visible page goes ahead of queued validation requests after
  // the server cooldown, but still obeys the shared rate spacing.
  {
    const arrivals=[];let first=true;
    globalThis.fetch=async (_input,init)=>{
      const range=new Headers(init.headers).get('Range');arrivals.push(range);
      if(first){first=false;return new Response('',{status:429});}
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range);
      return new Response(new Uint8Array(Number(b)-Number(a)+1),{status:206,headers:{
        ETag:'"stable"','Content-Range':`bytes ${a}-${b}/16`}});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:60});policy.add(['/a.pdf']);
    const firstFetch=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    await tick();
    const background=fetch('/a.pdf',{headers:{Range:'bytes=4-7'}});
    const foreground=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});
    policy.prioritizeRange(8,12);
    for(const response of await Promise.all([firstFetch,background,foreground]))await response.arrayBuffer();
    assert.deepEqual(arrivals.slice(1),['bytes=8-11','bytes=0-3','bytes=4-7']);
    policy.dispose();
  }
  // An admitted recovery caller must not outlive the ordinary initial-body
  // deadline just because it is waiting in the shared cooldown queue.
  await checkAdmissionDeadline({initialTotalMs:40},undefined,40);
  // A server that keeps returning 429 may not trigger unbounded retries.
  {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    await assert.rejects(fetch('/a.pdf',{headers:{Range:'bytes=0-3'}}),/rate limited/);
    assert.equal(calls,2);policy.dispose();
  }
  // A new 429 before any recovery success invalidates the previous success
  // generation: an old delayed success cannot turn pacing off early.
  {
    let releaseOld,first=true;const starts=[];
    globalThis.fetch=async input=>{
      const key=String(input);starts.push({key,at:performance.now()});
      if(key.endsWith('/trigger.pdf')&&first){first=false;return new Response('',{status:429});}
      if(key.endsWith('/old.pdf'))await new Promise(resolve=>{releaseOld=resolve;});
      if(key.endsWith('/new429.pdf'))return new Response('',{status:429,headers:{'Retry-After':'60'}});
      return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:20,rateLimitRecoveryMs:15,rateLimitSpacingMs:50});
    policy.add(['/trigger.pdf','/old.pdf','/new429.pdf','/first.pdf','/second.pdf']);
    const old=fetch('/old.pdf',{headers:{Range:'bytes=0-3'}});await tick();
    const trigger=fetch('/trigger.pdf',{headers:{Range:'bytes=0-3'}});
    await (await trigger).arrayBuffer();
    const limited=fetch('/new429.pdf',{headers:{Range:'bytes=0-3'}});const rejected=assert.rejects(limited);await rejected;
    releaseOld();await (await old).arrayBuffer();
    await new Promise(resolve=>setTimeout(resolve,20));
    const a=fetch('/first.pdf',{headers:{Range:'bytes=0-3'}});
    const b=fetch('/second.pdf',{headers:{Range:'bytes=0-3'}});
    for(const response of await Promise.all([a,b]))await response.arrayBuffer();
    const times=starts.filter(x=>/first\.pdf|second\.pdf/.test(x.key));
    assert.ok(times[1].at-times[0].at>=35,'old success must not disable recovery pacing');
    policy.dispose();
  }
  // A body may stall after a valid prefix, and its second (recovery) request
  // may then be rate-limited. A bounded 429 retry must revalidate and replay
  // only the bytes not already delivered.
  {
    let calls=0;
    globalThis.fetch=async()=>{
      calls++;
      if(calls===1)return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));}}),{status:206,headers});
      if(calls===2)return new Response('',{status:429});
      return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy({...opts,idleMs:20,attemptMs:500});policy.add(['/a.pdf']);
    const result=await (await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}})).arrayBuffer();
    assert.deepEqual([...new Uint8Array(result)],[1,2,3,4]);assert.equal(calls,3);policy.dispose();
  }
  // The combination is still bounded: a second 429 may not trigger a fourth
  // request or return a partial body as a complete document.
  {
    let calls=0;
    globalThis.fetch=async()=>{
      calls++;
      if(calls===1)return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));}}),{status:206,headers});
      return new Response('',{status:429});
    };
    const policy=createPdfFetchPolicy({...opts,idleMs:20,attemptMs:500});policy.add(['/a.pdf']);
    const response=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    await assert.rejects(response.arrayBuffer(),/rate limited/);assert.equal(calls,3);policy.dispose();
  }
  // A slow/hung range must retain an overall deadline even if it is queued by
  // feedback. The range admission budget covers at most two attempts.
  await checkAdmissionDeadline({attemptMs:40},{headers:{Range:'bytes=0-3'}},80);
  // If a source changes during the backoff the body must not be mixed.
  {
    let calls=0;
    globalThis.fetch=async()=>{
      calls++;
      if(calls===1)return new Response(bytes,{status:206,headers});
      if(calls===2)return new Response('',{status:429});
      return new Response(bytes,{status:206,headers:{...headers,ETag:'"changed"'}});
    };
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    await (await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}})).arrayBuffer();
    await assert.rejects(fetch('/a.pdf',{headers:{Range:'bytes=0-3'}}),/PDF_SOURCE_CHANGED/);
    assert.equal(calls,3);assert.equal(policy.identity,null);policy.dispose();
  }
  // Disposing during the pause cancels pending calls and does not retry.
  {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:200});policy.add(['/a.pdf']);
    const pending=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    const rejected=assert.rejects(pending);
    await tick();policy.dispose();await rejected;
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,1);
  }
  // Cancelling one queued caller must not stall or reject other owners sharing
  // the same per-document scheduler.
  {
    let first=true;
    globalThis.fetch=async()=>{if(first){first=false;return new Response('',{status:429});}
      return new Response(bytes,{status:206,headers});};
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:80});policy.add(['/a.pdf','/b.pdf','/c.pdf']);
    const a=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    await tick();const controller=new AbortController();
    const b=fetch('/b.pdf',{headers:{Range:'bytes=0-3'},signal:controller.signal});const rejected=assert.rejects(b);
    const c=fetch('/c.pdf',{headers:{Range:'bytes=0-3'}});controller.abort();await rejected;
    const values=await Promise.all([a,c]);
    for(const result of values)assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3,4]);
    policy.dispose();
  }
  // Repeat mixed cancellation across the pacing boundary; every surviving
  // demand must settle and no aborted one may occupy a network slot.
  {
    let first=true,calls=0;
    globalThis.fetch=async()=>{calls++;if(first){first=false;return new Response('',{status:429});}
      return new Response(bytes,{status:206,headers});};
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:40,rateLimitSpacingMs:5});
    policy.add(['/a.pdf']);
    const firstResponse=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
    await tick();
    const owners=Array.from({length:12},()=>new AbortController());
    const requests=owners.map(owner=>fetch('/a.pdf',{headers:{Range:'bytes=0-3'},signal:owner.signal})
      .then(async response=>{await response.arrayBuffer();return 'ok';},()=> 'cancelled'));
    for(let i=0;i<owners.length;i+=2)owners[i].abort();
    assert.deepEqual((await Promise.all(requests)).sort(),[...Array(6).fill('cancelled'),...Array(6).fill('ok')].sort());
    await (await firstResponse).arrayBuffer();
    assert.equal(calls,8);policy.dispose();
  }
  // When a document is closed after an early 429, both active fetches and
  // queued admissions stop; no network request starts afterward.
  {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:300});policy.add(['/a.pdf']);
    const work=Array.from({length:20},()=>fetch('/a.pdf',{headers:{Range:'bytes=0-3'}}).catch(()=>null));
    await tick();const atClose=calls;policy.dispose();await Promise.all(work);
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(calls,atClose);
    assert.equal(policy.queuedAdmissions,0);
  }
  // A new request arriving after a queued batch drains but while recovery is
  // still active must start a new admission drain and cannot be stranded.
  {
    let first=true,calls=0;
    globalThis.fetch=async()=>{calls++;if(first){first=false;return new Response('',{status:429});}
      return new Response(bytes,{status:206,headers});};
    const policy=createPdfFetchPolicy({...opts,rateLimitRecoveryMs:1000});policy.add(['/a.pdf']);
    for(let i=0;i<10;i++){
      const result=await fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});
      assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3,4]);
      await tick();
    }
    assert.equal(calls,11);policy.dispose();
  }
  // A bounded number of callers must be allowed to burst again after a
  // successful cooldown; otherwise one transient 429 makes all future page
  // turns and full-text search permanently slow.
  await withClock(async advance=>{
    const starts=[];
    globalThis.fetch=async input=>{
      starts.push(String(input));
      if(starts.length===1)return new Response('',{status:429});
      return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitSpacingMs:45,rateLimitRecoveryMs:10});
    const burst=['/b.pdf','/c.pdf','/d.pdf'];
    const init={headers:{Range:'bytes=0-3'}};
    policy.add(['/a.pdf',...burst]);
    try {
      const recovered=fetch('/a.pdf',init).then(response=>response.arrayBuffer());
      void recovered.catch(()=>{});
      await advance(0);
      await advance(29);
      assert.deepEqual(starts,['/a.pdf']);
      await advance(1);
      assert.deepEqual(starts,['/a.pdf','/a.pdf']);
      assert.deepEqual(new Uint8Array(await recovered),bytes);
      await advance(10);
      const responses=Promise.all(burst.map(url=>fetch(url,init).then(response=>response.arrayBuffer())));
      void responses.catch(()=>{});
      await advance(0);
      // The next paced slot would be at t=75; all three must start at t=40.
      assert.deepEqual(starts.slice(2).sort(),burst);
      for(const response of await responses)assert.deepEqual(new Uint8Array(response),bytes);
    } finally {policy.dispose();}
  });
  // A very long Retry-After can overlap a pre-429 request completing. Its
  // late success must not leave permanent throttling or strand a future read.
  {
    let gate;
    globalThis.fetch=async input=>{
      if(String(input).endsWith('/b.pdf'))return new Response('',{status:429,headers:{'Retry-After':'0.08'}});
      if(String(input).endsWith('/a.pdf'))await new Promise(resolve=>{gate=resolve;});
      return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:80,rateLimitRecoveryMs:10});
    policy.add(['/a.pdf','/b.pdf','/c.pdf']);
    const a=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});await tick();
    const b=fetch('/b.pdf',{headers:{Range:'bytes=0-3'}});const rejected=assert.rejects(b);await tick();
    gate();await (await a).arrayBuffer();
    await rejected;
    await new Promise(resolve=>setTimeout(resolve,100));
    const c=await fetch('/c.pdf',{headers:{Range:'bytes=0-3'}});assert.deepEqual([...new Uint8Array(await c.arrayBuffer())],[1,2,3,4]);
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(policy.queuedAdmissions,0);policy.dispose();
  }
  // Recovery retries already queued must remain paced even when successful
  // responses arrive more slowly than the idle-recovery interval.
  {
    const calls=new Map(),retries=[];
    globalThis.fetch=async input=>{
      const key=String(input),n=(calls.get(key)||0)+1;calls.set(key,n);
      if(n===1)return new Response('',{status:429});
      retries.push(performance.now());await new Promise(resolve=>setTimeout(resolve,50));
      return new Response(bytes,{status:206,headers});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:20,rateLimitSpacingMs:100,rateLimitRecoveryMs:30});
    policy.add(['/a.pdf','/b.pdf','/c.pdf']);
    const values=await Promise.all(['/a.pdf','/b.pdf','/c.pdf'].map(url=>fetch(url,{headers:{Range:'bytes=0-3'}})));
    for(const response of values)await response.arrayBuffer();
    assert.ok(retries[1]-retries[0]>=80);assert.ok(retries[2]-retries[1]>=80);
    policy.dispose();
  }
  // Foreground status is consumed once its exact response has arrived; an
  // old page's range must not keep jumping ahead of a new background request.
  {
    const starts=[];let first=true;
    globalThis.fetch=async (_input,init)=>{
      const range=new Headers(init.headers).get('Range');starts.push(range);
      if(first){first=false;return new Response('',{status:429});}
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range);
      return new Response(new Uint8Array(Number(b)-Number(a)+1),{status:206,headers:{
        ETag:'"stable"','Content-Range':`bytes ${a}-${b}/16`}});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:60,rateLimitRecoveryMs:1000});policy.add(['/a.pdf']);
    const trigger=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});await tick();
    const visible=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});policy.prioritizeRange(8,12,'/a.pdf');
    for(const response of await Promise.all([trigger,visible]))await response.arrayBuffer();
    const background=fetch('/a.pdf',{headers:{Range:'bytes=4-7'}});
    const old=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});
    for(const response of await Promise.all([background,old]))await response.arrayBuffer();
    assert.deepEqual(starts.slice(-2),['bytes=4-7','bytes=8-11']);policy.dispose();
  }
  // A demand that is already active still has its priority hint retired when
  // it completes; otherwise it can bias later non-foreground reads.
  {
    const starts=[];let first=true,releaseVisible,visibleHeld=false;
    globalThis.fetch=async (_input,init)=>{
      const range=new Headers(init.headers).get('Range');starts.push(range);
      if(range==='bytes=0-3'&&first){first=false;return new Response('',{status:429});}
      if(range==='bytes=8-11'&&!visibleHeld){visibleHeld=true;await new Promise(resolve=>{releaseVisible=resolve;});}
      const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range);
      return new Response(new Uint8Array(Number(b)-Number(a)+1),{status:206,headers:{
        ETag:'"stable"','Content-Range':`bytes ${a}-${b}/16`}});
    };
    const policy=createPdfFetchPolicy({...opts,rateLimitDelayMs:20,rateLimitRecoveryMs:1000});policy.add(['/a.pdf']);
    const active=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});await tick();
    const trigger=fetch('/a.pdf',{headers:{Range:'bytes=0-3'}});await tick();
    policy.prioritizeRange(8,12,'/a.pdf');
    if(!releaseVisible)throw new Error('visible request was not held');
    releaseVisible();
    for(const response of await Promise.all([active,trigger]))await response.arrayBuffer();
    const background=fetch('/a.pdf',{headers:{Range:'bytes=4-7'}});
    const old=fetch('/a.pdf',{headers:{Range:'bytes=8-11'}});
    for(const response of await Promise.all([background,old]))await response.arrayBuffer();
    assert.deepEqual(starts.slice(-2),['bytes=4-7','bytes=8-11']);policy.dispose();
  }
  // BEGIN_PDF_ADMISSION_CANCELLATION
  // Cancellation can race the async admission continuation, even when no
  // rate limiting was active. Do not invoke native fetch with an aborted owner.
  for (const [kind,options] of [['reader', {headers:{Range:'bytes=0-3'}}],
    ['caller', {headers:{Range:'bytes=0-3'}}], ['full', {}]]) {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response(bytes,{status:206,headers});};
    const policy=createPdfFetchPolicy(opts);policy.add(['/a.pdf']);
    const owner=new AbortController();
    const pending=fetch('/a.pdf',{...options,signal:owner.signal});
    if (kind==='caller') owner.abort(new DOMException('caller closed','AbortError'));
    else policy.dispose();
    await assert.rejects(pending,error=>error.name==='AbortError');
    assert.equal(calls,0,`${kind}: no native dispatch after admission cancellation`);
    policy.dispose();
  }
  // END_PDF_ADMISSION_CANCELLATION
  console.log('429 feedback, shared spacing, bounded retry, version consistency and cancellation passed');
} finally {globalThis.fetch=native;}
