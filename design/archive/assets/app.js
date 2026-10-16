/* 洋流 Capital Current — 設計稿共用腳本
 * 1. 側欄／頂列骨架（每頁呼叫 CC.shell）
 * 2. 主題（霧白／深海）與損益色彩慣例切換，記在 localStorage
 * 3. 以 SVG 畫「示意資料」圖表：折線、基準比較、資料缺漏區段、迷你走勢
 * 所有數列都是假資料，只用來看版面。
 */
(function () {
  'use strict';

  /* ---------- 圖示（Lucide 風格，24 viewBox，stroke） ---------- */
  var ICONS = {
    overview: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    market: '<path d="M2 6c3-2 5 2 8 0s5 2 8 0 3 0 4 0"/><path d="M2 12c3-2 5 2 8 0s5 2 8 0 3 0 4 0"/><path d="M2 18c3-2 5 2 8 0s5 2 8 0 3 0 4 0"/>',
    assets: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 15h3"/>',
    performance: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    ai: '<path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    swap: '<path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    chevron: '<path d="M9 18l6-6-6-6"/>',
    updown: '<path d="M7 15l5 5 5-5M7 9l5-5 5 5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    wave: '<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-3 5 0"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.1 9.9A6 6 0 1 1 9.9 18.1"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>'
  };
  function icon(name, cls) {
    return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  var MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#139A9A"/><path d="M6 12c3-3 5-3 8 0s5 3 8 0 3-2 4-1" fill="none" stroke="#061A33" stroke-width="2.2" stroke-linecap="round"/><path d="M6 18c3-3 5-3 8 0s5 3 8 0 3-2 4-1" fill="none" stroke="#E6EEF6" stroke-width="2.2" stroke-linecap="round"/><path d="M6 24c3-3 5-3 8 0s5 3 8 0 3-2 4-1" fill="none" stroke="#061A33" stroke-width="2.2" stroke-linecap="round" opacity=".55"/></svg>';

  /* ---------- 導覽結構（規格 9.1） ---------- */
  var NAV = [
    { id: 'overview', label: '總覽', icon: 'overview', href: 'index.html' },
    { id: 'market', label: '市場洋流', icon: 'market', href: 'market.html' },
    { id: 'assets', label: '我的資產', icon: 'assets', href: 'holdings.html', sub: [
      { id: 'networth', label: '淨值儀表板', href: 'index.html#networth' },
      { id: 'holdings', label: '持倉', href: 'holdings.html' },
      { id: 'accounts', label: '帳戶', href: '#' },
      { id: 'transactions', label: '交易紀錄', href: '#' },
      { id: 'dividends', label: '股息', href: '#' },
      { id: 'import', label: '匯入中心', href: 'import.html' }
    ] },
    { id: 'performance', label: '績效分析', icon: 'performance', href: '#' },
    { id: 'ai', label: 'AI 研究', icon: 'ai', href: '#' },
    { id: 'settings', label: '設定', icon: 'settings', href: 'styleguide.html' }
  ];

  function navHtml(active) {
    var h = '<nav class="nav" aria-label="主導覽">';
    NAV.forEach(function (n) {
      var isActive = n.id === active || (n.sub || []).some(function (s) { return s.id === active; });
      h += '<a href="' + n.href + '"' + (n.id === active ? ' aria-current="page"' : '') + '>' + icon(n.icon) + n.label + '</a>';
      if (n.sub && isActive) {
        h += '<div class="sub">';
        n.sub.forEach(function (s) {
          h += '<a href="' + s.href + '"' + (s.id === active ? ' aria-current="page"' : '') + '>' + s.label + '</a>';
        });
        h += '</div>';
      }
    });
    return h + '</nav>';
  }

  /* ---------- 骨架 ---------- */
  function shell(opts) {
    var app = document.querySelector('.app');
    if (!app) return;
    var side = document.createElement('aside');
    side.className = 'side';
    side.innerHTML =
      '<div class="brand">' + MARK + '<div class="brand-name">洋流<small>Capital Current</small></div></div>' +
      navHtml(opts.active) +
      '<div class="side-foot">' +
        '<button class="portfolio-switch" type="button"><span><small>投資組合</small><strong>全部（3 組）</strong></span>' + icon('updown') + '</button>' +
        '<div class="side-user"><span class="avatar">YC</span><span>示意使用者<br><span class="xs">基準幣別 TWD · Asia/Taipei</span></span></div>' +
      '</div>';
    app.insertBefore(side, app.firstChild);

    var main = app.querySelector('.main');
    var top = document.createElement('header');
    top.className = 'topbar';
    var crumbs = (opts.crumbs || []).map(function (c, i, arr) {
      return i === arr.length - 1 ? '<b>' + c + '</b>' : '<span>' + c + '</span><span class="sep">/</span>';
    }).join('');
    top.innerHTML =
      '<div class="crumbs">' + crumbs + '</div>' +
      '<div class="topbar-tools">' +
        '<div class="freshness"><span class="dot' + (opts.stale ? ' stale' : '') + '"></span><span>' + (opts.freshness || '行情 2026-10-16 13:30 · 匯率 2026-10-16 · 估值 v3') + '</span></div>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-toggle="convention" title="切換損益顏色慣例">' + icon('swap') + '<span data-convention-label>紅賺綠虧</span></button>' +
        '<button class="btn btn-ghost btn-sm btn-icon" type="button" data-toggle="theme" aria-label="切換深色模式">' + icon('moon') + '</button>' +
      '</div>';
    main.insertBefore(top, main.firstChild);
    bindToggles();
  }

  /* ---------- 主題／慣例 ---------- */
  var root = document.documentElement;
  try {
    var t = localStorage.getItem('cc-theme'); if (t) root.setAttribute('data-theme', t);
    var c = localStorage.getItem('cc-convention'); if (c) root.setAttribute('data-convention', c);
  } catch (e) {}
  /* 網址參數覆寫（截圖、分享用）：?theme=dark&convention=intl */
  var q = location.search.slice(1).split('&').reduce(function (m, kv) { var p = kv.split('='); if (p[0]) m[p[0]] = p[1] || ''; return m; }, {});
  if (q.theme === 'dark') root.setAttribute('data-theme', 'dark');
  if (q.theme === 'light') root.removeAttribute('data-theme');
  if (q.convention === 'intl') root.setAttribute('data-convention', 'intl');

  function bindToggles() {
    document.querySelectorAll('[data-toggle="theme"]').forEach(function (b) {
      b.innerHTML = icon(root.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon');
      b.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? '' : 'dark';
        if (next) root.setAttribute('data-theme', next); else root.removeAttribute('data-theme');
        try { localStorage.setItem('cc-theme', next); } catch (e) {}
        b.innerHTML = icon(next ? 'sun' : 'moon');
      });
    });
    var lbl = function () {
      var intl = root.getAttribute('data-convention') === 'intl';
      document.querySelectorAll('[data-convention-label]').forEach(function (el) { el.textContent = intl ? '綠賺紅虧' : '紅賺綠虧'; });
    };
    lbl();
    document.querySelectorAll('[data-toggle="convention"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var next = root.getAttribute('data-convention') === 'intl' ? '' : 'intl';
        if (next) root.setAttribute('data-convention', next); else root.removeAttribute('data-convention');
        try { localStorage.setItem('cc-convention', next); } catch (e) {}
        lbl();
      });
    });
    document.querySelectorAll('.tabs').forEach(function (tabs) {
      tabs.addEventListener('click', function (e) {
        var btn = e.target.closest('button'); if (!btn) return;
        tabs.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-selected', x === btn ? 'true' : 'false'); });
      });
    });
  }

  /* ---------- 假資料產生器（確定性，重新整理後不變） ---------- */
  function rng(seed) { var s = seed; return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
  function series(n, start, drift, vol, seed) {
    var r = rng(seed), out = [], v = start;
    for (var i = 0; i < n; i++) { v = v * (1 + drift + (r() - 0.5) * vol); out.push(v); }
    return out;
  }

  /* ---------- SVG 折線圖 ----------
   * opts: { w, h, series:[{values, cls}], gaps:[[i0,i1]], labels:[...], yFmt, markerLast }
   */
  function lineChart(el, opts) {
    var w = opts.w || 720, h = opts.h || 220, pl = 46, pr = 12, pt = 10, pb = 24;
    var all = [].concat.apply([], opts.series.map(function (s) { return s.values; }));
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    var pad = (max - min) * 0.08 || 1; min -= pad; max += pad;
    var n = opts.series[0].values.length;
    var x = function (i) { return pl + (i / (n - 1)) * (w - pl - pr); };
    var y = function (v) { return pt + (1 - (v - min) / (max - min)) * (h - pt - pb); };
    var fmt = opts.yFmt || function (v) { return Math.round(v).toLocaleString(); };
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + (opts.aria || '示意圖表') + '">';
    s += '<defs><linearGradient id="g' + (el.id || 'x') + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--chart-area-from)"/><stop offset="1" stop-color="var(--chart-area-to)"/></linearGradient></defs>';
    s += '<g class="grid">';
    for (var g = 0; g <= 4; g++) {
      var gv = min + (max - min) * g / 4, gy = y(gv);
      s += '<line x1="' + pl + '" x2="' + (w - pr) + '" y1="' + gy + '" y2="' + gy + '"/>';
      s += '<text class="axis" x="' + (pl - 8) + '" y="' + (gy + 3.5) + '" text-anchor="end">' + fmt(gv) + '</text>';
    }
    s += '</g>';
    (opts.gaps || []).forEach(function (gp) {
      s += '<rect class="gap-band" x="' + x(gp[0]) + '" y="' + pt + '" width="' + (x(gp[1]) - x(gp[0])) + '" height="' + (h - pt - pb) + '"/>';
    });
    opts.series.forEach(function (ser, si) {
      var d = ser.values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
      if (si === 0 && opts.area !== false) {
        s += '<path d="' + d + ' L' + x(n - 1).toFixed(1) + ' ' + (h - pb) + ' L' + pl + ' ' + (h - pb) + ' Z" fill="url(#g' + (el.id || 'x') + ')"/>';
      }
      s += '<path class="' + (ser.cls || 'line-main') + '" d="' + d + '"/>';
      (opts.gaps || []).forEach(function (gp) {
        if (si !== 0) return;
        var gd = ''; for (var i = gp[0]; i <= gp[1]; i++) gd += (i === gp[0] ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(ser.values[i]).toFixed(1) + ' ';
        s += '<path class="gap" fill="none" d="' + gd + '"/>';
      });
    });
    if (opts.markerLast !== false) {
      var lv = opts.series[0].values[n - 1];
      s += '<circle class="marker" cx="' + x(n - 1) + '" cy="' + y(lv) + '" r="3.5"/>';
    }
    (opts.labels || []).forEach(function (lb, i, arr) {
      var lx = pl + (i / (arr.length - 1)) * (w - pl - pr);
      s += '<text class="axis" x="' + lx + '" y="' + (h - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle') + '">' + lb + '</text>';
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  function spark(values, cls, w, h) {
    w = w || 56; h = h || 18;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values), n = values.length;
    var d = values.map(function (v, i) {
      return (i ? 'L' : 'M') + (i / (n - 1) * w).toFixed(1) + ' ' + ((1 - (v - min) / ((max - min) || 1)) * (h - 2) + 1).toFixed(1);
    }).join(' ');
    return '<svg class="mini" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.4" class="' + (cls || '') + '"/></svg>';
  }

  /* 洋流流線：市場頁首裝飾 */
  function streams(el) {
    var s = '<svg class="streams" viewBox="0 0 600 300" preserveAspectRatio="none" aria-hidden="true">';
    for (var i = 0; i < 9; i++) {
      var yy = 20 + i * 32, a = 14 + (i % 3) * 6;
      s += '<path d="M0 ' + yy + ' C 100 ' + (yy - a) + ', 200 ' + (yy + a) + ', 300 ' + yy + ' S 500 ' + (yy - a) + ', 600 ' + yy + '" fill="none" stroke="' + (i % 2 ? '#2EB8B5' : '#9DB7D4') + '" stroke-width="' + (1 + (i % 3) * 0.4) + '" stroke-dasharray="' + (i % 2 ? '3 7' : '0') + '" stroke-linecap="round"/>';
    }
    el.insertAdjacentHTML('afterbegin', s + '</svg>');
  }

  window.CC = { shell: shell, icon: icon, lineChart: lineChart, spark: spark, series: series, streams: streams, rng: rng };
})();
