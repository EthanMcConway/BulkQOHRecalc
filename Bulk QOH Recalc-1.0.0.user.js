// ==UserScript==
// @name         Bulk QOH Recalc
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Adds a "Recalc All QOH" button to the Inventory tab that triggers the Recalc QOH action on every non-archived item.
// @match        https://us.merchantos.com/*
// @match        https://eu.merchantos.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, (m) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    ));
  }

  function withErrorBoundary(handler, context = 'operation') {
    return async function (...args) {
      try { return await handler.apply(this, args); }
      catch (error) {
        console.error(`[QRT Error in ${context}]:`, error);
        alert(`Error during ${context}. Check console.`);
        throw error;
      }
    };
  }

  async function processInParallel(items, handler, { concurrency = 2, onProgress = null, signal = null } = {}) {
    const results = [];
    const executing = [];

    for (let i = 0; i < items.length; i++) {
      if (signal?.aborted) break;
      if (i > 0 && i % 50 === 0) {
        console.log('[QRT] Batch pause to drain network queue...');
        await sleep(2000);
        if (signal?.aborted) break;
      }

      const item = items[i];
      const promise = handler(item, i).then(result => {
        executing.splice(executing.indexOf(promise), 1);
        if (onProgress) onProgress(i + 1, items.length, result);
        return result;
      });

      results.push(promise);
      executing.push(promise);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.allSettled(results);
  }

  async function fetchText(url, opts = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...opts });
    const text = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, text };
  }

  async function fetchJson(url, opts = {}) {
    const { ok, status, statusText, text } = await fetchText(url, opts);
    if (!ok) throw new Error(`HTTP ${status} ${statusText} for ${url}`);
    try { return JSON.parse(text); } catch { throw new Error('Non-JSON response'); }
  }

  function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function getAccountId() {
    const el = document.querySelector('#help_account_id var') || document.querySelector('#help_account_id');
    if (el) return el.textContent.trim();
    const m = document.body.innerHTML.match(/\/API\/Account\/(\d+)\//);
    return m ? m[1] : null;
  }

  // ---------- Status GIFs ----------
  const QRT_GIFS = {
    loading: [
      'https://media.tenor.com/tYi19NWNAN8AAAAi/thinking-math.gif',
      'https://media.tenor.com/jwD1lSkdKY4AAAAi/pepe-emote.gif',
      'https://media.tenor.com/fQqJgQAlGSoAAAAi/fet-hmm.gif'
    ],
    // Picked by current item count — first bucket whose upTo > count wins.
    running: [
      { upTo: 100,      url: 'https://media.tenor.com/km-lY7Mlqc4AAAAi/typing-pepe-the-frog.gif' },
      { upTo: 200,      url: 'https://media.tenor.com/SBedvzzMHIoAAAAi/chatting-pepechat.gif' },
      { upTo: 300,      url: 'https://media.tenor.com/u6seASGWv08AAAAi/malding.gif' },
      { upTo: 400,      url: 'https://media.tenor.com/YijNqMHT6KsAAAAj/smadging-smadge.gif' },
      { upTo: Infinity, url: 'https://media1.tenor.com/m/ffN-es3aN5cAAAAd/peepokc-kcpeepo.gif' }
    ],
    done: [
      'https://media.tenor.com/2jyXimGaXXkAAAAi/peepo-hyperyump.gif',
      'https://media.tenor.com/RZ5fesAMlK0AAAAi/peepo-happier-peepo-happy.gif',
      'https://media.tenor.com/Vw2sr_UWA6cAAAAi/pepo-party-celebrate.gif'
    ],
    failed: 'https://media.tenor.com/gx1kZF3d8W8AAAAi/flexo4.gif'
  };

  function preloadGifs() {
    if (preloadGifs._done) return;
    preloadGifs._done = true;
    const urls = [
      ...QRT_GIFS.loading,
      ...QRT_GIFS.running.map(b => b.url),
      ...QRT_GIFS.done,
      QRT_GIFS.failed
    ];
    urls.forEach(u => { const i = new Image(); i.src = u; });
  }

  let qrtGifCycleTimer = null;
  let qrtCurrentGifUrl = null;
  function setGifState(state, count = 0) {
    const img = document.getElementById('qrt-gif');
    if (!img) return;

    if (qrtGifCycleTimer) { clearInterval(qrtGifCycleTimer); qrtGifCycleTimer = null; }

    const setSrc = (url) => {
      if (url === qrtCurrentGifUrl) return; // avoid restarting the same GIF
      qrtCurrentGifUrl = url;
      img.src = url;
    };

    if (state === 'loading') {
      let i = 0;
      const cycle = () => {
        setSrc(QRT_GIFS.loading[i % QRT_GIFS.loading.length]);
        i++;
      };
      cycle();
      qrtGifCycleTimer = setInterval(cycle, 2500);
    } else if (state === 'running') {
      const bucket = QRT_GIFS.running.find(b => count < b.upTo) || QRT_GIFS.running[QRT_GIFS.running.length - 1];
      setSrc(bucket.url);
    } else if (state === 'done') {
      setSrc(QRT_GIFS.done[Math.floor(Math.random() * QRT_GIFS.done.length)]);
    } else if (state === 'failed') {
      setSrc(QRT_GIFS.failed);
    }
  }

  // ---------- Styles (overlay + button polish) ----------
  function injectStyles() {
    if (document.getElementById('qrt-styles')) return;
    const style = document.createElement('style');
    style.id = 'qrt-styles';
    style.textContent = `
      #qrt-overlay {
        position: fixed; bottom: 16px; right: 16px; z-index: 99999;
        background: #1a1a2e; color: #fff;
        padding: 14px 16px; border-radius: 10px;
        font: 13px/1.5 ui-monospace, Consolas, monospace;
        box-shadow: 0 6px 24px rgba(0,0,0,0.35);
        min-width: 300px; max-width: 380px;
      }
      #qrt-overlay header {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 10px;
        font-family: 'Segoe UI', system-ui, sans-serif;
        font-size: 13px; font-weight: 700;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        padding-bottom: 8px;
      }
      #qrt-overlay #qrt-gif {
        width: 44px; height: 44px; flex-shrink: 0;
        border-radius: 6px;
        background: rgba(255,255,255,0.06);
        object-fit: contain;
        image-rendering: auto;
      }
      #qrt-overlay .qrt-line { font-family: 'Segoe UI', system-ui, sans-serif; }
      #qrt-overlay .qrt-count { font-size: 18px; font-weight: 700; margin: 4px 0 10px; }
      #qrt-overlay .qrt-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      #qrt-overlay button {
        background: rgba(255,255,255,0.12); color: #fff;
        border: 1px solid rgba(255,255,255,0.2); border-radius: 5px;
        padding: 5px 10px; cursor: pointer; font-size: 11px;
        font-family: 'Segoe UI', system-ui, sans-serif;
      }
      #qrt-overlay button:hover { background: rgba(255,255,255,0.22); }
      #qrt-overlay button:disabled { opacity: 0.45; cursor: default; }
      #qrt-overlay button.qrt-danger { border-color: #ef5350; color: #ef9a9a; }
      #qrt-overlay button.qrt-danger:hover { background: rgba(239,83,80,0.18); }
    `;
    document.head.appendChild(style);
  }

  // ---------- Button injection ----------
  function findOptionsList() {
    const anchor = document.querySelector('#serialNumbersButton');
    if (!anchor) return null;
    return anchor.closest('ul.options');
  }

  function injectButton() {
    if (document.getElementById('qrt-recalc-all-btn')) return;
    const optionsList = findOptionsList();
    if (!optionsList) return;

    const li = document.createElement('li');
    li.id = 'qrt-recalc-all-li';
    li.innerHTML = `
      <button id="qrt-recalc-all-btn" type="button">
        <i class="icon-refresh"></i>
        <span data-automation="buttonTitle">Recalc All QOH</span>
      </button>
      <p class="explanation">Trigger Recalc QOH on every non-archived item in the account.</p>
    `;
    optionsList.appendChild(li);

    li.querySelector('#qrt-recalc-all-btn').addEventListener(
      'click',
      withErrorBoundary(handleRecalcAllClick, 'bulk QOH recalc')
    );
  }

  // ---------- Floating overlay ----------
  function buildOverlay() {
    document.getElementById('qrt-overlay')?.remove();
    const ov = document.createElement('div');
    ov.id = 'qrt-overlay';
    ov.innerHTML = `
      <header>
        <img id="qrt-gif" alt="">
        <span>Bulk QOH Recalc</span>
      </header>
      <div class="qrt-line" id="qrt-status">Starting…</div>
      <div class="qrt-count" id="qrt-count"></div>
      <div class="qrt-actions">
        <button id="qrt-stop" class="qrt-danger" type="button">Stop</button>
        <button id="qrt-download" type="button" style="display:none;">Download Failed IDs</button>
        <button id="qrt-close" type="button" style="display:none;">Close</button>
      </div>
    `;
    document.body.appendChild(ov);
    return ov;
  }

  // ---------- Item discovery ----------
  // Lightspeed removed `offset` and now uses cursor pagination via @attributes.next.
  // The `next` URL may be absolute (api.lightspeedapp.com host) — we rewrite it to a
  // same-origin path so cookie-based auth keeps working.
  function nextUrlToSameOrigin(next) {
    if (!next || typeof next !== 'string' || !next.trim()) return null;
    try {
      if (/^https?:\/\//i.test(next)) {
        const u = new URL(next);
        return u.pathname + u.search;
      }
      return next.startsWith('/') ? next : '/' + next;
    } catch {
      return null;
    }
  }

  async function fetchAllNonArchivedItems(accountId, onProgress, signal) {
    const all = [];
    const PAGE = 100;
    let url = `/API/V3/Account/${accountId}/Item.json?limit=${PAGE}&archived=false`;

    while (url) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const data = await fetchJson(url, { signal });
      let items = data.Item ?? [];
      if (!Array.isArray(items)) items = items ? [items] : [];
      if (items.length) {
        // Defensive client-side archived filter in case the query param is ignored.
        const nonArchived = items.filter(i => String(i.archived) !== 'true');
        all.push(...nonArchived);
        if (onProgress) onProgress(all.length);
      }
      url = nextUrlToSameOrigin(data?.['@attributes']?.next);
    }
    return all;
  }

  // ---------- Per-item recalc ----------
  async function recalcOne(itemId, signal) {
    const body = new URLSearchParams({
      form_name: 'view.dofunction',
      fnc: 'refresh_qoh',
      pannel_id: 'view',
      ajax_view: JSON.stringify({
        name: 'item.views.item',
        record_id: Number(itemId),
        tab: 'details',
        title: `Item: ${itemId}`,
        count: 0,
        rec_num: 0,
        type: 'view'
      }),
      key_values: JSON.stringify({
        view_id: '',
        primary_id: String(itemId)
      })
    });

    let attempts = 0;
    while (attempts < 3) {
      try {
        const res = await fetch(
          `/ajax_forms.php?ajax=1&no_cache=${Date.now()}&form_name=view.dofunction`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true };
      } catch (e) {
        if (e.name === 'AbortError') return { success: false, aborted: true };
        attempts++;
        if (attempts >= 3) return { success: false, error: e.message };
        await sleep(2000);
      }
    }
  }

  // ---------- Main run handler ----------
  async function handleRecalcAllClick() {
    const accountId = getAccountId();
    if (!accountId) {
      alert('Could not detect Account ID on this page.');
      return;
    }

    if (!confirm('This will trigger Recalc QOH on every non-archived item in the account. Continue?')) {
      return;
    }

    injectStyles();
    preloadGifs();
    buildOverlay();
    const statusEl = document.getElementById('qrt-status');
    const countEl = document.getElementById('qrt-count');
    const stopBtn = document.getElementById('qrt-stop');
    const dlBtn = document.getElementById('qrt-download');
    const closeBtn = document.getElementById('qrt-close');

    let aborted = false;
    const controller = new AbortController();
    stopBtn.onclick = () => {
      aborted = true;
      controller.abort();
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
    };

    const finalize = (gif) => {
      setGifState(gif);
      stopBtn.style.display = 'none';
      closeBtn.style.display = '';
      closeBtn.onclick = () => {
        if (qrtGifCycleTimer) { clearInterval(qrtGifCycleTimer); qrtGifCycleTimer = null; }
        document.getElementById('qrt-overlay')?.remove();
      };
    };

    // Step 1: discover items
    statusEl.textContent = 'Discovering items…';
    setGifState('loading');
    let items;
    try {
      items = await fetchAllNonArchivedItems(accountId, (n) => {
        countEl.textContent = `Loaded ${n.toLocaleString()} items`;
      });
    } catch (e) {
      console.error('[QRT] Item discovery failed:', e);
      statusEl.textContent = `Discovery failed: ${e.message}`;
      finalize('failed');
      return;
    }

    if (!items.length) {
      statusEl.textContent = 'No non-archived items found.';
      finalize('done');
      return;
    }

    if (aborted) return;

    if (!confirm(`Found ${items.length.toLocaleString()} items. Run Recalc QOH on all of them now?`)) {
      statusEl.textContent = 'Cancelled before run.';
      finalize('failed');
      return;
    }

    // Step 2: recalc each
    statusEl.textContent = `Recalculating ${items.length.toLocaleString()} items…`;
    setGifState('running', 0);
    const failed = [];
    let skipped = 0;

    await processInParallel(items, async (item) => {
      if (aborted) return { success: false, aborted: true, id: item.itemID };
      const res = await recalcOne(item.itemID, controller.signal);
      if (!res.success) {
        if (res.aborted) return { success: false, aborted: true, id: item.itemID };
        return { success: false, id: item.itemID, error: res.error };
      }
      return { success: true, id: item.itemID };
    }, {
      concurrency: 2,
      onProgress: (done, total, result) => {
        countEl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
        setGifState('running', done);
        if (result && !result.success) {
          if (result.aborted) skipped++;
          else if (result.id) failed.push(String(result.id));
        }
      }
    });

    // Step 3: report
    const succeeded = items.length - failed.length - skipped;
    statusEl.textContent = aborted
      ? `Stopped. ${succeeded} recalc'd, ${failed.length} failed, ${skipped} skipped.`
      : `Done. ${succeeded} recalc'd, ${failed.length} failed.`;
    finalize(aborted || succeeded === 0 ? 'failed' : 'done');

    if (failed.length) {
      dlBtn.style.display = '';
      const batchId = Date.now().toString(36);
      dlBtn.onclick = () => {
        const csv = 'item_id\n' + [...new Set(failed)].join('\n');
        downloadCSV(csv, `qoh_recalc_failed_${batchId}.csv`);
      };
    }
  }

  // ---------- Boot + SPA keep-alive ----------
  function tryInject() {
    if (findOptionsList()) injectButton();
  }

  tryInject();

  let observerTimeout;
  const obs = new MutationObserver(() => {
    if (observerTimeout) return;
    observerTimeout = setTimeout(() => {
      observerTimeout = null;
      tryInject();
    }, 150);
  });

  obs.observe(document.body, { childList: true, subtree: true });
})();
