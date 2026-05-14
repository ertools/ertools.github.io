/* ═══════════════════════════════════════════════
   DocEdit — app.js
   ═══════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────
   CUSTOM QUILL BLOTS — must register before
   any Quill instances are created
   Red wavy  = grammar-error  (spelling / typo)
   Blue wavy = grammar-suggestion (grammar/style)
─────────────────────────────────────────────*/
(function registerBlots() {
  const Inline = Quill.import('blots/inline');

  /* Grammar blots — store the match offset as a data attribute for click lookup */
  function makeDataBlot(blotName, className) {
    class Blot extends Inline {
      static create(v) {
        const node = super.create();
        node.setAttribute('data-goff', v);
        return node;
      }
      static formats(node) {
        const v = node.getAttribute('data-goff');
        return v !== null ? v : true;
      }
    }
    Blot.blotName  = blotName;
    Blot.tagName   = 'span';
    Blot.className = className;
    return Blot;
  }

  Quill.register(makeDataBlot('grammar-error',      'ql-grammar-error'));
  Quill.register(makeDataBlot('grammar-suggestion', 'ql-grammar-suggestion'));
})();

/* ── Quill toolbar ── */
const TOOLBAR = [
  [{ header: [1, 2, 3, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ color: [] }, { background: [] }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['blockquote', 'clean']
];

/* ── Init editors ── */
const qInput   = new Quill('#editorInput',   { theme: 'snow', modules: { toolbar: TOOLBAR } });
const qWorking = new Quill('#editorWorking', { theme: 'snow', modules: { toolbar: TOOLBAR } });
const qOutput  = new Quill('#editorOutput',  { theme: 'snow', modules: { toolbar: TOOLBAR } });

/* ── Workflow state ── */
let sentences       = [];
let currentIndex    = -1;
let outputSentences = [];

/* ── Edit-toggle state ── */
let inputEditOn       = true;
let outputEditOn      = false;
let inputEverPasted   = false;   /* tracks first paste into input panel */

/* ── Grammar state ── */
let grammarMatches   = [];
let grammarDebounce  = null;
let activePopupMatch = null;          /* match currently shown in the popup */
const dismissedErrors = new Set();    /* "ruleId:errorText" keys ignored by the user */

/* ── Dictionary state ── */
let dictDebounce    = null;
let currentAudioUrl = null;


/* ═══════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseSentences(text) {
  if (!text || !text.trim()) return [];
  const raw = text.match(/[^.!?]*[.!?]+(?:\s|$)|[^.!?]+$/g) || [];
  return raw.map(s => s.trim()).filter(Boolean);
}

function getInputText() {
  return qInput.getText().replace(/​/g, '').trim();
}


/* ═══════════════════════════════════════════════
   SENTENCE HIGHLIGHT  (Input panel)
   ═══════════════════════════════════════════════ */

let _hlStart = -1, _hlLen = 0;

function clearHighlight() {
  if (_hlStart >= 0 && _hlLen > 0)
    qInput.formatText(_hlStart, _hlLen, { background: false }, Quill.sources.SILENT);
  _hlStart = -1; _hlLen = 0;
}

function highlightSentence(index) {
  clearHighlight();
  if (index < 0 || index >= sentences.length) return;
  const fullText = qInput.getText();
  const target   = sentences[index];
  let from = 0;
  for (let i = 0; i < index; i++) {
    const p = fullText.indexOf(sentences[i], from);
    if (p === -1) return;
    from = p + sentences[i].length;
  }
  const start = fullText.indexOf(target, from);
  if (start === -1) return;
  _hlStart = start; _hlLen = target.length;
  qInput.formatText(_hlStart, _hlLen, { background: '#fff3c4' }, Quill.sources.SILENT);
}

function scrollInputToHighlight() {
  if (_hlStart < 0) return;
  setTimeout(() => {
    const bounds   = qInput.getBounds(_hlStart, _hlLen);
    const scroller = document.querySelector('#editorInput .ql-container');
    if (!bounds || !scroller) return;

    /* qInput.getBounds() returns coords relative to #editorInput (the Quill
       mount div), which includes the toolbar above .ql-container.
       Subtract the toolbar height so we get a position within the scroller. */
    const toolbar = document.querySelector('#editorInput .ql-toolbar');
    const tH      = toolbar ? toolbar.offsetHeight : 0;

    /* (bounds.top - tH) = position in .ql-container's current visible area.
       Adding scrollTop converts that to absolute content position. */
    const absPos = (bounds.top - tH) + scroller.scrollTop;
    const target = absPos - scroller.clientHeight / 2 + bounds.height / 2;

    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, 30);
}


/* ═══════════════════════════════════════════════
   COUNTERS & STATUS
   ═══════════════════════════════════════════════ */

function updateCounts() {
  document.getElementById('inputCount').textContent =
    sentences.length + ' sentence' + (sentences.length !== 1 ? 's' : '');
  document.getElementById('outputCount').textContent =
    outputSentences.length + ' sentence' + (outputSentences.length !== 1 ? 's' : '');
  document.getElementById('sentencePos').textContent =
    (currentIndex >= 0 && currentIndex < sentences.length)
      ? `Sentence ${currentIndex + 1} of ${sentences.length}` : '—';
  const done = outputSentences.length, total = sentences.length;
  document.getElementById('statusProgress').textContent =
    total > 0 ? `${done} / ${total} processed` : '';
}

function setStatus(msg) {
  const el = document.getElementById('statusMsg');
  el.innerHTML = msg;
  el.classList.remove('status-flash');
  void el.offsetWidth;
  el.classList.add('status-flash');
}


/* ═══════════════════════════════════════════════
   CORE WORKFLOW
   ═══════════════════════════════════════════════ */

function loadSentencesFromInput() {
  sentences = parseSentences(getInputText());
  currentIndex = -1;
  outputSentences = [];
  qOutput.setContents([]);
  qWorking.setContents([]);
  clearHighlight();
  clearGrammar();
  showDictPlaceholder();
  updateCounts();
}

function advance() {
  if (sentences.length === 0) {
    loadSentencesFromInput();
    if (sentences.length === 0) {
      setStatus('<i class="bi bi-exclamation-circle me-1"></i>Input Panel is empty. Paste or type your document first.');
      return;
    }
  }
  if (currentIndex >= 0) {
    const txt = qWorking.getText().trim();
    if (txt) { outputSentences.push(txt); appendToOutput(txt); }
  }
  const next = currentIndex + 1;
  if (next >= sentences.length) {
    qWorking.setContents([]);
    currentIndex = sentences.length;
    clearHighlight(); clearGrammar();
    setStatus('<i class="bi bi-check-circle me-1 text-success"></i>All sentences processed! Check the Output Panel.');
    updateCounts(); return;
  }
  currentIndex = next;
  qWorking.setText(sentences[currentIndex]);
  qWorking.setSelection(0, 0);
  highlightSentence(currentIndex);
  scrollInputToHighlight();
  clearGrammar();
  setStatus(`<i class="bi bi-arrow-right-circle me-1"></i>Sentence <strong>${currentIndex + 1}</strong> of <strong>${sentences.length}</strong> loaded.`);
  updateCounts();
  scheduleGrammarCheck(700);
}

function revert() {
  if (outputSentences.length === 0 && currentIndex <= 0) {
    setStatus('<i class="bi bi-info-circle me-1"></i>Nothing to revert.'); return;
  }
  if (currentIndex >= sentences.length) {
    currentIndex = sentences.length - 1;
    qWorking.setText(sentences[currentIndex]);
    highlightSentence(currentIndex); scrollInputToHighlight(); clearGrammar();
    setStatus(`<i class="bi bi-arrow-left-circle me-1"></i>Reverted to sentence <strong>${currentIndex + 1}</strong>.`);
    updateCounts(); scheduleGrammarCheck(700); return;
  }
  if (outputSentences.length > 0) { outputSentences.pop(); rebuildOutput(); }
  const prev = currentIndex - 1;
  if (prev < 0) {
    qWorking.setContents([]); currentIndex = -1;
    clearHighlight(); clearGrammar();
    setStatus('<i class="bi bi-arrow-left-circle me-1"></i>Reverted to start.');
  } else {
    currentIndex = prev;
    qWorking.setText(sentences[currentIndex]);
    highlightSentence(currentIndex); scrollInputToHighlight(); clearGrammar();
    setStatus(`<i class="bi bi-arrow-left-circle me-1"></i>Reverted to sentence <strong>${currentIndex + 1}</strong>.`);
    scheduleGrammarCheck(700);
  }
  updateCounts();
}

function appendToOutput(text) {
  const len = qOutput.getLength();
  if (len > 1) qOutput.insertText(len - 1, ' ');
  qOutput.insertText(qOutput.getLength() - 1, text);
}

function rebuildOutput() {
  qOutput.setContents([]);
  const c = outputSentences.join(' ');
  if (c) qOutput.setText(c);
}


/* ═══════════════════════════════════════════════
   GRAMMAR — LanguageTool + inline underlines
   ═══════════════════════════════════════════════ */

function scheduleGrammarCheck(delay) {
  clearTimeout(grammarDebounce);
  grammarDebounce = setTimeout(runGrammarCheck, delay || 1400);
}

/* Stable key for a match — used to remember user dismissals across re-checks */
function dismissalKey(match) {
  const ruleId    = match.rule?.id || 'unknown';
  const errorText = qWorking.getText(match.offset, match.length);
  return `${ruleId}:${errorText}`;
}

async function runGrammarCheck() {
  const text = qWorking.getText().trim();
  if (!text) { clearGrammar(); return; }

  setGrammarStatus('checking');
  try {
    const res = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: 'en-US' })
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    /* Filter out errors the user already dismissed this session */
    grammarMatches = (data.matches || []).filter(m => !dismissedErrors.has(dismissalKey(m)));
    applyGrammarUnderlines(grammarMatches);
    setGrammarStatus(grammarMatches.length === 0 ? 'ok' : 'found');
  } catch (_) {
    setGrammarStatus('unavailable');
  }
}

function applyGrammarUnderlines(matches) {
  eraseGrammarUnderlines();
  matches.forEach(m => {
    const catId   = (m.rule?.category?.id || '').toLowerCase();
    const isTypo  = catId.includes('typos') || catId.includes('spell') || m.rule?.issueType === 'misspelling';
    const format  = isTypo ? 'grammar-error' : 'grammar-suggestion';
    /* store the match's own offset as the blot value for lookup on click */
    qWorking.formatText(m.offset, m.length, format, String(m.offset), Quill.sources.SILENT);
  });
}

function eraseGrammarUnderlines() {
  const len = qWorking.getLength();
  if (len > 1) {
    qWorking.formatText(0, len, 'grammar-error',      false, Quill.sources.SILENT);
    qWorking.formatText(0, len, 'grammar-suggestion', false, Quill.sources.SILENT);
  }
}

function clearGrammar() {
  eraseGrammarUnderlines();
  grammarMatches = [];
  dismissedErrors.clear();   /* reset per-sentence dismissals when moving to a new sentence */
  setGrammarStatus('clear');
  hideGrammarPopup();
}

function setGrammarStatus(state) {
  const badge  = document.getElementById('grammarBadge');
  const status = document.getElementById('grammarStatus');
  if (state === 'checking') {
    badge.textContent = '';
    status.innerHTML  = '<span class="dict-spinner" style="width:11px;height:11px;border-width:2px;vertical-align:middle;margin-right:4px"></span>Checking…';
  } else if (state === 'ok') {
    badge.textContent = '';
    status.innerHTML  = '<i class="bi bi-check2 me-1" style="color:var(--color-output)"></i>All good';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } else if (state === 'found') {
    badge.textContent = grammarMatches.length + (grammarMatches.length === 1 ? ' issue' : ' issues');
    status.textContent = '';
  } else {
    badge.textContent  = '';
    status.textContent = '';
  }
}

/* Re-check when user edits working panel */
qWorking.on('text-change', (delta, old, source) => {
  if (source !== Quill.sources.USER) return;
  eraseGrammarUnderlines();
  setGrammarStatus('checking');
  scheduleGrammarCheck(1400);
});

function applyGrammarFix(match, replacement) {
  eraseGrammarUnderlines();
  qWorking.deleteText(match.offset, match.length, Quill.sources.API);
  qWorking.insertText(match.offset, replacement, Quill.sources.API);
  scheduleGrammarCheck(800);
}


/* ═══════════════════════════════════════════════
   GRAMMAR POPUP  (context-menu style)
   ═══════════════════════════════════════════════ */

function showGrammarPopup(clientX, clientY, match) {
  activePopupMatch = match;
  const popup = document.getElementById('grammarPopup');

  document.getElementById('grammarPopupMsg').textContent =
    match.shortMessage || match.message;

  const suggs = document.getElementById('grammarPopupSuggestions');
  suggs.innerHTML = '';

  const repls = (match.replacements || []).slice(0, 7);
  if (repls.length === 0) {
    const el = document.createElement('div');
    el.className   = 'grammar-popup-no-sugg';
    el.textContent = 'No suggestions available';
    suggs.appendChild(el);
  } else {
    repls.forEach(r => {
      const item = document.createElement('div');
      item.className = 'grammar-popup-item';
      item.innerHTML = `<i class="bi bi-arrow-return-right me-2"></i><span>${escapeHtml(r.value)}</span>`;
      item.addEventListener('click', e => {
        e.stopPropagation();
        applyGrammarFix(match, r.value);
        hideGrammarPopup();
      });
      suggs.appendChild(item);
    });
  }

  /* Measure then position */
  popup.style.visibility = 'hidden';
  popup.style.display    = 'block';

  requestAnimationFrame(() => {
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    const vw = window.innerWidth,  vh = window.innerHeight;
    let left = clientX, top = clientY + 6;
    if (left + pw + 10 > vw) left = clientX - pw;
    if (top  + ph + 10 > vh) top  = clientY - ph - 6;
    left = Math.max(6, left);
    top  = Math.max(6, top);
    popup.style.left       = left + 'px';
    popup.style.top        = top  + 'px';
    popup.style.visibility = 'visible';
  });
}

function hideGrammarPopup() {
  document.getElementById('grammarPopup').style.display = 'none';
  activePopupMatch = null;
}

function dismissGrammarError() {
  if (!activePopupMatch) { hideGrammarPopup(); return; }

  /* Remember this error so future re-checks skip it */
  dismissedErrors.add(dismissalKey(activePopupMatch));

  /* Remove from the active list and redraw remaining underlines */
  grammarMatches = grammarMatches.filter(m => m.offset !== activePopupMatch.offset);
  applyGrammarUnderlines(grammarMatches);
  setGrammarStatus(grammarMatches.length === 0 ? 'ok' : 'found');

  hideGrammarPopup();
}

/* Click on an underlined word — bubble phase on the editor mount div.
   stopPropagation prevents the document handler from closing the popup
   immediately after it opens. */
document.getElementById('editorWorking').addEventListener('click', e => {
  const span = e.target.closest('.ql-grammar-error, .ql-grammar-suggestion');
  if (!span) { hideGrammarPopup(); return; }

  e.stopPropagation(); /* don't let doc-level handler close popup right away */

  const offset = parseInt(span.getAttribute('data-goff'), 10);
  const match  = grammarMatches.find(m => m.offset === offset);
  if (match) showGrammarPopup(e.clientX, e.clientY, match);
});

/* Close popup when clicking outside it */
document.addEventListener('click', e => {
  const popup = document.getElementById('grammarPopup');
  if (popup.style.display === 'none') return;
  if (!popup.contains(e.target)) hideGrammarPopup();
});

document.getElementById('grammarPopupDismiss')
  .addEventListener('click', dismissGrammarError);


/* ═══════════════════════════════════════════════
   DICTIONARY — Free Dictionary API
   ═══════════════════════════════════════════════ */

qWorking.on('selection-change', () => {
  clearTimeout(dictDebounce);
  dictDebounce = setTimeout(() => {
    const sel = qWorking.getSelection();
    if (!sel || sel.length === 0) return;
    const raw = qWorking.getText(sel.index, sel.length).trim();
    if (/^[a-zA-Z][a-zA-Z'-]*$/.test(raw) && raw.length > 1) {
      document.getElementById('dictWordChip').textContent = raw;
      lookupWord(raw);
    }
  }, 350);
});

async function lookupWord(word) {
  showDictLoading(word);
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`
    );
    if (!res.ok) { showDictNotFound(word); return; }
    const data = await res.json();
    renderDictEntry(data[0]);
  } catch (_) {
    showDictNotFound(word);
  }
}

function showDictPlaceholder() {
  document.getElementById('dictWordChip').textContent = '';
  document.getElementById('dictBody').innerHTML = `
    <div class="dict-placeholder">
      <i class="bi bi-cursor-text"></i>
      <p>Select a word in the Working Panel to look it up</p>
    </div>`;
}

function showDictLoading(word) {
  document.getElementById('dictBody').innerHTML = `
    <div class="dict-loading">
      <span class="dict-spinner"></span>Looking up <em>${escapeHtml(word)}</em>…
    </div>`;
}

function showDictNotFound(word) {
  document.getElementById('dictBody').innerHTML = `
    <div class="dict-notfound">
      <i class="bi bi-question-circle"></i>
      No definition found for <strong>${escapeHtml(word)}</strong>
    </div>`;
}

function renderDictEntry(entry) {
  const body = document.getElementById('dictBody');
  body.innerHTML = '';

  const wordEl = document.createElement('div');
  wordEl.className   = 'dict-entry-word';
  wordEl.textContent = entry.word;
  body.appendChild(wordEl);

  const phonObj  = (entry.phonetics || []).find(p => p.text);
  const audioObj = (entry.phonetics || []).find(p => p.audio);
  currentAudioUrl = audioObj ? audioObj.audio : null;

  if (phonObj || currentAudioUrl) {
    const ph = document.createElement('div');
    ph.className = 'dict-phonetic';
    if (phonObj) ph.appendChild(document.createTextNode(phonObj.text));
    if (currentAudioUrl) {
      const btn = document.createElement('button');
      btn.className = 'btn-audio';
      btn.title     = 'Play pronunciation';
      btn.innerHTML = '<i class="bi bi-volume-up-fill"></i>';
      btn.addEventListener('click', () => new Audio(currentAudioUrl).play().catch(() => {}));
      ph.appendChild(btn);
    }
    body.appendChild(ph);
  }

  (entry.meanings || []).slice(0, 4).forEach((meaning, mi) => {
    if (mi > 0) { const d = document.createElement('div'); d.className = 'dict-divider'; body.appendChild(d); }

    const mEl = document.createElement('div');
    mEl.className = 'dict-meaning';

    const pos = document.createElement('span');
    pos.className   = 'dict-pos-tag';
    pos.textContent = meaning.partOfSpeech;
    mEl.appendChild(pos);

    (meaning.definitions || []).slice(0, 3).forEach((def, di) => {
      const defEl = document.createElement('div');
      defEl.className = 'dict-def';
      defEl.innerHTML = `<span class="dict-def-num">${di + 1}.</span>${escapeHtml(def.definition)}`;
      mEl.appendChild(defEl);
      if (def.example) {
        const ex = document.createElement('div');
        ex.className   = 'dict-example';
        ex.textContent = '"' + def.example + '"';
        mEl.appendChild(ex);
      }
    });

    const syns = (meaning.synonyms || []).slice(0, 5);
    if (syns.length) {
      const synsEl = document.createElement('div');
      synsEl.className = 'dict-syns';
      const lbl = document.createElement('span');
      lbl.className = 'dict-syn-label'; lbl.textContent = 'Syn:';
      synsEl.appendChild(lbl);
      syns.forEach(s => {
        const chip = document.createElement('span');
        chip.className = 'dict-syn'; chip.textContent = s; chip.title = 'Look up ' + s;
        chip.addEventListener('click', () => {
          document.getElementById('dictWordChip').textContent = s;
          lookupWord(s);
        });
        synsEl.appendChild(chip);
      });
      mEl.appendChild(synsEl);
    }
    body.appendChild(mEl);
  });
}


/* ═══════════════════════════════════════════════
   EDIT TOGGLES & COPY
   ═══════════════════════════════════════════════ */

function setInputEdit(on) {
  inputEditOn = on;
  qInput.enable(on);
  const btn  = document.getElementById('btnInputEdit');
  const pane = document.getElementById('paneInput');
  btn.className = 'btn-panel-toggle ' + (on ? 'state-on' : 'state-off');
  btn.innerHTML = on
    ? '<i class="bi bi-pencil-fill"></i><span>Edit: On</span>'
    : '<i class="bi bi-lock-fill"></i><span>Edit: Off</span>';
  pane.classList.toggle('edit-disabled', !on);
}

function setOutputEdit(on) {
  outputEditOn = on;
  qOutput.enable(on);
  const btn  = document.getElementById('btnOutputEdit');
  const pane = document.getElementById('paneOutput');
  btn.className = 'btn-panel-toggle ' + (on ? 'state-on' : 'state-off');
  btn.innerHTML = on
    ? '<i class="bi bi-pencil-fill"></i><span>Edit: On</span>'
    : '<i class="bi bi-lock-fill"></i><span>Edit: Off</span>';
  pane.classList.toggle('edit-disabled', !on);
}

document.getElementById('btnInputEdit').addEventListener('click', () => setInputEdit(!inputEditOn));
document.getElementById('btnOutputEdit').addEventListener('click', () => setOutputEdit(!outputEditOn));

/* Auto-lock input on first paste */
document.querySelector('#editorInput .ql-editor').addEventListener('paste', () => {
  if (!inputEverPasted) {
    inputEverPasted = true;
    setTimeout(() => setInputEdit(false), 80);   /* let paste land first */
  }
});

/* Copy All — output panel */
document.getElementById('btnCopyAll').addEventListener('click', () => {
  const text = qOutput.getText().trim();
  if (!text) return;

  const btn  = document.getElementById('btnCopyAll');
  const done = () => {
    const orig = '<i class="bi bi-clipboard"></i><span>Copy All</span>';
    btn.innerHTML = '<i class="bi bi-check2"></i><span>Copied!</span>';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1800);
  };

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
});

function fallbackCopy(text, callback) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); callback(); } catch (_) {}
  document.body.removeChild(ta);
}

/* ═══════════════════════════════════════════════
   KEYBOARD
   ═══════════════════════════════════════════════ */

document.addEventListener('keydown', e => {
  if (e.key === 'Tab')    { e.preventDefault(); e.shiftKey ? revert() : advance(); }
  if (e.key === 'Escape') hideGrammarPopup();
});


/* ═══════════════════════════════════════════════
   TOOLBAR BUTTONS
   ═══════════════════════════════════════════════ */

document.getElementById('btnNext').addEventListener('click', advance);
document.getElementById('btnPrev').addEventListener('click', revert);

document.getElementById('btnReset').addEventListener('click', () => {
  if (!confirm('Reset all panels? Working and Output panels will be cleared.')) return;
  loadSentencesFromInput();
  /* restore default edit states on full reset */
  inputEverPasted = false;
  setInputEdit(true);
  setOutputEdit(false);
  setStatus('<i class="bi bi-arrow-counterclockwise me-1"></i>Reset — press Tab to start.');
});

document.getElementById('btnLoad').addEventListener('click', () => {
  const sample = `The quick brown fox jumps over the lazy dog. This is a sample document for testing the DocEdit workflow editor. Each sentence will be loaded into the Working Panel one at a time. You can edit the sentence in the Working Panel before sending it to the Output Panel. Press Tab to advance to the next sentence. Press Shift+Tab to go back to the previous sentence. The Output Panel accumulates your edited sentences in order. This workflow helps you review and refine each sentence of a document individually. Continue until all sentences have been processed. When finished, copy the content of the Output Panel as your revised document.`;
  qInput.setText(sample);
  loadSentencesFromInput();
  setStatus('<i class="bi bi-cloud-download me-1"></i>Sample loaded — press <kbd>Tab</kbd> to begin.');
  updateCounts();
});

let inputDebounce;
qInput.on('text-change', () => {
  clearTimeout(inputDebounce);
  inputDebounce = setTimeout(() => {
    if (currentIndex === -1) {
      const p = parseSentences(getInputText());
      document.getElementById('inputCount').textContent =
        p.length + ' sentence' + (p.length !== 1 ? 's' : '');
    }
  }, 400);
});


/* ═══════════════════════════════════════════════
   RESIZABLE PANES
   ═══════════════════════════════════════════════ */

(function verticalResize() {
  const handle = document.getElementById('dragV');
  const left   = document.getElementById('paneInput');
  const right  = document.getElementById('paneOutput');
  let drag = false, startX, startL, startR;
  handle.addEventListener('mousedown', e => {
    drag = true; startX = e.clientX;
    startL = left.getBoundingClientRect().width;
    startR = right.getBoundingClientRect().width;
    document.body.classList.add('dragging-v'); e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    const total = startL + startR;
    const nL    = Math.max(120, Math.min(total - 120, startL + e.clientX - startX));
    left.style.flex  = `0 0 ${nL}px`;
    right.style.flex = `0 0 ${total - nL}px`;
  });
  document.addEventListener('mouseup', () => { if (drag) { drag = false; document.body.classList.remove('dragging-v'); } });
})();

(function horizontalResize() {
  const handle = document.getElementById('dragH');
  const top    = document.getElementById('topRow');
  const bot    = document.getElementById('paneWorking');
  let drag = false, startY, startT, startB;
  handle.addEventListener('mousedown', e => {
    drag = true; startY = e.clientY;
    startT = top.getBoundingClientRect().height;
    startB = bot.getBoundingClientRect().height;
    document.body.classList.add('dragging-h'); e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    const total = startT + startB;
    const nT    = Math.max(100, Math.min(total - 160, startT + e.clientY - startY));
    top.style.flex = `0 0 ${nT}px`;
    bot.style.flex = `0 0 ${total - nT}px`;
  });
  document.addEventListener('mouseup', () => { if (drag) { drag = false; document.body.classList.remove('dragging-h'); } });
})();


(function dictResize() {
  const handle = document.getElementById('dragDict');
  const dict   = document.getElementById('dictCol');
  let drag = false, startX, startW;

  handle.addEventListener('mousedown', e => {
    drag   = true;
    startX = e.clientX;
    startW = dict.getBoundingClientRect().width;
    document.body.classList.add('dragging-v');
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    /* dragging left → dict wider; dragging right → dict narrower */
    const newW = Math.max(160, Math.min(520, startW + (startX - e.clientX)));
    dict.style.flex = `0 0 ${newW}px`;
  });
  document.addEventListener('mouseup', () => {
    if (drag) { drag = false; document.body.classList.remove('dragging-v'); }
  });
})();

/* ── Init ── */
setInputEdit(true);    /* Input: editable by default */
setOutputEdit(false);  /* Output: read-only by default */
updateCounts();
