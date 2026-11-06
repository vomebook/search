import assert from 'node:assert/strict';
import {createReaderDocumentLoader} from '../../../static/reader/core/reader-document-loader.mjs';

// Integration of the PDF-specific rate policy with the existing outer retry
// owner: it must not retry early when Retry-After exceeds the local cap.
let calls=0;
const context={
  assertReaderActive(){},
  retryableReaderProxyError(error){return error?.status===429;},
  async waitForReader(){throw Error('an outer retry was scheduled');}
};
const loader=createReaderDocumentLoader(context);
await assert.rejects(loader.retryReaderProxy(async()=>{
  calls++;
  throw Object.assign(new Error('rate limited'),{status:429,code:'READER_PDF_RATE_LIMIT'});
}),/rate limited/);
assert.equal(calls,1);
// Generic non-PDF errors retain the pre-existing outer retry contract.
calls=0;context.waitForReader=async()=>{};
assert.equal(await loader.retryReaderProxy(async()=>{
  if (++calls===1)throw Object.assign(new Error('temporary'),{status:429});
  return 'ok';
}),'ok');
assert.equal(calls,2);
console.log('PDF rate-limit retry boundary and generic retry preserved');
