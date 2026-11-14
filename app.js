'use strict';

/* =========================================================
   读书 —— 拍一页，念给你听
   图片只在本机识别，不上传。
   ========================================================= */

const $ = (sel) => document.querySelector(sel);

const LS = {
  text: 'dushu.text',
  pages: 'dushu.pages',
  idx: 'dushu.idx',
  rate: 'dushu.rate',
  volume: 'dushu.volume',
  autoScroll: 'dushu.autoscroll',
  fontSize: 'dushu.fontsize',
};

const state = {
  pages: [],          // [{ id, order, blob, width, height, lines:[{text,bbox}] }]
  pageUrls: [],
  sentences: [],      // [{ text, page }]
  idx: 0,
  playing: false,
  paused: false,
  finished: false,
  rate: 1,
  volume: 1,
  autoScroll: true,
  fontSize: 19,
  // 朗读用本机的 Piper 语音（华言女声），不再用系统音色
  audio: null,
  audioCache: new Map(),
  audioPending: new Map(),
  piper: null,
  piperPromise: null,
  piperFailed: false,
  synthToken: 0,
  worker: null,
  busy: false,
  canceled: false,
  wakeLock: null,
};

/* ---------------- 启动 ---------------- */

document.addEventListener('DOMContentLoaded', init);

function init() {
  readSettings();
  bindEvents();
  initAudio();
  restoreReading();
}

/* ---------------- 设置读写 ---------------- */

function num(key, fallback) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
}

function readSettings() {
  state.rate = Math.min(2, Math.max(0.5, num(LS.rate, 1)));
  state.volume = Math.min(1, Math.max(0, num(LS.volume, 1)));
  state.fontSize = Math.min(30, Math.max(15, num(LS.fontSize, 19)));
  const auto = localStorage.getItem(LS.autoScroll);
  state.autoScroll = auto === null ? true : auto === '1';

  const rateRange = $('#rateRange');
  const volRange = $('#volRange');
  if (rateRange) rateRange.value = String(state.rate);
  if (volRange) volRange.value = String(state.volume);
  updateRateLabels();
  const autoEl = $('#autoScroll');
  if (autoEl) autoEl.checked = state.autoScroll;
  applyFontSize();
}

function updateRateLabels() {
  const rateVal = $('#rateVal');
  if (rateVal) rateVal.textContent = state.rate.toFixed(1);
  const rateText = $('#rateText');
  if (rateText) rateText.textContent = `${state.rate.toFixed(1)} 倍`;
  const volVal = $('#volVal');
  if (volVal) volVal.textContent = Math.round(state.volume * 100) + '%';
}

function applyFontSize() {
  document.documentElement.style.setProperty('--read-size', state.fontSize + 'px');
  localStorage.setItem(LS.fontSize, String(state.fontSize));
}

/* ---------------- 页面存取（IndexedDB：原图 + 文字行坐标） ---------------- */

const DB_NAME = 'dushu-pages';
const DB_STORE = 'pages';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function dbAll() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
  );
}

function dbPut(page) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(page);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function dbClear() {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

async function restoreReading() {
  state.idx = parseInt(localStorage.getItem(LS.idx) || '0', 10) || 0;
  try {
    const pages = await dbAll();
    pages.sort((a, b) => (a.order || 0) - (b.order || 0));
    state.pages = pages;
  } catch (e) {
    console.error(e);
    state.pages = [];
  }
  if (state.pages.length) render();
  else showEmpty();
}

function saveIdx() {
  try { localStorage.setItem(LS.idx, String(state.idx)); } catch (e) { /* 忽略 */ }
}

/* ---------------- 视图切换 ---------------- */

function showEmpty() {
  $('#emptyState').classList.remove('hidden');
  $('#readingState').classList.add('hidden');
  $('#player').classList.add('hidden');
}

function showReading() {
  $('#emptyState').classList.add('hidden');
  $('#readingState').classList.remove('hidden');
  $('#player').classList.remove('hidden');
}

/* ---------------- 句子与行坐标 ---------------- */

function splitSentencesWithPos(text) {
  const out = [];
  let start = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      if (cur) {
        out.push({ text: cur, start, end: i });
        cur = '';
      }
      start = i + 1;
      continue;
    }
    cur += ch;
    if (END_PUNCT.includes(ch)) {
      while (i + 1 < text.length && CLOSERS.includes(text[i + 1])) {
        cur += text[++i];
      }
      out.push({ text: cur, start, end: i + 1 });
      start = i + 1;
      cur = '';
    }
  }
  if (cur) out.push({ text: cur, start, end: text.length });
  return out;
}

function buildPageSentences(lines) {
  let full = '';
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    const start = full.length;
    full += t;
    ranges.push({ start, end: full.length });

    // 标题这类短行单独成句，别和下一行正文粘在一起
    const next = lines[i + 1];
    if (next && t.length <= 16 && !/[。！？；：…，,、]$/.test(t)) {
      full += '\n';
    }
  }
  return { ranges, sents: splitSentencesWithPos(full) };
}

// 这一行第一个字落在哪一句里
function sentenceIndexAtLine(sents, ranges, lineIdx) {
  const rs = ranges[lineIdx].start;
  for (let i = 0; i < sents.length; i++) {
    if (sents[i].end > rs) return i;
  }
  return Math.max(0, sents.length - 1);
}

// 某个字符位置落在哪一行
function lineIndexOf(ranges, pos) {
  for (let i = 0; i < ranges.length; i++) {
    if (pos < ranges[i].end) return i;
  }
  return Math.max(0, ranges.length - 1);
}

/* ---------------- 渲染：直接显示原图，文字变成图上的热区 ---------------- */

function render() {
  const tv = $('#textView');
  tv.innerHTML = '';
  state.sentences = [];

  if (state.pageUrls && state.pageUrls.length) {
    state.pageUrls.forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ }
    });
  }
  state.pageUrls = [];

  if (!state.pages.length) {
    showEmpty();
    return;
  }

  state.pages.forEach((page, pi) => {
    const { ranges, sents } = buildPageSentences(page.lines || []);
    if (!sents.length) return;

    const base = state.sentences.length;
    sents.forEach((s) => state.sentences.push({ text: s.text, page: pi }));

    const article = document.createElement('article');
    article.className = 'page-view';

    const frame = document.createElement('div');
    frame.className = 'page-frame';

    const img = document.createElement('img');
    img.alt = `第 ${pi + 1} 页`;
    img.loading = pi === 0 ? 'eager' : 'lazy';
    if (page.blob) {
      const url = URL.createObjectURL(page.blob);
      state.pageUrls.push(url);
      img.src = url;
    }
    frame.appendChild(img);

    const overlay = document.createElement('div');
    overlay.className = 'page-hotspots';

    // 点图上任意一段文字，就从那里开始读
    overlay.addEventListener('click', (e) => {
      const hs = e.target.closest('.hs');
      if (!hs) return;
      const i = parseInt(hs.dataset.sent, 10);
      if (Number.isFinite(i)) seekTo(i);
    });

    (sents || []).forEach((s, si) => {
      const globalIdx = base + si;
      const startLine = lineIndexOf(ranges, s.start);
      const endLine = lineIndexOf(ranges, Math.max(s.start, s.end - 1));

      for (let li = startLine; li <= endLine; li++) {
        const rs = ranges[li].start;
        const re = ranges[li].end;
        const segStart = Math.max(s.start, rs);
        const segEnd = Math.min(s.end, re);
        if (segEnd <= segStart) continue;

        const line = page.lines[li];
        const b = line && line.bbox;
        if (!b) continue;

        // 按字符比例算出这句话在这一行里的左右边界
        const span = Math.max(1, re - rs);
        const r0 = (segStart - rs) / span;
        const r1 = (segEnd - rs) / span;
        const x0 = b.x0 + (b.x1 - b.x0) * r0;
        const x1 = b.x0 + (b.x1 - b.x0) * r1;

        const hs = document.createElement('div');
        hs.className = 'hs';
        hs.style.left = (x0 / page.width) * 100 + '%';
        hs.style.top = (b.y0 / page.height) * 100 + '%';
        hs.style.width = Math.max(0.6, ((x1 - x0) / page.width) * 100) + '%';
        hs.style.height = ((b.y1 - b.y0) / page.height) * 100 + '%';
        hs.dataset.sent = String(globalIdx);
        hs.setAttribute('role', 'button');
        hs.setAttribute('aria-label', s.text);
        overlay.appendChild(hs);
      }
    });

    frame.appendChild(overlay);
    article.appendChild(frame);
    tv.appendChild(article);
  });

  if (!state.sentences.length) {
    showEmpty();
    return;
  }

  if (state.idx >= state.sentences.length) state.idx = 0;
  if (state.idx < 0) state.idx = 0;

  $('#pageCount').textContent = `共 ${state.pages.length} 页`;
  updateActive();
  showReading();
}

function updateActive() {
  document.querySelectorAll('.hs.active').forEach((el) => el.classList.remove('active'));
  const list = document.querySelectorAll(`.hs[data-sent="${state.idx}"]`);
  list.forEach((el) => el.classList.add('active'));

  $('#posText').textContent = state.sentences.length
    ? `${state.idx + 1} / ${state.sentences.length}`
    : '0 / 0';
  saveIdx();
  return list;
}

function setCurrent(i, opts) {
  if (!state.sentences.length) return;
  state.idx = Math.max(0, Math.min(i, state.sentences.length - 1));
  const list = updateActive();
  if (opts && opts.scroll && state.autoScroll && list && list.length) {
    list[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ---------------- 断句 ---------------- */

const END_PUNCT = '。！？!?…';
const CLOSERS = '”’」』"）)]】》';

function splitSentences(para) {
  const raw = [];
  let cur = '';

  for (let i = 0; i < para.length; i++) {
    const ch = para[i];
    if (ch === '\n') {
      if (cur.trim()) raw.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
    if (END_PUNCT.includes(ch)) {
      while (i + 1 < para.length && CLOSERS.includes(para[i + 1])) {
        cur += para[++i];
      }
      if (cur.trim()) raw.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) raw.push(cur.trim());

  const out = [];
  for (const s of raw) {
    if (s.length <= 80) {
      out.push(s);
      continue;
    }
    // 太长的句子按逗号、顿号再拆，方便定位和暂停
    let buf = '';
    for (let i = 0; i < s.length; i++) {
      buf += s[i];
      if ('，,、；;：:'.includes(s[i]) && buf.length >= 40) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf.trim()) {
      if (buf.trim().length < 10 && out.length) out[out.length - 1] += buf.trim();
      else out.push(buf.trim());
    }
  }
  return out.filter(Boolean);
}

/* ---------------- 朗读 ---------------- */

/* ---------------- 朗读（本机 Piper 离线语音） ---------------- */

const PIPER_VOICE = 'zh_CN-huayan-medium';

function initAudio() {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('ended', onAudioEnded);
  audio.addEventListener('error', () => {
    if (state.playing && !state.paused) skipToNext();
  });
  state.audio = audio;
}

function piperBase() {
  return ASSET_BASE + 'vendor/piper/';
}

// 模型只读一次，每次都返回同一个 ArrayBuffer，ONNX 会话才会复用
function makeVoiceProvider(base) {
  let config = null;
  let model = null;

  async function load() {
    if (model) return;
    const [cfgRes, modelRes] = await Promise.all([
      fetch(base + PIPER_VOICE + '.onnx.json'),
      fetch(base + PIPER_VOICE + '.onnx'),
    ]);
    if (!cfgRes.ok || !modelRes.ok) throw new Error('voice-files');
    config = await cfgRes.json();
    model = await modelRes.arrayBuffer();
  }

  return {
    async fetch() {
      await load();
      const cfg = JSON.parse(JSON.stringify(config));
      const natural = cfg.inference.length_scale || 1;
      // 语速快了，就把音拉短
      cfg.inference.length_scale = natural / state.rate;
      return [cfg, model];
    },
    destroy() {},
  };
}

async function ensurePiper() {
  if (state.piper) return state.piper;
  if (state.piperPromise) return state.piperPromise;

  state.piperPromise = (async () => {
    const base = piperBase();
    const mod = await import(base + 'piper-tts-web.js');
    const engine = new mod.PiperWebEngine({
      onnxRuntime: new mod.OnnxWebRuntime({ basePath: base + 'onnx/', numThreads: 1 }),
      phonemizeRuntime: new mod.PhonemizeWebRuntime({ basePath: base + 'piper/' }),
      voiceProvider: makeVoiceProvider(base + 'models/'),
    });
    return { engine };
  })();

  try {
    state.piper = await state.piperPromise;
    return state.piper;
  } catch (e) {
    state.piperPromise = null;
    state.piperFailed = true;
    throw e;
  }
}

function audioKey(idx) {
  return `${state.rate.toFixed(2)}|${state.sentences[idx].text}`;
}

async function getAudioFor(idx) {
  const key = audioKey(idx);
  if (state.audioCache.has(key)) return state.audioCache.get(key);
  if (state.audioPending.has(key)) return state.audioPending.get(key);

  const task = (async () => {
    const { engine } = await ensurePiper();
    const res = await engine.generate(state.sentences[idx].text, PIPER_VOICE, 0);
    const item = { url: URL.createObjectURL(res.file), duration: res.duration };
    state.audioCache.set(key, item);

    while (state.audioCache.size > 30) {
      const firstKey = state.audioCache.keys().next().value;
      const old = state.audioCache.get(firstKey);
      state.audioCache.delete(firstKey);
      try { URL.revokeObjectURL(old.url); } catch (e) { /* 忽略 */ }
    }
    return item;
  })();

  state.audioPending.set(key, task);
  try {
    return await task;
  } finally {
    state.audioPending.delete(key);
  }
}

function clearAudioCache() {
  for (const item of state.audioCache.values()) {
    try { URL.revokeObjectURL(item.url); } catch (e) { /* 忽略 */ }
  }
  state.audioCache.clear();
}

async function playCurrentSentence() {
  if (!state.playing || state.paused) return;
  if (!state.sentences.length) return;

  if (state.idx >= state.sentences.length) {
    finishPlayback();
    return;
  }

  const idx = state.idx;
  const token = ++state.synthToken;

  setCurrent(idx, { scroll: true });

  let item;
  try {
    item = await getAudioFor(idx);
  } catch (e) {
    if (token !== state.synthToken) return;
    console.error(e);
    if (state.piperFailed) {
      toast('语音包没加载出来，检查一下 vendor/piper');
      stopSpeech();
      return;
    }
    skipToNext();
    return;
  }

  if (token !== state.synthToken || !state.playing || state.idx !== idx) return;

  const audio = state.audio;
  audio.src = item.url;
  audio.volume = state.volume;
  audio.play().catch((err) => {
    console.error(err);
    if (state.playing && !state.paused) skipToNext();
  });

  prefetchSentence(idx + 1);
}

function prefetchSentence(idx) {
  if (idx >= state.sentences.length) return;
  getAudioFor(idx).catch(() => { /* 预取失败就算了 */ });
}

function onAudioEnded() {
  if (!state.playing || state.paused) return;
  if (state.idx + 1 >= state.sentences.length) {
    finishPlayback();
    return;
  }
  state.idx += 1;
  playCurrentSentence();
}

function skipToNext() {
  if (!state.playing) return;
  if (state.idx + 1 >= state.sentences.length) {
    finishPlayback();
    return;
  }
  state.idx += 1;
  playCurrentSentence();
}

function playFromCurrent() {
  if (!state.sentences.length) return;

  if (state.paused) {
    state.paused = false;
    updatePlayButton();
    state.audio.play().catch(() => {});
    return;
  }

  if (state.finished) {
    state.finished = false;
    setCurrent(0);
  }

  state.playing = true;
  state.paused = false;
  updatePlayButton();
  requestWakeLock();

  if (!state.piper && !state.piperPromise) {
    toast('正在加载离线语音，第一次要十几秒');
  }

  playCurrentSentence();
}

function togglePlay() {
  if (!state.sentences.length) return;
  if (state.playing && !state.paused) {
    state.paused = true;
    state.audio.pause();
    updatePlayButton();
    return;
  }
  playFromCurrent();
}

function stopSpeech() {
  state.playing = false;
  state.paused = false;
  state.finished = false;
  state.synthToken++;
  if (state.audio) state.audio.pause();
  updatePlayButton();
  releaseWakeLock();
}

function finishPlayback() {
  state.playing = false;
  state.paused = false;
  state.finished = true;
  state.synthToken++;
  if (state.audio) state.audio.pause();
  updatePlayButton();
  releaseWakeLock();
  setCurrent(state.sentences.length - 1);
}

function jump(delta) {
  if (!state.sentences.length) return;
  const wasPlaying = state.playing && !state.paused;
  const target = Math.max(0, Math.min(state.idx + delta, state.sentences.length - 1));

  stopSpeech();
  state.finished = false;
  setCurrent(target);

  if (wasPlaying) {
    state.playing = true;
    updatePlayButton();
    requestWakeLock();
    playCurrentSentence();
  }
}

function seekTo(i) {
  if (!state.sentences.length) return;
  const wasPlaying = state.playing && !state.paused;
  stopSpeech();
  state.finished = false;
  setCurrent(i);
  if (wasPlaying) {
    state.playing = true;
    updatePlayButton();
    requestWakeLock();
    playCurrentSentence();
  }
}

function updatePlayButton() {
  const showPause = state.playing && !state.paused;
  $('#playIconPlay').classList.toggle('hidden', showPause);
  $('#playIconPause').classList.toggle('hidden', !showPause);
  $('#btnPlay').setAttribute('aria-label', showPause ? '暂停' : '播放');
}

/* ---------------- 屏幕常亮（播放时） ---------------- */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (e) { /* 不支持就算了 */ }
}

function releaseWakeLock() {
  try {
    if (state.wakeLock) state.wakeLock.release();
  } catch (e) { /* 忽略 */ }
  state.wakeLock = null;
}

/* ---------------- 音色固定为 Piper 华言，不再枚举系统语音 ---------------- */

/* ---------------- OCR ---------------- */

function onOcrProgress(m) {
  if (!state.busy) return;
  const labels = {
    'loading tesseract core': '正在加载识别引擎',
    'initializing tesseract': '正在初始化引擎',
    'loading language traineddata': '正在下载中文识别包',
    'initializing api': '正在准备中文识别',
    'recognizing text': '正在识别文字',
  };
  const title = labels[m.status] || m.status || '正在识别';
  const pct = typeof m.progress === 'number' ? Math.round(m.progress * 100) : null;

  // 只更新副标题，主标题保留“第几页”，避免来回闪
  $('#overlaySub').textContent = pct !== null ? `${title} ${pct}%` : title;
  if (pct !== null) setBar(m.progress);
}

const ASSET_BASE = new URL('.', location.href).href;   // 页面所在目录，末尾带斜杠

async function ensureWorker() {
  if (state.worker) return state.worker;
  if (!window.Tesseract) throw new Error('no-tesseract');

  const worker = await Tesseract.createWorker('chi_sim', 1, {
    workerPath: ASSET_BASE + 'vendor/worker.min.js',
    corePath: ASSET_BASE + 'vendor',
    langPath: ASSET_BASE + 'vendor/tessdata',
    logger: onOcrProgress,
  });
  state.worker = worker;
  return worker;
}

function disposeWorker() {
  const w = state.worker;
  state.worker = null;
  if (w) {
    try {
      const p = w.terminate();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 忽略 */ }
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  if (!files.length || state.busy) return;

  state.busy = true;
  state.canceled = false;
  stopSpeech();

  showOverlay('准备识别', '第一次用要下载中文识别包，请稍等');
  setBar(0);

  let done = 0;

  try {
    const worker = await ensureWorker();

    for (let i = 0; i < files.length; i++) {
      if (state.canceled) break;

      showOverlay(
        files.length > 1 ? `正在识别第 ${i + 1} / ${files.length} 页` : '正在识别这一页',
        ''
      );
      setBar(0);

      const img = await loadImage(files[i]);
      const canvas = preprocess(img);
      const result = await worker.recognize(canvas, {}, { blocks: true, text: true });
      if (state.canceled) break;

      const lines = extractLines(result && result.data);

      if (!lines.length) {
        toast('这一页没认出字。试试光线亮一点，镜头正对书页，拍得平整些');
      } else {
        const blob = await canvasToBlob(canvas);
        await addPage({
          blob,
          width: canvas.width,
          height: canvas.height,
          lines,
        });
        done++;
      }

      setBar((i + 1) / files.length);
    }

    if (state.canceled) {
      toast('已经停下');
    } else if (!done && files.length) {
      // 全部失败时给个明确的提示
      toast('这次没认出文字，换一张清楚的照片再试');
    }
  } catch (err) {
    console.error(err);
    if (state.canceled) {
      // 取消时 terminate 会抛错，忽略
    } else if (err && err.message === 'no-tesseract') {
      toast('识别程序没加载出来，检查一下网络再试');
      disposeWorker();
    } else {
      toast('识别出问题了，检查网络后再试一次');
      disposeWorker();
    }
  } finally {
    state.busy = false;
    state.canceled = false;
    hideOverlay();
    const input = $('#fileInput');
    if (input) input.value = '';
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * 只把照片缩到合适的尺寸，减少处理时间。
 * 不去做灰度、拉对比度——实测那样会吃掉细小的标点，反而不如原图。
 * Tesseract 自己有二值化，交给它更稳。
 */
function preprocess(img) {
  const maxSide = 2400;
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

/**
 * 一页识别结果整理成一段连续文字：
 * 去掉页码、行内多余空格、软换行；短行且后面接着长行的当小标题。
 */
const HALF_TO_FULL = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };
const CJK = '\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef\\u2018\\u2019\\u201c\\u201d';
const CJK_RE = `[${CJK}]`;

// 中文语言包会在汉字之间插空格、混用半角标点，这里统一收拾干净
function cleanLine(line) {
  let s = line;

  // 汉字和中文标点之间的空格
  s = s.replace(new RegExp(`${CJK_RE}\\s+(?=${CJK_RE})`, 'g'), (m) => m[0]);

  // 汉字后面的半角标点换成全角
  s = s.replace(
    new RegExp(`([\\u4e00-\\u9fff])\\s*([,;:!?])\\s*(?=${CJK_RE})`, 'g'),
    (m, ch, p) => ch + HALF_TO_FULL[p]
  );

  // 汉字后面的英文句点当句号
  s = s.replace(new RegExp(`([\\u4e00-\\u9fff])\\s*\\.\\s*(?=${CJK_RE}|$)`, 'g'), '$1。');

  // 全角标点两侧的空格
  s = s.replace(/\s*([，。；：、！？])\s*/g, '$1');

  return s.trim();
}

// 跨行合并后，行尾残留的标点再规范一遍
function normalizePunct(s) {
  let out = s
    .replace(new RegExp(`\\s*([,;:!?])\\s*(?=${CJK_RE})`, 'g'), (m, p) => HALF_TO_FULL[p])
    .replace(new RegExp(`([\\u4e00-\\u9fff])\\s*\\.\\s*(?=${CJK_RE}|$)`, 'g'), '$1。')
    .replace(/\s*([，。；：、！？])\s*/g, '$1')
    .replace(new RegExp(`${CJK_RE}\\s+(?=${CJK_RE})`, 'g'), (m) => m[0]);
  return out.trim();
}

function isPageNumberLine(l) {
  return (
    /^[\s\-—–_·•*]*\d{1,4}[\s\-—–_·•*]*$/.test(l) ||   // 12 / - 36 -
    /^第\s*\d+\s*页$/.test(l) ||                        // 第 12 页
    /^[（(]?[ivxlcdm]{1,6}[)）]?$/i.test(l)            // 罗马页码
  );
}

function cleanPageText(raw) {
  const rawLines = raw
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim());

  // 按空行分组，空行当段落边界；顺手把页码行丢掉
  const groups = [];
  let group = [];
  for (const line of rawLines) {
    if (!line) {
      if (group.length) {
        groups.push(group);
        group = [];
      }
      continue;
    }
    if (isPageNumberLine(line)) continue;
    group.push(line);
  }
  if (group.length) groups.push(group);

  const paras = [];

  for (const lines of groups) {
    const cleaned = lines.map(cleanLine).filter(Boolean);
    if (!cleaned.length) continue;

    let buf = '';
    for (let i = 0; i < cleaned.length; i++) {
      const line = cleaned[i];
      const next = cleaned[i + 1];

      // 短、后面接着长行、又没句末标点，多半是小标题
      const headingLike =
        line.length >= 2 &&
        line.length <= 16 &&
        !/[。！？；：…，,、]$/.test(line) &&
        next &&
        next.length > line.length + 6;

      if (headingLike) {
        if (buf) {
          paras.push(normalizePunct(buf));
          buf = '';
        }
        paras.push(normalizePunct(line));
        continue;
      }

      if (!buf) {
        buf = line;
      } else if (/[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(line)) {
        buf += ' ' + line;   // 英文断行补个空格
      } else {
        buf += line;
      }
    }
    if (buf) paras.push(normalizePunct(buf));
  }

  return paras.filter(Boolean).join('\n\n').trim();
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
  });
}

// 从识别结果里取出每一行的文字和坐标
function extractLines(data) {
  const out = [];
  const blocks = (data && data.blocks) || [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = cleanLine(line.text || '');
        if (!text) continue;
        if (isPageNumberLine(text)) continue;
        const b = line.bbox;
        if (!b || b.x1 <= b.x0 || b.y1 <= b.y0) continue;
        out.push({ text, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } });
      }
    }
  }
  return out;
}

async function addPage(page) {
  const existing = await dbAll();
  const order = existing.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await dbPut({ id, order, ...page });
  await restoreReading();
}

/* ---------------- 编辑（图片模式下不再直接改文字） ---------------- */

function openEditor() {
  toast('现在是图片阅读，文字不能直接改');
}

function cancelEditor() {
  document.body.classList.remove('editing');
  $('#editWrap').classList.add('hidden');
  $('#textView').classList.remove('hidden');
}

function saveEditor() {
  cancelEditor();
}

/* ---------------- 工具栏动作 ---------------- */

function allText() {
  return state.pages
    .map((p) => (p.lines || []).map((l) => l.text).join('\n'))
    .join('\n\n')
    .trim();
}

async function copyAll() {
  const text = allText();
  if (!text) {
    toast('还没有文字');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制全文');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    toast(ok ? '已复制全文' : '复制失败');
  }
}

function downloadTxt() {
  const text = allText();
  if (!text) {
    toast('还没有文字');
    return;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `读书-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function clearAll() {
  if (!state.pages.length) {
    toast('现在是空的');
    return;
  }
  if (!window.confirm('确定清空全部页面吗？图片和文字都会删掉，找不回来。')) return;

  stopSpeech();
  state.pages = [];
  state.idx = 0;
  state.finished = false;
  state.sentences = [];
  try { await dbClear(); } catch (e) { console.error(e); }
  localStorage.removeItem(LS.text);
  localStorage.removeItem(LS.pages);
  localStorage.removeItem(LS.idx);
  if (state.pageUrls) {
    state.pageUrls.forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ }
    });
    state.pageUrls = [];
  }
  $('#textView').innerHTML = '';
  closeSettings();
  showEmpty();
  toast('已经清空');
}

/* ---------------- 离线词典 ---------------- */

let dictPromise = null;

function loadDict() {
  if (dictPromise) return dictPromise;

  dictPromise = (async () => {
    const res = await fetch(ASSET_BASE + 'vendor/dict/dict.json.gz');
    if (!res.ok) throw new Error('dict-http');

    let text;
    if ('DecompressionStream' in window && res.body) {
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else {
      throw new Error('dict-unsupported');
    }

    const data = JSON.parse(text);

    const chars = new Map();
    for (const it of data.chars) chars.set(it[0], { pinyin: it[1], explain: it[2] });

    const words = new Map();
    for (const it of data.words) words.set(it[0], { explain: it[1] });

    const idioms = new Map();
    for (const it of data.idioms) {
      idioms.set(it[0], { pinyin: it[1], explain: it[2], example: it[3], source: it[4] });
    }

    return { chars, words, idioms };
  })();

  dictPromise.catch(() => { dictPromise = null; });
  return dictPromise;
}

const TERM_CHAR_RE = /[㐀-䶿一-鿿A-Za-z0-9]/;

// 选中文字常带标点、空格，掐头去尾只留字词
function cleanTerm(text) {
  const chars = Array.from(String(text || '').replace(/[\s　]+/g, ''));
  let start = 0;
  let end = chars.length;
  while (start < end && !TERM_CHAR_RE.test(chars[start])) start++;
  while (end > start && !TERM_CHAR_RE.test(chars[end - 1])) end--;
  return chars.slice(start, end).join('');
}

function localPinyin(term) {
  try {
    if (window.pinyinPro) {
      const arr = pinyinPro.pinyin(term, { toneType: 'symbol', type: 'array' });
      return Array.isArray(arr) ? arr.join(' ') : String(arr || '');
    }
  } catch (e) { /* 取不到就算了 */ }
  return '';
}

async function dictLookup(term) {
  const dict = await loadDict();

  if (dict.idioms.has(term)) {
    const e = dict.idioms.get(term);
    return {
      type: '成语',
      term,
      pinyin: e.pinyin || localPinyin(term),
      explain: e.explain,
      example: e.example,
      source: e.source,
    };
  }

  if (dict.words.has(term)) {
    const e = dict.words.get(term);
    return { type: '词语', term, pinyin: localPinyin(term), explain: e.explain };
  }

  if (term.length === 1 && dict.chars.has(term)) {
    const e = dict.chars.get(term);
    return { type: '单字', term, pinyin: e.pinyin || localPinyin(term), explain: e.explain };
  }

  // 词典里没有整个词，就把每个字拆开解释
  const parts = [];
  for (const ch of Array.from(term)) {
    const e = dict.chars.get(ch);
    if (e) parts.push({ ch, pinyin: e.pinyin, explain: e.explain });
  }
  if (parts.length) {
    return { type: '逐字解释', term, pinyin: localPinyin(term), parts };
  }

  return { type: 'none', term };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderDictEntry(result) {
  const box = $('#dictResult');
  box.innerHTML = '';

  if (result.type === 'none') {
    box.appendChild(el('p', 'dict-hint',
      `词典里没有「${result.term}」。换个词，或者只选中其中的一两个字试试。`));
    return;
  }

  const head = el('div', 'dict-term');
  head.appendChild(el('h3', '', result.term));
  if (result.pinyin) head.appendChild(el('span', 'dict-pinyin', result.pinyin));
  head.appendChild(el('span', 'dict-type', result.type));
  box.appendChild(head);

  if (result.parts) {
    const wrap = el('div', 'dict-parts');
    for (const p of result.parts) {
      const row = el('div', 'dict-part');
      row.appendChild(el('b', '', p.ch));
      const body = el('div', 'dict-part-body');
      if (p.pinyin) body.appendChild(el('span', 'dict-part-py', p.pinyin));
      appendExplain(body, p.explain, 220);
      row.appendChild(body);
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  } else {
    appendExplain(box, result.explain, 420);
    if (result.example) {
      const eg = el('div', 'dict-example');
      eg.appendChild(el('b', '', '例句  '));
      eg.appendChild(document.createTextNode(result.example));
      box.appendChild(eg);
    }
    if (result.source) {
      const src = el('div', 'dict-example');
      src.appendChild(el('b', '', '出处  '));
      src.appendChild(document.createTextNode(result.source));
      box.appendChild(src);
    }
  }

  const actions = el('div', 'dict-actions');
  const speakBtn = el('button', 'ghost', '读一遍');
  speakBtn.type = 'button';
  speakBtn.addEventListener('click', () => speakWord(result.term));
  actions.appendChild(speakBtn);
  box.appendChild(actions);
}

// 单字释义经常几百字，先显示一段，想看全文再展开
function appendExplain(box, text, limit) {
  if (!text) return;
  const t = compactExplain(text);
  if (t.length <= limit) {
    box.appendChild(el('p', 'dict-explain', t));
    return;
  }
  const p = el('p', 'dict-explain', t.slice(0, limit) + '…');
  box.appendChild(p);
  const btn = el('button', 'link-btn', '展开全文');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    p.textContent = t;
    btn.remove();
  });
  box.appendChild(btn);
}

// 词典里的换行切得很碎，合并成自然段，只在义项编号前断行
function compactExplain(text) {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t　]{2,}/g, ' ')
    .replace(/\s*(?=\d{1,2}[.、])/g, '\n')
    .replace(/\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/g, '\n')
    .replace(/\s*(?=【)/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function speakWord(text) {
  stopSpeech();
  try {
    const { engine } = await ensurePiper();
    const res = await engine.generate(text, PIPER_VOICE, 0);
    const url = URL.createObjectURL(res.file);
    const audio = state.audio;
    const cleanup = () => {
      try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
      audio.removeEventListener('ended', cleanup);
    };
    audio.addEventListener('ended', cleanup);
    audio.src = url;
    audio.volume = state.volume;
    await audio.play();
  } catch (e) {
    console.error(e);
    toast('读不出来，语音包可能没加载好');
  }
}

let dictQueryToken = 0;

async function runDictQuery(raw) {
  const term = cleanTerm(raw);
  const box = $('#dictResult');

  if (!term) {
    box.innerHTML = '';
    box.appendChild(el('p', 'dict-hint', '输入一个字或词。'));
    return;
  }

  const token = ++dictQueryToken;
  box.innerHTML = '';
  box.appendChild(el('p', 'dict-hint',
    dictPromise ? '正在查…' : '正在准备词典，第一次要几秒…'));

  try {
    const result = await dictLookup(term);
    if (token !== dictQueryToken) return;
    renderDictEntry(result);
  } catch (e) {
    if (token !== dictQueryToken) return;
    console.error(e);
    box.innerHTML = '';
    box.appendChild(el('p', 'dict-hint', '词典没加载出来。刷新页面再试一次。'));
  }
}

function openDict(term) {
  if (state.playing && !state.paused) {
    state.paused = true;
    state.audio.pause();
    updatePlayButton();
  }
  hideSelButton();
  document.body.classList.add('sheet-open');
  $('#dictSheet').classList.remove('hidden');

  const input = $('#dictInput');
  if (term) {
    input.value = term;
    runDictQuery(term);
  } else {
    input.value = '';
    input.focus();
  }
}

function closeDict() {
  document.body.classList.remove('sheet-open');
  $('#dictSheet').classList.add('hidden');
}

// 语音输入（离线识别，模型在 vendor/vosk）
let voskModel = null;
let voskScriptPromise = null;
let voiceState = null;

// 浏览器 AudioContext 跑不到 16k 时，手动线性插值重采样
function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function loadVoskScript() {
  if (window.Vosk) return Promise.resolve();
  if (voskScriptPromise) return voskScriptPromise;

  voskScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ASSET_BASE + 'vendor/vosk/vosk.js';
    s.onload = () => resolve();
    s.onerror = () => {
      voskScriptPromise = null;
      reject(new Error('vosk-script'));
    };
    document.head.appendChild(s);
  });

  return voskScriptPromise;
}

async function ensureVoskModel() {
  if (voskModel) return voskModel;
  await loadVoskScript();
  if (!window.Vosk) throw new Error('no-vosk');
  voskModel = await Vosk.createModel(ASSET_BASE + 'vendor/vosk/model.tar.gz');
  return voskModel;
}

function resetVoice() {
  const v = voiceState;
  voiceState = null;
  if (!v) return;
  try { v.node.onaudioprocess = null; } catch (e) { /* 忽略 */ }
  try { v.source.disconnect(); } catch (e) { /* 忽略 */ }
  try { v.node.disconnect(); } catch (e) { /* 忽略 */ }
  try { v.ctx.close(); } catch (e) { /* 忽略 */ }
  try { v.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* 忽略 */ }
  try { v.recognizer.remove(); } catch (e) { /* 忽略 */ }
}

function dictHint(text) {
  const result = $('#dictResult');
  result.innerHTML = '';
  result.appendChild(el('p', 'dict-hint', text));
}

async function startVoiceInput() {
  const micBtn = $('#btnDictMic');

  if (voiceState) {
    stopVoiceInput();
    return;
  }

  micBtn.classList.add('recording');
  dictHint('正在准备语音识别，第一次要十几秒…');

  try {
    const model = await ensureVoskModel();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });

    // 模型只认 16k，尽量让 AudioContext 直接跑在 16k，不行就自己重采样
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch (e) {
      ctx = new AudioContext();
    }
    if (ctx.state === 'suspended') await ctx.resume();

    const inputRate = ctx.sampleRate;
    const recognizer = new model.KaldiRecognizer(16000);

    recognizer.on('result', (message) => {
      const text = message && message.result && message.result.text ? message.result.text : '';
      if (text) $('#dictInput').value = text.replace(/\s+/g, '');
    });

    recognizer.on('partialresult', (message) => {
      const partial = message && message.result && message.result.partial ? message.result.partial : '';
      if (partial) $('#dictInput').value = partial.replace(/\s+/g, '');
    });

    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event) => {
      try {
        let data = event.inputBuffer.getChannelData(0);
        if (inputRate !== 16000) data = resampleLinear(data, inputRate, 16000);
        recognizer.acceptWaveformFloat(data, 16000);
      } catch (e) { /* 单块失败不影响后面 */ }
    };
    source.connect(node);
    node.connect(ctx.destination);

    voiceState = { stream, ctx, source, node, recognizer };

    $('#dictInput').value = '';
    dictHint('请说话。说完再点一下麦克风，就会去查。');
  } catch (e) {
    console.error(e);
    resetVoice();
    micBtn.classList.remove('recording');

    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      dictHint('麦克风没被允许。在地址栏里允许麦克风，或者换成 https 地址再试。');
    } else if (e && e.message === 'no-vosk') {
      dictHint('语音识别程序没加载出来，检查一下 vendor/vosk 目录。');
    } else {
      dictHint('语音没启动起来，检查一下麦克风有没有接好。');
    }
  }
}

function stopVoiceInput() {
  const v = voiceState;
  $('#btnDictMic').classList.remove('recording');
  if (!v) return;

  dictHint('正在识别…');

  try { v.recognizer.retrieveFinalResult(); } catch (e) { /* 忽略 */ }

  // 给最后的识别留一点时间，再拿结果去查
  setTimeout(() => {
    resetVoice();
    const value = ($('#dictInput').value || '').trim();
    if (value) {
      runDictQuery(value);
    } else {
      dictHint('没听清。再点一次麦克风说一遍，或者直接打字。');
    }
  }, 700);
}

/* ---------------- 选中文字浮出「查」 ---------------- */

let selTimer = null;
let selectedTerm = '';

function hideSelButton() {
  const btn = $('#selQueryBtn');
  if (btn) btn.classList.add('hidden');
}

function updateSelButton() {
  const btn = $('#selQueryBtn');
  const sel = window.getSelection();

  if (!btn || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideSelButton();
    return;
  }

  const term = cleanTerm(sel.toString());
  if (!term || Array.from(term).length > 8) {
    hideSelButton();
    return;
  }

  const range = sel.getRangeAt(0);
  const tv = $('#textView');
  if (!tv || !tv.contains(range.commonAncestorContainer)) {
    hideSelButton();
    return;
  }

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideSelButton();
    return;
  }

  selectedTerm = term;

  const btnW = 52;
  let left = rect.left + rect.width / 2 - btnW / 2;
  left = Math.max(10, Math.min(window.innerWidth - btnW - 10, left));
  let top = rect.top - 48;
  if (top < 64) top = rect.bottom + 10;

  btn.style.left = left + 'px';
  btn.style.top = top + 'px';
  btn.classList.remove('hidden');
}

/* ---------------- 弹层 ---------------- */

function showOverlay(title, sub) {
  $('#overlayTitle').textContent = title;
  $('#overlaySub').textContent = sub || '';
  $('#overlay').classList.remove('hidden');
  setBar(0);
}

function setOverlay(title, sub) {
  $('#overlayTitle').textContent = title;
  if (sub !== undefined) $('#overlaySub').textContent = sub;
}

function hideOverlay() {
  $('#overlay').classList.add('hidden');
  setBar(0);
}

function setBar(p) {
  const v = Math.max(0, Math.min(1, p || 0));
  const el = $('#barFill');
  if (el) el.style.width = (v * 100).toFixed(1) + '%';
}

function openSettings() {
  document.body.classList.add('sheet-open');
  $('#settings').classList.remove('hidden');
}

function closeSettings() {
  document.body.classList.remove('sheet-open');
  $('#settings').classList.add('hidden');
}

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  const fileInput = $('#fileInput');

  const pickFile = () => {
    if (state.busy) {
      toast('正在识别上一张，稍等一下');
      return;
    }
    fileInput.click();
  };

  $('#btnAddEmpty').addEventListener('click', pickFile);
  $('#btnAddMore').addEventListener('click', pickFile);

  fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) handleFiles(files);
  });

  // 播放条
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnPrev').addEventListener('click', () => jump(-1));
  $('#btnNext').addEventListener('click', () => jump(1));

  // 点句子定位
  $('#textView').addEventListener('click', (e) => {
    const span = e.target.closest('.sent');
    if (!span) return;
    const i = parseInt(span.dataset.i, 10);
    if (Number.isFinite(i)) seekTo(i);
  });

  // 设置
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#settings').addEventListener('click', (e) => {
    if (e.target === $('#settings')) closeSettings();
  });

  $('#rateRange').addEventListener('input', (e) => {
    state.rate = parseFloat(e.target.value);
    clearAudioCache();
    updateRateLabels();
    localStorage.setItem(LS.rate, String(state.rate));
  });

  $('#volRange').addEventListener('input', (e) => {
    state.volume = parseFloat(e.target.value);
    if (state.audio) state.audio.volume = state.volume;
    updateRateLabels();
    localStorage.setItem(LS.volume, String(state.volume));
  });

  $('#autoScroll').addEventListener('change', (e) => {
    state.autoScroll = e.target.checked;
    localStorage.setItem(LS.autoScroll, state.autoScroll ? '1' : '0');
  });

  $('#btnCopy').addEventListener('click', copyAll);
  $('#btnDownload').addEventListener('click', downloadTxt);
  $('#btnClear').addEventListener('click', clearAll);

  // 查词
  $('#btnDict').addEventListener('click', () => openDict(''));
  $('#btnCloseDict').addEventListener('click', closeDict);
  $('#dictSheet').addEventListener('click', (e) => {
    if (e.target === $('#dictSheet')) closeDict();
  });
  $('#btnDictGo').addEventListener('click', () => runDictQuery($('#dictInput').value));
  $('#dictInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runDictQuery($('#dictInput').value);
    }
  });
  $('#btnDictMic').addEventListener('click', startVoiceInput);

  // 选中文字后浮出「查」
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(updateSelButton, 140);
  });
  $('#selQueryBtn').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (selectedTerm) openDict(selectedTerm);
  });
  window.addEventListener('scroll', hideSelButton, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDict();
      closeSettings();
    }
  });

  // 取消识别
  $('#btnCancelOcr').addEventListener('click', () => {
    state.canceled = true;
    disposeWorker();
    hideOverlay();
    toast('已取消');
  });

  // 空格键播放/暂停（不在输入框和按钮上时）
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') {
      jump(-1);
    } else if (e.code === 'ArrowRight') {
      jump(1);
    }
  });

  // 页面刷新/关闭前停掉朗读
  window.addEventListener('pagehide', () => {
    stopSpeech();
  });

  // 切回页面时，如果音频被系统暂停了，接着放
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.playing && !state.paused && state.audio && state.audio.paused) {
      state.audio.play().catch(() => {});
    }
  });
}
