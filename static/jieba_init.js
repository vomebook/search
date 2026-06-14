// jieba_init.js — loads jieba WASM and exposes window.jiebaCut / window.jiebaReady
import init, { cut_for_search } from './jieba_rs_wasm.js';

const jiebaReady = init();

window.jiebaReady = jiebaReady;
window.jiebaCut = async function (text) {
  await jiebaReady;
  return cut_for_search(text);
};
