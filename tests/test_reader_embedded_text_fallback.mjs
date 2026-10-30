import assert from 'node:assert/strict';
import {createReaderPdfTextRuntime} from '../static/reader/pdf/reader-pdf-text-runtime.mjs';

globalThis.VoiceOfMLReaderSecurity = {validatePdfOcrPage:()=>{}};

function setup(payload) {
  const layer = {};
  const shell = {dataset:{page:'1'},isConnected:true,querySelector:()=>layer};
  let embedded = 0, nativeRuns = 0, externalRuns = 0;
  const reader = {
    ocrManifestUrl:'/retired-text', readerAbortController:new AbortController(),
    isPdfPageVisible:()=>true, acquirePdfTextSlot:async()=>{},releasePdfTextSlot:()=>{},
    loadPdfOcrPage:async()=>{if(payload instanceof Error)throw payload;return payload;},
    loadPdfTextContent:async()=>{embedded++;return {items:[{str:'source text'}],styles:{}};},
    cachePdfTextContent:()=>{}, assertReaderActive:()=>{}, highlightPdfText:()=>{},
    populatePdfTextLayer:()=>nativeRuns++, populateOcrTextLayer:()=>externalRuns++,
    populateIndependentTextLayer:()=>externalRuns++
  };
  const runtime = createReaderPdfTextRuntime(reader);
  reader.renderPdfText = runtime.renderPdfText;
  reader.renderPdfOcrText = runtime.renderPdfOcrText;
  const page = {getTextContent:()=>{},getViewport:()=>({width:100,height:200})};
  return {reader,shell,page,counts:()=>({embedded,nativeRuns,externalRuns})};
}

for (const value of [new Error('not found'),{kind:'pdf-text-layer',text:' ',regions:[]},
                     {kind:'pdf-ocr-page',blocks:[]}]) {
  const {reader,shell,page,counts}=setup(value);
  const warn=console.warn;console.warn=()=>{};
  try {await reader.renderPdfText(page,shell);} finally {console.warn=warn;}
  assert.equal(shell.dataset.textReady,'1');
  assert.equal(shell.dataset.nativeTextFallback,'1');
  assert.deepEqual(counts(),{embedded:1,nativeRuns:1,externalRuns:0});
}
{
  const {reader,shell,page,counts}=setup({kind:'pdf-ocr-page',blocks:[{t:'existing text',b:[0,0,1,1]}]});
  await reader.renderPdfText(page,shell);
  assert.equal(shell.dataset.textReady,'1');
  assert.deepEqual(counts(),{embedded:0,nativeRuns:0,externalRuns:1});
}
{
  const {reader,shell,page,counts}=setup({kind:'pdf-ocr-page',blocks:[{t:'recovered',b:[0,0,1,1]}]});
  shell.dataset.textReady='1';shell.dataset.nativeTextFallback='1';
  await reader.renderPdfText(page,shell);
  assert.equal(shell.dataset.nativeTextFallback,undefined);
  assert.deepEqual(counts(),{embedded:0,nativeRuns:0,externalRuns:1});
}
{
  const {reader,shell,page,counts}=setup({kind:'pdf-ocr-page',blocks:[{t:'recovered',b:[0,0,1,1]}]});
  shell.dataset.textReady='1';shell.dataset.nativeTextFallback='1';
  reader.pdfSelectionIntersects=()=>true;
  await reader.renderPdfText(page,shell);
  assert.equal(shell.dataset.nativeTextFallback,'1');
  assert.deepEqual(counts(),{embedded:0,nativeRuns:0,externalRuns:0});
}
console.log('Embedded text is retained when external text is missing or empty; existing text still takes precedence');
