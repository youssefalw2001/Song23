/**
 * The studio, served by the service itself.
 *
 * One page, no build step, no dependency, no framework. It is delivered as a
 * string by the same process that generates the songs, which removes every moving
 * part the previous arrangement had: no second deployment, no service URL to
 * enter, no CORS allowlist to get wrong, and no cross-origin auth problem. You
 * open the URL and you are in the studio.
 *
 * Being same-origin also fixes audio outright. Previously the player needed an
 * Authorization header that `<audio src>` cannot send, so the page had to fetch
 * the bytes and build an object URL. Here a cookie carries the credential, so
 * `<audio src="/jobs/x/audio">` simply works — including seeking, since the
 * server handles Range.
 *
 * Written as a template string rather than a file on disk so that a build that
 * compiles is a build that has its UI. There is no arrangement of `dist/` that
 * can be missing an asset.
 */

import { config, authIsOpen } from "../config.ts";

const PALETTE = `
  --page:#F7F3EE; --raise:#F1EBE4; --ink:#24211F; --body:#4A4540; --muted:#6B655F;
  --rose:#A87F72; --rose-deep:#8A6153; --rose-press:#7D5548;
  --line:#E4DCD3; --line-soft:#ECE5DD;
`;

/**
 * Deliberately the same palette and type feeling as the public site, because the
 * operator moves between them and a memorial product should not have a garish
 * back office. Georgia rather than Cormorant: it is on every machine, and loading
 * a webfont into an internal tool for one heading is not worth the request.
 */
const STYLES = `
*,*::before,*::after{box-sizing:border-box}
:root{${PALETTE}}
body{margin:0;background:var(--page);color:var(--ink);
  font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
.shell{max-width:52rem;margin:0 auto;padding:0 1.5rem}
header{border-bottom:1px solid var(--line);margin-bottom:2.5rem}
.bar{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;
  min-height:4.5rem;flex-wrap:wrap;padding:1rem 0}
h1{font:300 1.35rem/1.2 Georgia,"Times New Roman",serif;margin:0;letter-spacing:.01em}
h2{font:300 1.35rem/1.25 Georgia,serif;margin:0 0 .25rem}
h3{font:400 .75rem/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted);margin:0 0 .6rem}
p{margin:.4rem 0}
a{color:var(--rose-deep);text-decoration:underline;text-decoration-color:rgba(138,97,83,.35);
  text-underline-offset:3px}
a:hover{text-decoration-color:var(--rose-deep)}
.q{color:var(--muted);font-size:.8125rem;line-height:1.65}
section{border:1px solid var(--line);border-radius:3px;background:rgba(241,235,228,.4);
  padding:1.5rem;margin-bottom:1.25rem}
label{display:block;margin-bottom:1rem}
label>span.l{display:block;font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);margin-bottom:.4rem}
label>span.h{display:block;font-size:.8125rem;color:var(--muted);margin:-.2rem 0 .4rem}
input,textarea,select{width:100%;font:inherit;color:var(--ink);background:var(--page);
  border:1px solid var(--line);border-radius:3px;padding:.6rem .7rem}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--rose-deep)}
textarea{resize:vertical;line-height:1.65}
textarea.code{font:13px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}
button{font:500 .9375rem/1 inherit;border:0;border-radius:3px;padding:0 1.75rem;height:3rem;
  background:var(--rose-deep);color:var(--page);cursor:pointer;transition:background .25s}
button:hover:not(:disabled){background:var(--rose-press)}
button:disabled{opacity:.45;cursor:default}
button.ghost{background:none;color:var(--ink);border:1px solid rgba(36,33,31,.2);height:2.6rem;
  padding:0 1.1rem;font-size:.875rem}
button.ghost:hover:not(:disabled){background:none;border-color:rgba(36,33,31,.5)}
button.chip{background:none;color:var(--muted);border:1px solid var(--line);height:2.4rem;
  padding:0 .9rem;font-size:.8125rem}
button.chip[aria-pressed=true]{border-color:var(--rose-deep);color:var(--ink)}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
.grid{display:grid;gap:1rem}
@media(min-width:34rem){.grid.two{grid-template-columns:1fr 1fr}.grid.four{grid-template-columns:repeat(4,1fr)}}
.warn{border-left:2px solid var(--rose);padding-left:.85rem;margin:.7rem 0;font-size:.875rem}
.actions{display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap;
  border-top:1px solid var(--line-soft);padding-top:1.25rem;margin-top:1.5rem}
.hide{display:none!important}
audio{width:100%;margin-top:.5rem}
.jobs{list-style:none;margin:0;padding:0}
.jobs li{border-top:1px solid var(--line-soft)}
.jobs button{background:none;color:inherit;width:100%;text-align:left;height:auto;
  padding:.7rem 0;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.jobs button:hover{background:none;color:var(--rose-deep)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:.6rem;
  background:var(--line);flex:0 0 auto}
.dot.ok{background:var(--rose-deep)}.dot.bad{background:var(--ink)}
.dot.busy{background:var(--rose);animation:p 1.4s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.35}}
.meta{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1.25rem;font-size:.8125rem;margin-top:1rem}
.meta dt{color:var(--muted)}.meta dd{margin:0;font-variant-numeric:tabular-nums}
.log{font:12px/1.7 ui-monospace,Menlo,monospace;color:var(--muted);margin:0;padding:0;list-style:none}
footer{border-top:1px solid var(--line);margin-top:2.5rem;padding:1.5rem 0 3rem}
`;

/** The whole client. Vanilla, same-origin, ~1 request. */
const SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hide', !on);
let job = null, envelope = null, poll = null;

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: opts?.body ? { 'Content-Type': 'application/json' } : {},
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (res.status === 401) { show('login', true); throw new Error('Sign in first.'); }
  if (!res.ok) {
    const detail = Array.isArray(body?.detail) ? ' ' + body.detail.join('; ') : '';
    throw new Error((body?.error || ('HTTP ' + res.status)) + detail);
  }
  return body;
}

function err(id, message) {
  const el = $(id);
  el.textContent = message || '';
  show(id, !!message);
}

// ---- answers ---------------------------------------------------------------
const FIELDS = ['petName','species','about','personality','memories','include','style','yourName','email'];
function readAnswers() {
  const a = {};
  for (const f of FIELDS) { const el = $('f-' + f); if (el && el.value.trim()) a[f] = el.value.trim(); }
  const sp = document.querySelector('[data-species][aria-pressed=true]');
  if (sp) a.species = sp.dataset.species;
  return a;
}
function writeAnswers(a) {
  for (const f of FIELDS) { const el = $('f-' + f); if (el && a[f] != null) el.value = a[f]; }
  if (a.species) {
    document.querySelectorAll('[data-species]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.species === a.species)));
  }
}
document.querySelectorAll('[data-species]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-species]').forEach((o) =>
    o.setAttribute('aria-pressed', String(o === b)));
});

// ---- paste an email --------------------------------------------------------
$('parse').onclick = async () => {
  err('parse-err','');
  const text = $('paste').value;
  if (!text.trim()) return;
  try {
    const r = await api('/parse', { method:'POST', body: JSON.stringify({ text }) });
    if (!r.matched.length) {
      err('parse-err', "Nothing recognisable in that. It expects the summary the Create flow produces — lines like \"Their name:\" followed by the answer. Fill the fields in by hand instead.");
      return;
    }
    writeAnswers(r.answers);
    $('parse-ok').textContent = 'Read ' + r.matched.length + ' field' + (r.matched.length===1?'':'s') + ': ' + r.labels.join(', ') + '. Check them against the original.';
    show('parse-ok', true);
  } catch (e) { err('parse-err', e.message); }
};

// ---- build the brief ------------------------------------------------------
$('build').onclick = async () => {
  err('build-err','');
  const a = readAnswers();
  if (!a.petName || !a.memories) {
    err('build-err','Their name and one memory are the only things actually required.');
    return;
  }
  $('build').disabled = true; $('build').textContent = 'Writing…';
  try {
    envelope = await api('/jobs', { method:'POST', body: JSON.stringify(a) });
    job = envelope.job;
    renderBrief();
    show('brief', true);
    $('brief').scrollIntoView({ behavior:'smooth', block:'start' });
    loadJobs();
  } catch (e) { err('build-err', e.message); }
  finally { $('build').disabled = false; $('build').textContent = 'Write the song'; }
};

function renderBrief() {
  $('b-title').value = job.brief.title;
  $('b-caption').value = job.brief.caption;
  $('b-lyrics').value = job.brief.lyrics;
  $('b-duration').value = job.brief.durationSeconds;
  $('b-bpm').value = job.brief.bpm || '';
  $('b-key').value = job.brief.keyScale || '';
  $('b-time').value = job.brief.timeSignature || '';
  $('b-who').textContent = job.answers.petName;

  const esc = (s) => s.replace(/[&<>]/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  // Problems block generation, warnings don't. Showing problems first, and in the
  // same place, means you find out before pressing the button rather than from a
  // 422 afterwards.
  const problems = (envelope?.problems || []).map((p) =>
    '<p class="warn"><strong>' + esc(p) + '</strong></p>');
  const warnings = envelope?.warnings || [];
  $('warnings').innerHTML = problems.concat(
    warnings.map((w) => '<p class="warn">' + esc(w) + '</p>')).join('');
  show('warn-wrap', problems.length + warnings.length > 0);

  const notes = envelope?.notes || [];
  $('notes').innerHTML = notes.map((n) =>
    '<p class="q">· ' + n.replace(/[&<>]/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</p>').join('');
  show('notes-wrap', notes.length > 0);

  const unused = envelope?.unusedLines || [];
  $('unused').innerHTML = unused.map((l) =>
    '<p class="q" style="color:var(--ink)"><span style="color:var(--muted);display:inline-block;width:3.5rem">'
    + l.syllables + ' syl</span>' + l.text.replace(/[&<>]/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</p>').join('');
  show('unused-wrap', unused.length > 0);

  $('gen').textContent = job.take > 0 ? 'Generate take ' + (job.take + 1) : 'Generate the song';
}

function briefFromForm() {
  return {
    title: $('b-title').value,
    caption: $('b-caption').value,
    lyrics: $('b-lyrics').value,
    durationSeconds: Number($('b-duration').value) || 0,
    bpm: Number($('b-bpm').value) || undefined,
    keyScale: $('b-key').value || undefined,
    timeSignature: $('b-time').value || undefined,
  };
}

// ---- generate -------------------------------------------------------------
$('gen').onclick = async () => {
  err('gen-err','');
  $('gen').disabled = true;
  try {
    const r = await api('/jobs/' + job.id + '/generate', {
      method:'POST', body: JSON.stringify({ brief: briefFromForm() }),
    });
    job = r.job;
    setStatus();
    startPoll();
  } catch (e) { err('gen-err', e.message); $('gen').disabled = false; }
};

function startPoll() {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const r = await api('/jobs/' + job.id);
      job = r.job;
      setStatus();
      if (job.status === 'ready' || job.status === 'failed') {
        clearInterval(poll); poll = null;
        $('gen').disabled = false;
        renderBrief();
        if (job.status === 'ready') renderResult(); else err('gen-err', job.error);
        loadJobs();
      }
    } catch (e) { clearInterval(poll); poll = null; $('gen').disabled = false; err('gen-err', e.message); }
  }, 3000);
}

function setStatus() {
  const working = job.status === 'queued' || job.status === 'generating';
  const tries = job.attempts.filter((a) => !a.ok).length;
  $('state').innerHTML = '<span class="dot ' +
    (job.status === 'ready' ? 'ok' : working ? 'busy' : job.status === 'failed' ? 'bad' : '') + '"></span>' +
    (job.status === 'ready' ? 'Take ' + job.take + ' ready'
     : job.status === 'generating' ? 'Generating take ' + job.take + '…' + (tries ? ' (retry ' + tries + ')' : '')
     : job.status === 'queued' ? 'Queued'
     : job.status === 'draft' ? 'Draft — not generated yet' : 'Failed');
  show('state', true);
  renderAttempts();
}

function renderAttempts() {
  const failed = job.attempts.filter((a) => !a.ok);
  $('attempts').innerHTML = job.attempts.map((a, i) =>
    '<li>' + (i+1) + '. ' + (a.ok ? 'ok' : 'HTTP ' + (a.status || '—')) + ' · ' +
    (a.ms/1000).toFixed(1) + 's' + (a.error ? '<br>' + a.error.replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) : '') + '</li>').join('');
  show('attempts-wrap', failed.length > 0);
}

function renderResult() {
  const r = job.result;
  // Same-origin plus a cookie, so the element can just fetch it. Cache-busted per
  // take so a new one never plays the previous take from cache.
  $('audio').src = '/jobs/' + job.id + '/audio/' + r.audioFile;
  $('dl').href = '/jobs/' + job.id + '/audio/' + r.audioFile;
  $('dl').download = job.answers.petName + ' - ' + job.brief.title + '.' + r.format;
  $('r-title').textContent = job.brief.title;
  $('r-sub').textContent = job.answers.petName + ' · take ' + job.take + ' · ' + r.approxDurationSeconds + 's';
  $('r-meta').innerHTML =
    '<dt>Length</dt><dd>' + r.approxDurationSeconds + 's (asked ' + job.brief.durationSeconds + 's)</dd>' +
    '<dt>Size</dt><dd>' + (r.bytes/1048576).toFixed(1) + ' MB ' + r.format + '</dd>' +
    '<dt>Attempts</dt><dd>' + job.attempts.length + '</dd>';
  $('takes').innerHTML = job.takes.length > 1 ? job.takes.map((t) =>
    '<button class="chip" aria-pressed="' + (t === r.audioFile) + '" data-take="' + t + '">' +
    t.replace(/\.\w+$/,'').replace('take-','Take ') + '</button>').join('') : '';
  show('takes-wrap', job.takes.length > 1);
  document.querySelectorAll('[data-take]').forEach((b) => b.onclick = () => {
    $('audio').src = '/jobs/' + job.id + '/audio/' + b.dataset.take;
    $('audio').play();
    document.querySelectorAll('[data-take]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  });
  show('result', true);
  $('result').scrollIntoView({ behavior:'smooth', block:'start' });
}

// ---- recent ---------------------------------------------------------------
async function loadJobs() {
  try {
    const r = await api('/jobs');
    if (!r.jobs.length) { show('recent', false); return; }
    $('jobs').innerHTML = r.jobs.slice(0, 25).map((j) =>
      '<li><button data-job="' + j.id + '"><span><span class="dot ' +
      (j.status==='ready'?'ok':j.status==='failed'?'bad':j.status==='generating'?'busy':'') +
      '"></span><strong style="font:400 1.05rem Georgia,serif">' +
      j.answers.petName.replace(/[&<>]/g,'') + '</strong> <span class="q">' +
      (j.brief.title||'').replace(/[&<>]/g,'') + '</span></span><span class="q">' +
      (j.status==='ready' ? 'take ' + j.take : j.status) + '</span></button></li>').join('');
    show('recent', true);
    document.querySelectorAll('[data-job]').forEach((b) => b.onclick = async () => {
      const r2 = await api('/jobs/' + b.dataset.job);
      job = r2.job; envelope = null;
      writeAnswers(job.answers);
      renderBrief(); setStatus();
      show('brief', true);
      if (job.status === 'ready') renderResult(); else show('result', false);
      if (job.status === 'queued' || job.status === 'generating') startPoll();
      $('brief').scrollIntoView({ behavior:'smooth', block:'start' });
    });
  } catch {}
}

// ---- sign in (only when a token is configured) -----------------------------
const loginBtn = $('login-go');
if (loginBtn) loginBtn.onclick = async () => {
  err('login-err','');
  try {
    await api('/login', { method:'POST', body: JSON.stringify({ token: $('login-token').value.trim() }) });
    show('login', false);
    loadJobs();
  } catch (e) { err('login-err', e.message); }
};

loadJobs();
`;

export function studioPage(): string {
  const open = authIsOpen();

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Studio · Tails We Remember</title>
<style>${STYLES}</style>
</head><body>

<header><div class="shell bar">
  <h1>Tails We Remember <span class="q" style="font-family:ui-sans-serif;letter-spacing:.14em;text-transform:uppercase;font-size:.7rem"> Studio</span></h1>
  <p class="q" id="state" style="margin:0"></p>
</div></header>

<main class="shell">

${
  open
    ? `<section style="border-left:2px solid var(--rose)">
    <p class="q" style="color:var(--ink)"><strong>No operator token is set, so this page is public.</strong>
    Anyone with this URL can read every customer&rsquo;s answers and generate songs on your ACE key.
    Harmless while nothing real is stored; set <code>OPERATOR_TOKEN</code> in the environment to close it.</p>
  </section>`
    : `<section id="login" class="hide">
    <h2>Sign in</h2>
    <p class="q">The operator token from this service&rsquo;s environment.</p>
    <label style="max-width:26rem"><span class="l">Operator token</span>
      <input id="login-token" type="password" autocomplete="off"></label>
    <button id="login-go">Sign in</button>
    <p class="warn hide" id="login-err"></p>
  </section>`
}

<section>
  <h2>Paste what they sent</h2>
  <p class="q">The summary from the Create flow, straight out of the email. Or skip this and fill in the fields.</p>
  <label style="margin-top:1rem"><textarea id="paste" rows="5" class="code"
    placeholder="Their name:&#10;Buddy&#10;&#10;Never want to forget:&#10;He never once slept in the bed we bought him…"></textarea></label>
  <div class="row"><button class="ghost" id="parse">Read the fields</button></div>
  <p class="q hide" id="parse-ok" style="margin-top:.75rem"></p>
  <p class="warn hide" id="parse-err"></p>
</section>

<section>
  <h2>About them</h2>
  <p class="q">Only their name and one memory are required.</p>

  <div class="grid two" style="margin-top:1.25rem">
    <label><span class="l">Their name</span><input id="f-petName" maxlength="80" placeholder="Buddy"></label>
    <div><span class="l" style="display:block;font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:.4rem">Dog, cat or other</span>
      <div class="row">
        <button class="chip" data-species="dog" aria-pressed="false">Dog</button>
        <button class="chip" data-species="cat" aria-pressed="false">Cat</button>
        <button class="chip" data-species="other" aria-pressed="false">Other</button>
      </div></div>
  </div>

  <label><span class="l">What you never want to forget</span>
    <span class="h">The verses are built almost entirely from this. Small and specific beats big and general.</span>
    <textarea id="f-memories" rows="4" maxlength="900"
      placeholder="He never once slept in the bed we bought him. Always the laundry basket, right on the warm clothes."></textarea></label>

  <label><span class="l">About them</span>
    <textarea id="f-about" rows="3" maxlength="900"></textarea></label>

  <div class="grid two">
    <label><span class="l">What they were like</span>
      <input id="f-personality" maxlength="160" placeholder="Gentle, stubborn, always hungry"></label>
    <label><span class="l">Preferred sound</span>
      <select id="f-style">
        <option value="">Not stated — we choose</option>
        <option value="acoustic">Gentle acoustic</option>
        <option value="piano">Piano</option>
        <option value="folk">Soft folk</option>
        <option value="country">Country</option>
        <option value="unsure">You choose</option>
      </select></label>
  </div>

  <label><span class="l">To include or avoid</span>
    <span class="h">A name here goes in the bridge. Anything they asked you to leave out is flagged before you generate.</span>
    <textarea id="f-include" rows="2" maxlength="600"
      placeholder="Please include my daughter Ellie. And please don't mention the illness."></textarea></label>

  <div class="grid two">
    <label><span class="l">Owner&rsquo;s name</span><input id="f-yourName"></label>
    <label><span class="l">Email</span><span class="h">Stored, never shown again.</span><input id="f-email" type="email"></label>
  </div>

  <div class="actions">
    <button id="build">Write the song</button>
    <span class="q">This writes the lyrics and caption. It does not generate audio yet.</span>
  </div>
  <p class="warn hide" id="build-err"></p>
</section>

<section id="brief" class="hide">
  <h2>The song for <span id="b-who"></span></h2>
  <p class="q">Read it. Change anything. Then generate.</p>

  <div id="warn-wrap" class="hide" style="margin-top:1.25rem">
    <h3>Read these first</h3><div id="warnings"></div>
  </div>

  <label style="margin-top:1.25rem"><span class="l">Title</span><input id="b-title"></label>

  <label><span class="l">Caption</span>
    <span class="h">Style, instruments, voice, room. The model weights this more heavily than the lyrics. Tempo and key have their own fields below.</span>
    <textarea id="b-caption" rows="3" class="code"></textarea></label>

  <label><span class="l">Lyrics</span>
    <span class="h">Sent word for word. Section tags matter. Six to ten syllables a line sings best.</span>
    <textarea id="b-lyrics" rows="20" class="code"></textarea></label>

  <div class="grid four">
    <label><span class="l">Length (s)</span><input id="b-duration" type="number" min="10" max="600"></label>
    <label><span class="l">BPM</span><input id="b-bpm" type="number" min="30" max="300"></label>
    <label><span class="l">Key</span><input id="b-key"></label>
    <label><span class="l">Time sig</span><input id="b-time"></label>
  </div>

  <div class="actions">
    <button id="gen">Generate the song</button>
    <span class="q">Twenty seconds or so. Longer if the free endpoint is busy — it retries.</span>
  </div>
  <p class="warn hide" id="gen-err"></p>

  <div id="attempts-wrap" class="hide" style="margin-top:1.5rem;border-top:1px solid var(--line-soft);padding-top:1.25rem">
    <h3>Attempts</h3><ul class="log" id="attempts"></ul>
  </div>

  <div id="unused-wrap" class="hide" style="margin-top:1.5rem;border-top:1px solid var(--line-soft);padding-top:1.25rem">
    <h3>Their words you haven&rsquo;t used</h3><div id="unused"></div>
  </div>

  <div id="notes-wrap" class="hide" style="margin-top:1.5rem;border-top:1px solid var(--line-soft);padding-top:1.25rem">
    <h3>How this was built</h3><div id="notes"></div>
  </div>
</section>

<section id="result" class="hide">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap">
    <div><h2 id="r-title"></h2><p class="q" id="r-sub"></p></div>
    <a id="dl" href="#">Download</a>
  </div>
  <audio id="audio" controls preload="metadata"></audio>
  <div id="takes-wrap" class="hide" style="margin-top:1.25rem">
    <h3>Takes</h3><div class="row" id="takes"></div>
    <p class="q" style="margin-top:.6rem">Every take is kept. Take three is often better than take five.</p>
  </div>
  <dl class="meta" id="r-meta"></dl>
  <p class="q" style="margin-top:1.25rem;border-top:1px solid var(--line-soft);padding-top:1rem">
    Listen to the whole thing before you send it.</p>
</section>

<section id="recent" class="hide">
  <h2>Songs</h2>
  <ul class="jobs" id="jobs"></ul>
</section>

</main>

<footer class="shell">
  <p class="q">Every song here is somebody&rsquo;s pet. Provider <code>${config.provider}</code>.
  ${
    config.provider === "acemusic"
      ? "The free hosted endpoint gives 128kbps mp3 and no uptime guarantee &mdash; move to your own GPU before charging for these."
      : ""
  }</p>
</footer>

<script>${SCRIPT}</script>
</body></html>`;
}
