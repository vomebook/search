"use strict";
// Pure, bounded rolling source planner. All offsets refer to original UTF-16.
globalThis.CCRDSpeechPlan = (() => {
  const ending = /[。！？!?；;\n]/u;
  const ascii = /[A-Za-z0-9]/u;
  const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
  const connectors = "但是|可是|不过|然而|同时|而且|并且|因此|所以|此外|另外|于是|但是同时|与此同时|但是也|但是又|同时也|而是|或者|以及";
  const connectorWords = connectors.split("|").sort((a, b) => b.length - a.length);
  function connectorOnly(text) {
    let index = 0, found = false;
    while (index < text.length) {
      if (/[，,、：:\s]/u.test(text[index])) { index += 1; continue; }
      const word = connectorWords.find(value => text.startsWith(value, index));
      if (!word) return false;
      found = true; index += word.length;
    }
    return found;
  }
  const dangling = new Set(["的", "地", "得", "和", "与", "及", "或", "把", "被", "在", "对", "向", "为", "将", "不", "一", "很", "更", "最", "也", "还", "都", "就", "再", "又", "才", "没", "没有", "关于", "以及", "因为", "为了", "由于", "如果", ...connectors.split("|"), "一个", "这个", "那个", "今后", "目前", "当时", "现在", "已经", "正在", "需要", "应该", "必须", "可以", "能够", "不能", "有关", "一些"]);
  function numberSpans(text) {
    const label = "(?:订单编号|訂單編號|订单号|訂單號|编号|編號|手机号|手機號|电话|電話|学号|學號|邮编|郵編|ISBN(?:-13|-10)?|IP)";
    const pattern = new RegExp(label + "[ \\t]*[:：]?[ \\t]*[A-Za-z0-9]+(?:[._/\\-][A-Za-z0-9]+)*" +
      "|(?<![A-Za-z0-9])(?:版本|[Vv]ersion|[Vv])[ \\t]*[:：]?[ \\t]*[vV]?[0-9]+(?:\\.[0-9]+)+" +
      "|(?<![A-Za-z0-9])[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}(?![0-9])" +
      "|(?<![A-Za-z0-9])[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}[日号]" +
      "|(?<![A-Za-z0-9])[0-9]{4}年|(?<![0-9])[0-9]+(?:\\.[0-9]+){2,}" +
      "|(?<![A-Za-z0-9])[+-]?[0-9]+/[0-9]+(?![0-9/])" +
      "|[+-]?[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?(?:[%％]|℃)?", "gu");
    return Array.from(text.matchAll(pattern), match => ({ start: match.index, end: match.index + match[0].length }));
  }
  function wordEnds(text) {
    const atoms = numberSpans(text);
    const values = words ? Array.from(words.segment(text), value => ({ end: value.index + value.segment.length, word: value.segment.trim() })) :
      Array.from(text.matchAll(/[^，,。！？!?；;：:\n]+[，,。！？!?；;：:\n]?/gu), value => ({ end: value.index + value[0].length, word: "" }));
    return values.filter(value => !atoms.some(atom => atom.start < value.end && value.end < atom.end));
  }
  const RAMP = [[16, 32], [36, 56], [64, 90]];
  function phraseEnds(text, first = false) {
    const cuts = wordEnds(text), chars = Array.from(text), offsets = [0], ends = [];
    for (const char of chars) offsets.push(offsets[offsets.length - 1] + char.length);
    let start = 0;
    while (start < text.length) {
      const position = offsets.indexOf(start), short = first && !ends.length;
      // Streaming ramp (as ElevenLabs' chunk_length_schedule): each early clip
      // is short enough to be synthesized while the one before it still plays,
      // so the first sentence is quick and the second does not wait ~5 s for a
      // 90-character clip on the shared CPU worker.
      const marks = (goal, limit) => {
        const ceiling = offsets[Math.min(chars.length, position + limit)];
        return { target: offsets[Math.min(chars.length, position + goal)],
          hard: cuts.find(value => value.end > start && value.end <= ceiling && endsSentence(text, value.end)),
          natural: cuts.filter(value => value.end > start + (short ? 5 : Math.min(20, goal / 2)) && value.end <= ceiling &&
            /[，,：:、—…][”’"'」』）)\t \r]*$/u.test(text.slice(start, value.end)) && !connectorOnly(text.slice(start, value.end).trim())),
          // A run of book titles (《甲》《乙》) has no comma; between titles is a weak mark.
          weak: cuts.filter(value => value.end > start + (short ? 5 : Math.min(20, goal / 2)) && value.end <= ceiling &&
            text[value.end - 1] === "》" && text[value.end] === "《") };
      };
      // A clip ending without punctuation is read as an utterance end and its
      // last words fade (measured -17 to -21 dB). A ramp clip therefore never
      // cuts mid-phrase: without a mark in its range it widens to the next size.
      const sizes = first ? [...RAMP.slice(ends.length), [90, 120]] : [[90, 120]];
      let found = marks(...sizes[0]);
      for (const size of sizes.slice(1)) {
        if (found.hard || found.natural.length) break;
        const wider = marks(...size);
        // Prefer a nearer title boundary to a much longer clip.
        if (found.weak.length && !wider.natural.some(value => value.end <= found.weak[found.weak.length - 1].end + 8)) break;
        found = wider;
      }
      const { target, hard } = found, natural = found.natural.length ? found.natural : found.weak;
      let end;
      if (short && natural.length && (!hard || natural[0].end < hard.end)) end = natural[0].end; // Earliest mark keeps first audio fast.
      else if (hard) end = hard.end; // Never merge different spoken sentences in one part.
      else if (natural.length) end = short ? natural[0].end : natural[natural.length - 1].end;
      else {
        const choices = cuts.filter(value => value.end > start && value.end <= target && !dangling.has(value.word));
        const any = cuts.filter(value => value.end > start && value.end <= target);
        end = choices.length ? choices[choices.length - 1].end : any.length ? any[any.length - 1].end : cuts.find(value => value.end > start)?.end || text.length;
      }
      // Keep leading connectives with their predicate, not in a tiny independent
      // model clip. No source replacement, phoneme gain or global tone changes.
      if (connectorOnly(text.slice(start, end).trim()) && end < text.length) {
        end = cuts.find(value => value.end > end && !dangling.has(value.word) && !connectorOnly(text.slice(start, value.end).trim()))?.end || text.length;
      }
      // Doubled marks (——, ……) and closing quotes stay with the clip they end.
      while (end < text.length && /[”’"'」』）)\s—…]/u.test(text[end])) end += 1;
      if (end <= start) throw new Error("无法确定完整词语边界");
      if (end < text.length && !/[\p{L}\p{N}]/u.test(text.slice(end))) end = text.length;
      ends.push(end); start = end;
    }
    return ends;
  }
  function wordStart(text, offset) {
    offset = safe(text, offset);
    if (!offset || offset === text.length) return offset;
    const begin = safe(text, Math.max(0, offset - 96));
    const nearby = text.slice(begin, offset + 128), relative = offset - begin;
    const atom = numberSpans(nearby).find(value => value.start < relative && relative < value.end);
    if (atom) return begin + atom.start;
    if (words) {
      for (const value of words.segment(nearby)) {
        if (value.isWordLike && value.index < relative && relative < value.index + value.segment.length) return begin + value.index;
      }
    }
    return offset;
  }
  function safe(text, offset) {
    offset = Math.max(0, Math.min(text.length, Math.floor(offset)));
    return offset && /[\uDC00-\uDFFF]/u.test(text[offset] || "") && /[\uD800-\uDBFF]/u.test(text[offset - 1]) ? offset - 1 : offset;
  }
  function boundary(text, index) {
    return ending.test(text[index]) || (text[index] === "." && !ascii.test(text[index + 1] || "") && !listMarker(text, index));
  }
  // "1." / "12." / "一." / "(3)." at a line or clause start number the item that
  // follows; that period must not end a sentence ("1." spoken alone, then the item).
  function listMarker(text, index) {
    let cursor = index;
    const closed = cursor > 0 && /[)）]/u.test(text[cursor - 1]);
    if (closed) cursor -= 1;
    const digits = cursor;
    while (cursor > 0 && digits - cursor < 4 && /[0-9０-９一二三四五六七八九十百]/u.test(text[cursor - 1])) cursor -= 1;
    if (cursor === digits) return false;
    if (cursor > 0 && /[(（]/u.test(text[cursor - 1])) cursor -= 1;
    else if (closed) return false;
    return cursor === 0 || /[\s。！？!?；;：:，,、]/u.test(text[cursor - 1]);
  }
  // Whether text[0..end) finishes a sentence (ignoring closing quotes/space).
  function endsSentence(text, end) {
    let index = end - 1;
    while (index > 0 && /[”’"'」』）)\t \r]/u.test(text[index])) index -= 1;
    return index >= 0 && boundary(text, index);
  }
  // Clause marks for natural cut points; ASCII , and : only outside numbers/times.
  function clause(text, index) {
    const char = text[index];
    return /[，、：；—…]/u.test(char) || ((char === "," || char === ":") && !ascii.test(text[index + 1] || ""));
  }
  function clauseStart(text, offset) {
    // Start/seek at the nearest preceding clause or sentence mark when it is
    // close; otherwise keep the whole-word start.
    offset = safe(text, offset);
    for (let index = offset; index > 0 && offset - index < 48; index -= 1) {
      if (boundary(text, index - 1) || clause(text, index - 1)) {
        let start = index;
        while (start < offset && /[\s”’"'」』）)]/u.test(text[start])) start += 1;
        return start;
      }
    }
    return wordStart(text, offset);
  }
  function sentence(text, offset) {
    offset = safe(text, offset);
    // Navigation examines nearby source, not a document-sized sentence/DOM list.
    let start = offset;
    while (start > 0 && offset - start < 4096 && !boundary(text, start - 1)) start -= 1;
    while (start < offset && /[\s”’"'」』）)]/u.test(text[start])) start += 1;
    let end = Math.max(start, offset);
    while (end < text.length && end - offset < 4096) {
      const finish = boundary(text, end++);
      if (finish) break;
    }
    while (end < text.length && /[”’"'」』）)\s]/u.test(text[end])) end += 1;
    return { start: safe(text, start), end: safe(text, end) };
  }
  function partIndex(batch, offset) {
    const relative = offset - batch.start;
    if (relative === 0) return 0;
    const previous = batch.segment_ends.indexOf(relative);
    return previous >= 0 && previous + 1 < batch.segment_ends.length ? previous + 1 : -1;
  }
  function previousSentence(text, offset) {
    let cursor = sentence(text, offset).start - 1;
    while (cursor > 0 && /[”’"'」』）)\s]/u.test(text[cursor])) cursor -= 1;
    return sentence(text, Math.max(0, cursor)).start;
  }
  function batch(text, offset, first = false) {
    // The first batch holds the whole short-to-long clip ramp (see RAMP).
    const start = first ? clauseStart(text, offset) : safe(text, offset), limit = first ? 200 : 480;
    if (start >= text.length) return null;
    const chars = Array.from(text.slice(start, start + 1800)), offsets = [start];
    for (const char of chars) offsets.push(offsets[offsets.length - 1] + char.length);
    let end = Math.min(limit, chars.length), punctuated = false;
    if (offsets[end] < text.length) {
      for (let index = end - 1; index >= Math.floor(limit / 2); index -= 1) {
        if (boundary(text, offsets[index])) { end = index + 1; punctuated = true; break; }
      }
      // No sentence end in range: a clause mark is still a better batch end
      // than an arbitrary word, which the model reads as an utterance ending.
      if (!punctuated) for (let index = end - 1; index >= Math.floor(limit / 4); index -= 1) {
        if (clause(text, offsets[index])) { end = index + 1; punctuated = true; break; }
      }
      while (punctuated && end < Math.min(chars.length, 800) && /[”’"'」』）)\s—…]/u.test(chars[end])) end += 1;
      // Dates, versions, identifiers and words remain whole across API batches.
      const atoms = /(?:[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}[日号]|[0-9]{4}年|[A-Za-z0-9]+(?:[._/\-][A-Za-z0-9]+)*)/gu;
      for (const match of text.slice(start, offsets[Math.min(chars.length, 800)]).matchAll(atoms)) {
        const begin = start + match.index, stop = begin + match[0].length;
        if (begin < offsets[end] && offsets[end] < stop) {
          const target = begin > start ? begin : stop;
          const found = offsets.indexOf(target);
          if (found > 0 && found <= 800) end = found;
          break;
        }
      }
    }
    let stop = offsets[end];
    const candidates = wordEnds(text.slice(start, offsets[Math.min(chars.length, 800)]))
      .filter(value => value.end <= stop - start && value.end > 0 && !dangling.has(value.word));
    if (candidates.length && stop < text.length && !punctuated) stop = start + candidates[candidates.length - 1].end;
    let body = text.slice(start, stop), ends = phraseEnds(body, first);
    if (ends.length > 64) { stop = start + ends[63]; body = text.slice(start, stop); ends = ends.slice(0, 64); }
    return { start, end: stop, text: body, first, segment_ends: ends,
      context_before: Array.from(text.slice(Math.max(0, start - 64), start)).slice(-32).join(""),
      context_after: Array.from(text.slice(stop, stop + 64)).slice(0, 32).join("") };
  }
  return { safe, sentence, batch, phraseEnds, wordEnds, wordStart, clauseStart, numberSpans, partIndex, previousSentence };
})();

if (typeof document !== "undefined") window.CCRDSpeech = (() => {
  const ORIGIN = "https://vomebook-hitokoto.hf.space";
  const plan = CCRDSpeechPlan;
  const $ = selector => document.querySelector(selector);
  const panel = $("#speech-panel");
  if (!panel) return null; // Mixed cached shells must still search normally.
  const status = $("#speech-status"), play = $("#speech-play");
  const previous = $("#speech-previous"), next = $("#speech-next");
  const pitch = $("#speech-pitch"), speed = $("#speech-speed"), timer = $("#speech-timer");
  const visible = $("#speech-visible"), locate = $("#speech-locate");
  const collapse = $("#speech-collapse"), stopButton = $("#speech-stop");
  let preview = null, owner = null, saved = null, audio = null, switching = false;
  let sleepDeadline = 0, finishClip = false, sleepTimer;
  let marked = null, markedRegistry = null;
  // Optional host adapter (paged/sectioned documents) supplies text that only
  // grows at its end, plus DOM mapping. Without one, the preview body is used.
  // NEED covers one batch plus its planning context; growth targets LOOKAHEAD.
  const LOOKAHEAD = 2400, NEED = 1800;
  let starting = 0; // Supersedes pending adapter loads (start/stop).
  function more(snapshot) { return !!snapshot.adapter && !snapshot.adapter.done; }
  function loaded(snapshot, offset) { return !more(snapshot) || snapshot.text.length >= offset + NEED; }
  function sameSource(a, b) { return a?.id === b?.id && (a.adapter || b.adapter ? a.adapter === b.adapter : a.text === b.text); }
  function grow(snapshot, offset, value) {
    if (!more(snapshot) || snapshot.growing) return;
    snapshot.growing = Promise.resolve(snapshot.adapter.ensure(offset + LOOKAHEAD)).catch(() => {}).finally(() => {
      snapshot.growing = null;
      if (value && live(value) && value.wantsPlay) { advance(value); pump(value); }
      controls();
    });
  }
  // Bounded in-memory MP3 clips. Every HF round-trip costs about a second, so
  // sentence changes and seeks play already-published parts from memory.
  const CLIP_LIMIT = 48, CLIP_BYTES = 4 * 1024 * 1024, CLIP_AHEAD = 4, CLIP_LOADS = 2;
  const clips = new Map();
  let clipBytes = 0, clipEpoch = 0, clipLoads = 0;

  function notice(text) { status.textContent = text; }
  function live(value) { return owner === value && !value.cancelled; }
  function nonce() { return Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join(""); }
  function release(id, keepalive = false) {
    if (id) fetch(`${ORIGIN}/tts/jobs/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "omit", keepalive }).catch(() => {});
  }
  function clipKey(value, job, part) { return `${value.snapshot.id}\n${value.pitch}\n${job.batch.start + part.start}\n${job.batch.start + part.end}`; }
  function dropClip(key) {
    const entry = clips.get(key);
    if (!entry) return;
    clips.delete(key);
    entry.controller?.abort();
    if (entry.url) { URL.revokeObjectURL(entry.url); clipBytes -= entry.bytes; }
  }
  function clearClips() { clipEpoch += 1; for (const key of Array.from(clips.keys())) dropClip(key); }
  function clipUrl(key) {
    const entry = clips.get(key);
    if (!entry?.url) return "";
    clips.delete(key); clips.set(key, entry); // Least recently used order.
    return entry.url;
  }
  function storeClip(key, entry, blob) {
    entry.url = URL.createObjectURL(blob); entry.bytes = blob.size; clipBytes += blob.size;
    for (const [other, item] of Array.from(clips)) {
      if (clips.size <= CLIP_LIMIT && clipBytes <= CLIP_BYTES) break;
      if (other !== key && item.url && item.url !== audio?.getAttribute("src") && item.url !== spare?.getAttribute("src")) dropClip(other);
    }
  }
  function fetchClip(value, job, part) {
    const key = clipKey(value, job, part);
    if (clips.has(key) || clipLoads >= CLIP_LOADS || !part.audio_url) return;
    const entry = { url: "", bytes: 0, controller: new AbortController() }, epoch = clipEpoch;
    clips.set(key, entry); clipLoads += 1;
    fetch(ORIGIN + part.audio_url, { credentials: "omit", signal: entry.controller.signal })
      .then(response => response.ok && (response.headers.get("Content-Type") || "").startsWith("audio/mpeg") ? response.blob() : null)
      .then(blob => {
        if (epoch !== clipEpoch || clips.get(key) !== entry) return;
        entry.controller = null;
        if (!blob || blob.size !== part.bytes) clips.delete(key);
        else storeClip(key, entry, blob);
      })
      .catch(() => { if (clips.get(key) === entry) clips.delete(key); })
      .finally(() => {
        clipLoads -= 1;
        if (live(value) && value.wantsPlay && value.current) {
          prefetchAhead(value, value.current.job);
          if (!handoff && !retiring && audio && !audio.paused) armHandoff(value); // the next clip just arrived
        }
      });
  }
  function prefetchAhead(value, job) {
    // Current, a few following parts and the next batch's first parts only;
    // nothing while paused or after a "finish this clip" sleep request.
    if (finishClip || !live(value) || !value.wantsPlay || job.preloaded || job.stale) return;
    // The part already loading from its URL is not downloaded a second time.
    const from = value.current?.job === job && !audio.getAttribute("src")?.startsWith("blob:") ? value.part + 1 : value.part;
    const wanted = job.parts.slice(Math.max(0, from), value.part + CLIP_AHEAD + 1).map(part => [job, part]);
    const following = value.jobs.get(job.batch.end);
    if (following && !following.preloaded) for (const part of following.parts.slice(0, CLIP_AHEAD + 1 - wanted.length)) wanted.push([following, part]);
    for (const [item, part] of wanted) fetchClip(value, item, part);
  }
  function clearPreload() {
    for (const [key, entry] of Array.from(clips)) if (entry.controller) dropClip(key);
  }
  function remember(value, job) {
    if (job.state !== "ready" || !job.used) return;
    value.history = [{ ...job.batch, parts: job.parts.slice() }, ...value.history.filter(batch => batch.start !== job.batch.start)].slice(0, 2);
  }
  function discard(value, job) {
    remember(value, job);
    job.cancelled = true;
    value.jobs.delete(job.batch.start);
    release(job.id);
  }
  function clearSleep() {
    clearTimeout(sleepTimer); sleepDeadline = 0; finishClip = false; timer.value = "off";
  }
  function checkSleep() {
    if (sleepDeadline && Date.now() >= sleepDeadline) { stop("睡眠定时已结束，可继续朗读"); return true; }
    return false;
  }
  function armSleep() {
    clearTimeout(sleepTimer);
    sleepDeadline = timer.value !== "off" && timer.value !== "clip" ? Date.now() + Number(timer.value) * 60000 : 0;
    finishClip = timer.value === "clip";
    if (finishClip && owner) {
      clearPreload();
      for (const job of Array.from(owner.jobs.values())) if (job.batch.start !== owner.batch.start && job.state !== "ready") discard(owner, job);
    }
    function tickSleep() { if (!checkSleep() && sleepDeadline) sleepTimer = setTimeout(tickSleep, Math.min(1000, sleepDeadline - Date.now())); }
    tickSleep();
  }
  // "回到播放位置" <-> "回到原位置" (like a reader's "back to page N" after a jump):
  // after jumping, the button returns to where the reader was until the playing
  // sentence is no longer in view (the reader scrolled away / it moved on).
  let returnView = null, locateTimer = 0;
  function playingInView() {
    const value = owner || saved;
    if (!value || preview?.id !== value.snapshot.id) return false;
    if (value.snapshot.adapter) return preview.adapter === value.snapshot.adapter && !!value.snapshot.adapter.inView?.(value.position);
    const rect = sourceRange(Math.min(value.position, Math.max(0, preview.text.length - 1)))?.getBoundingClientRect();
    const box = preview.body.getBoundingClientRect();
    return !!rect?.height && rect.bottom > Math.max(0, box.top) && rect.top < Math.min(innerHeight, box.bottom);
  }
  function updateLocate() {
    if (returnView && performance.now() > returnView.grace && !playingInView()) returnView = null;
    const back = !!returnView;
    locate.textContent = back ? "回到原位置" : "回到播放位置";
    locate.setAttribute("aria-label", back ? "回到跳转前的阅读位置" : "回到正在朗读的句子");
  }
  function viewChanged() { clearTimeout(locateTimer); locateTimer = setTimeout(updateLocate, 120); }
  function saveView() {
    if (preview?.adapter) return preview.adapter.saveView?.() ?? null;
    return preview?.body ? { body: preview.body, top: preview.body.scrollTop, page: scrollY } : null;
  }
  function restoreView(view) {
    if (view?.body) { view.body.scrollTop = view.top; scrollTo({ top: view.page }); }
    else if (view !== null && view !== undefined) preview?.adapter?.restoreView?.(view);
  }
  async function toggleLocate() {
    if (returnView) {
      const view = returnView.view; returnView = null;
      restoreView(view); updateLocate();
      return;
    }
    const view = saveView();
    await locateSource();
    if (view !== null && view !== undefined) returnView = { view, grace: performance.now() + 2500 };
    updateLocate();
  }
  document.addEventListener("scroll", viewChanged, { capture: true, passive: true });
  function show() {
    const parent = preview?.host?.isConnected ? preview.host : preview?.body?.isConnected ? preview.body.parentElement : $("#preview-panel:not([hidden])") || document.body;
    if (panel.parentElement !== parent) parent.append(panel);
    panel.hidden = false;
    $("[data-speech-toggle]")?.setAttribute("aria-expanded", "true");
  }
  function hide() {
    panel.hidden = true;
    const button = $("[data-speech-toggle]");
    button?.setAttribute("aria-expanded", "false");
    if (panel.contains(document.activeElement) && button?.isConnected) button.focus({ preventScroll: true });
  }
  function controls() {
    play.textContent = owner?.wantsPlay ? "暂停" : owner?.blocked ? "重试" : "继续";
    play.setAttribute("aria-label", play.textContent + "朗读");
    play.disabled = !owner && !saved;
    previous.disabled = !owner || plan.sentence(owner.snapshot.text, owner.position).start <= 0;
    next.disabled = !owner || (plan.sentence(owner.snapshot.text, owner.position).end >= owner.snapshot.text.length && !more(owner.snapshot));
    visible.disabled = !preview;
    locate.disabled = !owner && !saved;
    updateLocate();
    $("#speech-pitch-value").textContent = (Number(pitch.value) > 0 ? "+" : "") + pitch.value;
    $("#speech-speed-value").textContent = Number(speed.value).toFixed(2).replace(/0$/, "") + "×";
    const button = $("[data-speech-toggle]");
    if (button) {
      button.setAttribute("aria-expanded", String(!panel.hidden));
      button.classList.toggle("speech-active", !!owner && owner.snapshot.id === preview?.id);
    }
  }
  function sourceRange(start, end = start + 1) {
    if (!preview || preview.body.textContent !== preview.text) return null;
    const range = document.createRange(), walker = document.createTreeWalker(preview.body, NodeFilter.SHOW_TEXT);
    let node, offset = 0, begun = false;
    while ((node = walker.nextNode())) {
      if (!begun && start < offset + node.length) { range.setStart(node, start - offset); begun = true; }
      if (begun && end <= offset + node.length) { range.setEnd(node, end - offset); return range; }
      offset += node.length;
    }
    return null;
  }
  function clearMark() {
    if (globalThis.CSS?.highlights) CSS.highlights.delete("ccrd-speech");
    if (markedRegistry) { markedRegistry.delete("ccrd-speech"); markedRegistry = null; }
    for (const node of marked || []) {
      const parent = node.parentElement;
      node.replaceWith(...node.childNodes);
      parent?.normalize(); // Older WebViews must not accumulate text nodes per clip.
    }
    marked = null;
  }
  function mark(retried = false) {
    clearMark();
    if (!owner?.current || preview?.id !== owner.snapshot.id || (owner.snapshot.adapter && preview.adapter !== owner.snapshot.adapter)) return;
    const start = owner.current.job.batch.start + owner.current.part.start;
    const end = owner.current.job.batch.start + owner.current.part.end;
    const range = preview.adapter ? preview.adapter.range?.(start, end) : sourceRange(start, end);
    if (!range) {
      // The clip's page/section may not be rendered yet: the adapter can bring
      // it into view, after which the same clip is highlighted once.
      const current = owner.current;
      if (preview.adapter && !retried) Promise.resolve(preview.adapter.follow?.(start, end)).then(() => { if (owner?.current === current) mark(true); }, () => {});
      return;
    }
    if (preview.adapter) {
      // The range may live in an iframe document or shadow tree: register it in
      // that realm's highlight registry and never mutate the host's DOM.
      const realm = (range.startContainer.ownerDocument || document).defaultView || globalThis;
      if (realm.CSS?.highlights && realm.Highlight) { realm.CSS.highlights.set("ccrd-speech", new realm.Highlight(range)); markedRegistry = realm.CSS.highlights; }
      preview.adapter.follow?.(start, end);
      viewChanged();
      return;
    }
    if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set("ccrd-speech", new Highlight(range));
    else {
      const node = document.createElement("mark"); node.className = "speech-current";
      node.append(range.extractContents()); range.insertNode(node); marked = [node];
    }
  }
  function offsetAtPoint(x, y) {
    if (preview?.adapter) return null;
    const point = document.caretPositionFromPoint?.(x, y);
    const range = !point && document.caretRangeFromPoint?.(x, y);
    const node = point?.offsetNode || range?.startContainer, offset = point?.offset ?? range?.startOffset;
    if (!node || !preview?.body.contains(node)) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(preview.body); prefix.setEnd(node, offset);
    return plan.safe(preview.text, prefix.toString().length);
  }
  function visibleOffset() {
    if (!preview) return 0;
    if (preview.adapter) return plan.safe(preview.text, preview.adapter.offsetAtTop?.() || 0);
    const body = preview.body, box = body.getBoundingClientRect(), style = getComputedStyle(body);
    const top = Math.max(box.top, 0, body.parentElement.querySelector(".preview-header")?.getBoundingClientRect().bottom || 0);
    const bottom = Math.min(box.bottom, innerHeight);
    if (bottom <= top) return 0;
    const x = Math.max(1, box.left + parseFloat(style.paddingLeft) + 1);
    // At the top line's leading edge, not at the pointer or the document start.
    for (let y = top + 2; y < Math.min(bottom, top + parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + 8); y += 3) {
      const offset = offsetAtPoint(x, y);
      if (offset !== null) {
        const range = sourceRange(offset, Math.min(preview.text.length, offset + (preview.text.codePointAt(offset) > 65535 ? 2 : 1)));
        const rect = range?.getBoundingClientRect();
        if (rect?.height && rect.bottom > top && rect.top < bottom) return offset;
      }
    }
    return 0;
  }
  async function locateSource() {
    const value = owner || saved;
    if (!value) return;
    const position = value.position, snapshot = value.snapshot;
    if (snapshot.adapter) {
      // The host may have re-based its preview while reading continued; the
      // owning adapter navigates there and republishes itself as the preview.
      if (!preview || preview.id === snapshot.id) { await snapshot.adapter.reveal?.(position); mark(); }
      return;
    }
    if (preview?.id !== snapshot.id) {
      if (typeof openPreview !== "function") return;
      await openPreview(snapshot.id, "", { scroll: false });
    }
    if (preview?.id !== snapshot.id) return;
    const range = sourceRange(Math.min(position, preview.text.length - 1));
    const rect = range?.getBoundingClientRect();
    if (rect) {
      const box = preview.body.getBoundingClientRect();
      preview.body.scrollTop += rect.top - box.top - Math.min(80, box.height / 3);
      if (box.bottom < 0 || box.top > innerHeight) preview.body.scrollIntoView({ block: "nearest" });
      mark();
    }
  }
  function pause() {
    if (!owner) return;
    owner.wantsPlay = false;
    clearPreload();
    for (const job of Array.from(owner.jobs.values())) if (job.batch.start !== owner.batch.start && job.state !== "ready") discard(owner, job);
    audio.pause(); cancelHandoff(); if (retiring) retire(); notice("已暂停"); controls();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }
  function stop(message = "已停止，可继续朗读", keepalive = false, keepClips = false) {
    starting += 1; // A pending adapter load must not start playback after stopping.
    const value = owner;
    if (value) {
      for (const job of value.jobs.values()) remember(value, job);
      saved = { snapshot: value.snapshot, position: value.position, history: value.history, pitch: value.pitch };
      value.cancelled = true; clearTimeout(value.timer);
      for (const controller of value.controllers) if (!controller.createsJob) controller.abort();
      for (const job of value.jobs.values()) release(job.id, keepalive);
    }
    owner = null;
    clearSleep(); clearPreload(); switching = true;
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    cancelHandoff(); if (retiring) retire();
    // An internal restart (seek outside the buffer, pitch, retry) keeps clips;
    // an explicit stop, sleep expiry or page exit releases all audio memory.
    if (!keepClips) clearClips();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
    notice(message); controls();
  }
  // Gapless handoff (double-buffered players, as in gapless music players): the
  // next cached clip is preloaded in a second element and started when this
  // clip's speech ends, instead of waiting for its trailing guard silence and a
  // src swap/decode (measured 0.15-0.18 s per clip). The server adds at least
  // 0.22 s after every part (lost-tail guard for single-element swaps), so a
  // comma took ~0.5 s. Old clips finish their silent tail in their own element.
  const SPOKEN_PAUSE = { comma: .14, clause: .22, sentence: .32, line: .35, list: .3, heading: .45, paragraph: .55, continuation: .06 };
  let spare = null, retiring = null, handoff = null, handoffBlocked = false;
  function newPlayer() {
    const player = new Audio(); player.preload = "auto"; player.hidden = true; player.crossOrigin = "anonymous";
    document.body.append(player);
    return player;
  }
  function cancelHandoff() {
    if (!handoff) return;
    clearTimeout(handoff.timer); handoff = null;
    if (spare && spare !== retiring) { spare.removeAttribute("src"); spare.load(); }
  }
  function retire() {
    const old = retiring; retiring = null;
    if (old && old !== audio) { old.pause(); old.removeAttribute("src"); old.load(); }
    if (owner?.wantsPlay) armHandoff(owner);
  }
  function nextClip(value) {
    const job = value.current?.job, part = job?.parts[value.part + 1];
    if (!part || job.stale) return null;
    const url = clipUrl(clipKey(value, job, part));
    return url ? { job, part, url } : null;
  }
  function armHandoff(value) {
    cancelHandoff();
    const part = value.current?.part, kind = part?.pause_kind;
    if (handoffBlocked || retiring || finishClip || !live(value) || !value.wantsPlay || !spare ||
        !(kind in SPOKEN_PAUSE) || !(part.pause_after_seconds > 0) || !Number.isFinite(audio.duration)) return;
    const next = nextClip(value);
    if (!next) return;
    // Speech ends `pause_after_seconds` before the clip does; keep its intended pause.
    const at = audio.duration - part.pause_after_seconds + SPOKEN_PAUSE[kind];
    if (at >= audio.duration - .03) return;
    spare.src = next.url; spare.load();
    const token = handoff = { ...next, current: value.current, timer: 0 };
    const wait = () => {
      if (handoff !== token) return;
      const left = (at - audio.currentTime) / (audio.playbackRate || 1);
      if (left > .02) { token.timer = setTimeout(wait, Math.min(250, left * 1000)); return; }
      commitHandoff(value, token);
    };
    wait();
  }
  function commitHandoff(value, token) {
    if (handoff !== token || owner !== value || value.current !== token.current || !value.wantsPlay || checkSleep() ||
        spare.readyState < 2 || spare.getAttribute("src") !== token.url) return;
    const next = spare;
    next.defaultPlaybackRate = next.playbackRate = audio.playbackRate;
    if ("preservesPitch" in next) next.preservesPitch = true;
    next.muted = audio.muted; next.volume = audio.volume;
    next.play().then(() => {
      if (handoff !== token || owner !== value || value.current !== token.current || !value.wantsPlay) {
        if (next !== audio) next.pause();
        return;
      }
      handoff = null;
      const previous = audio;
      previous.removeAttribute("id"); next.id = "speech-audio";
      audio = next; spare = previous; retiring = previous;
      previous.addEventListener("ended", retire, { once: true });
      setTimeout(() => { if (retiring === previous) retire(); }, 2000);
      value.position = token.job.batch.start + token.current.part.end; value.part += 1;
      token.job.used = true;
      value.current = { job: token.job, part: token.part }; value.position = token.job.batch.start + token.part.start;
      notice("朗读中"); mark(); controls();
      pump(value);
    }, () => { handoffBlocked = true; handoff = null; }); // e.g. iOS autoplay: keep the ordinary path.
  }
  function clipEnded(event) {
    const value = owner;
    if (event.target !== audio || !value?.current || checkSleep()) return;
    cancelHandoff();
    value.position = value.current.job.batch.start + value.current.part.end;
    value.part += 1; value.current = null;
    if (finishClip) { stop("本句已读完，睡眠定时结束"); return; }
    advance(value); pump(value);
  }
  function bindPlayer(player) {
    player.addEventListener("loadedmetadata", () => {
      if (player !== audio || !owner?.current || checkSleep()) return;
      switching = false; applyRate();
      if (owner.wantsPlay) { playAudio(owner); armHandoff(owner); }
    });
    player.addEventListener("ended", clipEnded);
    player.addEventListener("pause", () => {
      if (player === audio && owner && !switching && !audio.ended && owner.wantsPlay) pause();
    });
    player.addEventListener("error", () => onPlayerError(player));
    player.addEventListener("timeupdate", () => { if (player === audio) checkSleep(); });
  }
  function createAudio() {
    if (audio) return;
    audio = newPlayer(); audio.id = "speech-audio";
    spare = newPlayer();
    bindPlayer(audio); bindPlayer(spare);
  }
  function onPlayerError(player) {
    if (player !== audio) { if (handoff && player === spare) { clearTimeout(handoff.timer); handoff = null; } return; }
    {
      if (!owner?.current || !audio.hasAttribute("src")) return;
      const { job, part } = owner.current;
      if (audio.getAttribute("src").startsWith("blob:") && !job.preloaded && !job.stale) {
        // A browser that cannot decode a Blob MP3 still has the unchanged GET.
        dropClip(clipKey(owner, job, part)); switching = true;
        if (!owner.wantsPlay) { owner.current = null; audio.removeAttribute("src"); audio.load(); return; }
        audio.src = ORIGIN + part.audio_url; audio.load(); applyRate(); return;
      }
      owner.blocked = true; pause(); notice("音频连接中断，点击继续重试，不跳过正文"); controls();
    }
  }
  function applyRate() {
    if (!audio) return;
    audio.defaultPlaybackRate = audio.playbackRate = Number(speed.value);
    if ("preservesPitch" in audio) audio.preservesPitch = true;
  }
  function playAudio(value) {
    if (!live(value) || !value.wantsPlay || checkSleep()) return;
    const current = value.current;
    audio.play().catch(() => {
      if (!live(value) || current !== value.current) return;
      pause(); notice("音频已就绪，请点击继续播放");
    });
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  }
  async function request(path, options, value, timeoutMs = 15000) {
    const controller = new AbortController(); controller.createsJob = options?.method === "POST";
    value.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ORIGIN + path, { ...options, signal: controller.signal, cache: "no-store", credentials: "omit" });
      // HF gateway/proxy failures can return an HTML page; keep the HTTP status.
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        const error = new Error(data?.error?.message || `语音请求失败（${response.status}）`);
        error.status = response.status; error.code = data?.error?.code;
        error.retryAfter = Math.max(2, Math.min(30, Number(response.headers.get("Retry-After")) || 5));
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); value.controllers.delete(controller); }
  }
  function newJob(batch) { return { batch, id: "", nonce: nonce(), parts: [], state: "new", retryAt: 0, failures: 0, deadline: Date.now() + 600000 }; }
  function acceptInline(job, data, value) {
    const clip = data.first_audio, part = job.parts[0], maximum = 128 * 1024;
    const key = part && clipKey(value, job, part);
    if (!job.batch.first || !clip || !part || clips.has(key) || clip.index !== 0 || clip.content_type !== "audio/mpeg" ||
        clip.encoding !== "base64" || !Number.isInteger(clip.bytes) || clip.bytes < 1 || clip.bytes > maximum ||
        clip.bytes !== part.bytes || typeof clip.data !== "string" || clip.data.length !== 4 * Math.ceil(clip.bytes / 3)) return;
    // Transport is optional: malformed/unsupported inline bytes fall back only
    // to the already-validated canonical audio path, never an arbitrary URL.
    try {
      const decoded = atob(clip.data);
      if (decoded.length !== clip.bytes || btoa(decoded) !== clip.data) return;
      const entry = { url: "", bytes: 0, controller: null };
      clips.set(key, entry);
      storeClip(key, entry, new Blob([Uint8Array.from(decoded, char => char.charCodeAt(0))], { type: "audio/mpeg" }));
    } catch (_) { /* Use the ordinary immutable MP3 GET. */ }
  }
  function accept(job, data, value) {
    if (!/^[A-Za-z0-9_-]{32}$/u.test(data.id) || (job.id && job.id !== data.id)) throw new Error("语音任务标识无效");
    job.id = data.id;
    if (data.state === "error") throw new Error(data.error?.message || "语音合成失败，正文未跳过");
    if (["expired", "cancelled"].includes(data.state)) { const error = new Error("语音任务已过期"); error.status = 410; throw error; }
    const parts = data.progress?.parts || [];
    if (!Array.isArray(parts) || parts.length > 64 || (data.result?.pitch_semitones ?? value.pitch) !== value.pitch) throw new Error("语音分段信息无效");
    if (data.progress && (!Number.isInteger(data.progress.total_parts) || data.progress.total_parts < 1 ||
        data.progress.total_parts > 64 || parts.length > data.progress.total_parts)) throw new Error("语音分段总数无效");
    let end = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.index !== index || part.start !== end || !Number.isInteger(part.end) || part.end <= end || part.end > job.batch.text.length ||
          (part.pitch_semitones ?? 0) !== value.pitch || part.audio_url !== `/tts/audio/${job.id}/parts/${index}.mp3`) throw new Error("语音分段未连续保留原文");
      end = part.end;
      if (job.batch.segment_ends[index] !== end) throw new Error("语音没有按完整词句边界生成");
      if (job.parts[index] && (job.parts[index].start !== part.start || job.parts[index].end !== part.end)) throw new Error("已发布语音的原文范围发生变化");
    }
    if (data.state === "ready" && (end !== job.batch.text.length || parts.length !== data.progress?.total_parts)) throw new Error("语音未完整覆盖当前正文");
    job.parts = parts; job.state = data.state; job.preloaded = false;
    acceptInline(job, data, value);
  }
  async function update(value, job) {
    if (!live(value) || job.cancelled || job.pending || !value.wantsPlay || job.state === "ready" || job.blocked || job.stale || Date.now() < job.retryAt || checkSleep()) return;
    job.pending = true;
    try {
      if (Date.now() > job.deadline) throw new Error("语音排队超时，点击继续重试");
      const data = job.id ? await request(`/tts/jobs/${job.id}?after=${job.parts.length}`, {}, value) : await request("/tts/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: job.batch.text, voice: "zf_001", speed: 1.2, pitch_semitones: value.pitch,
          unsupported_policy: "pause", progressive: true, segment_ends: job.batch.segment_ends, wait_first: job.batch.first,
          inline_first: job.batch.first && value.part === 0,
          cache_only: job.restore === true,
          context_before: job.batch.context_before,
          context_after: job.batch.context_after, request_id: job.nonce }) }, value, job.batch.first ? 22000 : 15000);
      if (!live(value) || job.cancelled || value.jobs.get(job.batch.start) !== job) { release(data.id); return; }
      accept(job, data, value); job.failures = 0; job.busy = 0; job.retryAt = Date.now() + (job.parts.length ? 120 : 250);
      advance(value); // A long-polled part can start before the next pump tick.
    } catch (error) {
      if (!live(value) || job.cancelled) return;
      if (job.restore && error.status === 410) {
        // Metadata history is not an audio cache promise. A miss must NOT queue
        // a large old batch; create just the requested new foreground sentence.
        // Clips still held in browser memory keep playing until one is missing.
        if (job.preloaded) { job.stale = true; advance(value); return; }
        start(value.snapshot, value.position, value.wantsPlay, true);
        return;
      }
      job.failures += 1;
      // A just-cancelled seek target or the two-job client bound clears within
      // a moment; do not wait the generic 5 s Retry-After the browser cannot read.
      if (error.status === 429 && ["client_busy", "cancel_pending"].includes(error.code) && (job.busy = (job.busy || 0) + 1) <= 8) {
        job.failures -= 1; job.retryAt = Date.now() + 400; controls(); return;
      }
      const transient = [404, 410, 429, 502, 503, 504].includes(error.status) || error.name === "AbortError" || error instanceof TypeError;
      job.retryAt = Date.now() + 1000 * (error.retryAfter || Math.min(20, 2 ** job.failures));
      job.message = error.message;
      if ([404, 410].includes(error.status)) {
        release(job.id); job.id = ""; job.nonce = nonce(); job.state = "new";
        if (job === value.jobs.get(value.batch.start)) { job.blocked = true; }
      }
      job.blocked = job.blocked || !transient || job.failures >= 3;
      if (job.batch.start === value.batch.start) {
        if (job.blocked) { value.blocked = true; pause(); }
        notice(error.message + (job.blocked ? " · 点击继续重试" : " · 稍后重试，进度保留"));
      }
      controls();
    } finally { job.pending = false; }
  }
  function advance(value) {
    if (!live(value) || !value.wantsPlay || value.blocked || checkSleep()) return;
    let job = value.jobs.get(value.batch.start);
    if (!job) return;
    if (job.blocked) { value.blocked = true; pause(); notice(job.message || "下一段暂未就绪，点击继续重试"); return; }
    if (!value.current) {
      const part = job.parts[value.part];
      const cached = part ? clipUrl(clipKey(value, job, part)) : "";
      if (part && !cached && job.stale) {
        // Server cache miss and no local clip: synthesize from here only.
        start(value.snapshot, job.batch.start + part.start, true, true);
        return;
      }
      if (part && (cached || !job.preloaded)) {
        job.used = true;
        value.current = { job, part }; value.position = job.batch.start + part.start;
        switching = true; cancelHandoff(); audio.src = cached || ORIGIN + part.audio_url; audio.load(); applyRate();
        notice("朗读中"); mark(); controls();
      } else if (job.state === "ready" || (job.stale && !part)) {
        // A paged source may still be loading the text after this batch.
        if (!loaded(value.snapshot, job.batch.end)) { grow(value.snapshot, job.batch.end, value); return; }
        value.position = job.batch.end;
        discard(value, job);
        if (value.position >= value.snapshot.text.length) { stop("已读完全文"); saved = null; controls(); return; }
        value.batch = plan.batch(value.snapshot.text, value.position);
        value.part = 0;
        if (!value.jobs.has(value.batch.start)) value.jobs.set(value.batch.start, newJob(value.batch));
        advance(value); return;
      }
    }
    // One following API batch and a few following published MP3 parts only. No
    // work on pause, no document-wide plan/DOM/audio cache and no whole-book POST.
    // Queue the following batch once the current one is publishing: the server
    // runs one synthesis at a time, so this only removes the boundary wait.
    if (!finishClip && value.current && !loaded(value.snapshot, job.batch.end)) grow(value.snapshot, job.batch.end, value);
    if (!finishClip && value.current && (job.state === "ready" || (job.parts.length && !job.preloaded && !job.stale)) &&
        job.batch.end < value.snapshot.text.length && loaded(value.snapshot, job.batch.end) && !value.jobs.has(job.batch.end)) {
      // A completed preceding batch can remain usable briefly after a seek, but
      // never keep a third subscription or add extra speculative inference.
      for (const other of Array.from(value.jobs.values())) if (other !== job) discard(value, other);
      const batch = plan.batch(value.snapshot.text, job.batch.end);
      value.jobs.set(batch.start, newJob(batch));
    }
    if (value.current) prefetchAhead(value, job);
  }
  async function pump(value) {
    if (!live(value) || value.pumpEpoch === value.seekEpoch || checkSleep() || !value.wantsPlay) return;
    const epoch = value.seekEpoch;
    clearTimeout(value.timer); value.pumpEpoch = epoch;
    try {
      const current = value.jobs.get(value.batch.start);
      if (current) await update(value, current);
      if (!live(value) || epoch !== value.seekEpoch) return;
      advance(value); // Never wait for speculative work before playing a part.
      if (!live(value) || !value.wantsPlay) return;
      for (const job of Array.from(value.jobs.values())) if (job.batch.start !== current?.batch.start) {
        await update(value, job);
        if (!live(value) || epoch !== value.seekEpoch) return;
        advance(value);
      }
    } finally {
      if (epoch === value.seekEpoch) {
        value.pumpEpoch = null;
        if (live(value) && value.wantsPlay) value.timer = setTimeout(() => pump(value), value.current ? 600 : 250);
      }
    }
  }
  function start(snapshot, offset, playing = true, skipHistory = false) {
    createAudio();
    if (!loaded(snapshot, offset)) {
      // Load enough source around the target first; a newer start wins.
      const token = ++starting;
      notice("正在载入正文…"); show();
      // A host may report where a slow search for text has reached.
      const progress = setInterval(() => {
        const text = token === starting && snapshot.adapter.progress?.();
        if (text) notice(text); else if (token !== starting) clearInterval(progress);
      }, 500);
      Promise.resolve(snapshot.adapter.ensure(offset + NEED)).catch(() => {}).then(() => {
        clearInterval(progress);
        if (token !== starting) return;
        if (!snapshot.text.trim()) { notice("这份文档没有可朗读的文字"); return; }
        start(snapshot, Math.min(offset, snapshot.text.length), playing, skipHistory);
      });
      return;
    }
    starting += 1;
    const mode = timer.value, deadline = sleepDeadline;
    if (owner) for (const job of owner.jobs.values()) remember(owner, job);
    const recent = owner || saved;
    const history = sameSource(recent?.snapshot, snapshot) && recent.pitch === Number(pitch.value) ? recent.history.slice() : [];
    const restored = !skipHistory && history.find(batch => plan.partIndex(batch, offset) >= 0);
    stop("正在准备首句…", false, recent?.snapshot.id === snapshot.id);
    const batch = restored || plan.batch(snapshot.text, offset, true);
    if (!batch) { notice("已到正文末尾"); return; }
    const value = { snapshot, batch, position: restored ? offset : batch.start, part: restored ? plan.partIndex(batch, offset) : 0,
      current: null, pitch: Number(pitch.value), wantsPlay: playing, history,
      jobs: new Map(), controllers: new Set(), cancelled: false, blocked: false, seekEpoch: 0, pumpEpoch: null };
    const job = newJob(batch); job.restore = !!restored;
    // Remembered source ranges let locally held clips play before the
    // cache_only confirmation returns; URLs are replaced once it arrives.
    if (restored?.parts?.length) { job.parts = restored.parts.slice(); job.preloaded = true; }
    value.jobs.set(batch.start, job); owner = value; saved = null;
    timer.value = mode; armSleep();
    if (deadline) { sleepDeadline = deadline; if (checkSleep()) return; }
    $("#speech-title").textContent = snapshot.title || "朗读";
    show(); notice(playing ? "正在准备首句…" : "已选择句子，点击继续播放"); controls();
    if ("mediaSession" in navigator && "MediaMetadata" in globalThis) navigator.mediaSession.metadata = new MediaMetadata({ title: snapshot.title });
    if (job.preloaded) advance(value);
    pump(value); // First POST directly; no iframe, voices or health round-trips.
  }
  function fromPreview(offset) {
    // An adapter loads its text on demand; start() waits for it.
    if (!preview || (!preview.adapter && !preview.text.trim())) { if (typeof showToast === "function") showToast("请等待预览正文加载完成"); return; }
    if (offset === undefined && preview.adapter?.locateTop) {
      // Find (and load up to) the text at the reading position first, so a
      // paged document is not read from its first loaded unit.
      const token = ++starting;
      if (!owner) { notice("正在定位当前阅读位置…"); show(); }
      Promise.resolve(preview.adapter.locateTop()).catch(() => 0).then((found) => {
        if (token === starting && preview?.adapter) fromPreview(plan.safe(preview.text, Number(found) || 0));
      });
      return;
    }
    if (offset === undefined) offset = visibleOffset();
    if (owner && owner.snapshot.id !== preview.id && !confirm("切换到当前预览会停止原朗读，继续吗？")) return;
    if (owner && sameSource(owner.snapshot, preview) && seek(owner, offset, true)) return;
    start(preview.adapter ? preview.snapshot : { id: preview.id, text: preview.text, title: preview.title }, offset);
  }
  function resume() {
    if (checkSleep()) return;
    if (!owner) { if (saved) start(saved.snapshot, saved.position); return; }
    if (owner.blocked || owner.settingsChanged) { start(owner.snapshot, owner.position); return; }
    owner.wantsPlay = true; notice("正在继续…"); controls();
    if (owner.current) { playAudio(owner); armHandoff(owner); }
    advance(owner); pump(owner);
  }
  function launch() {
    if (!owner) {
      // A host adapter resumes a stopped session only when it is the same
      // window; otherwise "听书" starts where the reader is looking now.
      if (saved?.snapshot.id === preview?.id && (!preview?.adapter || saved.snapshot.adapter === preview.adapter && !preview.adapter.locateTop)) start(saved.snapshot, saved.position);
      else fromPreview();
    } else if (!panel.hidden) hide();
    else { show(); if (!owner.wantsPlay && owner.snapshot.id === preview?.id) resume(); }
  }
  function navigate(direction) {
    if (!owner) return;
    const sentence = plan.sentence(owner.snapshot.text, owner.position);
    const target = direction > 0 ? sentence.end : plan.previousSentence(owner.snapshot.text, owner.position);
    if ((target < owner.snapshot.text.length || more(owner.snapshot)) && !seek(owner, target, owner.wantsPlay)) start(owner.snapshot, target, owner.wantsPlay);
  }
  function seek(value, offset, playing) {
    if (!live(value) || value.settingsChanged || value.pitch !== Number(pitch.value)) return false;
    const job = Array.from(value.jobs.values()).find(item => !item.cancelled && !item.blocked && plan.partIndex(item.batch, offset) >= 0);
    if (!job) return false;
    const index = plan.partIndex(job.batch, offset), current = value.current;
    value.seekEpoch += 1; clearTimeout(value.timer); clearPreload();
    value.position = offset; value.batch = job.batch; value.part = index; value.wantsPlay = playing;
    value.blocked = false;
    // Do not let synthesis of a now irrelevant batch hold up the target job.
    for (const other of Array.from(value.jobs.values())) {
      if (other !== job && other.batch.start !== job.batch.end && other.state !== "ready") discard(value, other);
      else if (!playing && other !== job && other.state !== "ready") discard(value, other);
    }
    if (current?.job === job && current.part.index === index && audio.readyState >= 1 && !audio.error) {
      audio.currentTime = 0;
      if (playing) playAudio(value); else audio.pause();
    } else {
      value.current = null; switching = true; audio.pause(); audio.removeAttribute("src"); audio.load();
      advance(value);
    }
    show(); mark(); controls();
    notice(playing ? (value.current ? "朗读中" : "正在准备所选句…") : "已选择句子，点击继续播放");
    pump(value);
    return true;
  }
  function previewLoaded(value) {
    clearMark();
    if (value.adapter) {
      // Host-supplied document (e.g. the Reader). One stable snapshot per
      // adapter: its text getter grows, so offsets and history stay valid.
      const adapter = value.adapter;
      const snapshot = { id: value.id, title: value.title, adapter, get text() { return adapter.text; } };
      preview = { id: value.id, title: value.title, adapter, snapshot, host: value.host || null, body: value.body || adapter.root || null, get text() { return adapter.text; } };
    } else preview = { ...value, body: $("#preview-panel .preview-body") };
    if (!preview.body && !preview.adapter) { preview = null; return; }
    // Older cached app.js may still produce the former three-button toolbar.
    $(".preview-speech-tools")?.remove();
    const tools = value.tools || $("#preview-panel .preview-tools");
    if (tools && !tools.querySelector("[data-speech-toggle]")) {
      const button = document.createElement("button"); button.type = "button"; button.className = value.buttonClass || "icon-btn-sm preview-speech-btn";
      button.dataset.speechToggle = ""; button.setAttribute("aria-label", "朗读与设置"); button.setAttribute("aria-controls", "speech-panel");
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
      tools.prepend(button);
    }
    arrangeToggle();
    if (!panel.hidden) show();
    mark(); controls();
    // Establish the TLS connection while reading the preview, not with an
    // expensive fixed-query/model warmup or speculative synthesis.
    if (!$("link[data-speech-connect]")) {
      const link = document.createElement("link"); link.rel = "preconnect"; link.href = ORIGIN; link.crossOrigin = "anonymous";
      link.dataset.speechConnect = ""; document.head.append(link);
    }
  }
  function previewClosed() { clearMark(); preview = null; if (panel.parentElement !== document.body) document.body.append(panel); controls(); }
  function previewPending() {
    clearMark(); preview = null; controls();
    // Keep the old modal preview's controls inside its focus scope while the
    // new source is loading. Detach only immediately before replacing its DOM.
  }
  function arrangeToggle() {
    const button = $("[data-speech-toggle]"), tools = button?.parentElement;
    if (!tools) return;
    if (document.body.classList.contains("mobile")) tools.append(button);
    else tools.prepend(button);
  }
  new MutationObserver(arrangeToggle).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("click", event => { if (event.target.closest("[data-speech-toggle]")) launch(); });
  document.addEventListener("dblclick", event => {
    if (preview?.adapter || !preview?.body?.contains(event.target)) return;
    const offset = offsetAtPoint(event.clientX, event.clientY);
    if (offset === null) return;
    const sentence = plan.sentence(preview.text, offset);
    const range = sourceRange(sentence.start, sentence.end);
    if (range) { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    fromPreview(sentence.start);
  });
  play.addEventListener("click", () => { if (owner?.wantsPlay) pause(); else resume(); });
  previous.addEventListener("click", () => navigate(-1));
  next.addEventListener("click", () => navigate(1));
  visible.addEventListener("click", () => fromPreview());
  locate.addEventListener("click", toggleLocate);
  collapse.addEventListener("click", hide);
  stopButton.addEventListener("click", () => { stop(); clearMark(); hide(); });
  pitch.addEventListener("input", controls);
  pitch.addEventListener("change", () => {
    if (!owner) return;
    if (owner.wantsPlay) start(owner.snapshot, owner.position);
    else { owner.settingsChanged = true; notice("音高已调整，点击继续后从当前句重新生成"); }
  });
  speed.addEventListener("input", () => { applyRate(); controls(); if (owner?.current && owner.wantsPlay && !retiring) armHandoff(owner); });
  timer.addEventListener("change", armSleep);
  panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); } });
  window.addEventListener("pagehide", () => stop("已停止", true));
  document.addEventListener("visibilitychange", checkSleep);
  window.addEventListener("online", () => { if (owner?.wantsPlay) pump(owner); });
  if ("mediaSession" in navigator) {
    for (const [action, handler] of Object.entries({ play: resume, pause, stop: () => stop(), previoustrack: () => navigate(-1), nexttrack: () => navigate(1) })) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* Optional. */ }
    }
  }
  controls();
  // readFrom: a host adapter's double-click/selection starts at a source offset.
  return { launch, previewLoaded, previewPending, previewClosed, owns: node => !!node && panel.contains(node), modal: () => false,
    readFrom: offset => { if (preview) fromPreview(plan.sentence(preview.text, offset).start); },
    // Host hooks: show the playing sentence (no "回到原位置" toggle) and report
    // scrolling the player cannot observe itself (e.g. inside an iframe).
    reveal: () => { returnView = null; return locateSource().then(updateLocate); },
    viewChanged,
    state: () => ({ active: !!owner, playing: !!owner?.wantsPlay, adapter: owner?.snapshot.adapter || saved?.snapshot.adapter || null }),
    stop: () => { stop("已停止", true); clearMark(); hide(); } };
})();
