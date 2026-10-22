/*
 * ExamPrep — interactive MSQ/MCQ practice (static site, no build step).
 * Loads assets/data/questions.json, validates it, and runs everything in the browser.
 * Progress is stored in localStorage under STORE_KEY.
 */
(function () {
  'use strict';

  var DATA_URL = 'assets/data/questions.json'; // relative: works under a GitHub Pages sub-path
  var REVISION_URL = 'assets/data/revision.json';
  var STORE_KEY = 'qmvm-exam-practice:v1';
  var ACTIVITY_LIMIT = 60;
  var HISTORY_LIMIT = 20;
  var BROWSE_PAGE = 25;
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* =====================================================================
     Pure helpers (also exposed on window.ExamApp for testing)
     ===================================================================== */

  function unique(arr) {
    var out = [];
    arr.forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
    return out;
  }

  /** True when both arrays contain exactly the same set of ids. */
  function sameSet(a, b) {
    var ua = unique(a), ub = unique(b);
    if (ua.length !== ub.length) return false;
    return ua.every(function (x) { return ub.indexOf(x) !== -1; });
  }

  /**
   * Grade a selection. Exact-set match only: partial or extra selections are incorrect.
   * @returns {{isCorrect:boolean, right:string[], missed:string[], wrong:string[]}}
   */
  function gradeSelection(q, selected) {
    var sel = unique(selected || []);
    var correct = q.correctAnswers;
    if (q.type === 'MCQ' && sel.length !== 1) {
      return {
        isCorrect: false,
        right: sel.filter(function (id) { return correct.indexOf(id) !== -1; }),
        missed: correct.filter(function (id) { return sel.indexOf(id) === -1; }),
        wrong: sel.filter(function (id) { return correct.indexOf(id) === -1; })
      };
    }
    return {
      isCorrect: sameSet(sel, correct),
      right: sel.filter(function (id) { return correct.indexOf(id) !== -1; }),
      missed: correct.filter(function (id) { return sel.indexOf(id) === -1; }),
      wrong: sel.filter(function (id) { return correct.indexOf(id) === -1; })
    };
  }

  function shuffle(arr, rnd) {
    var r = rnd || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.round((ms || 0) / 1000));
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    var mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function humanDuration(ms) {
    var total = Math.round((ms || 0) / 1000);
    if (total < 60) return total + 's';
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
    return h ? h + 'h ' + m + 'm' : m + 'm ' + (total % 60) + 's';
  }

  function timeAgo(ts) {
    var diff = Math.round((Date.now() - ts) / 1000);
    if (diff < 45) return 'just now';
    if (diff < 3600) return Math.round(diff / 60) + ' min ago';
    if (diff < 86400) return Math.round(diff / 3600) + ' h ago';
    if (diff < 86400 * 7) return Math.round(diff / 86400) + ' d ago';
    return new Date(ts).toLocaleDateString();
  }

  function qCourse(q) { return q.course && String(q.course).trim() ? q.course : 'General'; }
  function qTopic(q) { return q.topic && String(q.topic).trim() ? q.topic : 'General'; }
  function topicKey(q) { return qCourse(q) + '||' + qTopic(q); }
  function shortCourse(c) {
    if (/^quality/i.test(c)) return 'QM';
    if (/^vendor/i.test(c)) return 'VM';
    return c;
  }

  /** Per-session statistics. A question counts once, however many times it was retried. */
  function sessionStats(session, byId) {
    var st = {
      total: 0, attempted: 0, correct: 0, incorrect: 0, unanswered: 0, skipped: 0, answered: 0,
      byType: { MSQ: { total: 0, attempted: 0, correct: 0 }, MCQ: { total: 0, attempted: 0, correct: 0 } },
      byTopic: []
    };
    var topics = {};
    session.qids.forEach(function (id) {
      var q = byId.get(id);
      if (!q) return;
      var a = session.answers[id];
      var bt = st.byType[q.type];
      var key = topicKey(q);
      if (!topics[key]) {
        topics[key] = { course: qCourse(q), topic: qTopic(q), total: 0, attempted: 0, correct: 0 };
        st.byTopic.push(topics[key]);
      }
      var tp = topics[key];
      st.total++; bt.total++; tp.total++;
      if (a && a.selected && a.selected.length) st.answered++;
      if (a && a.checked) {
        st.attempted++; bt.attempted++; tp.attempted++;
        if (a.correct) { st.correct++; bt.correct++; tp.correct++; } else { st.incorrect++; }
      } else {
        st.unanswered++;
        if (a && a.skipped) st.skipped++;
      }
    });
    return st;
  }

  /* =====================================================================
     Storage
     ===================================================================== */

  function defaultStore() {
    return {
      version: 1,
      settings: { theme: 'system', shuffleOptions: false, showHints: true },
      attempts: {},      // qid -> { status, firstStatus, selected, count, lastAt }
      bookmarks: [],     // qid[]
      activity: [],      // newest first
      session: null,     // active session
      lastResult: null,  // last finished session (for results/review)
      history: [],       // summaries of finished sessions
      revised: {}        // revision section id -> timestamp marked as revised
    };
  }

  function isSession(s) {
    return !!(s && typeof s === 'object' && Array.isArray(s.qids) && s.answers && typeof s.answers === 'object');
  }

  function normalizeStore(d) {
    var def = defaultStore();
    if (!d || typeof d !== 'object') return def;
    var settings = Object.assign(def.settings, d.settings && typeof d.settings === 'object' ? d.settings : {});
    if (['system', 'light', 'dark'].indexOf(settings.theme) === -1) settings.theme = 'system';
    return {
      version: 1,
      settings: settings,
      attempts: d.attempts && typeof d.attempts === 'object' && !Array.isArray(d.attempts) ? d.attempts : {},
      bookmarks: Array.isArray(d.bookmarks) ? d.bookmarks.filter(function (x) { return typeof x === 'string'; }) : [],
      activity: Array.isArray(d.activity) ? d.activity.slice(0, ACTIVITY_LIMIT) : [],
      session: isSession(d.session) ? d.session : null,
      lastResult: isSession(d.lastResult) ? d.lastResult : null,
      history: Array.isArray(d.history) ? d.history.slice(0, HISTORY_LIMIT) : [],
      revised: d.revised && typeof d.revised === 'object' && !Array.isArray(d.revised) ? d.revised : {}
    };
  }

  var Store = {
    data: defaultStore(),
    ok: true,
    warned: false,
    load: function () {
      var raw = null;
      try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) { this.ok = false; }
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
      this.data = normalizeStore(parsed);
    },
    save: function () {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
        this.ok = true;
      } catch (e) {
        this.ok = false;
        if (!this.warned) {
          this.warned = true;
          toast('Progress cannot be saved in this browser (storage is blocked or full).', 'alert');
        }
      }
    }
  };
  function store() { return Store.data; }
  function save() { Store.save(); }

  /* =====================================================================
     App state
     ===================================================================== */

  var S = {
    bank: [],
    byId: new Map(),
    meta: {},
    report: null,
    courses: [],
    topics: [],            // [{key, course, topic, count}]
    route: { name: 'dashboard', params: [] },
    hintOpen: false,
    navOpen: false,
    timerId: null,
    ticks: 0,
    review: { filter: 'all', index: 0 },
    browse: { q: '', course: '', topic: '', type: '', difficulty: '', status: '', limit: BROWSE_PAGE, open: {} },
    modes: { scope: 'all', topic: '', difficulty: 'Medium', randomCount: '20', examCount: '25', examTime: '0', examType: '', shuffleQ: false },
    // Slides & Quick Revision (loaded lazily on first visit)
    rev: null,
    revError: null,
    revLoading: false,
    revDeck: 'qm',
    revQ: '',
    revClosed: {},
    revViewer: null
  };

  var app = null;

  var MODE_INFO = {
    all: { title: 'All Questions', icon: 'i-layers' },
    msq: { title: 'MSQ Practice', icon: 'i-checks' },
    mcq: { title: 'MCQ Practice', icon: 'i-radio' },
    topic: { title: 'Topic Practice', icon: 'i-book' },
    difficulty: { title: 'Difficulty Practice', icon: 'i-gauge' },
    incorrect: { title: 'Incorrect Questions', icon: 'i-x-circle' },
    bookmarked: { title: 'Bookmarked Questions', icon: 'i-bookmark' },
    random: { title: 'Random Practice', icon: 'i-shuffle' },
    exam: { title: 'Exam Mode', icon: 'i-flag' },
    revision: { title: 'Revision Mode', icon: 'i-history' },
    custom: { title: 'Custom Set', icon: 'i-search' },
    continue: { title: 'Continue Practice', icon: 'i-play' },
    retry: { title: 'Retry Incorrect', icon: 'i-refresh' }
  };

  /* =====================================================================
     Small UI utilities
     ===================================================================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function icon(id, cls) { return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

  function toast(msg, ic) {
    var box = document.getElementById('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = icon(ic === 'alert' ? 'i-alert' : ic === 'bookmark' ? 'i-bookmark' : 'i-check-circle') + '<span>' + escapeHtml(msg) + '</span>';
    box.appendChild(el);
    setTimeout(function () { el.classList.add('leaving'); }, 2600);
    setTimeout(function () { el.remove(); }, 2900);
  }

  function stripTags(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || '';
  }

  /** Promise-based modal. Falls back to window.confirm when <dialog> is unsupported. */
  function confirmDialog(opts) {
    var dlg = document.getElementById('dialog');
    var body = opts.html || escapeHtml(opts.message || '');
    if (!dlg || typeof dlg.showModal !== 'function') {
      if (opts.alertOnly) { window.alert(opts.title + '\n\n' + stripTags(body)); return Promise.resolve(true); }
      return Promise.resolve(window.confirm(opts.title + '\n\n' + stripTags(body)));
    }
    $('#dialogTitle').textContent = opts.title;
    $('#dialogBody').innerHTML = body;
    var ok = $('#dialogOk'), cancel = $('#dialogCancel');
    ok.textContent = opts.ok || 'OK';
    ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    cancel.textContent = opts.cancel || 'Cancel';
    cancel.hidden = !!opts.alertOnly;
    dlg.returnValue = '';
    dlg.showModal();
    (opts.danger ? cancel : ok).focus();
    return new Promise(function (resolve) {
      dlg.addEventListener('close', function () { resolve(dlg.returnValue === 'ok'); }, { once: true });
    });
  }

  function ringSvg(value, label, sub, size, stroke) {
    size = size || 96; stroke = stroke || 10;
    var r = (100 - stroke) / 2;
    var c = 2 * Math.PI * r;
    var v = Math.max(0, Math.min(100, value));
    var off = c * (1 - v / 100);
    return '<div class="ring" style="--size:' + size + 'px" role="img" aria-label="' + escapeHtml(sub + ': ' + label) + '">' +
      '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
      (v > 0 ? '<circle class="bar" cx="50" cy="50" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"/>' : '') +
      '</svg><div class="ring-label" aria-hidden="true"><div>' + escapeHtml(label) + '<small>' + escapeHtml(sub) + '</small></div></div></div>';
  }

  function progressBar(value, label, thin) {
    var v = Math.max(0, Math.min(100, value));
    return '<div class="progress' + (thin ? ' thin' : '') + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(v) + '" aria-label="' + escapeHtml(label) + '"><span style="width:' + v + '%"></span></div>';
  }

  function splitBar(correct, incorrect, total) {
    var g = total ? (correct / total) * 100 : 0;
    var r = total ? (incorrect / total) * 100 : 0;
    var title = correct + ' correct · ' + incorrect + ' incorrect · ' + (total - correct - incorrect) + ' not attempted';
    return '<div class="split-bar" title="' + title + '" role="img" aria-label="' + title + '">' +
      (g > 0 ? '<span class="g" style="width:' + g + '%"></span>' : '') +
      (r > 0 ? '<span class="r" style="width:' + r + '%"></span>' : '') + '</div>';
  }

  function typeBadge(q) {
    return q.type === 'MSQ'
      ? '<span class="badge badge-msq">' + icon('i-checks', 'ic-sm') + 'MSQ</span>'
      : '<span class="badge badge-mcq">' + icon('i-radio', 'ic-sm') + 'MCQ</span>';
  }
  function diffBadge(q) {
    if (!q.difficulty) return '';
    return '<span class="badge badge-' + escapeHtml(String(q.difficulty).toLowerCase()) + '">' + icon('i-gauge', 'ic-sm') + escapeHtml(q.difficulty) + '</span>';
  }
  function topicBadges(q) {
    var out = '<span class="badge" title="' + escapeHtml(qCourse(q)) + '">' + escapeHtml(shortCourse(qCourse(q))) + '</span>' +
      '<span class="badge">' + escapeHtml(qTopic(q)) + '</span>';
    if (q.tag && q.tag !== q.difficulty) out += '<span class="badge">' + escapeHtml(q.tag) + '</span>';
    return out;
  }

  function sourceText(q) {
    var s = q.source;
    if (!s || typeof s !== 'object') return '';
    var parts = [];
    if (s.file) parts.push(s.file);
    if (s.pages || s.page) parts.push('PDF p.' + (s.pages || s.page));
    if (s.slide) parts.push('Slide ' + s.slide);
    return parts.join(' · ');
  }

  function hintText(q) {
    if (q.hint && String(q.hint).trim()) return q.hint;
    var src = q.source && (q.source.slide || q.source.page) ? 'Revisit ' + (q.source.slide ? 'slide ' + q.source.slide : 'page ' + q.source.page) + ' of ' + (q.source.file || 'the source') + '. ' : '';
    if (q.type === 'MSQ') return src + q.correctAnswers.length + ' of the ' + q.options.length + ' options are correct.';
    return src + 'Exactly one option is correct.';
  }

  function isBookmarked(id) { return store().bookmarks.indexOf(id) !== -1; }

  function toggleBookmark(id) {
    var b = store().bookmarks;
    var i = b.indexOf(id);
    if (i === -1) { b.push(id); toast('Bookmarked', 'bookmark'); } else { b.splice(i, 1); toast('Bookmark removed', 'bookmark'); }
    save();
  }

  /* =====================================================================
     Theme
     ===================================================================== */

  function applyTheme() {
    var t = store().settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var btn = document.getElementById('themeBtn');
    if (btn) {
      var ic = t === 'light' ? 'i-sun' : t === 'dark' ? 'i-moon' : 'i-monitor';
      var label = t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'System';
      btn.innerHTML = icon(ic);
      btn.setAttribute('aria-label', 'Theme: ' + label + '. Click to change.');
      btn.title = 'Theme: ' + label;
    }
  }

  function setTheme(t) {
    store().settings.theme = t;
    save();
    applyTheme();
  }

  /* =====================================================================
     Bank & derived data
     ===================================================================== */

  function setupBank(report) {
    S.report = report;
    S.meta = report.meta || {};
    S.bank = report.questions;
    S.byId = new Map();
    S.bank.forEach(function (q) { S.byId.set(q.id, q); });
    var courses = [];
    var topics = {};
    S.topics = [];
    S.bank.forEach(function (q) {
      var c = qCourse(q);
      if (courses.indexOf(c) === -1) courses.push(c);
      var k = topicKey(q);
      if (!topics[k]) { topics[k] = { key: k, course: c, topic: qTopic(q), count: 0 }; S.topics.push(topics[k]); }
      topics[k].count++;
    });
    S.courses = courses;
  }

  /** Drop references to questions that no longer exist (e.g. after editing the JSON). */
  function reconcileStore() {
    var d = store();
    ['session', 'lastResult'].forEach(function (k) {
      var s = d[k];
      if (!s) return;
      s.qids = s.qids.filter(function (id) { return S.byId.has(id); });
      if (!s.qids.length) { d[k] = null; return; }
      if (typeof s.index !== 'number' || s.index < 0 || s.index >= s.qids.length) s.index = 0;
      if (!s.order || typeof s.order !== 'object') s.order = {};
      Object.keys(s.order).forEach(function (qid) {
        var q = S.byId.get(qid);
        var ids = q ? q.options.map(function (o) { return o.id; }) : [];
        if (!q || !sameSet(s.order[qid], ids) || s.order[qid].length !== ids.length) delete s.order[qid];
      });
    });
    d.bookmarks = d.bookmarks.filter(function (id) { return S.byId.has(id); });
    save();
  }

  function globalStats() {
    var d = store();
    var st = {
      total: S.bank.length, attempted: 0, correct: 0, incorrect: 0, firstCorrect: 0,
      byType: { MSQ: { total: 0, attempted: 0, correct: 0, incorrect: 0 }, MCQ: { total: 0, attempted: 0, correct: 0, incorrect: 0 } },
      byTopic: {}
    };
    S.bank.forEach(function (q) {
      var bt = st.byType[q.type];
      var k = topicKey(q);
      var tp = st.byTopic[k] || (st.byTopic[k] = { total: 0, attempted: 0, correct: 0, incorrect: 0 });
      bt.total++; tp.total++;
      var a = d.attempts[q.id];
      if (a) {
        st.attempted++; bt.attempted++; tp.attempted++;
        if (a.status === 'correct') { st.correct++; bt.correct++; tp.correct++; }
        else { st.incorrect++; bt.incorrect++; tp.incorrect++; }
        if (a.firstStatus === 'correct') st.firstCorrect++;
      }
    });
    return st;
  }

  function pool(scope) {
    if (!scope || scope === 'all') return S.bank;
    return S.bank.filter(function (q) { return qCourse(q) === scope; });
  }

  function ids(list) { return list.map(function (q) { return q.id; }); }

  /* =====================================================================
     Sessions
     ===================================================================== */

  function getEntry(session, qid) {
    if (!session.answers[qid]) session.answers[qid] = { selected: [], checked: false, correct: null, tries: 0, skipped: false };
    return session.answers[qid];
  }

  function optionOrder(session, q) {
    var o = session && session.order && session.order[q.id];
    return o && o.length === q.options.length ? o : q.options.map(function (x) { return x.id; });
  }

  function hasProgress(s) {
    return Object.keys(s.answers).some(function (k) {
      var a = s.answers[k];
      return a && (a.checked || (a.selected && a.selected.length));
    });
  }

  /**
   * Start a new session. Returns a promise resolving to true when started.
   * opts: { mode, title, qids, exam, timeLimit, shuffleQuestions }
   */
  function startSession(opts) {
    var qids = (opts.qids || []).filter(function (id) { return S.byId.has(id); });
    if (!qids.length) {
      toast('No questions match this selection.', 'alert');
      return Promise.resolve(false);
    }
    var current = store().session;
    var gate = current && hasProgress(current)
      ? confirmDialog({
        title: 'Replace current session?',
        html: '<p>You have an unfinished session: <strong>' + escapeHtml(current.title) + '</strong>. Starting a new one discards it. Answers you already checked stay in your overall progress.</p>',
        ok: 'Start new session', cancel: 'Keep current'
      })
      : Promise.resolve(true);
    return gate.then(function (yes) {
      if (!yes) return false;
      var list = opts.shuffleQuestions ? shuffle(qids) : qids.slice();
      var order = {};
      if (store().settings.shuffleOptions) {
        list.forEach(function (id) { order[id] = shuffle(S.byId.get(id).options.map(function (o) { return o.id; })); });
      }
      store().session = {
        id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        mode: opts.mode,
        title: opts.title || (MODE_INFO[opts.mode] || {}).title || 'Practice',
        exam: !!opts.exam,
        timeLimit: Number(opts.timeLimit) || 0,
        shuffleQuestions: !!opts.shuffleQuestions,
        qids: list,
        index: 0,
        order: order,
        answers: {},
        startedAt: Date.now(),
        elapsed: 0,
        status: 'active'
      };
      S.hintOpen = false;
      save();
      navigate('practice');
      return true;
    });
  }

  function recordAttempt(q, selected, correct, session, logActivity) {
    var d = store();
    var prev = d.attempts[q.id];
    var status = correct ? 'correct' : 'incorrect';
    d.attempts[q.id] = {
      status: status,
      firstStatus: prev && prev.firstStatus ? prev.firstStatus : status,
      selected: selected.slice(),
      count: (prev && prev.count ? prev.count : 0) + 1,
      lastAt: Date.now()
    };
    if (logActivity) {
      var top = d.activity[0];
      var entry = { kind: 'q', qid: q.id, correct: correct, t: Date.now(), sid: session.id };
      // A retry of the same question in the same session replaces its entry (no duplicate attempts).
      if (top && top.kind === 'q' && top.qid === q.id && top.sid === session.id) d.activity[0] = entry;
      else d.activity.unshift(entry);
      d.activity = d.activity.slice(0, ACTIVITY_LIMIT);
    }
  }

  function finalizeSession(session) {
    var d = store();
    stopTimer();
    session.status = 'finished';
    session.finishedAt = Date.now();
    var st = sessionStats(session, S.byId);
    d.history.unshift({
      id: session.id, title: session.title, mode: session.mode, exam: session.exam,
      total: st.total, attempted: st.attempted, correct: st.correct, elapsed: session.elapsed, t: session.finishedAt
    });
    d.history = d.history.slice(0, HISTORY_LIMIT);
    d.activity.unshift({ kind: 's', title: session.title, exam: session.exam, correct: st.correct, total: st.total, t: session.finishedAt });
    d.activity = d.activity.slice(0, ACTIVITY_LIMIT);
    d.lastResult = session;
    if (d.session && d.session.id === session.id) d.session = null;
    save();
    navigate('results');
  }

  function finishPractice() {
    var s = store().session;
    if (!s) return;
    if (s.exam) { submitExam(false); return; }
    var st = sessionStats(s, S.byId);
    var gate = st.unanswered
      ? confirmDialog({
        title: 'Finish this session?',
        html: '<p>You have <strong>' + st.unanswered + '</strong> unanswered question' + (st.unanswered === 1 ? '' : 's') + '. They will be counted as unanswered.</p>',
        ok: 'Finish & see results', cancel: 'Keep practising'
      })
      : Promise.resolve(true);
    gate.then(function (yes) { if (yes) finalizeSession(s); });
  }

  function submitExam(force) {
    var s = store().session;
    if (!s || !s.exam) return;
    var answered = s.qids.filter(function (id) { var a = s.answers[id]; return a && a.selected && a.selected.length; }).length;
    var unanswered = s.qids.length - answered;
    var gate = force ? Promise.resolve(true) : confirmDialog({
      title: 'Submit exam?',
      html: '<p>You answered <strong>' + answered + '</strong> of <strong>' + s.qids.length + '</strong> questions.' +
        (unanswered ? ' <strong>' + unanswered + '</strong> unanswered question' + (unanswered === 1 ? ' counts' : 's count') + ' as not attempted.' : '') +
        '</p><p>You cannot change answers after submitting.</p>',
      ok: 'Submit exam', cancel: 'Keep working'
    });
    gate.then(function (yes) {
      if (!yes || store().session !== s) return;
      s.qids.forEach(function (id) {
        var a = s.answers[id];
        if (!a || !a.selected || !a.selected.length || a.checked) return;
        var q = S.byId.get(id);
        var g = gradeSelection(q, a.selected);
        a.checked = true;
        a.correct = g.isCorrect;
        a.tries = 1;
        recordAttempt(q, a.selected, g.isCorrect, s, false);
      });
      s.status = 'submitted';
      finalizeSession(s);
    });
  }

  /* =====================================================================
     Timer
     ===================================================================== */

  function stopTimer() {
    if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
  }

  function startTimer() {
    stopTimer();
    var s = store().session;
    if (!s || S.route.name !== 'practice') return;
    S.timerId = setInterval(function () {
      if (document.hidden) return;
      var cur = store().session;
      if (!cur || cur !== s || S.route.name !== 'practice') { stopTimer(); return; }
      s.elapsed += 1000;
      S.ticks++;
      updateTimer();
      if (S.ticks % 5 === 0) save();
      if (s.exam && s.timeLimit && s.elapsed >= s.timeLimit * 60000) {
        stopTimer();
        toast('Time is up — your exam was submitted.', 'alert');
        submitExam(true);
      }
    }, 1000);
  }

  function timerLabel(s) {
    if (s.exam && s.timeLimit) {
      var left = s.timeLimit * 60000 - s.elapsed;
      return { text: formatDuration(left), low: left <= 60000, aria: 'Time remaining' };
    }
    return { text: formatDuration(s.elapsed), low: false, aria: 'Time elapsed' };
  }

  function updateTimer() {
    var el = document.getElementById('timer');
    var s = store().session;
    if (!el || !s) return;
    var t = timerLabel(s);
    $('.t', el).textContent = t.text;
    el.classList.toggle('low', t.low);
  }

  /* =====================================================================
     Router
     ===================================================================== */

  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/').filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    return { name: parts[0] || 'dashboard', params: parts.slice(1) };
  }

  function navigate(path) {
    var target = '#/' + path;
    if (location.hash === target) render(true);
    else location.hash = target;
  }

  function setActiveNav(name) {
    var navName = name === 'review' ? 'results' : name === 'practice' ? 'modes' : name;
    $all('[data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === navName) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  var VIEWS = {
    dashboard: renderDashboard,
    modes: renderModes,
    practice: renderPractice,
    review: renderReview,
    results: renderResults,
    browse: renderBrowse,
    revision: renderRevision,
    settings: renderSettings
  };

  function render(isNavigation) {
    var r = parseHash();
    if (!VIEWS[r.name]) { r = { name: 'dashboard', params: [] }; }
    var changed = S.route.name !== r.name;
    S.route = r;
    if (r.name !== 'practice') stopTimer();
    if (r.name !== 'revision') document.body.classList.remove('rev-split', 'rev-sheet-open');
    setActiveNav(r.name);
    VIEWS[r.name]();
    var titles = { dashboard: 'Dashboard', modes: 'Practice modes', practice: 'Practice', review: 'Review', results: 'Results', browse: 'Question bank', revision: 'Slides & Quick Revision', settings: 'Settings' };
    document.title = titles[r.name] + ' · QM & VM Exam Practice';
    if (isNavigation || changed) {
      window.scrollTo(0, 0);
      var main = document.getElementById('main');
      if (main && r.name !== 'practice' && r.name !== 'review') main.focus({ preventScroll: true });
    }
  }

  /* =====================================================================
     Views — Dashboard
     ===================================================================== */

  function renderDashboard() {
    var d = store();
    var g = globalStats();
    var s = d.session;
    var sessionBlock;
    if (s) {
      var st = sessionStats(s, S.byId);
      var done = s.exam ? st.answered : st.attempted;
      sessionBlock = ringSvg(pct(done, st.total), pct(done, st.total) + '%', 'done', 92, 11) +
        '<div><h3>' + escapeHtml(s.title) + '</h3><p>' + done + ' of ' + st.total + (s.exam ? ' answered' : ' checked') +
        ' · question ' + (s.index + 1) + '</p><p>' + (s.exam ? 'Exam in progress' : st.correct + ' correct · ' + st.incorrect + ' incorrect') + '</p></div>';
    } else {
      sessionBlock = ringSvg(pct(g.attempted, g.total), pct(g.attempted, g.total) + '%', 'covered', 92, 11) +
        '<div><h3>No active session</h3><p>You have practised ' + g.attempted + ' of ' + g.total + ' questions. Continue picks up the ones you have not tried yet.</p></div>';
    }

    var warn = '';
    if (S.report && S.report.errors.length) {
      warn = '<div class="notice warn" role="alert">' + icon('i-alert') + '<div><strong>' + S.report.errors.length +
        ' question' + (S.report.errors.length === 1 ? ' was' : 's were') + ' skipped</strong> because of data errors. <a href="#/settings">See details in Settings</a>.</div></div>';
    }

    var tiles = [
      { ic: 'i-layers', cls: '', v: g.total, l: 'Total questions', sub: 'in the bank' },
      { ic: 'i-checks', cls: 'v', v: g.byType.MSQ.total, l: 'MSQs', sub: 'multiple select' },
      { ic: 'i-radio', cls: 't', v: g.byType.MCQ.total, l: 'MCQs', sub: 'single answer' },
      { ic: 'i-target', cls: '', v: g.attempted, l: 'Attempted', sub: pct(g.attempted, g.total) + '% of the bank' },
      { ic: 'i-check-circle', cls: 'g', v: g.correct, l: 'Correct', sub: 'latest attempt' },
      { ic: 'i-x-circle', cls: 'r', v: g.incorrect, l: 'Incorrect', sub: 'latest attempt' },
      { ic: 'i-gauge', cls: 'v', v: g.attempted ? pct(g.correct, g.attempted) + '%' : '—', l: 'Accuracy', sub: g.attempted ? 'first try ' + pct(g.firstCorrect, g.attempted) + '%' : 'no attempts yet' },
      { ic: 'i-bookmark', cls: 't', v: d.bookmarks.length, l: 'Bookmarked', sub: 'saved for later' }
    ].map(function (t) {
      return '<div class="card stat"><div class="stat-icon ' + t.cls + '">' + icon(t.ic) + '</div><div><div class="stat-value">' + t.v +
        '</div><div class="stat-label">' + t.l + '</div><div class="stat-sub">' + t.sub + '</div></div></div>';
    }).join('');

    function typeCard(type) {
      var b = g.byType[type];
      var isMsq = type === 'MSQ';
      return '<div class="card card-hover type-card ' + type.toLowerCase() + '">' +
        '<div class="type-glyph">' + type + '</div>' +
        '<div class="type-body"><h3>' + (isMsq ? 'MSQ practice' : 'MCQ practice') + '</h3>' +
        '<p>' + b.total + ' questions · ' + (isMsq ? 'one or more correct, exact match needed' : 'exactly one correct option') + '</p>' +
        '<div style="margin:.6rem 0 .3rem">' + splitBar(b.correct, b.incorrect, b.total) + '</div>' +
        '<p class="small">' + b.attempted + ' attempted · ' + (b.attempted ? pct(b.correct, b.attempted) + '% accuracy' : 'not started') + '</p></div>' +
        '<button class="btn btn-soft" data-action="quick-start" data-mode="' + type.toLowerCase() + '">' + icon('i-play') + 'Start</button></div>';
    }

    // topic-wise progress
    var topicHtml = '';
    S.courses.forEach(function (c) {
      topicHtml += '<div class="course-label">' + escapeHtml(c) + '</div>';
      S.topics.filter(function (t) { return t.course === c; }).forEach(function (t) {
        var tp = g.byTopic[t.key];
        topicHtml += '<button class="topic-row" data-action="start-topic" data-topic="' + escapeHtml(t.key) + '" aria-label="Practise ' + escapeHtml(t.topic) + '">' +
          '<span class="topic-name">' + escapeHtml(t.topic) + '<small>' + tp.attempted + ' / ' + tp.total + ' attempted</small></span>' +
          '<span class="progress-col">' + splitBar(tp.correct, tp.incorrect, tp.total) + '</span>' +
          '<span class="topic-acc">' + (tp.attempted ? pct(tp.correct, tp.attempted) + '%' : '—') + '<small>accuracy</small></span></button>';
      });
    });

    // recent activity
    var acts = d.activity.slice(0, 8);
    var actHtml = acts.length ? '<ul class="activity">' + acts.map(function (a) {
      if (a.kind === 's') {
        return '<li><span class="dot n">' + icon(a.exam ? 'i-flag' : 'i-trophy', 'ic-sm') + '</span><div class="txt"><strong>' + escapeHtml(a.title) +
          '</strong> finished<span class="muted">' + a.correct + ' / ' + a.total + ' correct</span></div><span class="when">' + timeAgo(a.t) + '</span></li>';
      }
      var q = S.byId.get(a.qid);
      if (!q) return '';
      return '<li><span class="dot ' + (a.correct ? 'g' : 'r') + '">' + icon(a.correct ? 'i-check' : 'i-x', 'ic-sm') + '</span><div class="txt"><span>' +
        escapeHtml(q.question) + '</span><span class="muted small">' + (a.correct ? 'Correct' : 'Incorrect') + ' · ' + q.type + ' · ' + escapeHtml(qTopic(q)) +
        '</span></div><span class="when">' + timeAgo(a.t) + '</span></li>';
    }).join('') + '</ul>'
      : '<div class="empty" style="padding:1.5rem .5rem"><div class="art">' + icon('i-history') + '</div><p>No activity yet. Answer a question and it will show up here.</p></div>';

    app.innerHTML = '<div class="view">' +
      '<section class="hero" aria-labelledby="heroTitle">' +
      '<div style="position:relative;z-index:1"><div class="eyebrow">' + icon('i-sparkles', 'ic-sm') + escapeHtml(S.meta.course || 'Exam preparation') + '</div>' +
      '<h1 id="heroTitle">Practise smarter for Quality &amp; Vendor Management</h1>' +
      '<p>' + g.total + ' exam-style questions built from your Session 11 and Session 7 slides, with instant checking and an explanation for every option.</p>' +
      '<div class="hero-actions"><button class="btn btn-white" data-action="continue">' + icon('i-play') + (s ? 'Continue practice' : 'Continue practice') + '</button>' +
      '<a class="btn btn-light" href="#/modes">' + icon('i-grid') + 'All practice modes</a>' +
      '<button class="btn btn-light" data-action="quick-start" data-mode="exam">' + icon('i-flag') + 'Quick exam (25)</button></div></div>' +
      '<div class="hero-session">' + sessionBlock + '</div></section>' + warn +
      '<div class="stats">' + tiles + '</div>' +
      '<section class="section"><div class="section-title"><h2>Practice by question type</h2><a class="btn btn-ghost btn-sm" href="#/modes">More modes ' + icon('i-right', 'ic-sm') + '</a></div>' +
      '<div class="grid grid-2">' + typeCard('MSQ') + typeCard('MCQ') + '</div></section>' +
      '<section class="section"><div class="section-title"><h2>Slides &amp; quick revision</h2><a class="btn btn-ghost btn-sm" href="#/revision">Open ' + icon('i-right', 'ic-sm') + '</a></div>' +
      '<div class="grid grid-2">' +
      '<a class="card card-hover rev-link accent-violet" href="#/revision/qm"><span class="deck-icon">' + icon('i-slides') + '</span><span><strong>Quality Management</strong><span class="small muted">Session 11 · summaries, gurus table, formulas, cases</span></span>' + icon('i-right') + '</a>' +
      '<a class="card card-hover rev-link accent-teal" href="#/revision/vm"><span class="deck-icon">' + icon('i-slides') + '</span><span><strong>Vendor Management &amp; Contracts</strong><span class="small muted">Session 7 · Kraljic, TCO, clauses, SLAs, cases</span></span>' + icon('i-right') + '</a>' +
      '</div></section>' +
      '<section class="section grid grid-2" style="align-items:start">' +
      '<div class="card"><div class="section-title"><h2>Topic progress</h2><div class="legend"><span><i style="background:var(--good)"></i>Correct</span><span><i style="background:var(--bad)"></i>Incorrect</span><span><i style="background:var(--surface-3)"></i>Not tried</span></div></div>' +
      '<div class="topic-list">' + topicHtml + '</div></div>' +
      '<div class="card"><div class="section-title"><h2>Recent activity</h2>' + (d.lastResult ? '<a class="btn btn-ghost btn-sm" href="#/results">Last results</a>' : '') + '</div>' + actHtml + '</div>' +
      '</section></div>';
  }

  /* =====================================================================
     Views — Practice modes
     ===================================================================== */

  function modeCounts() {
    var p = pool(S.modes.scope);
    var d = store();
    return {
      pool: p,
      all: p.length,
      msq: p.filter(function (q) { return q.type === 'MSQ'; }).length,
      mcq: p.filter(function (q) { return q.type === 'MCQ'; }).length,
      incorrect: p.filter(function (q) { var a = d.attempts[q.id]; return a && a.status === 'incorrect'; }).length,
      bookmarked: p.filter(function (q) { return isBookmarked(q.id); }).length,
      revision: p.filter(function (q) { return !!d.attempts[q.id]; }).length,
      diff: {
        Easy: p.filter(function (q) { return q.difficulty === 'Easy'; }).length,
        Medium: p.filter(function (q) { return q.difficulty === 'Medium'; }).length,
        Hard: p.filter(function (q) { return q.difficulty === 'Hard'; }).length
      }
    };
  }

  function buildModeQids(mode) {
    var m = S.modes;
    var p = pool(m.scope);
    var d = store();
    switch (mode) {
      case 'all': return ids(p);
      case 'msq': return ids(p.filter(function (q) { return q.type === 'MSQ'; }));
      case 'mcq': return ids(p.filter(function (q) { return q.type === 'MCQ'; }));
      case 'topic': return ids(S.bank.filter(function (q) { return topicKey(q) === m.topic; }));
      case 'difficulty': return ids(p.filter(function (q) { return q.difficulty === m.difficulty; }));
      case 'incorrect': return ids(p.filter(function (q) { var a = d.attempts[q.id]; return a && a.status === 'incorrect'; }));
      case 'bookmarked': return ids(p.filter(function (q) { return isBookmarked(q.id); }));
      case 'revision': return ids(p.filter(function (q) { return !!d.attempts[q.id]; }));
      case 'random': {
        var r = shuffle(ids(p));
        return m.randomCount === 'all' ? r : r.slice(0, Number(m.randomCount));
      }
      case 'exam': {
        var e = p.filter(function (q) { return !m.examType || q.type === m.examType; });
        var x = shuffle(ids(e));
        return m.examCount === 'all' ? x : x.slice(0, Number(m.examCount));
      }
      default: return [];
    }
  }

  function startMode(mode) {
    var m = S.modes;
    var qids = buildModeQids(mode);
    var title = MODE_INFO[mode].title;
    if (mode === 'topic') {
      var t = S.topics.filter(function (x) { return x.key === m.topic; })[0];
      if (!t) { toast('Choose a topic first.', 'alert'); return; }
      title = 'Topic: ' + t.topic + (t.topic === 'Mixed Review' ? ' (' + shortCourse(t.course) + ')' : '');
    } else if (mode === 'difficulty') {
      title = m.difficulty + ' questions';
    } else if (mode === 'exam') {
      title = 'Exam · ' + qids.length + ' questions' + (m.examTime !== '0' ? ' · ' + m.examTime + ' min' : '');
    }
    if (m.scope !== 'all' && mode !== 'topic') title += ' · ' + shortCourse(m.scope);
    var shuffleQ = mode === 'random' || mode === 'exam' ? false : m.shuffleQ; // random/exam are already shuffled
    startSession({
      mode: mode, title: title, qids: qids, shuffleQuestions: shuffleQ,
      exam: mode === 'exam', timeLimit: mode === 'exam' ? Number(m.examTime) : 0
    });
  }

  function renderModes() {
    var m = S.modes;
    if (!m.topic && S.topics.length) m.topic = S.topics[0].key;
    var c = modeCounts();
    var settings = store().settings;

    function card(mode, iconCls, desc, count, controls, opts) {
      opts = opts || {};
      var info = MODE_INFO[mode];
      var disabled = !count;
      return '<div class="card card-hover mode-card' + (opts.featured ? ' featured' : '') + '">' +
        '<div class="row"><div class="mode-icon ' + iconCls + '">' + icon(info.icon) + '</div><span class="spacer"></span>' +
        '<span class="count">' + count + ' question' + (count === 1 ? '' : 's') + '</span></div>' +
        '<h3>' + (opts.num ? '<span class="muted">' + opts.num + '.</span> ' : '') + info.title + '</h3><p>' + desc + '</p>' +
        (controls || '') +
        '<div class="mode-foot"><button class="btn ' + (opts.featured ? 'btn-gradient' : 'btn-primary') + ' btn-sm" data-action="start-mode" data-mode="' + mode + '"' + (disabled ? ' disabled' : '') + '>' +
        icon(mode === 'exam' ? 'i-flag' : 'i-play', 'ic-sm') + (mode === 'exam' ? 'Start exam' : 'Start') + '</button>' +
        (disabled && opts.emptyMsg ? '<span class="muted small">' + opts.emptyMsg + '</span>' : '') + '</div></div>';
    }

    var topicOptions = S.courses.map(function (course) {
      return '<optgroup label="' + escapeHtml(course) + '">' + S.topics.filter(function (t) { return t.course === course; }).map(function (t) {
        return '<option value="' + escapeHtml(t.key) + '"' + (t.key === m.topic ? ' selected' : '') + '>' + escapeHtml(t.topic) + ' (' + t.count + ')</option>';
      }).join('') + '</optgroup>';
    }).join('');
    var topicCount = (S.topics.filter(function (t) { return t.key === m.topic; })[0] || { count: 0 }).count;

    var diffSeg = '<div class="segmented" role="group" aria-label="Difficulty">' + ['Easy', 'Medium', 'Hard'].map(function (dv) {
      return '<button type="button" data-action="set-mode-opt" data-key="difficulty" data-value="' + dv + '" aria-pressed="' + (m.difficulty === dv) + '">' + dv + ' · ' + c.diff[dv] + '</button>';
    }).join('') + '</div>';

    function select(key, label, options) {
      return '<div class="field"><label for="mo-' + key + '">' + label + '</label><select class="select" id="mo-' + key + '" data-change="mode-opt" data-key="' + key + '">' +
        options.map(function (o) { return '<option value="' + o[0] + '"' + (String(m[key]) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    }

    var examPool = c.pool.filter(function (q) { return !m.examType || q.type === m.examType; }).length;
    var examN = m.examCount === 'all' ? examPool : Math.min(examPool, Number(m.examCount));
    var randomN = m.randomCount === 'all' ? c.all : Math.min(c.all, Number(m.randomCount));

    var scopeSeg = '<div class="segmented" role="group" aria-label="Course">' + [['all', 'All courses']].concat(S.courses.map(function (x) { return [x, x]; })).map(function (o) {
      return '<button type="button" data-action="set-mode-opt" data-key="scope" data-value="' + escapeHtml(o[0]) + '" aria-pressed="' + (m.scope === o[0]) + '">' + escapeHtml(o[1]) + '</button>';
    }).join('') + '</div>';

    var resume = store().session
      ? '<div class="notice info">' + icon('i-play') + '<div style="flex:1">You have a session in progress: <strong>' + escapeHtml(store().session.title) + '</strong>.</div><a class="btn btn-primary btn-sm" href="#/practice">Resume</a></div>'
      : '';

    app.innerHTML = '<div class="view">' +
      '<div class="page-head"><div><h1>Practice modes</h1><p>Pick how you want to practise. Your progress is saved automatically.</p></div></div>' +
      '<div class="card" style="padding:1rem 1.25rem"><div class="row" style="gap:1rem 1.5rem">' +
      '<div class="field"><span class="label">Course</span>' + scopeSeg + '</div><span class="spacer"></span>' +
      '<label class="row small" style="gap:.6rem"><span class="switch"><input type="checkbox" data-change="mode-shuffleQ"' + (m.shuffleQ ? ' checked' : '') + '><span class="track"></span></span>Shuffle question order</label>' +
      '<label class="row small" style="gap:.6rem"><span class="switch"><input type="checkbox" data-change="setting" data-key="shuffleOptions"' + (settings.shuffleOptions ? ' checked' : '') + '><span class="track"></span></span>Shuffle options</label>' +
      '</div></div>' + resume +
      '<div class="grid grid-3" style="margin-top:1.25rem">' +
      card('all', '', 'Every question, MSQs and MCQs mixed, in course order.', c.all, '', { featured: true, num: 1 }) +
      card('msq', 'violet', 'Multiple-select only. Every correct option, and nothing else, must be ticked.', c.msq, '', { num: 2 }) +
      card('mcq', 'teal', 'Single-answer questions with exactly one correct option.', c.mcq, '', { num: 3 }) +
      card('topic', 'navy', 'Focus on one lecture section.', topicCount,
        '<div class="field"><label for="mo-topic">Topic</label><select class="select" id="mo-topic" data-change="mode-opt" data-key="topic">' + topicOptions + '</select></div>', { num: 4 }) +
      card('difficulty', 'amber', 'Filter by Easy, Medium or Hard.', c.diff[m.difficulty], diffSeg, { num: 5 }) +
      card('incorrect', 'rose', 'Retry questions whose latest answer was wrong.', c.incorrect, '', { num: 6, emptyMsg: 'Nothing to retry yet.' }) +
      card('bookmarked', 'violet', 'Practise the questions you saved.', c.bookmarked, '', { num: 7, emptyMsg: 'No bookmarks yet.' }) +
      card('random', 'teal', 'A shuffled mix from the whole bank.', randomN,
        select('randomCount', 'Number of questions', [['10', '10'], ['20', '20'], ['30', '30'], ['50', '50'], ['all', 'All']]), { num: 8 }) +
      card('exam', 'navy', 'Answer everything first, then submit for a scored review. No feedback until you submit.', examN,
        '<div class="grid grid-3" style="gap:.5rem">' + select('examCount', 'Questions', [['10', '10'], ['25', '25'], ['50', '50'], ['100', '100'], ['all', 'All']]) +
        select('examTime', 'Time limit', [['0', 'None'], ['10', '10 min'], ['20', '20 min'], ['30', '30 min'], ['60', '60 min'], ['90', '90 min']]) +
        select('examType', 'Type', [['', 'Mixed'], ['MSQ', 'MSQ'], ['MCQ', 'MCQ']]) + '</div>', { num: 9 }) +
      card('revision', '', 'Go back over every question you have already attempted.', c.revision, '', { num: 10, emptyMsg: 'Attempt some questions first.' }) +
      '</div>' +
      '<p class="muted small" style="margin-top:1.25rem">Tip: build a custom set by searching or filtering in the <a href="#/browse">Question bank</a> and pressing “Practise these”.</p>' +
      '</div>';
  }

  /* =====================================================================
     Views — Practice / Exam / Review (shared question renderer)
     ===================================================================== */

  function renderPractice() {
    var s = store().session;
    if (!s) {
      app.innerHTML = '<div class="view"><div class="card empty"><div class="art">' + icon('i-play') + '</div><h2>No active session</h2>' +
        '<p>Choose a practice mode to start answering questions.</p><div class="row" style="justify-content:center">' +
        '<a class="btn btn-primary" href="#/modes">' + icon('i-grid') + 'Choose a mode</a>' +
        '<button class="btn btn-ghost" data-action="continue">' + icon('i-play') + 'Continue where I left off</button></div></div></div>';
      return;
    }
    if (s.index >= s.qids.length) s.index = s.qids.length - 1;
    renderQuestion({ kind: s.exam ? 'exam' : 'practice', session: s, list: s.qids, index: s.index });
    startTimer();
  }

  function reviewList(s, filter) {
    return s.qids.filter(function (id) {
      var a = s.answers[id];
      if (filter === 'incorrect') return a && a.checked && !a.correct;
      if (filter === 'unanswered') return !(a && a.checked);
      return true;
    });
  }

  function renderReview() {
    var s = store().lastResult;
    var filter = S.route.params[0] || 'all';
    if (['all', 'incorrect', 'unanswered'].indexOf(filter) === -1) filter = 'all';
    if (!s) {
      app.innerHTML = '<div class="view"><div class="card empty"><div class="art">' + icon('i-chart') + '</div><h2>Nothing to review</h2><p>Finish a practice session or an exam to review it here.</p><a class="btn btn-primary" href="#/modes">Start practising</a></div></div>';
      return;
    }
    var list = reviewList(s, filter);
    if (!list.length) {
      app.innerHTML = '<div class="view"><div class="card empty"><div class="art">' + icon('i-check-circle') + '</div><h2>' +
        (filter === 'incorrect' ? 'No incorrect answers' : 'Nothing here') + '</h2><p>' + (filter === 'incorrect' ? 'Every question you checked in this session was correct.' : 'There are no questions in this view.') +
        '</p><a class="btn btn-primary" href="#/results">Back to results</a></div></div>';
      return;
    }
    if (S.review.filter !== filter) { S.review.filter = filter; S.review.index = 0; }
    // A position in the URL (#/review/all/5) applies once per navigation, not on every re-render.
    if (S.review.appliedHash !== location.hash) {
      S.review.appliedHash = location.hash;
      var startAt = Number(S.route.params[1]);
      if (S.route.params[1] !== undefined && !isNaN(startAt)) S.review.index = Math.max(0, Math.min(list.length - 1, startAt));
      else S.review.index = 0;
    }
    if (S.review.index >= list.length) S.review.index = 0;
    renderQuestion({ kind: 'review', session: s, list: list, index: S.review.index, filter: filter });
  }

  /** Build the UI state for one option. */
  function optionState(q, optId, entry, revealed) {
    var sel = entry && entry.selected ? entry.selected.indexOf(optId) !== -1 : false;
    if (!revealed) return { cls: sel ? 'selected' : '', label: '' };
    var isAns = q.correctAnswers.indexOf(optId) !== -1;
    if (isAns && sel) return { cls: 'is-correct', label: icon('i-check', 'ic-sm') + 'Correct' };
    if (isAns && !sel) return { cls: 'is-missed', label: 'Correct answer' };
    if (!isAns && sel) return { cls: 'is-wrong', label: icon('i-x', 'ic-sm') + 'Your pick' };
    return { cls: 'is-neutral', label: '' };
  }

  function letterFor(order, optId) { return LETTERS.charAt(order.indexOf(optId)); }

  function optText(q, optId) {
    for (var i = 0; i < q.options.length; i++) if (q.options[i].id === optId) return q.options[i].text;
    return '';
  }

  function listLetters(order, idsList) {
    return idsList.slice().sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); })
      .map(function (id) { return letterFor(order, id); }).join(', ');
  }

  function feedbackHtml(q, entry, order, kind) {
    var answered = entry && entry.selected && entry.selected.length;
    var checked = entry && entry.checked;
    var ok = !!(checked && entry.correct);
    var g = gradeSelection(q, entry ? entry.selected : []);
    var head, sub;
    if (ok) {
      head = 'Correct Answer!';
      sub = q.type === 'MSQ' ? 'You selected all ' + q.correctAnswers.length + ' correct option' + (q.correctAnswers.length === 1 ? '' : 's') + ' and nothing else.' : 'Well done — that is the right option.';
    } else if (answered && !checked) {
      head = 'Not checked';
      sub = 'You selected options but never checked this question, so it was not scored.';
    } else if (!checked || !answered) {
      head = 'Not answered';
      sub = 'You did not answer this question. The correct answer is shown below.';
    } else {
      head = 'Incorrect Answer';
      sub = q.type === 'MSQ' ? 'An MSQ is only correct when the selected set matches the answer key exactly.' : 'That option is not the correct one.';
    }

    var why = '';
    if (checked && answered && !ok) {
      var parts = [];
      if (q.type === 'MCQ') {
        parts.push('You chose <strong>' + listLetters(order, entry.selected) + '</strong>, but the correct answer is <strong>' + listLetters(order, q.correctAnswers) + '</strong>.');
      } else {
        if (g.right.length) parts.push('You correctly picked <strong>' + listLetters(order, g.right) + '</strong>.');
        if (g.missed.length) parts.push('You missed <strong>' + listLetters(order, g.missed) + '</strong>, which ' + (g.missed.length === 1 ? 'is' : 'are') + ' also correct.');
        if (g.wrong.length) parts.push('You selected <strong>' + listLetters(order, g.wrong) + '</strong>, which ' + (g.wrong.length === 1 ? 'is' : 'are') + ' not correct.');
      }
      why = '<div class="fb-why"><strong>Why it is marked wrong:</strong> ' + parts.join(' ') + '</div>';
    }

    var expl;
    var oe = q.optionExplanations;
    if (oe && typeof oe === 'object' && Object.keys(oe).length) {
      expl = '<ul>' + order.map(function (id) {
        var isAns = q.correctAnswers.indexOf(id) !== -1;
        var text = oe[id] ? oe[id] : (isAns ? 'Correct option.' : 'Incorrect option.');
        return '<li class="' + (isAns ? 'ok' : 'no') + '"><span class="k" aria-label="' + (isAns ? 'Correct option ' : 'Incorrect option ') + letterFor(order, id) + '">' + letterFor(order, id) + '</span><span>' + escapeHtml(text) + '</span></li>';
      }).join('') + '</ul>';
    } else {
      expl = '<p style="margin:0">' + escapeHtml(q.explanation) + '</p>';
    }

    var src = sourceText(q);
    var cls = ok ? 'ok' : 'bad';
    return '<section class="feedback ' + cls + '" aria-labelledby="fbTitle">' +
      '<div class="fb-head"><span class="fb-icon">' + icon(ok ? 'i-check' : 'i-x') + '</span><div><h3 id="fbTitle" tabindex="-1">' + head + '</h3><p>' + sub + '</p></div></div>' +
      '<dl class="fb-answers"><dt>Your answer</dt><dd>' + (answered ? listLetters(order, entry.selected) : '—') + '</dd>' +
      '<dt>Correct answer</dt><dd>' + q.correctAnswers.slice().sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }).map(function (id) {
        return '<strong>' + letterFor(order, id) + '</strong> ' + escapeHtml(optText(q, id));
      }).join('<br>') + '</dd></dl>' + why +
      '<div class="fb-expl"><h4>Explanation</h4>' + expl + '</div>' +
      (src ? '<div class="fb-source">' + icon('i-file', 'ic-sm') + '<span>Source: ' + escapeHtml(src) + '</span></div>' : '') +
      (kind === 'practice' && entry && entry.tries > 1 ? '<div class="fb-source">' + icon('i-refresh', 'ic-sm') + '<span>Attempt ' + entry.tries + ' — counted once in your score.</span></div>' : '') +
      '</section>';
  }

  function navStatus(ctx, qid) {
    var a = ctx.session.answers[qid];
    if (ctx.kind === 'exam') {
      return a && a.selected && a.selected.length ? 'answered' : (a && a.skipped ? 'skipped' : '');
    }
    if (a && a.checked) return a.correct ? 'correct' : 'incorrect';
    if (ctx.kind === 'review') return '';
    if (a && a.selected && a.selected.length) return 'answered';
    if (a && a.skipped) return 'skipped';
    return '';
  }

  function renderQuestion(ctx) {
    var s = ctx.session;
    var qid = ctx.list[ctx.index];
    var q = S.byId.get(qid);
    var entry = ctx.kind === 'review' ? (s.answers[qid] || { selected: [], checked: false }) : getEntry(s, qid);
    var order = optionOrder(s, q);
    var revealed = ctx.kind === 'review' || (ctx.kind === 'practice' && entry.checked);
    var locked = revealed;
    var n = ctx.list.length;
    var isLast = ctx.index === n - 1;
    var settings = store().settings;
    var bm = isBookmarked(qid);
    var st = sessionStats(s, S.byId);

    // top bar
    var top = '<div class="practice-top"><div><div class="title">' + escapeHtml(ctx.kind === 'review' ? 'Review · ' + s.title : s.title) + '</div>' +
      '<div class="meta">' + (ctx.kind === 'exam' ? 'Exam mode — answers are checked when you submit' : ctx.kind === 'review' ? (ctx.filter === 'incorrect' ? 'Incorrect answers only' : ctx.filter === 'unanswered' ? 'Unanswered questions' : 'All questions') + ' · read-only' : 'Practice mode — check each answer as you go') + '</div></div><span class="spacer"></span>';
    if (ctx.kind !== 'review') {
      var t = timerLabel(s);
      top += '<span class="timer' + (t.low ? ' low' : '') + '" id="timer" aria-label="' + t.aria + '">' + icon('i-clock', 'ic-sm') + '<span class="t" aria-live="off">' + t.text + '</span></span>';
    }
    top += '<button class="btn btn-ghost btn-sm nav-toggle" data-action="toggle-nav" aria-expanded="' + S.navOpen + '" aria-controls="sidePanel">' + icon('i-grid', 'ic-sm') + 'Questions</button>';
    if (ctx.kind === 'exam') top += '<button class="btn btn-gradient btn-sm" data-action="submit-exam">' + icon('i-send', 'ic-sm') + 'Submit exam</button>';
    else if (ctx.kind === 'practice') top += '<button class="btn btn-ghost btn-sm" data-action="finish">' + icon('i-stop', 'ic-sm') + 'End session</button>';
    else top += '<a class="btn btn-ghost btn-sm" href="#/results">' + icon('i-left', 'ic-sm') + 'Results</a>';
    top += '</div>';

    var progressVal = ctx.kind === 'review' ? pct(ctx.index + 1, n) : pct(ctx.kind === 'exam' ? st.answered : st.attempted, st.total);
    var progressLabel = ctx.kind === 'review' ? 'Review position' : ctx.kind === 'exam' ? 'Questions answered' : 'Questions checked';
    var progress = '<div class="q-progress">' + progressBar(progressVal, progressLabel) +
      '<span class="count">' + (ctx.kind === 'review' ? (ctx.index + 1) + ' / ' + n : (ctx.kind === 'exam' ? st.answered : st.attempted) + ' / ' + st.total + (ctx.kind === 'exam' ? ' answered' : ' checked')) + '</span></div>';

    // options
    var inputType = q.type === 'MSQ' ? 'checkbox' : 'radio';
    var optionsHtml = order.map(function (id, i) {
      var os = optionState(q, id, entry, revealed);
      var sel = entry.selected && entry.selected.indexOf(id) !== -1;
      return '<label class="option type-' + q.type.toLowerCase() + ' ' + os.cls + (sel && revealed ? ' selected-orig' : '') + '" data-opt="' + escapeHtml(id) + '">' +
        '<input type="' + inputType + '" name="opt-' + escapeHtml(qid) + '" value="' + escapeHtml(id) + '"' + (sel ? ' checked' : '') + (locked ? ' disabled' : '') + ' data-change="option">' +
        '<span class="ctrl" aria-hidden="true">' + (q.type === 'MSQ' ? icon('i-check') : '') + '</span>' +
        '<span class="key" aria-hidden="true">' + LETTERS.charAt(i) + '</span>' +
        '<span class="body"><span class="text"><span class="sr-only">Option ' + LETTERS.charAt(i) + ': </span>' + escapeHtml(optText(q, id)) + '</span></span>' +
        '<span class="state">' + os.label + '</span></label>';
    }).join('');

    var optionsCls = 'options' + (locked ? ' locked' : '') + (revealed ? ' revealed' : '') +
      (S.justChecked ? (entry.correct ? ' pop' : ' shake') : '');
    S.justChecked = false;

    // actions
    var a = '<div class="actions">';
    a += '<button class="btn btn-ghost" data-action="prev"' + (ctx.index === 0 ? ' disabled' : '') + ' aria-label="Previous question">' + icon('i-left') + '<span class="lbl-long">Previous</span></button>';
    if (ctx.kind !== 'review') {
      a += '<button class="btn btn-ghost" data-action="clear"' + (locked || !entry.selected.length ? ' disabled' : '') + '>' + icon('i-eraser') + '<span class="lbl-long">Clear</span><span class="sr-only"> selection</span></button>';
      if (ctx.kind === 'practice' && settings.showHints) {
        a += '<button class="btn btn-ghost" data-action="hint" aria-expanded="' + S.hintOpen + '">' + icon('i-bulb') + '<span class="lbl-long">' + (S.hintOpen ? 'Hide hint' : 'Hint') + '</span></button>';
      }
    }
    a += '<span class="spacer"></span>';
    if (ctx.kind !== 'review' && !(ctx.kind === 'practice' && entry.checked)) {
      a += '<button class="btn btn-ghost" data-action="skip">' + icon('i-skip') + 'Skip</button>';
    }
    if (ctx.kind === 'practice') {
      if (entry.checked) {
        a += '<button class="btn btn-ghost" data-action="retry">' + icon('i-refresh') + 'Try again</button>';
      } else {
        a += '<button class="btn btn-primary" data-action="check">' + icon('i-check') + 'Check answer</button>';
      }
    }
    var nextPrimary = ctx.kind !== 'practice' || entry.checked;
    if (isLast) {
      if (ctx.kind === 'exam') a += '<button class="btn btn-gradient" data-action="submit-exam">' + icon('i-send') + 'Submit exam</button>';
      else if (ctx.kind === 'practice') a += '<button class="btn ' + (nextPrimary ? 'btn-gradient' : 'btn-ghost') + '" data-action="finish">' + icon('i-trophy') + 'Finish</button>';
      else a += '<a class="btn btn-primary" href="#/results">' + icon('i-chart') + 'Back to results</a>';
    } else {
      a += '<button class="btn ' + (nextPrimary ? 'btn-primary' : 'btn-ghost') + '" data-action="next">Next' + icon('i-right') + '</button>';
    }
    a += '</div>';

    var hint = ctx.kind === 'practice' && settings.showHints && S.hintOpen
      ? '<div class="hint-box" role="note">' + icon('i-bulb') + '<div><strong>Hint:</strong> ' + escapeHtml(hintText(q)) + '</div></div>' : '';

    var feedback = revealed ? feedbackHtml(q, entry, order, ctx.kind) : '';

    var card = '<article class="card q-card" aria-labelledby="qText">' +
      '<div class="q-head"><div class="q-badges">' + typeBadge(q) + diffBadge(q) + topicBadges(q) + '</div>' +
      '<button class="icon-btn" data-action="bookmark" aria-pressed="' + bm + '" aria-label="' + (bm ? 'Remove bookmark' : 'Bookmark this question') + '" title="Bookmark (B)">' + icon('i-bookmark') + '</button></div>' +
      '<div class="q-num">Question ' + (ctx.index + 1) + ' of ' + n + ' · ' + escapeHtml(q.id) + '</div>' +
      '<h2 class="q-text" id="qText" tabindex="-1">' + escapeHtml(q.question) + '</h2>' +
      '<div class="q-instr">' + icon(q.type === 'MSQ' ? 'i-checks' : 'i-radio', 'ic-sm') +
      (q.type === 'MSQ' ? 'Select all that apply — one or more options may be correct' : 'Select one option') + '</div>' +
      '<fieldset class="' + optionsCls + '" id="options"><legend class="sr-only">Answer options' + (q.type === 'MSQ' ? ' (select all that apply)' : ' (select one)') + '</legend>' + optionsHtml + '</fieldset>' +
      '<div id="notice" aria-live="assertive"></div>' + hint + a + feedback + '</article>';

    // side panel
    var mini;
    if (ctx.kind === 'exam') {
      mini = [[st.answered, 'Answered'], [st.total - st.answered, 'Left'], [s.qids.filter(isBookmarked).length, 'Saved']];
    } else {
      mini = [[st.correct, 'Correct'], [st.incorrect, 'Incorrect'], [st.unanswered, ctx.kind === 'review' ? 'Unanswered' : 'Left']];
    }
    var navDots = ctx.list.map(function (id, i) {
      var cls = navStatus(ctx, id);
      var label = 'Question ' + (i + 1) + (cls ? ', ' + cls : '') + (isBookmarked(id) ? ', bookmarked' : '') + (i === ctx.index ? ', current' : '');
      return '<button class="nav-dot ' + cls + (i === ctx.index ? ' current' : '') + (isBookmarked(id) ? ' bm' : '') + '" data-action="goto" data-index="' + i + '" aria-label="' + label + '"' + (i === ctx.index ? ' aria-current="true"' : '') + '>' + (i + 1) + '</button>';
    }).join('');
    var side = '<aside class="side collapsible' + (S.navOpen ? ' open' : '') + '" id="sidePanel" aria-label="Session overview">' +
      '<div class="card"><h3 style="margin-bottom:.75rem">Session</h3><div class="mini-stats">' + mini.map(function (m) { return '<div><b>' + m[0] + '</b><span>' + m[1] + '</span></div>'; }).join('') + '</div>' +
      (ctx.kind === 'review' ? '<div class="segmented" role="group" aria-label="Review filter" style="margin-top:.9rem;width:100%">' +
        [['all', 'All'], ['incorrect', 'Incorrect'], ['unanswered', 'Unanswered']].map(function (f) {
          return '<a href="#/review/' + f[0] + '"' + (ctx.filter === f[0] ? ' aria-current="true"' : '') + '>' + f[1] + '</a>';
        }).join('') + '</div>' : '') +
      '</div>' +
      '<div class="card navigator-card"><div class="section-title" style="margin-bottom:.6rem"><h3 style="margin:0">Questions</h3><span class="muted small">' + n + '</span></div>' +
      '<div class="navigator">' + navDots + '</div>' +
      '<div class="legend" style="margin-top:.8rem">' + (ctx.kind === 'exam'
        ? '<span><i style="background:var(--primary-soft);border:1px solid var(--primary)"></i>Answered</span><span><i style="background:var(--surface-2);border:1px solid var(--border-strong)"></i>Not answered</span>'
        : '<span><i style="background:var(--good)"></i>Correct</span><span><i style="background:var(--bad)"></i>Incorrect</span>') +
      '<span><i style="background:var(--violet);border-radius:50%"></i>Bookmarked</span></div></div></aside>';

    app.innerHTML = '<div class="view">' + top + progress + '<div class="practice-layout">' + card + side + '</div></div>';

    // keep the current question visible in the navigator
    var cur = $('.nav-dot.current', app);
    if (cur && cur.scrollIntoView) {
      var nav = $('.navigator', app);
      if (nav) nav.scrollTop = Math.max(0, cur.offsetTop - nav.offsetTop - 80);
    }
    S.ctx = ctx;
  }

  function currentCtxQuestion() {
    var ctx = S.ctx;
    if (!ctx) return null;
    var qid = ctx.list[ctx.index];
    return { ctx: ctx, q: S.byId.get(qid), qid: qid };
  }

  function focusAfterRender(sel) {
    var el = $(sel, app);
    if (el) el.focus({ preventScroll: false });
  }

  function showNotice(msg) {
    var n = document.getElementById('notice');
    if (n) n.innerHTML = '<div class="notice warn">' + icon('i-alert') + '<span>' + escapeHtml(msg) + '</span></div>';
  }

  function onOptionChange(input) {
    var cur = currentCtxQuestion();
    if (!cur || cur.ctx.kind === 'review') return;
    var s = cur.ctx.session;
    var entry = getEntry(s, cur.qid);
    if (cur.ctx.kind === 'practice' && entry.checked) return; // locked until Try again
    var id = input.value;
    if (cur.q.type === 'MCQ') {
      entry.selected = input.checked ? [id] : [];
    } else {
      var i = entry.selected.indexOf(id);
      if (input.checked && i === -1) entry.selected.push(id);
      if (!input.checked && i !== -1) entry.selected.splice(i, 1);
    }
    entry.skipped = false;
    save();
    // update visuals without re-rendering (keeps focus)
    $all('.option', app).forEach(function (lab) {
      var on = entry.selected.indexOf(lab.getAttribute('data-opt')) !== -1;
      lab.classList.toggle('selected', on);
      var inp = $('input', lab);
      if (inp) inp.checked = on;
    });
    var clearBtn = $('[data-action="clear"]', app);
    if (clearBtn) clearBtn.disabled = !entry.selected.length;
    var n = document.getElementById('notice');
    if (n) n.innerHTML = '';
    if (cur.ctx.kind === 'exam') {
      var dot = $('.nav-dot[data-index="' + cur.ctx.index + '"]', app);
      if (dot) dot.classList.toggle('answered', !!entry.selected.length);
      var st = sessionStats(s, S.byId);
      var mini = $all('.mini-stats b', app);
      if (mini.length >= 2) { mini[0].textContent = st.answered; mini[1].textContent = st.total - st.answered; }
      var countEl = $('.q-progress .count', app);
      if (countEl) countEl.textContent = st.answered + ' / ' + st.total + ' answered';
      var bar = $('.q-progress .progress', app);
      if (bar) { bar.setAttribute('aria-valuenow', pct(st.answered, st.total)); $('span', bar).style.width = pct(st.answered, st.total) + '%'; }
    }
  }

  function toggleOptionByIndex(i) {
    var inputs = $all('#options input', app);
    var inp = inputs[i];
    if (!inp || inp.disabled) return;
    if (inp.type === 'radio') inp.checked = true;
    else inp.checked = !inp.checked;
    onOptionChange(inp);
    inp.focus({ preventScroll: true });
  }

  function doCheck() {
    var cur = currentCtxQuestion();
    if (!cur || cur.ctx.kind !== 'practice') return;
    var s = cur.ctx.session;
    var entry = getEntry(s, cur.qid);
    if (entry.checked) return; // prevents repeated scoring
    if (!entry.selected.length) {
      showNotice(cur.q.type === 'MSQ' ? 'Select one or more options before checking your answer.' : 'Select an option before checking your answer.');
      return;
    }
    var g = gradeSelection(cur.q, entry.selected);
    entry.checked = true;
    entry.correct = g.isCorrect;
    entry.tries = (entry.tries || 0) + 1;
    entry.skipped = false;
    recordAttempt(cur.q, entry.selected, g.isCorrect, s, true);
    save();
    S.justChecked = true;
    renderPractice();
    focusAfterRender('#fbTitle');
  }

  function doRetry() {
    var cur = currentCtxQuestion();
    if (!cur || cur.ctx.kind !== 'practice') return;
    var entry = getEntry(cur.ctx.session, cur.qid);
    if (!entry.checked) return;
    entry.checked = false;
    entry.selected = [];
    save();
    renderPractice();
    var first = $('#options input', app);
    if (first) first.focus();
  }

  function doClear() {
    var cur = currentCtxQuestion();
    if (!cur || cur.ctx.kind === 'review') return;
    var entry = getEntry(cur.ctx.session, cur.qid);
    if (cur.ctx.kind === 'practice' && entry.checked) return;
    entry.selected = [];
    save();
    var first = $('#options input', app);
    $all('#options input', app).forEach(function (inp) { inp.checked = false; });
    $all('.option', app).forEach(function (lab) { lab.classList.remove('selected'); });
    var clearBtn = $('[data-action="clear"]', app);
    if (clearBtn) clearBtn.disabled = true;
    if (cur.ctx.kind === 'exam') renderPractice();
    if (first) first.focus();
  }

  function moveTo(index) {
    var ctx = S.ctx;
    if (!ctx) return;
    if (index < 0 || index >= ctx.list.length) return;
    S.hintOpen = false;
    if (ctx.kind === 'review') {
      S.review.index = index;
      renderReview();
    } else {
      ctx.session.index = index;
      save();
      renderPractice();
    }
    focusAfterRender('#qText');
  }

  function doNext() {
    var ctx = S.ctx;
    if (!ctx) return;
    if (ctx.index < ctx.list.length - 1) moveTo(ctx.index + 1);
    else if (ctx.kind === 'exam') submitExam(false);
    else if (ctx.kind === 'practice') finishPractice();
  }

  function doSkip() {
    var cur = currentCtxQuestion();
    if (!cur || cur.ctx.kind === 'review') return;
    var entry = getEntry(cur.ctx.session, cur.qid);
    if (!entry.checked && !(entry.selected && entry.selected.length)) entry.skipped = true;
    save();
    if (cur.ctx.index < cur.ctx.list.length - 1) moveTo(cur.ctx.index + 1);
    else {
      toast('That was the last question.', 'alert');
      renderPractice();
    }
  }

  /* =====================================================================
     Views — Results
     ===================================================================== */

  function renderResults() {
    var d = store();
    var s = d.lastResult;
    var active = d.session
      ? '<div class="notice info" style="margin-top:0;margin-bottom:1rem">' + icon('i-play') + '<div style="flex:1">Session in progress: <strong>' + escapeHtml(d.session.title) + '</strong></div><a class="btn btn-primary btn-sm" href="#/practice">Resume</a></div>'
      : '';
    if (!s) {
      app.innerHTML = '<div class="view">' + active + '<div class="card empty"><div class="art">' + icon('i-chart') + '</div><h2>No results yet</h2>' +
        '<p>Finish a practice session (press “End session” or “Finish”) or submit an exam to see your score summary here.</p>' +
        '<a class="btn btn-primary" href="#/modes">' + icon('i-play') + 'Start practising</a></div>' + historyHtml() + '</div>';
      return;
    }
    var st = sessionStats(s, S.byId);
    var acc = pct(st.correct, st.attempted);
    var score = pct(st.correct, st.total);
    var verdict = !st.attempted ? 'No answers were checked in this session.'
      : acc >= 85 ? 'Excellent work — you are exam ready on this set.'
        : acc >= 65 ? 'Good progress. Review the misses to lock it in.'
          : 'Keep going: review the explanations and retry the incorrect ones.';

    var topicRows = st.byTopic.map(function (t) {
      var a = pct(t.correct, t.attempted);
      return '<tr><td>' + escapeHtml(t.topic) + ' <span class="muted small">' + escapeHtml(shortCourse(t.course)) + '</span></td><td class="num">' + t.total + '</td><td class="num">' + t.attempted +
        '</td><td class="num">' + t.correct + '</td><td class="num"><div class="acc-cell">' + (t.attempted ? progressBar(a, t.topic + ' accuracy', true) + '<span>' + a + '%</span>' : '<span class="muted">—</span>') + '</div></td></tr>';
    }).join('');

    var order = function (q) { return optionOrder(s, q); };
    var items = s.qids.map(function (id, i) {
      var q = S.byId.get(id);
      var a = s.answers[id];
      var mark = a && a.checked ? (a.correct ? 'g' : 'r') : 'n';
      var label = mark === 'g' ? 'Correct' : mark === 'r' ? 'Incorrect' : 'Unanswered';
      var o = order(q);
      return '<div class="card review-item"><span class="mark ' + mark + '" aria-label="' + label + '">' + icon(mark === 'g' ? 'i-check' : mark === 'r' ? 'i-x' : 'i-skip', 'ic-sm') + '</span>' +
        '<div><div class="row" style="margin-bottom:.3rem">' + typeBadge(q) + '<span class="badge">' + escapeHtml(qTopic(q)) + '</span></div><p><strong>' + (i + 1) + '.</strong> ' + escapeHtml(q.question) + '</p>' +
        '<p class="small muted" style="margin-top:.3rem">Your answer: ' + (a && a.selected && a.selected.length ? listLetters(o, a.selected) : '—') + ' · Correct: ' + listLetters(o, q.correctAnswers) + '</p></div>' +
        '<a class="btn btn-ghost btn-sm" href="#/review/all/' + i + '">Review</a></div>';
    }).join('');

    app.innerHTML = '<div class="view">' + active +
      '<div class="card result-hero">' + ringSvg(score, score + '%', 'score', 168, 9) +
      '<div><div class="eyebrow muted small" style="font-weight:700;letter-spacing:.06em;text-transform:uppercase">' + (s.exam ? 'Exam results' : 'Session results') + ' · ' + new Date(s.finishedAt || Date.now()).toLocaleString() + '</div>' +
      '<h1>' + escapeHtml(s.title) + '</h1><p class="muted">' + verdict + '</p>' +
      '<div class="result-grid">' +
      cell(st.correct + ' / ' + st.total, 'Score') + cell(st.attempted, 'Attempted') + cell(st.correct, 'Correct') + cell(st.incorrect, 'Incorrect') +
      cell(st.attempted ? acc + '%' : '—', 'Accuracy') +
      cell(st.byType.MSQ.attempted ? pct(st.byType.MSQ.correct, st.byType.MSQ.attempted) + '%' : '—', 'MSQ accuracy (' + st.byType.MSQ.correct + '/' + st.byType.MSQ.attempted + ')') +
      cell(st.byType.MCQ.attempted ? pct(st.byType.MCQ.correct, st.byType.MCQ.attempted) + '%' : '—', 'MCQ accuracy (' + st.byType.MCQ.correct + '/' + st.byType.MCQ.attempted + ')') +
      cell(humanDuration(s.elapsed), 'Time taken') + cell(st.unanswered, 'Unanswered') +
      '</div>' +
      '<div class="row" style="margin-top:1.1rem">' +
      '<a class="btn btn-primary" href="#/review/incorrect"' + (st.incorrect ? '' : ' aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"') + '>' + icon('i-eye') + 'Review incorrect</a>' +
      '<button class="btn btn-gradient" data-action="retry-incorrect"' + (st.incorrect ? '' : ' disabled') + '>' + icon('i-refresh') + 'Retry incorrect</button>' +
      '<button class="btn btn-ghost" data-action="restart">' + icon('i-play') + 'Restart quiz</button>' +
      '<a class="btn btn-ghost" href="#/dashboard">' + icon('i-home') + 'Dashboard</a></div></div></div>' +
      '<section class="section"><div class="card"><div class="section-title"><h2>Topic-wise accuracy</h2></div><div class="table-wrap"><table class="data"><thead><tr><th>Topic</th><th class="num">Questions</th><th class="num">Attempted</th><th class="num">Correct</th><th class="num">Accuracy</th></tr></thead><tbody>' + topicRows + '</tbody></table></div></div></section>' +
      '<section class="section"><div class="section-title"><h2>Question by question</h2><a class="btn btn-ghost btn-sm" href="#/review/all">' + icon('i-eye', 'ic-sm') + 'Review all</a></div><div class="review-list">' + items + '</div></section>' +
      historyHtml() + '</div>';

    function cell(v, l) { return '<div class="cell"><b>' + v + '</b><span>' + l + '</span></div>'; }
  }

  function historyHtml() {
    var h = store().history;
    if (!h.length) return '';
    return '<section class="section"><div class="card"><div class="section-title"><h2>Recent sessions</h2></div><div class="table-wrap"><table class="data"><thead><tr><th>Session</th><th>When</th><th class="num">Score</th><th class="num">Accuracy</th><th class="num">Time</th></tr></thead><tbody>' +
      h.map(function (x) {
        return '<tr><td>' + (x.exam ? icon('i-flag', 'ic-sm') + ' ' : '') + escapeHtml(x.title) + '</td><td class="muted">' + timeAgo(x.t) + '</td><td class="num">' + x.correct + ' / ' + x.total +
          '</td><td class="num">' + (x.attempted ? pct(x.correct, x.attempted) + '%' : '—') + '</td><td class="num">' + humanDuration(x.elapsed) + '</td></tr>';
      }).join('') + '</tbody></table></div></div></section>';
  }

  /* =====================================================================
     Views — Question bank (browse, search, answer key)
     ===================================================================== */

  function searchTokens(q) {
    return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function questionHaystack(q) {
    if (!q._hay) {
      q._hay = [q.id, q.question, qTopic(q), qCourse(q), q.type, q.difficulty || '', q.tag || '', q.explanation]
        .concat(q.options.map(function (o) { return o.text; })).join(' \n ').toLowerCase();
    }
    return q._hay;
  }

  function browseResults() {
    var b = S.browse;
    var tokens = searchTokens(b.q);
    var d = store();
    return S.bank.filter(function (q) {
      if (b.course && qCourse(q) !== b.course) return false;
      if (b.topic && topicKey(q) !== b.topic) return false;
      if (b.type && q.type !== b.type) return false;
      if (b.difficulty && q.difficulty !== b.difficulty) return false;
      if (b.status) {
        var a = d.attempts[q.id];
        if (b.status === 'new' && a) return false;
        if (b.status === 'correct' && !(a && a.status === 'correct')) return false;
        if (b.status === 'incorrect' && !(a && a.status === 'incorrect')) return false;
        if (b.status === 'bookmarked' && !isBookmarked(q.id)) return false;
      }
      if (tokens.length) {
        var hay = questionHaystack(q);
        for (var i = 0; i < tokens.length; i++) if (hay.indexOf(tokens[i]) === -1) return false;
      }
      return true;
    });
  }

  function highlight(text, tokens) {
    var t = String(text);
    if (!tokens.length) return escapeHtml(t);
    var re = new RegExp('(' + tokens.map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
    return t.split(re).map(function (part, i) { return i % 2 ? '<mark>' + escapeHtml(part) + '</mark>' : escapeHtml(part); }).join('');
  }

  function renderBrowse() {
    var b = S.browse;
    function sel(key, label, options) {
      return '<div class="field"><label for="bf-' + key + '">' + label + '</label><select class="select" id="bf-' + key + '" data-change="browse" data-key="' + key + '">' +
        options.map(function (o) { return '<option value="' + escapeHtml(o[0]) + '"' + (b[key] === o[0] ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>'; }).join('') + '</select></div>';
    }
    var topicOpts = [['', 'All topics']].concat(S.topics.filter(function (t) { return !b.course || t.course === b.course; }).map(function (t) {
      return [t.key, (S.courses.length > 1 && !b.course ? shortCourse(t.course) + ' · ' : '') + t.topic];
    }));
    app.innerHTML = '<div class="view">' +
      '<div class="page-head"><div><h1>Question bank</h1><p>Search, filter and open the answer key for any question.</p></div></div>' +
      '<div class="card"><div class="filters">' +
      '<div class="field field-search"><label for="bf-q">Search</label><div class="search-wrap">' + icon('i-search') +
      '<input class="input" id="bf-q" type="search" placeholder="Keywords, e.g. Kraljic, SLA, Deming…" value="' + escapeHtml(b.q) + '" data-input="browse-q" autocomplete="off"></div></div>' +
      sel('course', 'Course', [['', 'All courses']].concat(S.courses.map(function (c) { return [c, c]; }))) +
      sel('topic', 'Topic', topicOpts) +
      sel('type', 'Type', [['', 'MSQ & MCQ'], ['MSQ', 'MSQ only'], ['MCQ', 'MCQ only']]) +
      sel('difficulty', 'Difficulty', [['', 'Any'], ['Easy', 'Easy'], ['Medium', 'Medium'], ['Hard', 'Hard']]) +
      sel('status', 'Status', [['', 'Any status'], ['new', 'Not attempted'], ['correct', 'Correct'], ['incorrect', 'Incorrect'], ['bookmarked', 'Bookmarked']]) +
      '</div></div>' +
      '<div id="browseList"></div></div>';
    renderBrowseList();
  }

  function renderBrowseList() {
    var box = document.getElementById('browseList');
    if (!box) return;
    var b = S.browse;
    var res = browseResults();
    var tokens = searchTokens(b.q);
    var d = store();
    var anyFilter = b.q || b.course || b.topic || b.type || b.difficulty || b.status;
    var head = '<div class="results-bar" role="status"><span><strong>' + res.length + '</strong> of ' + S.bank.length + ' questions</span>' +
      (anyFilter ? '<button class="btn btn-ghost btn-sm" data-action="browse-reset">' + icon('i-x', 'ic-sm') + 'Clear filters</button>' : '') +
      '<span class="spacer"></span>' +
      (res.length ? '<button class="btn btn-ghost btn-sm" data-action="browse-reveal-all">' + icon('i-eye', 'ic-sm') + 'Show all answers</button>' +
        '<button class="btn btn-primary btn-sm" data-action="practice-filtered">' + icon('i-play', 'ic-sm') + 'Practise these ' + res.length + '</button>' : '') + '</div>';
    if (!res.length) {
      box.innerHTML = head + '<div class="card empty" style="margin-top:1rem"><div class="art">' + icon('i-search') + '</div><h2>No matching questions</h2>' +
        '<p>Try fewer keywords or remove a filter.</p>' + (anyFilter ? '<button class="btn btn-primary" data-action="browse-reset">Clear filters</button>' : '') + '</div>';
      return;
    }
    var shown = res.slice(0, b.limit);
    box.innerHTML = head + '<div class="bank-list">' + shown.map(function (q) {
      var open = !!b.open[q.id];
      var a = d.attempts[q.id];
      var status = a ? (a.status === 'correct' ? '<span class="badge badge-good">' + icon('i-check', 'ic-sm') + 'Correct</span>' : '<span class="badge badge-bad">' + icon('i-x', 'ic-sm') + 'Incorrect</span>') : '<span class="badge">New</span>';
      var bm = isBookmarked(q.id);
      var oe = q.optionExplanations || {};
      return '<article class="card bank-item' + (open ? ' open' : '') + '" aria-labelledby="bq-' + escapeHtml(q.id) + '">' +
        '<div class="row">' + typeBadge(q) + diffBadge(q) + topicBadges(q) + status + '<span class="spacer"></span><span class="muted small">' + escapeHtml(q.id) + '</span>' +
        '<button class="icon-btn" data-action="bank-bookmark" data-id="' + escapeHtml(q.id) + '" aria-pressed="' + bm + '" aria-label="' + (bm ? 'Remove bookmark' : 'Bookmark') + '">' + icon('i-bookmark') + '</button></div>' +
        '<p class="bank-q" id="bq-' + escapeHtml(q.id) + '">' + highlight(q.question, tokens) + '</p>' +
        '<ol>' + q.options.map(function (o) {
          return '<li class="' + (q.correctAnswers.indexOf(o.id) !== -1 ? 'ans' : '') + '"><span class="k">' + escapeHtml(o.id) + '</span><span>' + highlight(o.text, tokens) +
            (open && q.correctAnswers.indexOf(o.id) !== -1 ? ' <span class="sr-only">(correct)</span>' : '') + '</span></li>';
        }).join('') + '</ol>' +
        '<div class="row"><button class="btn btn-ghost btn-sm" data-action="bank-toggle" data-id="' + escapeHtml(q.id) + '" aria-expanded="' + open + '">' + icon('i-eye', 'ic-sm') + (open ? 'Hide answer' : 'Show answer') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-action="bank-practice" data-id="' + escapeHtml(q.id) + '">' + icon('i-play', 'ic-sm') + 'Practise</button></div>' +
        '<div class="ans-panel"><p><strong>Correct answer: ' + escapeHtml(q.correctAnswers.join(', ')) + '</strong></p>' +
        (Object.keys(oe).length ? '<dl>' + q.options.map(function (o) { return oe[o.id] ? '<div><dt>' + escapeHtml(o.id) + ':</dt> <dd>' + escapeHtml(oe[o.id]) + '</dd></div>' : ''; }).join('') + '</dl>' : '<p>' + escapeHtml(q.explanation) + '</p>') +
        (sourceText(q) ? '<p class="fb-source">' + icon('i-file', 'ic-sm') + escapeHtml(sourceText(q)) + '</p>' : '') + '</div></article>';
    }).join('') + '</div>' +
      (res.length > shown.length ? '<div class="row" style="justify-content:center;margin-top:1rem"><button class="btn btn-ghost" data-action="browse-more">Show more (' + (res.length - shown.length) + ' left)</button></div>' : '');
  }

  /* =====================================================================
     Views — Slides & Quick Revision
     ===================================================================== */

  /** Minimal rich text for summaries: **bold**, *italic*, with search highlighting. Input is escaped. */
  function richText(text, tokens) {
    return String(text).split('**').map(function (part, i) {
      var inner = part.split('*').map(function (p, j) {
        return j % 2 ? '<em>' + highlight(p, tokens) + '</em>' : highlight(p, tokens);
      }).join('');
      return i % 2 ? '<strong>' + inner + '</strong>' : inner;
    }).join('');
  }

  function plain(text) { return String(text).replace(/\*/g, ''); }

  function sectionHaystack(sec) {
    var parts = [sec.title, sec.topic || '', sec.tip || ''].concat(sec.points || []);
    if (sec.table) {
      parts.push(sec.table.caption || '');
      parts = parts.concat(sec.table.head || []);
      (sec.table.rows || []).forEach(function (r) { parts = parts.concat(r); });
    }
    return plain(parts.join(' \n ')).toLowerCase();
  }

  function matchesTokens(hay, tokens) {
    for (var i = 0; i < tokens.length; i++) if (hay.indexOf(tokens[i]) === -1) return false;
    return true;
  }

  function pageLabel(p) { return p[0] === p[1] ? 'PDF p.' + p[0] : 'PDF p.' + p[0] + '–' + p[1]; }

  function deckProgress(deck) {
    var done = deck.sections.filter(function (s) { return store().revised[s.id]; }).length;
    return { done: done, total: deck.sections.length };
  }

  function loadRevision() {
    if (S.revLoading) return;
    S.revLoading = true;
    fetch(REVISION_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' while loading ' + REVISION_URL);
        return res.text();
      })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); } catch (e) { throw new Error('revision.json is not valid JSON: ' + e.message); }
        if (!json || !Array.isArray(json.decks) || !json.decks.length) throw new Error('revision.json has no "decks".');
        json.decks.forEach(function (d) {
          if (!d.id || !d.title || !d.file || !Array.isArray(d.sections)) throw new Error('A deck in revision.json is missing id, title, file or sections.');
          d.formulas = d.formulas || [];
          d.concepts = d.concepts || [];
        });
        S.rev = json;
        S.revError = null;
      })
      .catch(function (err) { S.revError = err; })
      .then(function () {
        S.revLoading = false;
        if (S.route.name === 'revision') renderRevision();
      });
  }

  function renderRevision() {
    if (S.revError) {
      app.innerHTML = '<div class="view"><div class="card error-card" role="alert"><div class="row">' + icon('i-alert', 'ic-lg') + '<h2 style="margin:0">Revision notes could not be loaded</h2></div>' +
        '<p style="margin-top:1rem">Check that <code>' + REVISION_URL + '</code> exists and contains valid JSON. Practice and the question bank still work.</p>' +
        '<details class="disclosure"><summary>Technical details</summary><pre>' + escapeHtml(S.revError.message || String(S.revError)) + '</pre></details>' +
        '<button class="btn btn-primary" data-action="rev-retry">' + icon('i-refresh') + 'Try again</button></div></div>';
      return;
    }
    if (!S.rev) {
      app.innerHTML = '<div class="view"><div class="page-head"><div><h1>Slides &amp; Quick Revision</h1><p>Loading revision notes…</p></div></div>' +
        '<div class="grid grid-2"><div class="card skeleton" style="height:220px"></div><div class="card skeleton" style="height:220px"></div></div></div>';
      loadRevision();
      return;
    }
    var decks = S.rev.decks;
    var params = S.route.params;
    var wanted = params[0] || S.revDeck;
    var deck = decks.filter(function (d) { return d.id === wanted; })[0] || decks[0];
    S.revDeck = deck.id;
    // The open PDF lives in the URL (#/revision/qm/view/23) so a refresh restores the same view.
    S.revViewer = params[1] === 'view'
      ? { deck: deck.id, page: Math.min(deck.pdfPages || 999, Math.max(1, Number(params[2]) || 1)) }
      : null;
    S.revSplit = !!S.revViewer && isWideScreen();
    document.body.classList.toggle('rev-split', S.revSplit);
    document.body.classList.toggle('rev-sheet-open', !!S.revViewer && !S.revSplit);
    if (S.revSplit) { renderRevisionWorkspace(deck); return; }

    var cards = decks.map(function (d) {
      var pr = deckProgress(d);
      var active = d.id === deck.id;
      return '<article class="deck-card accent-' + escapeHtml(d.accent || 'violet') + (active ? ' active' : '') + '" aria-labelledby="deck-' + d.id + '">' +
        '<div class="deck-top"><div class="deck-icon">' + icon('i-slides', 'ic-lg') + '</div>' +
        '<div class="deck-titles"><h2 id="deck-' + d.id + '">' + escapeHtml(d.title) + '</h2><p>' + escapeHtml(d.subtitle || '') + '</p></div></div>' +
        '<div class="deck-meta"><span>' + icon('i-file', 'ic-sm') + d.pdfPages + ' pages</span><span>' + icon('i-list', 'ic-sm') + d.sections.length + ' summaries</span>' +
        '<span>' + icon('i-sigma', 'ic-sm') + d.formulas.length + ' formulas</span><span>' + icon('i-clock', 'ic-sm') + escapeHtml(d.date || '') + '</span></div>' +
        '<div class="deck-progress"><div class="row" style="justify-content:space-between"><span class="small">Revised</span><span class="small" id="revProg-' + d.id + '"><strong>' + pr.done + '</strong> / ' + pr.total + '</span></div>' +
        progressBar(pct(pr.done, pr.total), d.title + ' sections revised', true) + '</div>' +
        '<div class="deck-actions">' +
        (active ? '<span class="btn btn-sm deck-current">' + icon('i-check', 'ic-sm') + 'Showing below</span>'
          : '<a class="btn btn-primary btn-sm" href="#/revision/' + d.id + '">' + icon('i-book', 'ic-sm') + 'Revise this deck</a>') +
        '<button class="btn btn-ghost btn-sm" data-action="rev-view" data-deck="' + d.id + '" data-page="1">' + icon('i-eye', 'ic-sm') + 'View PDF</button>' +
        '<a class="btn btn-ghost btn-sm" href="' + escapeHtml(d.file) + '" download="' + escapeHtml(d.downloadName || '') + '">' + icon('i-download', 'ic-sm') + 'Download</a>' +
        '</div></article>';
    }).join('');

    // no entry animation when the sheet is open: a transform on an ancestor would trap the fixed sheet
    app.innerHTML = '<div class="view' + (S.revViewer ? ' no-anim' : '') + '">' +
      '<div class="page-head"><div><h1>Slides &amp; Quick Revision</h1><p>Read the lecture decks, then revise from exam-focused summaries, key concepts and formulas. On a wide screen, “View PDF” opens the slides beside the notes.</p></div></div>' +
      '<div class="grid grid-2 deck-grid">' + cards + '</div>' +
      '<div class="rev-toolbar card">' + revTabs(deck) + revSearchAndTools() + '</div>' +
      '<div id="revBody"></div>' +
      (S.revViewer ? '<div class="rev-sheet" role="dialog" aria-modal="true" aria-label="' + escapeHtml(deck.title) + ' slides"><div id="revViewer"></div></div>' : '') +
      '</div>';
    renderRevisionViewer();
    renderRevisionBody();
    if (S.revViewer) { var c = $('#revViewer [data-action="rev-close-viewer"]', app); if (c) c.focus(); }
  }

  /* ----- split workspace: notes beside a 60% PDF panel ----- */

  var SPLIT_KEY = 'qmvm-rev-split';
  var SPLIT_DEFAULT = 60, SPLIT_MIN = 35, SPLIT_MAX = 75;

  function isWideScreen() { return window.matchMedia ? window.matchMedia('(min-width: 1000px)').matches : window.innerWidth >= 1000; }

  function getSplit() {
    var v = NaN;
    try { v = Number(window.localStorage.getItem(SPLIT_KEY)); } catch (e) { /* storage blocked */ }
    return v >= SPLIT_MIN && v <= SPLIT_MAX ? v : SPLIT_DEFAULT;
  }
  function setSplit(v, persist) {
    v = Math.round(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, v)));
    var ws = $('.rev-workspace', app);
    if (ws) ws.style.setProperty('--split', v + '%');
    var div = $('.ws-divider', app);
    if (div) { div.setAttribute('aria-valuenow', String(v)); div.setAttribute('aria-valuetext', 'Slides panel ' + v + '% of the width'); }
    if (persist) { try { window.localStorage.setItem(SPLIT_KEY, String(v)); } catch (e) { /* storage blocked */ } }
    return v;
  }

  function revHash(deckId, page) { return '#/revision/' + deckId + (page ? '/view/' + page : ''); }
  /** Update the URL without triggering a re-render (keeps the notes' scroll position). */
  function setRevHash(h) {
    if (location.hash !== h) {
      try { history.replaceState(null, '', h); } catch (e) { location.hash = h; return; }
    }
    S.route = parseHash();
  }

  function revTabs(deck) {
    return '<div class="segmented rev-tabs" role="tablist" aria-label="Choose a deck">' + S.rev.decks.map(function (d) {
      return '<a role="tab" href="' + revHash(d.id, S.revSplit ? 1 : 0) + '"' + (d.id === deck.id ? ' aria-current="true" aria-selected="true"' : ' aria-selected="false"') + '>' + escapeHtml(d.title) + '</a>';
    }).join('') + '</div>';
  }

  function revSearchAndTools() {
    return '<div class="search-wrap rev-search">' + icon('i-search') + '<input class="input" id="revQ" type="search" placeholder="Search notes, e.g. ZOPA, DMAIC, carve-out…" value="' + escapeHtml(S.revQ) + '" data-input="rev-q" autocomplete="off" aria-label="Search revision notes"></div>' +
      '<div class="row rev-tools"><button class="btn btn-ghost btn-sm" data-action="rev-expand">' + icon('i-chevron', 'ic-sm') + 'Expand all</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="rev-collapse">' + icon('i-list', 'ic-sm') + 'Collapse all</button></div>';
  }

  function sizeWorkspace() {
    var ws = $('.rev-workspace', app);
    if (!ws) return;
    var top = document.querySelector('.topbar');
    var h = window.innerHeight - (top ? top.offsetHeight : 64) - 24;
    ws.style.height = Math.max(420, h) + 'px';
  }

  function renderRevisionWorkspace(deck) {
    var pr = deckProgress(deck);
    app.innerHTML = '<div class="view rev-workspace accent-' + escapeHtml(deck.accent || 'violet') + '" style="--split:' + getSplit() + '%">' +
      '<div class="card ws-bar">' +
      '<div class="ws-deck"><span class="deck-icon sm">' + icon('i-slides') + '</span><div><strong>Study mode</strong><span class="small muted">Notes + slides side by side</span></div></div>' +
      revTabs(deck) + revSearchAndTools() +
      '<div class="deck-progress ws-prog" title="Sections marked as revised"><span class="small">Revised <span id="revProg-' + deck.id + '"><strong>' + pr.done + '</strong> / ' + pr.total + '</span></span>' +
      progressBar(pct(pr.done, pr.total), deck.title + ' sections revised', true) + '</div>' +
      '</div>' +
      '<div class="ws-panes">' +
      '<section class="ws-notes" id="revNotesPane" aria-label="' + escapeHtml(deck.title) + ' notes" tabindex="-1"><div id="revBody"></div></section>' +
      '<div class="ws-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize slides panel (arrow keys)" aria-valuemin="' + SPLIT_MIN + '" aria-valuemax="' + SPLIT_MAX + '" aria-valuenow="' + getSplit() + '" title="Drag to resize · double-click to reset"><span></span></div>' +
      '<section class="ws-pdf" aria-label="Slides"><div id="revViewer"></div></section>' +
      '</div></div>';
    sizeWorkspace();
    setSplit(getSplit(), false);
    bindDivider();
    renderRevisionViewer();
    renderRevisionBody();
  }

  function bindDivider() {
    var div = $('.ws-divider', app);
    var panes = $('.ws-panes', app);
    if (!div || !panes) return;
    div.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var ws = $('.rev-workspace', app);
      ws.classList.add('dragging');
      try { div.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      var move = function (ev) {
        var r = panes.getBoundingClientRect();
        setSplit(((r.right - ev.clientX) / r.width) * 100, false);
      };
      var up = function () {
        ws.classList.remove('dragging');
        div.removeEventListener('pointermove', move);
        div.removeEventListener('pointerup', up);
        div.removeEventListener('pointercancel', up);
        setSplit(Number(div.getAttribute('aria-valuenow')), true);
      };
      div.addEventListener('pointermove', move);
      div.addEventListener('pointerup', up);
      div.addEventListener('pointercancel', up);
    });
    div.addEventListener('dblclick', function () { setSplit(SPLIT_DEFAULT, true); });
    div.addEventListener('keydown', function (e) {
      var v = Number(div.getAttribute('aria-valuenow'));
      if (e.key === 'ArrowLeft') v += 5;        // divider moves left → slides get wider
      else if (e.key === 'ArrowRight') v -= 5;
      else if (e.key === 'Home') v = SPLIT_MAX;
      else if (e.key === 'End') v = SPLIT_MIN;
      else return;
      e.preventDefault();
      setSplit(v, true);
    });
  }

  function currentDeck() {
    if (!S.rev) return null;
    return S.rev.decks.filter(function (d) { return d.id === S.revDeck; })[0] || S.rev.decks[0];
  }

  function renderRevisionViewer() {
    var box = document.getElementById('revViewer');
    if (!box) return;
    var v = S.revViewer;
    if (!v) { box.innerHTML = ''; return; }
    var deck = S.rev.decks.filter(function (d) { return d.id === v.deck; })[0];
    if (!deck) { box.innerHTML = ''; return; }
    var src = deck.file + '#page=' + v.page + '&view=FitH&navpanes=0';
    // A fresh iframe each time so the PDF really jumps to the new page.
    box.innerHTML = '<section class="viewer accent-' + escapeHtml(deck.accent || 'violet') + '" aria-label="PDF viewer">' +
      '<div class="viewer-bar"><div class="viewer-title">' + icon('i-slides') + '<div><strong>' + escapeHtml(deck.title) + '</strong><span class="small muted" id="viewerPage"> · PDF page ' + v.page + ' of ' + (deck.pdfPages || '?') + '</span></div></div>' +
      '<div class="row viewer-actions">' +
      '<button class="btn btn-ghost btn-sm" data-action="rev-page" data-delta="-1" aria-label="Previous page"' + (v.page <= 1 ? ' disabled' : '') + '>' + icon('i-left', 'ic-sm') + '</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="rev-page" data-delta="1" aria-label="Next page"' + (deck.pdfPages && v.page >= deck.pdfPages ? ' disabled' : '') + '>' + icon('i-right', 'ic-sm') + '</button>' +
      '<a class="btn btn-ghost btn-sm" href="' + escapeHtml(src) + '" target="_blank" rel="noopener" title="Open in new tab">' + icon('i-external', 'ic-sm') + '<span class="lbl">New tab</span></a>' +
      '<a class="btn btn-ghost btn-sm" href="' + escapeHtml(deck.file) + '" download="' + escapeHtml(deck.downloadName || '') + '" title="Download PDF">' + icon('i-download', 'ic-sm') + '<span class="lbl">Download</span></a>' +
      '<button class="btn btn-soft btn-sm" data-action="rev-close-viewer">' + icon('i-x', 'ic-sm') + (S.revSplit ? 'Exit study mode' : 'Close') + '</button></div></div>' +
      '<div class="viewer-frame"><iframe title="' + escapeHtml(deck.title) + ' slides, page ' + v.page + '" src="' + escapeHtml(src) + '"></iframe></div>' +
      (S.revSplit ? '' : '<p class="viewer-note small muted">' + icon('i-alert', 'ic-sm') + ' Some phones cannot show PDFs inside a page. If the slides don’t appear, use “New tab” or “Download”.</p>') +
      '</section>';
    markViewingSection();
  }

  /** Highlight the note section whose pages contain the PDF page being shown. */
  function markViewingSection() {
    var deck = currentDeck();
    var page = S.revViewer && S.revViewer.page;
    $all('.rev-section', app).forEach(function (el) { el.classList.remove('is-viewing'); });
    if (!deck || !page) return;
    deck.sections.forEach(function (s) {
      if (page >= s.pages[0] && page <= s.pages[1]) {
        var el = document.getElementById(s.id);
        if (el) el.classList.add('is-viewing');
      }
    });
  }

  /** Show a PDF page: swap only the iframe when the viewer is already open, otherwise switch layout. */
  function showRevisionPage(deckId, page, fromSection) {
    if (deckId !== S.revDeck) { navigate('revision/' + deckId + '/view/' + page); return; }
    var wasOpen = !!S.revViewer;
    setRevHash(revHash(deckId, page));
    if (wasOpen) {
      S.revViewer.page = page;
      renderRevisionViewer();
      return;
    }
    renderRevision();
    if (fromSection) {
      var sec = document.getElementById(fromSection);
      if (sec && S.revSplit) sec.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    if (!S.revSplit) return;
    window.scrollTo(0, 0);
  }

  function closeRevisionViewer() {
    var focusSec = null;
    var viewing = $('.rev-section.is-viewing', app);
    if (viewing) focusSec = viewing.id;
    setRevHash(revHash(S.revDeck, 0));
    renderRevision();
    var target = focusSec && document.getElementById(focusSec);
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      var btn = $('[data-action="rev-view"]', target);
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  function renderRevisionBody() {
    var box = document.getElementById('revBody');
    var deck = currentDeck();
    if (!box || !deck) return;
    var tokens = searchTokens(S.revQ);
    var revised = store().revised;
    var topicCount = {};
    S.topics.forEach(function (t) { topicCount[t.key] = t.count; });

    var sections = deck.sections.map(function (sec, i) { return { sec: sec, n: i + 1, match: !tokens.length || matchesTokens(sectionHaystack(sec), tokens) }; });
    var shown = sections.filter(function (x) { return x.match; });
    var formulas = deck.formulas.filter(function (f) { return !tokens.length || matchesTokens(plain(f.name + ' ' + f.expr + ' ' + (f.example || '')).toLowerCase(), tokens); });
    var concepts = deck.concepts.filter(function (c) { return !tokens.length || matchesTokens((c.term + ' ' + c.def).toLowerCase(), tokens); });
    var overviewMatch = !tokens.length || matchesTokens(plain(deck.overview || '').toLowerCase(), tokens);

    // table of contents
    var toc = '<nav class="card toc" aria-label="' + escapeHtml(deck.title) + ' contents"><div class="toc-head"><h3>Contents</h3><span class="small muted">' + deckProgress(deck).done + '/' + deck.sections.length + ' revised</span></div><ol>' +
      (overviewMatch ? '<li><button data-action="rev-jump" data-target="rev-overview">' + icon('i-sparkles', 'ic-sm') + '<span>Overview</span></button></li>' : '') +
      shown.map(function (x) {
        var done = !!revised[x.sec.id];
        return '<li><button data-action="rev-jump" data-target="' + escapeHtml(x.sec.id) + '"' + (done ? ' class="done"' : '') + '><span class="toc-n">' + (done ? icon('i-check', 'ic-sm') : x.n) + '</span><span>' + escapeHtml(x.sec.title) + '</span></button></li>';
      }).join('') +
      (formulas.length ? '<li><button data-action="rev-jump" data-target="rev-formulas">' + icon('i-sigma', 'ic-sm') + '<span>Formulas &amp; numbers</span></button></li>' : '') +
      (concepts.length ? '<li><button data-action="rev-jump" data-target="rev-concepts">' + icon('i-bulb', 'ic-sm') + '<span>Key concepts</span></button></li>' : '') +
      '</ol></nav>';

    var hits = shown.length + formulas.length + concepts.length + (overviewMatch && tokens.length ? 1 : 0);
    var searchBar = tokens.length
      ? '<div class="results-bar" role="status"><span><strong>' + hits + '</strong> match' + (hits === 1 ? '' : 'es') + ' for “' + escapeHtml(S.revQ) + '” in ' + escapeHtml(deck.title) + '</span><button class="btn btn-ghost btn-sm" data-action="rev-clear-search">' + icon('i-x', 'ic-sm') + 'Clear search</button></div>'
      : '';

    var overview = overviewMatch ? '<section class="card rev-overview accent-' + escapeHtml(deck.accent || 'violet') + '" id="rev-overview">' +
      '<div class="eyebrow">' + icon('i-sparkles', 'ic-sm') + 'The big idea</div><p>' + richText(deck.overview || '', tokens) + '</p>' +
      '<div class="row small"><span>' + icon('i-file', 'ic-sm') + ' ' + escapeHtml(deck.lecturer || '') + '</span><span class="muted">·</span><span>' + escapeHtml(deck.date || '') + '</span></div></section>' : '';

    var secHtml = shown.map(function (x) {
      var sec = x.sec;
      var done = !!revised[sec.id];
      var open = tokens.length ? true : !S.revClosed[sec.id];
      var key = deck.course + '||' + sec.topic;
      var qCount = topicCount[key] || 0;
      var table = '';
      if (sec.table && sec.table.rows && sec.table.rows.length) {
        table = '<div class="table-wrap rev-table"><table class="data"><caption>' + escapeHtml(sec.table.caption || '') + '</caption><thead><tr>' +
          sec.table.head.map(function (h) { return '<th scope="col">' + escapeHtml(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          sec.table.rows.map(function (r) { return '<tr>' + r.map(function (c, ci) { return ci === 0 ? '<th scope="row">' + richText(c, tokens) + '</th>' : '<td>' + richText(c, tokens) + '</td>'; }).join('') + '</tr>'; }).join('') +
          '</tbody></table></div>';
      }
      return '<details class="card rev-section' + (done ? ' is-done' : '') + '" id="' + escapeHtml(sec.id) + '" data-sec="' + escapeHtml(sec.id) + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="sec-n">' + x.n + '</span><span class="sec-title">' + richText(sec.title, tokens) + '</span>' +
        '<span class="sec-chips"><span class="badge">' + pageLabel(sec.pages) + '</span>' + (done ? '<span class="badge badge-good">' + icon('i-check', 'ic-sm') + 'Revised</span>' : '') + '</span>' +
        '<svg class="ic chev" aria-hidden="true"><use href="#i-chevron"/></svg></summary>' +
        '<div class="sec-body"><div class="sec-actions">' +
        '<button class="btn btn-soft btn-sm" data-action="rev-view" data-deck="' + deck.id + '" data-page="' + sec.pages[0] + '" data-sec="' + escapeHtml(sec.id) + '">' + icon('i-eye', 'ic-sm') + (S.revViewer ? 'Show in slides' : 'View slides') + ' (' + pageLabel(sec.pages) + ')</button>' +
        (qCount ? '<button class="btn btn-ghost btn-sm" data-action="rev-practice" data-topic="' + escapeHtml(key) + '">' + icon('i-play', 'ic-sm') + 'Practise ' + qCount + ' questions</button>' : '') +
        '<button class="btn btn-sm ' + (done ? 'btn-good' : 'btn-ghost') + '" data-action="rev-toggle" data-sec="' + escapeHtml(sec.id) + '" aria-pressed="' + done + '">' + icon(done ? 'i-check-circle' : 'i-check', 'ic-sm') + (done ? 'Revised' : 'Mark as revised') + '</button></div>' +
        '<ul class="points">' + (sec.points || []).map(function (p) { return '<li>' + richText(p, tokens) + '</li>'; }).join('') + '</ul>' + table +
        (sec.tip ? '<div class="rev-tip">' + icon('i-alert') + '<div><strong>Exam trap</strong><p>' + richText(sec.tip, tokens) + '</p></div></div>' : '') +
        '</div></details>';
    }).join('');

    var numbers = '';
    var numTable = deck.dpmo ? { title: 'DPMO by sigma level (1.5σ shift)', rows: deck.dpmo } : deck.downtime ? { title: 'Allowed downtime per 30-day month', rows: deck.downtime } : null;
    if (numTable && !tokens.length) {
      numbers = '<div class="num-strip" role="table" aria-label="' + escapeHtml(numTable.title) + '"><div class="num-strip-title" role="caption">' + escapeHtml(numTable.title) + '</div><div class="num-cells">' +
        numTable.rows.map(function (r) { return '<div class="num-cell" role="row"><span role="cell">' + escapeHtml(r[0]) + '</span><b role="cell">' + escapeHtml(r[1]) + '</b></div>'; }).join('') + '</div></div>';
    }
    var formulaHtml = formulas.length ? '<section class="rev-block" id="rev-formulas"><div class="section-title"><h2>' + icon('i-sigma') + ' Formulas &amp; numbers</h2></div>' + numbers +
      '<div class="formula-grid">' + formulas.map(function (f) {
        return '<div class="card formula"><div class="f-name">' + highlight(f.name, tokens) + '</div><div class="f-expr">' + highlight(f.expr, tokens) + '</div>' +
          (f.example ? '<div class="f-ex"><span>Example</span>' + highlight(f.example, tokens) + '</div>' : '') + '</div>';
      }).join('') + '</div></section>' : '';

    var conceptHtml = concepts.length ? '<section class="rev-block" id="rev-concepts"><div class="section-title"><h2>' + icon('i-bulb') + ' Key concepts</h2></div><dl class="concept-grid">' +
      concepts.map(function (c) { return '<div class="concept"><dt>' + highlight(c.term, tokens) + '</dt><dd>' + highlight(c.def, tokens) + '</dd></div>'; }).join('') + '</dl></section>' : '';

    var empty = tokens.length && !hits
      ? '<div class="card empty"><div class="art">' + icon('i-search') + '</div><h2>No notes match</h2><p>Try another keyword, or switch decks — the search covers the deck shown.</p><button class="btn btn-primary" data-action="rev-clear-search">Clear search</button></div>'
      : '';

    box.innerHTML = searchBar + '<div class="rev-layout' + (S.revSplit ? ' compact' : '') + '">' + toc + '<div class="rev-main">' + (empty || (overview + secHtml + formulaHtml + conceptHtml)) + '</div></div>';
    markViewingSection();
  }

  function updateRevisionProgress() {
    if (!S.rev) return;
    S.rev.decks.forEach(function (d) {
      var el = document.getElementById('revProg-' + d.id);
      if (!el) return;
      var pr = deckProgress(d);
      el.innerHTML = '<strong>' + pr.done + '</strong> / ' + pr.total;
      var bar = el.closest('.deck-progress').querySelector('.progress');
      if (bar) { bar.setAttribute('aria-valuenow', pct(pr.done, pr.total)); bar.querySelector('span').style.width = pct(pr.done, pr.total) + '%'; }
    });
  }

  /* =====================================================================
     Views — Settings
     ===================================================================== */

  function renderSettings() {
    var d = store();
    var st = d.settings;
    var r = S.report;
    var g = globalStats();
    var themeSeg = '<div class="segmented" role="group" aria-label="Theme">' + [['system', 'System', 'i-monitor'], ['light', 'Light', 'i-sun'], ['dark', 'Dark', 'i-moon']].map(function (t) {
      return '<button type="button" data-action="set-theme" data-value="' + t[0] + '" aria-pressed="' + (st.theme === t[0]) + '">' + icon(t[2], 'ic-sm') + ' ' + t[1] + '</button>';
    }).join('') + '</div>';
    function sw(key, label, desc) {
      return '<div class="switch-row"><div><label class="label" for="set-' + key + '">' + label + '</label><p>' + desc + '</p></div>' +
        '<span class="switch"><input type="checkbox" id="set-' + key + '" data-change="setting" data-key="' + key + '"' + (st[key] ? ' checked' : '') + '><span class="track"></span></span></div>';
    }
    var errList = r.errors.length ? '<details class="disclosure" open><summary>' + r.errors.length + ' question(s) excluded because of errors</summary><ul class="health-list">' +
      r.errors.map(function (e) { return '<li><strong>' + escapeHtml(e.id) + '</strong> (entry #' + (e.index + 1) + '): ' + e.messages.map(escapeHtml).join(' ') + '</li>'; }).join('') + '</ul></details>' : '';
    var warnList = r.warnings.length ? '<details class="disclosure"><summary>' + r.warnings.length + ' question(s) with warnings (still included)</summary><ul class="health-list">' +
      r.warnings.map(function (e) { return '<li><strong>' + escapeHtml(e.id) + '</strong>: ' + e.messages.map(escapeHtml).join(' ') + '</li>'; }).join('') + '</ul></details>' : '';
    var note = S.meta.validation && S.meta.validation.note ? '<p class="small muted">' + escapeHtml(S.meta.validation.note) + '</p>' : '';
    var shortcuts = [['1 – 4', 'Select / toggle option'], ['Enter', 'Check answer, then go to next'], ['→ or N', 'Next question'], ['← or P', 'Previous question'], ['S', 'Skip'], ['B', 'Bookmark'], ['H', 'Show / hide hint'], ['R', 'Try again'], ['C', 'Clear selection'], ['?', 'Show shortcuts']];

    app.innerHTML = '<div class="view"><div class="page-head"><div><h1>Settings</h1><p>Appearance, practice preferences and your saved data.</p></div></div>' +
      '<div class="grid grid-2" style="align-items:start">' +
      '<div class="stack">' +
      '<div class="card"><h2>Appearance</h2><p class="muted small">Light, dark, or follow your device.</p>' + themeSeg + '</div>' +
      '<div class="card"><h2>Practice</h2>' +
      sw('shuffleOptions', 'Shuffle options', 'Randomise option order in new sessions. Grading uses option ids, so answer keys stay correct.') +
      sw('showHints', 'Show hint button', 'Offer a hint (slide reference and, for MSQs, how many options are correct).') + '</div>' +
      '<div class="card"><h2>Keyboard shortcuts</h2><table class="data"><tbody>' + shortcuts.map(function (k) { return '<tr><td><span class="kbd">' + k[0] + '</span></td><td>' + k[1] + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '</div><div class="stack">' +
      '<div class="card"><h2>Your progress</h2><p class="muted small">Saved in this browser only (localStorage). It does not sync across devices or browsers — use export/import to move it.</p>' +
      '<p>' + g.attempted + ' questions attempted · ' + g.correct + ' correct · ' + d.bookmarks.length + ' bookmarks · ' + d.history.length + ' finished sessions</p>' +
      (Store.ok ? '' : '<div class="notice warn">' + icon('i-alert') + '<span>Storage is unavailable in this browser mode, so progress will be lost when you close the page.</span></div>') +
      '<div class="row"><button class="btn btn-ghost" data-action="export">' + icon('i-download') + 'Export progress</button>' +
      '<label class="btn btn-ghost" for="importFile" tabindex="0" data-action="import-label">' + icon('i-upload') + 'Import progress</label><input type="file" id="importFile" accept="application/json,.json" class="sr-only" data-change="import" tabindex="-1">' +
      '<button class="btn btn-danger" data-action="reset">' + icon('i-trash') + 'Reset all progress</button></div></div>' +
      '<div class="card"><h2>Question bank health</h2><p><strong>' + S.bank.length + '</strong> valid questions loaded (' + g.byType.MSQ.total + ' MSQ, ' + g.byType.MCQ.total + ' MCQ) from <code>' + DATA_URL + '</code>.</p>' +
      (r.errors.length ? '' : '<p class="row" style="color:var(--good)">' + icon('i-check-circle') + 'No invalid questions found.</p>') + errList + warnList + note + '</div>' +
      '<div class="card"><h2>About</h2><p class="small">' + escapeHtml(S.meta.course || '') + (S.meta.lecturer ? ' · ' + escapeHtml(S.meta.lecturer) : '') + '</p><p class="small muted">Sources:</p><ul class="small">' +
      (S.meta.sources || []).map(function (x) { return '<li>' + escapeHtml(x) + '</li>'; }).join('') + '</ul></div>' +
      '</div></div></div>';
  }

  function exportProgress() {
    var blob = new Blob([JSON.stringify(Object.assign({ exportedAt: new Date().toISOString(), app: STORE_KEY }, store()), null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'exam-practice-progress-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Progress exported');
  }

  function importProgress(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); } catch (e) { toast('That file is not valid JSON.', 'alert'); return; }
      if (!parsed || typeof parsed !== 'object' || !parsed.attempts) { toast('That file is not an exported progress file.', 'alert'); return; }
      confirmDialog({ title: 'Import progress?', html: '<p>This replaces the progress saved in this browser with the contents of <strong>' + escapeHtml(file.name) + '</strong>.</p>', ok: 'Import', danger: true })
        .then(function (yes) {
          if (!yes) return;
          Store.data = normalizeStore(parsed);
          reconcileStore();
          applyTheme();
          toast('Progress imported');
          render();
        });
    };
    reader.onerror = function () { toast('Could not read that file.', 'alert'); };
    reader.readAsText(file);
  }

  /* =====================================================================
     Event handling
     ===================================================================== */

  var ACTIONS = {
    'continue': function () {
      if (store().session) { navigate('practice'); return; }
      var d = store();
      var todo = S.bank.filter(function (q) { return !d.attempts[q.id]; });
      if (todo.length) startSession({ mode: 'continue', title: 'Continue · unattempted questions', qids: ids(todo) });
      else startSession({ mode: 'all', title: 'All Questions', qids: ids(S.bank) });
    },
    'quick-start': function (el) {
      var mode = el.getAttribute('data-mode');
      if (mode === 'exam') {
        S.modes.examCount = '25'; S.modes.examTime = '0'; S.modes.examType = ''; S.modes.scope = 'all';
      }
      if (mode === 'msq' || mode === 'mcq') S.modes.scope = 'all';
      startMode(mode);
    },
    'start-mode': function (el) { startMode(el.getAttribute('data-mode')); },
    'start-topic': function (el) {
      var key = el.getAttribute('data-topic');
      S.modes.topic = key;
      startMode('topic');
    },
    'set-mode-opt': function (el) {
      S.modes[el.getAttribute('data-key')] = el.getAttribute('data-value');
      renderModes();
      var again = $('[data-action="set-mode-opt"][data-key="' + el.getAttribute('data-key') + '"][data-value="' + el.getAttribute('data-value') + '"]', app);
      if (again) again.focus();
    },
    'check': doCheck,
    'retry': doRetry,
    'clear': doClear,
    'next': doNext,
    'prev': function () { if (S.ctx) moveTo(S.ctx.index - 1); },
    'skip': doSkip,
    'goto': function (el) {
      if (window.innerWidth <= 900) S.navOpen = false;
      moveTo(Number(el.getAttribute('data-index')));
    },
    'hint': function () {
      S.hintOpen = !S.hintOpen;
      renderPractice();
      var b = $('[data-action="hint"]', app);
      if (b) b.focus();
    },
    'bookmark': function () {
      var cur = currentCtxQuestion();
      if (!cur) return;
      toggleBookmark(cur.qid);
      var btn = $('[data-action="bookmark"]', app);
      var on = isBookmarked(cur.qid);
      if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark this question'); }
      var dot = $('.nav-dot[data-index="' + cur.ctx.index + '"]', app);
      if (dot) dot.classList.toggle('bm', on);
    },
    'toggle-nav': function (el) {
      S.navOpen = !S.navOpen;
      var side = document.getElementById('sidePanel');
      if (side) side.classList.toggle('open', S.navOpen);
      el.setAttribute('aria-expanded', String(S.navOpen));
      if (S.navOpen && side) side.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    'finish': finishPractice,
    'submit-exam': function () { submitExam(false); },
    'retry-incorrect': function () {
      var s = store().lastResult;
      if (!s) return;
      var list = reviewList(s, 'incorrect');
      startSession({ mode: 'retry', title: 'Retry incorrect · ' + s.title.replace(/^Retry incorrect · /, ''), qids: list });
    },
    'restart': function () {
      var s = store().lastResult;
      if (!s) return;
      startSession({ mode: s.mode, title: s.title, qids: s.qids, exam: s.exam, timeLimit: s.timeLimit, shuffleQuestions: s.shuffleQuestions });
    },
    'browse-reset': function () {
      S.browse = { q: '', course: '', topic: '', type: '', difficulty: '', status: '', limit: BROWSE_PAGE, open: {} };
      renderBrowse();
    },
    'browse-more': function () { S.browse.limit += BROWSE_PAGE; renderBrowseList(); },
    'browse-reveal-all': function () {
      var res = browseResults().slice(0, S.browse.limit);
      var allOpen = res.every(function (q) { return S.browse.open[q.id]; });
      res.forEach(function (q) { S.browse.open[q.id] = !allOpen; });
      renderBrowseList();
    },
    'bank-toggle': function (el) {
      var id = el.getAttribute('data-id');
      S.browse.open[id] = !S.browse.open[id];
      var art = el.closest('.bank-item');
      var open = S.browse.open[id];
      art.classList.toggle('open', open);
      el.setAttribute('aria-expanded', String(open));
      el.innerHTML = icon('i-eye', 'ic-sm') + (open ? 'Hide answer' : 'Show answer');
    },
    'bank-bookmark': function (el) {
      var id = el.getAttribute('data-id');
      toggleBookmark(id);
      var on = isBookmarked(id);
      el.setAttribute('aria-pressed', String(on));
      el.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark');
    },
    'bank-practice': function (el) {
      var id = el.getAttribute('data-id');
      startSession({ mode: 'custom', title: 'Single question · ' + id, qids: [id] });
    },
    'practice-filtered': function () {
      var res = browseResults();
      var b = S.browse;
      var bits = [];
      if (b.q) bits.push('“' + b.q + '”');
      if (b.type) bits.push(b.type);
      if (b.difficulty) bits.push(b.difficulty);
      if (b.topic) { var t = S.topics.filter(function (x) { return x.key === b.topic; })[0]; if (t) bits.push(t.topic); }
      else if (b.course) bits.push(shortCourse(b.course));
      if (b.status) bits.push(b.status === 'new' ? 'not attempted' : b.status);
      startSession({ mode: 'custom', title: 'Custom set' + (bits.length ? ' · ' + bits.join(' · ') : ''), qids: ids(res) });
    },
    'rev-retry': function () { S.revError = null; renderRevision(); },
    'rev-view': function (el) {
      var deckId = el.getAttribute('data-deck');
      var page = Math.max(1, Number(el.getAttribute('data-page')) || 1);
      showRevisionPage(deckId, page, el.getAttribute('data-sec'));
    },
    'rev-page': function (el) {
      if (!S.revViewer) return;
      var deck = currentDeck();
      var page = S.revViewer.page + Number(el.getAttribute('data-delta'));
      page = Math.max(1, Math.min(deck.pdfPages || page, page));
      showRevisionPage(deck.id, page, null);
      var again = $('[data-action="rev-page"][data-delta="' + el.getAttribute('data-delta') + '"]', app);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    },
    'rev-close-viewer': closeRevisionViewer,
    'rev-toggle': function (el) {
      var id = el.getAttribute('data-sec');
      var r = store().revised;
      if (r[id]) delete r[id]; else { r[id] = Date.now(); toast('Marked as revised'); }
      save();
      renderRevisionBody();
      updateRevisionProgress();
      var again = $('[data-action="rev-toggle"][data-sec="' + id + '"]', app);
      if (again) again.focus({ preventScroll: true });
    },
    'rev-practice': function (el) {
      S.modes.topic = el.getAttribute('data-topic');
      startMode('topic');
    },
    'rev-jump': function (el) {
      var target = document.getElementById(el.getAttribute('data-target'));
      if (!target) return;
      if (target.tagName === 'DETAILS') { target.open = true; delete S.revClosed[target.id]; }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var focusEl = target.querySelector('summary') || target;
      if (!focusEl.hasAttribute('tabindex') && focusEl.tagName !== 'SUMMARY') focusEl.setAttribute('tabindex', '-1');
      focusEl.focus({ preventScroll: true });
    },
    'rev-expand': function () { S.revClosed = {}; renderRevisionBody(); },
    'rev-collapse': function () {
      var deck = currentDeck();
      if (!deck) return;
      deck.sections.forEach(function (s) { S.revClosed[s.id] = true; });
      renderRevisionBody();
    },
    'rev-clear-search': function () {
      S.revQ = '';
      var input = document.getElementById('revQ');
      if (input) input.value = '';
      renderRevisionBody();
      if (input) input.focus();
    },
    'set-theme': function (el) { setTheme(el.getAttribute('data-value')); renderSettings(); },
    'export': exportProgress,
    'import-label': function () { /* the label opens the file picker natively */ },
    'reset': function () {
      confirmDialog({
        title: 'Reset all progress?',
        html: '<p>This permanently deletes your attempts, bookmarks, session history and current session from this browser. Settings are kept.</p><p><strong>This cannot be undone.</strong> Consider exporting first.</p>',
        ok: 'Reset everything', danger: true
      }).then(function (yes) {
        if (!yes) return;
        var keep = store().settings;
        Store.data = defaultStore();
        Store.data.settings = keep;
        save();
        S.review = { filter: 'all', index: 0 };
        toast('All progress has been reset');
        render();
      });
    }
  };

  function onClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el || !app.contains(el)) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    var fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) {
      if (el.tagName === 'BUTTON' || el.tagName === 'A' && !el.getAttribute('href')) e.preventDefault();
      fn(el, e);
    }
  }

  function onChange(e) {
    var el = e.target;
    var kind = el.getAttribute && el.getAttribute('data-change');
    if (!kind) return;
    if (kind === 'option') onOptionChange(el);
    else if (kind === 'mode-opt') {
      S.modes[el.getAttribute('data-key')] = el.value;
      var id = el.id;
      renderModes();
      var again = document.getElementById(id);
      if (again) again.focus();
    } else if (kind === 'mode-shuffleQ') {
      S.modes.shuffleQ = el.checked;
    } else if (kind === 'setting') {
      store().settings[el.getAttribute('data-key')] = el.checked;
      save();
      toast('Setting saved');
    } else if (kind === 'browse') {
      var key = el.getAttribute('data-key');
      S.browse[key] = el.value;
      S.browse.limit = BROWSE_PAGE;
      if (key === 'course') {
        if (S.browse.topic && S.topics.every(function (t) { return t.key !== S.browse.topic || (el.value && t.course !== el.value); })) S.browse.topic = '';
        renderBrowse();
        var c = document.getElementById('bf-course');
        if (c) c.focus();
      } else {
        renderBrowseList();
      }
    } else if (kind === 'import') {
      importProgress(el.files && el.files[0]);
      el.value = '';
    }
  }

  var searchTimer = null;
  function onInput(e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-input') === 'rev-q') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        S.revQ = el.value;
        renderRevisionBody();
      }, 160);
      return;
    }
    if (el.getAttribute && el.getAttribute('data-input') === 'browse-q') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        S.browse.q = el.value;
        S.browse.limit = BROWSE_PAGE;
        renderBrowseList();
      }, 160);
    }
  }

  function showShortcuts() {
    confirmDialog({
      title: 'Keyboard shortcuts',
      alertOnly: true,
      ok: 'Got it',
      html: '<table><tbody>' + [['1 – 4', 'Select / toggle an option'], ['Enter', 'Check answer, then next question'], ['→ / N', 'Next question'], ['← / P', 'Previous question'], ['S', 'Skip question'], ['B', 'Bookmark'], ['H', 'Show / hide hint'], ['R', 'Try again'], ['C', 'Clear selection'], ['?', 'This help']]
        .map(function (k) { return '<tr><td><span class="kbd">' + k[0] + '</span></td><td>' + k[1] + '</td></tr>'; }).join('') + '</tbody></table>'
    });
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var dlg = document.getElementById('dialog');
    if (dlg && dlg.open) return;
    var t = e.target;
    var tag = t.tagName;
    var isChoice = tag === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio');
    if ((tag === 'INPUT' && !isChoice) || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
    if (e.key === 'Escape' && S.route.name === 'revision' && S.revViewer) { e.preventDefault(); closeRevisionViewer(); return; }
    var rn = S.route.name;
    if ((rn !== 'practice' && rn !== 'review') || !S.ctx || !$('#qText', app)) return;
    var ctx = S.ctx;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (/^[1-9]$/.test(k)) {
      if (ctx.kind === 'review') return;
      e.preventDefault();
      toggleOptionByIndex(Number(k) - 1);
    } else if (k === 'Enter') {
      if (tag === 'BUTTON' || tag === 'A' || tag === 'LABEL') return;
      e.preventDefault();
      if (ctx.kind === 'practice') {
        var entry = getEntry(ctx.session, ctx.list[ctx.index]);
        if (!entry.checked) doCheck(); else doNext();
      } else if (ctx.index < ctx.list.length - 1) {
        doNext();
      }
    } else if (k === 'ArrowRight' || k === 'n') {
      if (t.type === 'radio') return;
      e.preventDefault();
      if (ctx.index < ctx.list.length - 1) moveTo(ctx.index + 1);
    } else if (k === 'ArrowLeft' || k === 'p') {
      if (t.type === 'radio') return;
      e.preventDefault();
      moveTo(ctx.index - 1);
    } else if (k === 's' && ctx.kind !== 'review') {
      e.preventDefault(); doSkip();
    } else if (k === 'b') {
      e.preventDefault(); ACTIONS.bookmark();
    } else if (k === 'h' && ctx.kind === 'practice' && store().settings.showHints) {
      e.preventDefault(); ACTIONS.hint();
    } else if (k === 'r' && ctx.kind === 'practice') {
      e.preventDefault(); doRetry();
    } else if (k === 'c' && ctx.kind !== 'review') {
      e.preventDefault(); doClear();
    }
  }

  /* =====================================================================
     Startup
     ===================================================================== */

  function renderLoadError(err) {
    var isFile = location.protocol === 'file:';
    app.innerHTML = '<div class="view"><div class="card error-card" role="alert"><div class="row">' + icon('i-alert', 'ic-lg') + '<h2 style="margin:0">The question bank could not be loaded</h2></div>' +
      (isFile
        ? '<p style="margin-top:1rem">You opened the page directly from your disk (<code>file://</code>). Browsers block loading the JSON question file this way.</p>' +
        '<p><strong>Fix:</strong> start a small local web server in the project folder and open the address it prints:</p>' +
        '<pre>cd exam-practice-website\npython -m http.server 8000\n# then open http://localhost:8000</pre><p>On GitHub Pages this works automatically.</p>'
        : '<p style="margin-top:1rem">Check that <code>' + DATA_URL + '</code> exists next to <code>index.html</code> and contains valid JSON, then reload the page.</p>') +
      '<details class="disclosure"><summary>Technical details</summary><pre>' + escapeHtml(err && err.message ? err.message : String(err)) + '</pre></details>' +
      '<button class="btn btn-primary" onclick="location.reload()">' + icon('i-refresh') + 'Try again</button></div></div>';
  }

  function init() {
    app = document.getElementById('app');
    Store.load();
    applyTheme();

    document.getElementById('themeBtn').addEventListener('click', function () {
      var order = ['system', 'light', 'dark'];
      var next = order[(order.indexOf(store().settings.theme) + 1) % order.length];
      setTheme(next);
      toast('Theme: ' + next.charAt(0).toUpperCase() + next.slice(1));
      if (S.route.name === 'settings' && S.bank.length) renderSettings();
    });
    document.getElementById('shortcutsBtn').addEventListener('click', showShortcuts);
    app.addEventListener('click', onClick);
    app.addEventListener('change', onChange);
    app.addEventListener('input', onInput);
    // remember which revision sections the user collapsed ('toggle' does not bubble, so capture it)
    app.addEventListener('toggle', function (e) {
      var d = e.target;
      if (!d.classList || !d.classList.contains('rev-section') || searchTokens(S.revQ).length) return;
      if (d.open) delete S.revClosed[d.id]; else S.revClosed[d.id] = true;
    }, true);
    app.addEventListener('keydown', function (e) {
      // keyboard activation for the file-picker label
      if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('data-action') === 'import-label') {
        e.preventDefault();
        var f = document.getElementById('importFile');
        if (f) f.click();
      }
    });
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('pagehide', save);
    // Switch between split study mode and the full-screen sheet when the window crosses the breakpoint.
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (S.route.name !== 'revision' || !S.rev) return;
        if (S.revViewer && isWideScreen() !== S.revSplit) renderRevision();
        else if (S.revSplit) sizeWorkspace();
      }, 150);
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });

    if (!window.QuestionValidator) {
      renderLoadError(new Error('assets/js/validator.js did not load.'));
      return;
    }
    if (!window.fetch) {
      renderLoadError(new Error('This browser does not support fetch(). Please use a current browser.'));
      return;
    }

    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' while loading ' + DATA_URL);
        return res.text();
      })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); } catch (e) { throw new Error('questions.json is not valid JSON: ' + e.message); }
        var report = window.QuestionValidator.validateQuestionBank(json);
        if (report.fatal) {
          var detail = report.errors.slice(0, 10).map(function (x) { return x.id + ': ' + x.messages.join(' '); }).join('\n');
          throw new Error(report.fatal + (detail ? '\n' + detail : ''));
        }
        if (report.errors.length && window.console) {
          console.warn('[ExamPrep] ' + report.errors.length + ' invalid question(s) were skipped:', report.errors);
        }
        setupBank(report);
        reconcileStore();
        window.addEventListener('hashchange', function () { render(true); });
        render(true);
      })
      .catch(function (err) {
        if (window.console) console.error(err);
        renderLoadError(err);
      });
  }

  // Exposed for automated tests and debugging.
  window.ExamApp = {
    gradeSelection: gradeSelection,
    sameSet: sameSet,
    shuffle: shuffle,
    sessionStats: sessionStats,
    normalizeStore: normalizeStore,
    state: S,
    store: store
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
