// Server-rendered public pages. No client-side framework; plain HTML and one stylesheet.
import { Hono } from 'hono';
import { html } from 'hono/html';
import type { Child } from 'hono/jsx';
import logoSvg from '../assets/logo.svg';
import * as q from './db/queries';
import { describeRevision, TRUST_HELP, TRUST_LABELS, type ChangeLine, type Trust } from './lib/changeText';
import { CURRENCIES, formatMinor, isCurrency, STATUS_LABELS, STATUSES, type Status } from './lib/normalize';
import type { Env } from './env';

export const pages = new Hono<{ Bindings: Env }>();

const DARK_VARS = `
  --bg: #0f1216; --panel: #171b21; --text: #e6e9ed; --muted: #98a2ae; --line: #2a3038; --link: #6cb0ff;
  --good: #4cc26a; --warn: #e0a63a; --bad: #ff6b6b; --neutral: #9aa4af; --chip: #222830; color-scheme: dark;`;

// The theme follows the device unless the visitor used the switch, which sets data-theme on <html>.
const CSS = `
:root {
  --bg: #f6f7f9; --panel: #fff; --text: #1b1f24; --muted: #5f6b7a; --line: #dfe3e8; --link: #1558b0;
  --good: #1a7f37; --warn: #9a6700; --bad: #c62828; --neutral: #57606a; --chip: #eef1f4; color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme=light]) {${DARK_VARS}
  }
}
:root[data-theme=dark] {${DARK_VARS}
}
:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }
.skip { position: absolute; left: -9999px; top: 8px; z-index: 50; padding: 8px 14px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.skip:focus { left: 8px; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
header.site .inner, main, footer { max-width: 1100px; margin: 0 auto; padding: 0 16px; }

/* Top bar: the logo's navy and gold in both light and dark themes. */
header.site { position: sticky; top: 0; z-index: 20; color: #dfe6f5; background: linear-gradient(180deg, #14213f, #0d1730); border-bottom: 1px solid #263760; box-shadow: 0 1px 10px rgba(0, 0, 0, .28); }
header.site .inner { display: flex; align-items: stretch; gap: 0 20px; max-width: 1280px; min-height: 58px; }
header.site a:hover { text-decoration: none; }
header.site .brand { display: flex; align-items: center; gap: 11px; color: #fff; white-space: nowrap; }
header.site .brand img { filter: drop-shadow(0 0 6px rgba(242, 184, 75, .35)); }
header.site .brand .name { display: grid; line-height: 1.15; font-size: 17px; font-weight: 700; letter-spacing: .01em; }
header.site .brand .name small { font-size: 10.5px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: #f2b84b; }
header.site nav { display: flex; align-items: stretch; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
header.site nav a { display: flex; align-items: center; padding: 0 12px; color: #aebbd6; font-size: 14px; font-weight: 500; white-space: nowrap; border-bottom: 2px solid transparent; border-top: 2px solid transparent; transition: color .15s, border-color .15s, background-color .15s; }
header.site nav a:hover { color: #fff; background: rgba(255, 255, 255, .05); }
header.site nav a[aria-current] { color: #fff; border-bottom-color: #f2b84b; }
header.site .theme { display: grid; place-items: center; align-self: center; flex: none; width: 34px; height: 34px; padding: 0; color: #dfe6f5; background: none; border: 1px solid #2c3f6e; border-radius: 50%; cursor: pointer; }
header.site .theme:hover { background: rgba(255, 255, 255, .07); border-color: #3d5490; }
header.site .theme .sun, header.site .theme[data-mode=dark] .moon { display: none; }
header.site .theme[data-mode=dark] .sun { display: block; }
header.site .auth { position: relative; display: flex; align-items: center; min-width: 96px; justify-content: flex-end; }
header.site .signin { padding: 7px 14px; border-radius: 8px; color: #fff; background: #5865f2; font-size: 14px; font-weight: 600; white-space: nowrap; }
header.site .signin:hover { background: #4752c4; }
header.site details.user summary { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; color: #fff; font-size: 14px; font-weight: 500; border: 1px solid #2c3f6e; border-radius: 999px; cursor: pointer; list-style: none; user-select: none; }
header.site details.user summary::-webkit-details-marker { display: none; }
header.site details.user summary::after { content: "▾"; color: #aebbd6; font-size: 12px; }
header.site details.user summary:hover, header.site details.user[open] summary { background: rgba(255, 255, 255, .07); border-color: #3d5490; }
header.site img.avatar { object-fit: cover; }
header.site .avatar { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: #101a33; background: #f2b84b; font-size: 13px; font-weight: 700; text-transform: uppercase; }
header.site .attn { width: 9px; height: 9px; margin-left: -14px; margin-top: -18px; background: #ff6b6b; border: 2px solid #14213f; border-radius: 50%; box-sizing: content-box; }
header.site .uname { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header.site .menu { position: absolute; right: 0; top: calc(100% - 6px); display: grid; min-width: 210px; padding: 6px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 28px rgba(0, 0, 0, .3); }
header.site .menu .who { padding: 6px 10px 8px; margin-bottom: 4px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); }
header.site .menu a, header.site .menu button { display: block; width: 100%; padding: 8px 10px; color: var(--text); background: none; border: 0; border-radius: 6px; font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
header.site .menu a:hover, header.site .menu button:hover { background: var(--chip); }
@media (max-width: 860px) {
  header.site .inner { flex-wrap: wrap; padding-top: 8px; }
  header.site .brand { flex: 1; }
  header.site .theme { margin-right: 12px; }
  header.site nav { order: 3; flex-basis: 100%; height: 42px; margin: 6px -16px 0; padding: 0 8px; border-top: 1px solid #263760; }
}
main { padding-top: 24px; padding-bottom: 40px; }
main.wide { max-width: none; }
footer { color: var(--muted); font-size: 13px; padding-bottom: 32px; }
h1 { font-size: 26px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 18px; margin: 32px 0 10px; }
p.sub { color: var(--muted); margin: 0 0 16px; }
p.hint { color: var(--muted); font-size: 13px; margin: -4px 0 16px; }
form.pick { display: flex; align-items: center; gap: 10px; margin: 0 0 16px; }
form.pick select, form.pick button { padding: 7px 10px; font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
form.search { display: flex; gap: 8px; margin: 16px 0; }
form.search input { flex: 1; min-width: 0; padding: 10px 12px; font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
form.search button { padding: 10px 18px; font: inherit; font-weight: 600; color: #fff; background: #1558b0; border: 0; border-radius: 6px; cursor: pointer; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.card .cur { font-weight: 700; font-size: 13px; color: var(--muted); letter-spacing: .04em; }
.card .big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.card dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 8px 0 0; font-size: 14px; }
.card dt { color: var(--muted); }
.card dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.wrap { white-space: normal; min-width: 220px; overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--chip); }
.badge.good { color: var(--good); } .badge.warn { color: var(--warn); } .badge.bad { color: var(--bad); } .badge.neutral { color: var(--neutral); }
.muted { color: var(--muted); }
.alert { border-left: 4px solid var(--bad); }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }

/* Verdict banner: the answer, then the figures behind it. */
.verdict { margin: 0 0 12px; padding: 16px 18px; background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--neutral); border-radius: 10px; }
.verdict.good { border-left-color: var(--good); } .verdict.warn { border-left-color: var(--warn); } .verdict.bad { border-left-color: var(--bad); }
.verdict .headline { margin: 0; font-size: 19px; font-weight: 650; line-height: 1.35; }
.verdict .detail { margin: 4px 0 0; color: var(--muted); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px 28px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.stats.first { margin-top: 0; padding-top: 0; border-top: 0; }
.stat .label { color: var(--muted); font-size: 13px; }
.stat .big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat .unit { color: var(--muted); font-size: 13px; font-weight: 600; }
.stat .note { color: var(--muted); font-size: 12px; }
.stat ul.parts { margin: 4px 0 0; padding: 0; list-style: none; font-size: 13px; font-variant-numeric: tabular-nums; }
.stat ul.parts span { display: inline-block; width: 36px; color: var(--muted); }
.stat ul.names { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.fresh { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.trust { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 13px; white-space: nowrap; }
.trust svg { flex: none; }
.trust.fio_verified { color: var(--good); }
h2.flush { margin-top: 0; }
.cols > .panel h2 { font-size: 16px; margin: 20px 0 6px; }
.cols > .panel h2.flush { margin-top: 0; }
.cols > .panel p { margin: 0 0 8px; }
dl.facts.small { margin-top: 8px; font-size: 13px; gap: 3px 16px; }
ol.timeline { margin: 0 0 0 6px; padding: 0; list-style: none; border-left: 2px solid var(--line); }
ol.timeline li { position: relative; padding: 0 0 18px 20px; }
ol.timeline li:last-child { padding-bottom: 0; }
ol.timeline li::before { content: ""; position: absolute; left: -7px; top: 5px; width: 8px; height: 8px; background: var(--bg); border: 2px solid var(--neutral); border-radius: 50%; }
ol.timeline li.person::before { border-color: var(--link); background: var(--link); }
.timeline .when { color: var(--muted); font-size: 13px; }
.timeline .what { font-weight: 600; }
.timeline .line { font-size: 14px; overflow-wrap: anywhere; }
.timeline .from { color: var(--muted); }
.timeline details { margin-top: 4px; font-size: 13px; }
.timeline summary { color: var(--link); cursor: pointer; }
nav.contents { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 0 0 16px; }
nav.contents a { padding: 4px 12px; font-size: 14px; background: var(--chip); border-radius: 999px; }
.panel.about { margin-bottom: 12px; scroll-margin-top: 76px; }
.panel.about h2 { margin-top: 0; }
.panel.about p:last-child, .panel.about ul:last-child { margin-bottom: 0; }
.panel.about dt { scroll-margin-top: 76px; }
:root[data-connected] .track-cta { display: none; }
:root[data-connected] a.track-link { color: inherit; pointer-events: none; }
.prompt { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin: 0 0 16px; padding: 10px 14px; background: var(--panel); border: 1px solid var(--line); border-left: 4px solid #f2b84b; border-radius: 8px; }
.prompt button { padding: 4px 10px; color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer; }
a.button { display: inline-block; padding: 9px 16px; color: #fff; background: #1558b0; border-radius: 6px; font-weight: 600; }
a.button:hover { text-decoration: none; background: #114a94; }
section.mine + section.mine { margin-top: 40px; padding-top: 8px; border-top: 1px solid var(--line); }
p.hint.spaced { margin: 12px 0 8px; }
.titlebar { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
button.ghost { min-height: 34px; padding: 6px 14px; color: var(--link); background: none; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 14px; cursor: pointer; }
button.ghost:hover { background: var(--chip); }
.hero-block { padding: 20px 0 4px; text-align: center; }
.hero-block h1 { font-size: 30px; }
form.search.hero { max-width: 720px; margin: 20px auto 8px; }
form.search.hero input { padding: 14px 16px; font-size: 17px; }
form.search.hero button { padding: 14px 24px; font-size: 16px; }
.cols.three { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.cols.three p { margin: 6px 0 0; }
ul.next { margin: 8px 0 0; padding-left: 20px; }
th a { color: inherit; } th [aria-current] { color: var(--text); }

/* Phones: tables marked "stack" become one card per row, with the column name beside each value. */
@media (max-width: 640px) {
  h1 { font-size: 23px; } .hero-block h1 { font-size: 24px; }
  form.search { flex-wrap: wrap; } form.search button { flex: 1; }
  table.stack thead { position: absolute; left: -9999px; }
  table.stack tr { display: block; padding: 8px 0; border-bottom: 1px solid var(--line); }
  table.stack tr:last-child { border-bottom: 0; }
  table.stack td { display: flex; justify-content: space-between; gap: 16px; padding: 3px 12px; border: 0; white-space: normal; text-align: right; }
  table.stack td::before { content: attr(data-label); flex: none; color: var(--muted); text-align: left; }
  table.stack td:empty { display: none; }
  table.stack td.wrap { min-width: 0; }
}
`;

/** Marks the tab for the current page. Runs right after the nav is parsed, so there is no flicker. */
const NAV_SCRIPT = `(function () {
  var p = location.pathname;
  document.querySelectorAll('#nav a').forEach(function (a) {
    var h = a.getAttribute('href');
    var on = h === '/' ? p === '/' || p === '/search' || p.indexOf('/borrowers/') === 0 : p === h || p.indexOf(h + '/') === 0;
    if (on) a.setAttribute('aria-current', 'page');
  });
})();`;

/** Fills the right-hand corner: a sign-in button, or the user's menu. */
const AUTH_SCRIPT = `(function () {
  var el = document.getElementById('auth');
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  fetch('/auth/me').then(function (r) { return r.json(); }).then(function (d) {
    // Someone who already tracks their loans is not asked to again: prompts go, and inline links become plain text.
    var connected = Boolean(d.user && d.lenders && d.lenders.length);
    try { if (connected) localStorage.setItem('connected', '1'); else localStorage.removeItem('connected'); } catch (e) {}
    if (connected) {
      document.documentElement.dataset.connected = '1';
      document.querySelectorAll('a.track-link').forEach(function (a) { a.replaceWith(document.createTextNode(a.textContent.trim())); });
    } else {
      delete document.documentElement.dataset.connected;
    }
    if (!d.user) {
      if (!d.signInAvailable) return;
      var a = node('a', 'signin', 'Sign in with Discord');
      a.href = '/auth/login?return=' + encodeURIComponent(location.pathname + location.search);
      el.append(a);
      return;
    }
    var menu = node('details', 'user');
    var summary = node('summary');
    var initial = node('span', 'avatar', d.user.name.slice(0, 1));
    var face = initial;
    if (d.user.avatarUrl) {
      face = node('img', 'avatar');
      face.src = d.user.avatarUrl;
      face.alt = '';
      face.width = 28;
      face.height = 28;
      face.referrerPolicy = 'no-referrer';
      face.onerror = function () { face.replaceWith(initial); };
    }
    summary.append(face, node('span', 'uname', d.user.name));
    var lenders = d.lenders || [];
    var failing = lenders.filter(function (l) { return !l.ok; });
    if (failing.length) {
      var dot = node('span', 'attn');
      dot.title = 'Your FIO key needs attention';
      summary.append(dot);
    }
    var panel = node('div', 'menu');
    var mine = null;
    if (lenders.length) {
      mine = node('a', '', failing.length ? 'My lending (FIO key needs attention)' : 'My lending');
      mine.href = '/my-lending';
    }
    var track = node('a', '', 'Track my loans');
    track.href = '/track';
    var out = node('button', '', 'Sign out');
    out.type = 'button';
    out.onclick = function () { fetch('/auth/logout', { method: 'POST' }).then(function () { location.reload(); }); };
    panel.append(node('div', 'who', 'Signed in with Discord'));
    if (mine) panel.append(mine);
    panel.append(track, out);
    menu.append(summary, panel);
    el.append(menu);
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu.open = false; });

    // A lender who has signed in but not connected FIO gets one nudge on the Lookup page, until dismissed.
    var dismissed = false;
    try { dismissed = localStorage.getItem('trackPrompt') === 'off'; } catch (e) {}
    var main = document.getElementById('main');
    if (!lenders.length && !dismissed && location.pathname === '/' && main) {
      var prompt = node('div', 'prompt');
      var text = node('span', '', 'Do you lend? Connect FIO once and your loans stay up to date here without typing. ');
      var go = node('a', '', 'Track my loans');
      go.href = '/track';
      text.append(go);
      var close = node('button', '', 'Not now');
      close.type = 'button';
      close.onclick = function () {
        try { localStorage.setItem('trackPrompt', 'off'); } catch (e) {}
        prompt.remove();
      };
      prompt.append(text, close);
      main.prepend(prompt);
    }
  }).catch(function () {});
})();`;

/** Applies a saved theme choice, and whether this user already tracks their loans, before the first paint so nothing flashes. */
const THEME_HEAD_SCRIPT = `try { var t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; if (localStorage.getItem('connected') === '1') document.documentElement.dataset.connected = '1'; } catch (e) {}`;

/** The switch: flips between light and dark and remembers the choice on this device. */
const THEME_SCRIPT = `(function () {
  var b = document.getElementById('theme'), root = document.documentElement, mq = matchMedia('(prefers-color-scheme: dark)');
  function mode() { return root.dataset.theme || (mq.matches ? 'dark' : 'light'); }
  function paint() {
    var m = mode(), label = 'Switch to ' + (m === 'dark' ? 'light' : 'dark') + ' theme';
    b.dataset.mode = m; b.title = label; b.setAttribute('aria-label', label);
  }
  b.onclick = function () {
    var next = mode() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) {}
    paint();
  };
  mq.addEventListener('change', paint);
  paint();
})();`;

/** Search suggestions while typing, from the public search API. */
const SUGGEST_SCRIPT = `(function () {
  var input = document.getElementById('q'), list = document.getElementById('q-suggest'), timer, last = '';
  if (!input || !list) return;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    var v = input.value.trim();
    if (v.length < 2 || v === last) return;
    timer = setTimeout(function () {
      last = v;
      fetch('/api/v1/search?q=' + encodeURIComponent(v)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) return;
        var seen = {};
        list.textContent = '';
        d.borrowers.concat(d.lenders).forEach(function (x) {
          var key = x.username.toLowerCase();
          if (seen[key] || list.children.length >= 12) return;
          seen[key] = 1;
          var o = document.createElement('option');
          o.value = x.username;
          if (x.companyCode) o.label = x.username + ' (' + x.companyCode + ')';
          list.append(o);
        });
      }).catch(function () {});
    }, 160);
  });
})();`;

/** Small page behaviours: copy-link buttons, and times shown as "12 minutes ago". */
const PAGE_SCRIPT = `(function () {
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(location.href).then(function () {
      var was = b.textContent;
      b.textContent = 'Link copied';
      setTimeout(function () { b.textContent = was; }, 1800);
    });
  });
  document.querySelectorAll('time[data-rel]').forEach(function (t) {
    var s = (Date.now() - Date.parse(t.dateTime)) / 1000;
    if (isNaN(s) || s < 0) return;
    t.title = t.textContent;
    t.textContent = s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' minutes ago' : s < 172800 ? Math.round(s / 3600) + ' hours ago' : Math.round(s / 86400) + ' days ago';
  });
})();`;

const SITE_DESCRIPTION = 'A public record of lending between Prosperous Universe players.';

export const Layout = (props: { title: string; description?: string; wide?: boolean; children?: Child }) => html`<!doctype html>${(
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title} · PrUn Galactic Credit Bureau</title>
      <meta name="description" content={props.description ?? SITE_DESCRIPTION} />
      {/* Link previews (Discord and others). */}
      <meta property="og:site_name" content="PrUn Galactic Credit Bureau" />
      <meta property="og:title" content={props.title} />
      <meta property="og:description" content={props.description ?? SITE_DESCRIPTION} />
      <meta property="og:type" content="website" />
      <meta name="theme-color" content="#f2b84b" />
      <link rel="icon" type="image/svg+xml" href="/logo.svg" />
      <script dangerouslySetInnerHTML={{ __html: THEME_HEAD_SCRIPT }} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="site">
        <div class="inner">
          <a class="brand" href="/" aria-label="PrUn Galactic Credit Bureau, home">
            <img src="/logo.svg" alt="" width="34" height="34" />
            <span class="name">
              <small>PrUn Galactic</small>
              Credit Bureau
            </span>
          </a>
          <nav id="nav" aria-label="Main">
            <a href="/">Lookup</a>
            <a href="/ledger">Ledger</a>
            <a href="/lenders">Lenders</a>
            <a href="/leaderboards">Leaderboards</a>
            <a href="/changes">Changes</a>
            <a href="/about">About</a>
          </nav>
          <script dangerouslySetInnerHTML={{ __html: NAV_SCRIPT }} />
          <button type="button" id="theme" class="theme">
            <svg class="moon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
            <svg class="sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="currentColor" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </button>
          <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
          <div id="auth" class="auth"></div>
        </div>
      </header>
      <main id="main" class={props.wide ? 'wide' : undefined}>
        {props.children}
      </main>
      <footer>
        A public record of lending in Prosperous Universe. Amounts are in-game currency.
      </footer>
      <script dangerouslySetInnerHTML={{ __html: AUTH_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: PAGE_SCRIPT }} />
    </body>
  </html>
)}`;

const STATUS_TONE: Record<Status, string> = {
  in_progress: 'neutral',
  complete: 'good',
  overdue: 'warn',
  breached: 'bad',
  terminated: 'neutral',
  stale: 'warn',
};

/** One sentence on what each status means. Shown on hover and on the About page. */
const STATUS_HELP: Record<Status, string> = {
  in_progress: 'Paid out and being repaid.',
  overdue: 'A payment deadline has passed.',
  breached: 'The contract was breached in game.',
  complete: 'Fully repaid.',
  terminated: 'Ended early: a cancelled offer or a negotiated exit. Not counted in totals.',
  stale: 'Long past maturity and FIO no longer reports it, so the outcome is unknown.',
};

const StatusBadge = ({ status }: { status: Status }) => (
  <span class={`badge ${STATUS_TONE[status]}`} title={STATUS_HELP[status]}>
    {STATUS_LABELS[status]}
  </span>
);

const TRUST_ICONS: Record<Trust, Child> = {
  // A tick in a circle: checked against the game.
  fio_verified: (
    <>
      <circle cx="8" cy="8" r="6.6" />
      <path d="M5 8.3l2.1 2.1 4-4.4" />
    </>
  ),
  // A person: the lender's own word.
  lender_reported: (
    <>
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M2.9 13.6c.8-2.7 2.8-4 5.1-4s4.3 1.3 5.1 4" />
    </>
  ),
  // A pencil: typed in by hand.
  community_edited: <path d="M2.8 13.2l.7-3L10.7 3l2.3 2.3-7.2 7.2-3 .7z" />,
};

/** Where a loan's information came from: an icon and a word, linked to the explanation. `plain` drops the link. */
const TrustMark = ({ trust, plain }: { trust: Trust; plain?: boolean }) => {
  const body = (
    <>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {TRUST_ICONS[trust]}
      </svg>
      {TRUST_LABELS[trust]}
    </>
  );
  return plain ? (
    <span class={`trust ${trust}`}>{body}</span>
  ) : (
    <a class={`trust ${trust}`} href={`/about#trust-${trust}`} title={TRUST_HELP[trust]}>
      {body}
    </a>
  );
};

const Money = ({ minor, currency }: { minor: number; currency: string | null }) => (
  <>
    {formatMinor(minor)} <span class="muted">{currency ?? 'non-cash'}</span>
  </>
);

const day = (iso: string) => iso.slice(0, 10);
export const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
export const borrowerUrl = (name: string) => `/borrowers/${encodeURIComponent(name)}`;
export const lenderUrl = (name: string) => `/lenders/${encodeURIComponent(name)}`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Search box with suggestions as you type. `hero` is the large one on the home page. */
const SearchForm = ({ value, hero }: { value?: string; hero?: boolean }) => (
  <>
    <form class={hero ? 'search hero' : 'search'} action="/search" method="get" role="search">
      <input
        type="search"
        id="q"
        name="q"
        list="q-suggest"
        value={value ?? ''}
        placeholder="Borrower or lender username, or company code"
        aria-label="Search for a borrower or lender"
        required
        minlength={2}
        autocomplete="off"
        autofocus={hero}
      />
      <datalist id="q-suggest"></datalist>
      <button type="submit">Search</button>
    </form>
    <script dangerouslySetInnerHTML={{ __html: SUGGEST_SCRIPT }} />
  </>
);

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** The answer at the top of a page: one sentence, then the figures behind it. */
export const Verdict = ({ tone, headline, detail, children }: { tone: Tone; headline: string; detail?: Child; children?: Child }) => (
  <section class={`verdict ${tone}`} aria-label="Summary">
    <p class="headline">{headline}</p>
    {detail && <p class="detail">{detail}</p>}
    <div class="stats">{children}</div>
  </section>
);

export const Stat = ({ label, value, note, children }: { label: string; value: Child; note?: Child; children?: Child }) => (
  <div class="stat">
    <div class="label">{label}</div>
    <div class="big">{value}</div>
    {note && <div class="note">{note}</div>}
    {children}
  </div>
);

/**
 * A money figure: combined across currencies first, then each currency that contributes.
 * With a single currency there is nothing to combine, so it is shown as that currency's amount.
 */
export const MoneyStat = ({ label, combinedMinor, exposure, pick }: { label: string; combinedMinor: number; exposure: q.Exposure[]; pick: (e: q.Exposure) => number }) => {
  const parts = exposure.filter((e) => e.currency !== null && pick(e) > 0);
  return (
    <Stat
      label={label}
      value={
        <>
          {formatMinor(combinedMinor)}
          {parts.length === 1 && <span class="unit"> {parts[0]!.currency}</span>}
        </>
      }
    >
      {parts.length > 1 && (
        <ul class="parts">
          {parts.map((e) => (
            <li>
              <span>{e.currency}</span>
              {formatMinor(pick(e))}
            </li>
          ))}
        </ul>
      )}
    </Stat>
  );
};

/** When the automatically tracked data was last checked against FIO. */
const Freshness = ({ health }: { health: q.SyncHealth[] }) => {
  if (health.length === 0) return null;
  const last = health.reduce((latest, h) => (h.checkedAt > latest ? h.checkedAt : latest), '');
  const current = health.filter((h) => h.ok).length;
  return (
    <p class="fresh">
      Tracked loans last checked against FIO{' '}
      <time datetime={last} data-rel>
        {stamp(last)}
      </time>
      ; <a href="/lenders">
        {current} of {plural(health.length, 'tracked lender')} current
      </a>
      .
    </p>
  );
};

const CopyLink = () => (
  <button type="button" class="ghost" data-copy>
    Copy link
  </button>
);

export const LoanTable = ({ loans, hide }: { loans: q.Loan[]; hide?: 'lender' | 'borrower' }) =>
  loans.length === 0 ? (
    <p class="muted">None.</p>
  ) : (
    <div class="scroll">
      <table class="stack">
        <thead>
          <tr>
            <th>Issued</th>
            {hide !== 'lender' && <th>Lender</th>}
            {hide !== 'borrower' && <th>Borrower</th>}
            <th class="num">Amount</th>
            <th class="num">Weeks</th>
            <th>Status</th>
            <th>Contract</th>
            <th>Trust</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {loans.map((l) => (
            <tr>
              <td data-label="Issued">
                <a href={`/loans/${l.id}`}>{l.issuedOn}</a>
              </td>
              {hide !== 'lender' && (
                <td data-label="Lender">
                  <a href={lenderUrl(l.lender)}>{l.lender}</a>
                </td>
              )}
              {hide !== 'borrower' && (
                <td data-label="Borrower">
                  <a href={borrowerUrl(l.borrower.username)}>{l.borrower.username}</a>
                </td>
              )}
              <td class="num" data-label="Amount">
                <span>
                  <Money minor={l.principalMinor} currency={l.currency} />
                </span>
              </td>
              <td class="num" data-label="Weeks">
                {l.durationWeeks === null ? '–' : Number(l.durationWeeks.toFixed(1))}
              </td>
              <td data-label="Status">
                <span>
                  <StatusBadge status={l.status} />
                  {l.everBreached && l.status !== 'breached' && <span class="badge bad" style="margin-left:4px">was breached</span>}
                </span>
              </td>
              <td data-label="Contract">{l.contractId ?? <span class="muted">–</span>}</td>
              <td data-label="Trust">
                <TrustMark trust={l.trust} />
              </td>
              <td class="wrap" data-label="Notes">
                {l.notes ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

/** Loans still running or left unresolved, as opposed to finished ones. */
export const isOpen = (l: q.Loan) => l.status !== 'complete' && l.status !== 'terminated';

const NotFound = ({ what, children }: { what: string; children?: Child }) => (
  <Layout title="Not found">
    <h1>Not found</h1>
    <p class="sub">{what}</p>
    <SearchForm />
    {children}
  </Layout>
);

/** "No record" must not read as "clean record". */
const NoRecord = ({ name }: { name: string }) => (
  <div class="panel">
    <p>
      <strong>No lender has reported a loan to “{name}”.</strong> That is not the same as a clean history: lenders report to the bureau by choice, and
      loans made outside it do not appear.
    </p>
    <ul class="next">
      <li>Check the spelling, or search by part of the name.</li>
      <li>Try the player's company code instead.</li>
      <li>
        See <a href="/lenders">which lenders report</a> to judge how much of the market the bureau covers.
      </li>
    </ul>
  </div>
);

pages.get('/logo.svg', (c) => c.body(logoSvg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }));

pages.get('/', async (c) => {
  const [totals, health, { loans: breached }] = await Promise.all([
    q.getTotals(c.env.DB),
    q.getSyncHealth(c.env.DB),
    q.listLoans(c.env.DB, { status: 'breached', limit: 5, offset: 0 }),
  ]);
  const all = q.combine(totals.exposure);
  return c.html(
    <Layout title="Borrower lookup" description="Check what a Prosperous Universe player already owes, and to whom, before you lend.">
      <div class="hero-block">
        <h1>Check a borrower before you lend</h1>
        <p class="sub">See what a player already owes, to whom, and how their past loans ended.</p>
        <SearchForm hero />
      </div>

      <h2>On record</h2>
      <section class="verdict neutral" aria-label="Bureau totals">
        <div class="stats first">
          <MoneyStat label="Out on loan now" combinedMinor={all.currentMinor} exposure={totals.exposure} pick={(e) => e.currentMinor} />
          <MoneyStat label="Lent, all time" combinedMinor={all.totalMinor} exposure={totals.exposure} pick={(e) => e.totalMinor} />
          <Stat label="Loans" value={totals.loans.toLocaleString('en-US')} note={`${plural(totals.lenders, 'lender')} · ${plural(totals.borrowers, 'borrower')}`} />
        </div>
      </section>
      <Freshness health={health} />

      {breached.length > 0 && (
        <>
          <h2>Latest loans in breach</h2>
          <LoanTable loans={breached} />
        </>
      )}

      <h2>How it works</h2>
      <div class="cols three">
        <div class="panel">
          <strong>Lenders report</strong>
          <p class="muted">
            Lenders{' '}
            <a class="track-link" href="/track">
              connect FIO
            </a>{' '}
            and their loan contracts are read every hour. Anything else can be added by hand in the{' '}
            <a href="/ledger">ledger</a>.
          </p>
        </div>
        <div class="panel">
          <strong>Everyone can check</strong>
          <p class="muted">Every loan, status and change is public. No account is needed to look someone up.</p>
        </div>
        <div class="panel">
          <strong>The record stays honest</strong>
          <p class="muted">
            Each loan shows where it came from, and every edit is listed in <a href="/changes">Recent changes</a> with an undo.
          </p>
        </div>
      </div>
    </Layout>,
  );
});

pages.get('/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.redirect('/');
  const results = await q.search(c.env.DB, term);

  // A single exact hit goes straight to its page.
  const exactBorrower = results.borrowers.find((b) => b.username.toLowerCase() === term.toLowerCase());
  if (exactBorrower && results.lenders.length === 0 && results.borrowers.length === 1) return c.redirect(borrowerUrl(exactBorrower.username));

  return c.html(
    <Layout title={`Search: ${term}`}>
      <h1>Search</h1>
      <SearchForm value={term} />
      <h2>Borrowers</h2>
      {results.borrowers.length === 0 ? (
        <NoRecord name={term} />
      ) : (
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Company</th>
                <th>Corp</th>
                <th class="num">Loans</th>
              </tr>
            </thead>
            <tbody>
              {results.borrowers.map((b) => (
                <tr>
                  <td>
                    <a href={borrowerUrl(b.username)}>{b.username}</a>
                  </td>
                  <td>{b.companyCode ?? '–'}</td>
                  <td>{b.corpCode ?? '–'}</td>
                  <td class="num">{b.loans}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results.lenders.length > 0 && (
        <>
          <h2>Lenders</h2>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th class="num">Loans</th>
                </tr>
              </thead>
              <tbody>
                {results.lenders.map((l) => (
                  <tr>
                    <td>
                      <a href={lenderUrl(l.username)}>{l.username}</a>
                    </td>
                    <td class="num">{l.loans}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Layout>,
  );
});

pages.get('/borrowers/:username', async (c) => {
  const asked = c.req.param('username');
  const borrower = await q.getBorrower(c.env.DB, asked);
  if (!borrower) {
    c.status(404);
    return c.html(
      <NotFound what="There is no borrower record under this name.">
        <NoRecord name={asked} />
      </NotFound>,
    );
  }
  const [exposure, { loans }, health] = await Promise.all([
    q.getBorrowerExposure(c.env.DB, borrower.id),
    q.listLoans(c.env.DB, { borrower: borrower.username, limit: 500, offset: 0 }),
    q.getSyncHealth(c.env.DB),
  ]);
  const all = q.combine(exposure);
  const open = loans.filter(isOpen);
  const closed = loans.filter((l) => !isOpen(l));
  const owedTo = [...new Set(loans.filter((l) => l.status === 'in_progress' || l.status === 'overdue').map((l) => l.lender))];
  const owedIn = exposure.filter((e) => e.currency !== null && e.currentMinor > 0);

  // The verdict: what is owed, then the breach record.
  const debt =
    all.currentMinor > 0
      ? `Owes ${formatMinor(all.currentMinor)}${owedIn.length === 1 ? ` ${owedIn[0]!.currency}` : ''} to ${plural(owedTo.length, 'lender')}`
      : 'Owes nothing at the moment';
  const record =
    all.breachedLoans > 0
      ? `${plural(all.breachedLoans, 'loan')} in breach`
      : all.everBreachedLoans > 0
        ? `no breach now, but ${plural(all.everBreachedLoans, 'loan')} breached in the past`
        : 'no breaches on record';
  const headline = `${debt}; ${record}.`;
  const tone: Tone =
    all.breachedLoans > 0 ? 'bad' : all.overdueLoans > 0 || all.everBreachedLoans > 0 || all.staleMinor > 0 ? 'warn' : all.currentMinor > 0 ? 'neutral' : 'good';
  const caveats = [
    all.overdueLoans > 0 && `${plural(all.overdueLoans, 'loan')} overdue.`,
    all.staleMinor > 0 && `${formatMinor(all.staleMinor)} in stale loans, whose outcome is unknown.`,
    all.nonCashLoans > 0 && `${plural(all.nonCashLoans, 'non-cash loan')} not counted in the amounts.`,
  ].filter(Boolean);

  return c.html(
    <Layout title={borrower.username} description={`${borrower.username}: ${headline} ${plural(all.loans, 'loan')} on record.`}>
      <div class="titlebar">
        <div>
          <h1>{borrower.username}</h1>
          <p class="sub">
            Borrower · company {borrower.companyCode ?? 'unknown'} · corp {borrower.corpCode ?? 'none'}
            {borrower.aliases.length > 0 && <> · formerly {borrower.aliases.join(', ')}</>}
            {' · '}
            <a href={lenderUrl(borrower.username)}>as a lender</a>
          </p>
        </div>
        <CopyLink />
      </div>

      <Verdict tone={tone} headline={headline} detail={caveats.length > 0 ? caveats.join(' ') : undefined}>
        <MoneyStat label="Owed now" combinedMinor={all.currentMinor} exposure={exposure} pick={(e) => e.currentMinor} />
        <MoneyStat label="Borrowed in total" combinedMinor={all.totalMinor} exposure={exposure} pick={(e) => e.totalMinor} />
        <Stat label="Owed to" value={owedTo.length}>
          {owedTo.length > 0 && (
            <ul class="parts names">
              {owedTo.map((name) => (
                <li>
                  <a href={lenderUrl(name)}>{name}</a>
                </li>
              ))}
            </ul>
          )}
        </Stat>
        <Stat label="In breach" value={all.breachedLoans} note={`${all.everBreachedLoans} ever · ${all.overdueLoans} overdue`} />
        <Stat label="Loans" value={all.loans + all.nonCashLoans} note={`${open.length} open · ${closed.length} closed`} />
      </Verdict>
      <Freshness health={health} />

      <h2>Open or unresolved ({open.length})</h2>
      {open.length === 0 ? <p class="muted">Nothing open. Every recorded loan is complete or was terminated.</p> : <LoanTable loans={open} hide="borrower" />}
      <h2>Closed ({closed.length})</h2>
      {closed.length === 0 ? <p class="muted">No finished loans yet.</p> : <LoanTable loans={closed} hide="borrower" />}
    </Layout>,
  );
});

pages.get('/lenders', async (c) => {
  const sort = c.req.query('sort') === 'loans' ? 'loans' : c.req.query('sort') === 'name' ? 'name' : 'out';
  const [list, health] = await Promise.all([q.listLenders(c.env.DB), q.getSyncHealth(c.env.DB)]);
  const syncOf = new Map(health.map((h) => [h.lender.toLowerCase(), h]));
  const lenders = list.map((l) => ({ ...l, all: q.combine(l.exposure), sync: syncOf.get(l.username.toLowerCase()) }));
  const tracked = lenders.filter((l) => l.trackingMode === 'fio');
  const failing = tracked.filter((l) => l.sync && !l.sync.ok);
  const lastCheck = health.reduce((latest, h) => (h.checkedAt > latest ? h.checkedAt : latest), '');
  lenders.sort((a, b) =>
    sort === 'name'
      ? a.username.localeCompare(b.username)
      : (sort === 'loans' ? b.loans - a.loans : b.all.currentMinor - a.all.currentMinor) || b.all.totalMinor - a.all.totalMinor || a.username.localeCompare(b.username),
  );
  const cell = (l: q.LenderSummary, currency: string) => {
    const e = l.exposure.find((x) => x.currency === currency);
    return e && e.currentMinor > 0 ? formatMinor(e.currentMinor) : '';
  };
  const head = (key: string, label: string) =>
    sort === key ? (
      <span aria-current="true">{label} ▼</span>
    ) : (
      <a href={`/lenders?sort=${key}`} title={`Sort by ${label.toLowerCase()}`}>
        {label}
      </a>
    );
  return c.html(
    <Layout title="Lenders" description="Everyone who lends in Prosperous Universe and reports to the bureau, with what each has out on loan.">
      <h1>Lenders</h1>
      <p class="sub">
        Everyone who has lent, and what each has out on loan today.{' '}
        <span class="track-cta">
          Lend yourself? <a href="/track">Track your loans automatically</a>.
        </span>
      </p>
      {tracked.length > 0 && (
        <p class={failing.length > 0 ? 'panel alert' : 'fresh'}>
          <strong>
            {tracked.length - failing.length} of {plural(tracked.length, 'tracked lender')} {tracked.length - failing.length === 1 ? 'is' : 'are'} up to date
          </strong>
          {lastCheck && (
            <>
              , last checked against FIO{' '}
              <time datetime={lastCheck} data-rel>
                {stamp(lastCheck)}
              </time>
            </>
          )}
          .{failing.length > 0 && <> Loans from {failing.map((l) => l.username).join(', ')} may be out of date until their sync works again.</>}
        </p>
      )}
      <div class="scroll">
        <table class="stack">
          <thead>
            <tr>
              <th>{head('name', 'Lender')}</th>
              <th>Updates</th>
              <th class="num">{head('loans', 'Loans')}</th>
              <th class="num">{head('out', 'Out now')}</th>
              <th class="num">AIC</th>
              <th class="num">CIS</th>
              <th class="num">ICA</th>
              <th class="num">NCC</th>
            </tr>
          </thead>
          <tbody>
            {lenders.map((l) => (
              <tr>
                <td data-label="Lender">
                  <a href={lenderUrl(l.username)}>{l.username}</a>
                </td>
                <td data-label="Updates">
                  {l.trackingMode !== 'fio' ? (
                    <span class="muted">{l.trackingMode === 'api' ? 'Reported by the lender' : 'Manually entered'}</span>
                  ) : !l.sync ? (
                    <span class="muted">Automatic, first sync pending</span>
                  ) : l.sync.ok ? (
                    <span class="trust fio_verified">
                      Synced{' '}
                      <time datetime={l.sync.checkedAt} data-rel>
                        {stamp(l.sync.checkedAt)}
                      </time>
                    </span>
                  ) : (
                    <span class="badge bad" title={`Last tried ${stamp(l.sync.checkedAt)}`}>
                      Sync failing: {l.sync.error ?? 'unknown error'}
                    </span>
                  )}
                </td>
                <td class="num" data-label="Loans">
                  {l.loans}
                </td>
                <td class="num" data-label="Out now">
                  {l.all.currentMinor > 0 ? <strong>{formatMinor(l.all.currentMinor)}</strong> : ''}
                </td>
                <td class="num" data-label="AIC">
                  {cell(l, 'AIC')}
                </td>
                <td class="num" data-label="CIS">
                  {cell(l, 'CIS')}
                </td>
                <td class="num" data-label="ICA">
                  {cell(l, 'ICA')}
                </td>
                <td class="num" data-label="NCC">
                  {cell(l, 'NCC')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

pages.get('/lenders/:username', async (c) => {
  const lender = await q.getLender(c.env.DB, c.req.param('username'));
  if (!lender) {
    c.status(404);
    return c.html(<NotFound what="This player has not reported any loans as a lender." />);
  }
  const [exposure, { loans, total }, health] = await Promise.all([
    q.getLenderExposure(c.env.DB, lender.id),
    q.listLoans(c.env.DB, { lender: lender.username, limit: 500, offset: 0 }),
    q.getSyncHealth(c.env.DB),
  ]);
  const all = q.combine(exposure);
  const open = loans.filter(isOpen);
  const closed = loans.filter((l) => !isOpen(l));
  const lentTo = new Set(loans.filter((l) => l.status === 'in_progress' || l.status === 'overdue').map((l) => l.borrower.username.toLowerCase()));
  const outIn = exposure.filter((e) => e.currency !== null && e.currentMinor > 0);
  const sync = health.find((h) => h.lender.toLowerCase() === lender.username.toLowerCase());

  const headline =
    all.currentMinor > 0
      ? `Has ${formatMinor(all.currentMinor)}${outIn.length === 1 ? ` ${outIn[0]!.currency}` : ''} out on loan to ${plural(lentTo.size, 'borrower')}.`
      : all.loans > 0
        ? 'Has nothing out on loan at the moment.'
        : 'No loans on record yet.';
  const caveats = [
    all.breachedLoans > 0 && `${plural(all.breachedLoans, 'loan')} in breach.`,
    all.overdueLoans > 0 && `${plural(all.overdueLoans, 'loan')} overdue.`,
    all.nonCashLoans > 0 && `${plural(all.nonCashLoans, 'non-cash loan')} not counted in the amounts.`,
  ].filter(Boolean);
  const tracking =
    lender.trackingMode === 'fio' ? 'loans tracked automatically through FIO' : lender.trackingMode === 'api' ? 'loans reported through the API' : 'loans manually entered';

  return c.html(
    <Layout title={lender.username} description={`${lender.username} as a lender: ${headline} ${plural(all.loans, 'loan')} on record.`}>
      <div class="titlebar">
        <div>
          <h1>{lender.username}</h1>
          <p class="sub">
            Lender · {tracking} · <a href={borrowerUrl(lender.username)}>as a borrower</a>
          </p>
        </div>
        <CopyLink />
      </div>

      <Verdict tone={all.breachedLoans > 0 || all.overdueLoans > 0 ? 'warn' : 'neutral'} headline={headline} detail={caveats.length > 0 ? caveats.join(' ') : undefined}>
        <MoneyStat label="Out on loan now" combinedMinor={all.currentMinor} exposure={exposure} pick={(e) => e.currentMinor} />
        <MoneyStat label="Lent in total" combinedMinor={all.totalMinor} exposure={exposure} pick={(e) => e.totalMinor} />
        <Stat label="Borrowers now" value={lentTo.size} />
        <Stat label="In breach" value={all.breachedLoans} note={`${all.everBreachedLoans} ever · ${all.overdueLoans} overdue`} />
        <Stat label="Loans" value={(all.loans + all.nonCashLoans).toLocaleString('en-US')} note={`${all.terminatedLoans} terminated, not in totals`} />
      </Verdict>
      {sync ? (
        <p class="fresh">
          {sync.ok ? 'Last read from FIO' : `FIO sync is failing (${sync.error ?? 'unknown error'}); last tried`}{' '}
          <time datetime={sync.checkedAt} data-rel>
            {stamp(sync.checkedAt)}
          </time>
          .
        </p>
      ) : (
        <p class="fresh">These loans were manually entered and are not checked against FIO.</p>
      )}

      <h2>Open or unresolved ({open.length})</h2>
      {open.length === 0 ? <p class="muted">Nothing open.</p> : <LoanTable loans={open} hide="lender" />}
      <h2>
        Closed ({total - open.length}
        {total > loans.length && `, newest ${closed.length} shown`})
      </h2>
      {closed.length === 0 ? <p class="muted">No finished loans yet.</p> : <LoanTable loans={closed} hide="lender" />}
    </Layout>,
  );
});

interface TimelineEvent {
  at: string;
  who: string;
  /** True for a person, false for the sync or the import. */
  person: boolean;
  summary: string;
  lines: ChangeLine[];
  note: string | null;
  /** The untouched sheet row, for imported loans. */
  raw: Record<string, string> | null;
}

const SYSTEM_ACTORS: Record<string, string> = { 'fio-sync': 'FIO sync', 'sheet-import': 'Import from the Google Sheet' };
const HISTORY_SOURCES: Record<string, string> = { fio_sync: 'FIO sync', sheet_import: "The Google Sheet's sync", edit: 'Edited by hand', api: 'Lender report' };

/** One list, newest first, of everything that happened to a loan: status changes and edits together. */
function loanTimeline(history: q.StatusChange[], revisions: q.Revision[]): TimelineEvent[] {
  const events: TimelineEvent[] = revisions.map((r) => {
    const text = describeRevision(r);
    const raw = r.action === 'import' && r.after && typeof r.after === 'object' ? (r.after as Record<string, string>) : null;
    return { at: r.createdAt, who: r.actorType === 'user' ? r.actor : (SYSTEM_ACTORS[r.actor] ?? r.actor), person: r.actorType === 'user', ...text, raw };
  });
  // A hand edit or an added loan writes both a revision and a status row at the same instant; show it once.
  const revisionTimes = new Set(revisions.map((r) => r.createdAt));
  for (const h of history) {
    if (revisionTimes.has(h.changedAt) && (h.source === 'edit' || h.oldStatus === null)) continue;
    events.push({
      at: h.changedAt,
      who: HISTORY_SOURCES[h.source] ?? h.source,
      person: false,
      summary: h.oldStatus === null ? `First recorded as ${STATUS_LABELS[h.newStatus]}` : 'Status changed',
      lines: h.oldStatus === null ? [] : [{ label: 'Status', from: STATUS_LABELS[h.oldStatus], to: STATUS_LABELS[h.newStatus] }],
      note: null,
      raw: null,
    });
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

pages.get('/loans/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const loan = Number.isInteger(id) && id > 0 ? await q.getLoan(c.env.DB, id) : null;
  if (!loan) {
    c.status(404);
    return c.html(<NotFound what="No such loan." />);
  }
  const [history, revisions] = await Promise.all([q.getLoanHistory(c.env.DB, id), q.getRevisions(c.env.DB, 'loan', id)]);
  const timeline = loanTimeline(history, revisions);
  const name = loan.contractId ?? `#${loan.id}`;
  const ledgerLink = `/ledger?q=${encodeURIComponent(loan.contractId ?? loan.borrower.username)}`;
  const amount = `${formatMinor(loan.principalMinor)}${loan.currency ? ` ${loan.currency}` : ''}`;

  return c.html(
    <Layout
      title={`Loan ${name}`}
      description={`${loan.lender} lent ${amount} to ${loan.borrower.username} on ${loan.issuedOn}. Status: ${STATUS_LABELS[loan.status]}. ${TRUST_LABELS[loan.trust]}.`}
    >
      <div class="titlebar">
        <div>
          <h1>
            Loan {name} <StatusBadge status={loan.status} />
          </h1>
          <p class="sub">
            <a href={lenderUrl(loan.lender)}>{loan.lender}</a> lent {amount} to <a href={borrowerUrl(loan.borrower.username)}>{loan.borrower.username}</a>
          </p>
        </div>
        <CopyLink />
      </div>

      {loan.deletedAt && (
        <p class="panel alert">
          <strong>This loan was deleted on {loan.deletedAt.slice(0, 10)}.</strong> It is left out of lists and totals. Anyone signed in can restore it from{' '}
          <a href="/changes">Recent changes</a>.
        </p>
      )}

      <div class="cols">
        <div class="panel">
          <dl class="facts">
            <dt>Amount</dt>
            <dd>
              <Money minor={loan.principalMinor} currency={loan.currency} />
            </dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={loan.status} /> <span class="muted">{STATUS_HELP[loan.status]}</span>
              {loan.everBreached && loan.status !== 'breached' && <div class="muted">It was in breach at some point and changed status later.</div>}
            </dd>
            <dt>Issued</dt>
            <dd>{loan.issuedOn}</dd>
            <dt>Duration</dt>
            <dd>{loan.durationWeeks === null ? 'Unknown' : `${Number(loan.durationWeeks.toFixed(2))} weeks`}</dd>
            <dt>Matures</dt>
            <dd>{loan.maturesOn ?? 'Unknown'}</dd>
            <dt>Borrower company</dt>
            <dd>
              {loan.borrower.companyCode ?? 'Unknown'} · corp {loan.borrower.corpCode ?? 'none'}
            </dd>
            <dt>Contract ID</dt>
            <dd>{loan.contractId ?? 'None recorded'}</dd>
            {loan.notes && (
              <>
                <dt>Notes</dt>
                <dd>{loan.notes}</dd>
              </>
            )}
          </dl>
        </div>

        <div class="panel">
          <h2 class="flush">Where this comes from</h2>
          <p>
            <TrustMark trust={loan.trust} /> {TRUST_HELP[loan.trust]}
          </p>
          <p class="muted">
            {loan.autoTrack
              ? `Kept up to date from FIO${loan.lastSyncedAt ? `; last checked ${stamp(loan.lastSyncedAt)}` : ''}.`
              : 'A manual entry. The FIO sync does not update it.'}
          </p>
          <h2>Think this is wrong?</h2>
          {loan.autoTrack ? (
            <p>
              This record mirrors the in-game contract, so its status, amount and dates follow the game and cannot be changed by hand. If the contract
              itself is the problem, take it up with <a href={lenderUrl(loan.lender)}>{loan.lender}</a>. Anyone signed in can still add context in the
              notes, <a href={ledgerLink}>in the ledger</a>.
            </p>
          ) : (
            <p>
              Anyone signed in with Discord can correct this entry <a href={ledgerLink}>in the ledger</a>, whether you are the lender, the borrower or
              someone who knows better. Every change is listed below under your name and can be undone.
            </p>
          )}
        </div>
      </div>

      <h2>History</h2>
      {timeline.length === 0 ? (
        <p class="muted">Nothing recorded yet.</p>
      ) : (
        <ol class="timeline">
          {timeline.map((e) => (
            <li class={e.person ? 'person' : undefined}>
              <div class="when">
                {stamp(e.at)} · {e.who}
              </div>
              <div class="what">{e.summary}</div>
              {e.lines.map((line) => (
                <div class="line">
                  {line.label}: {line.from !== null && <span class="from">{line.from} → </span>}
                  <strong>{line.to}</strong>
                </div>
              ))}
              {e.note && <div class="line muted">{e.note}</div>}
              {e.raw && (
                <details>
                  <summary>The sheet row as imported</summary>
                  <dl class="facts small">
                    {Object.entries(e.raw)
                      .filter(([, value]) => value !== '')
                      .map(([key, value]) => (
                        <>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </>
                      ))}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </Layout>,
  );
});

pages.get('/leaderboards', async (c) => {
  const boards = await q.getLeaderboards(c.env.DB);
  const wanted = (c.req.query('currency') ?? '').toUpperCase();
  const currency = isCurrency(wanted) ? wanted : null;
  const board = currency ? boards.leaderboards.find((b) => b.currency === currency)! : boards.combined;
  const Board = ({ title, entries }: { title: string; entries: q.LeaderboardEntry[] }) => (
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>{title}</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colspan={3} class="muted">
                Nobody yet.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <tr>
              <td class="num">{e.rank}</td>
              <td>
                <a href={lenderUrl(e.lender)}>{e.lender}</a>
              </td>
              <td class="num">{formatMinor(e.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return c.html(
    <Layout title="Leaderboards">
      <h1>Leaderboards</h1>
      <p class="sub">The twenty largest lenders, by all-time lending and by what is out today. Terminated loans are left out.</p>
      <form class="pick" method="get" action="/leaderboards">
        <label for="currency">Currency</label>
        <select id="currency" name="currency" onchange="this.form.submit()">
          <option value="" selected={currency === null}>
            All currencies combined
          </option>
          {CURRENCIES.map((cur) => (
            <option value={cur} selected={currency === cur}>
              {cur}
            </option>
          ))}
        </select>
        <noscript>
          <button type="submit">Show</button>
        </noscript>
      </form>
      <div class="cols">
        <Board title="Total lent, all time" entries={board.byTotal} />
        <Board title="Out on loan now" entries={board.byCurrent} />
      </div>
    </Layout>,
  );
});

pages.get('/about', (c) =>
  c.html(
    <Layout title="About" description="How the PrUn Galactic Credit Bureau works: what the statuses and trust labels mean, how loans are tracked and how to correct a record.">
      <h1>About the bureau</h1>
      <p class="sub">
        The PrUn Galactic Credit Bureau gathers the loans that lenders report into one public record, so anyone can see what a borrower already owes and
        how their past loans ended. Reporting is voluntary, and everything here is public.
      </p>
      <nav class="contents" aria-label="On this page">
        <a href="#what">What is recorded</a>
        <a href="#statuses">Statuses</a>
        <a href="#trust">Trust labels</a>
        <a href="#combined">Combined amounts</a>
        <a href="#tracking">Automatic tracking</a>
        <a href="#editing">Editing</a>
        <a href="#disputes">If a record about you is wrong</a>
        <a href="#api">API</a>
      </nav>

      <section class="panel about" id="what">
        <h2>What is recorded</h2>
        <p>Three kinds of lending belong here: in-game loan contracts, advances paid for goods yet to be delivered, and sponsored bases.</p>
        <p>
          The bureau only knows what lenders tell it. A player with no record has not necessarily never borrowed; it means no reporting lender has lent
          to them.
        </p>
      </section>

      <section class="panel about" id="statuses">
        <h2>Statuses</h2>
        <dl class="facts">
          {STATUSES.map((s) => (
            <>
              <dt id={`status-${s}`}>
                <StatusBadge status={s} />
              </dt>
              <dd>{STATUS_HELP[s]}</dd>
            </>
          ))}
        </dl>
        <p class="muted">
          A loan that was once in breach keeps a “was breached” mark even after its status changes, because the status history is never erased.
        </p>
      </section>

      <section class="panel about" id="trust">
        <h2>Trust labels</h2>
        <p>Every loan says where its information came from.</p>
        <dl class="facts">
          {(Object.keys(TRUST_LABELS) as Trust[]).map((t) => (
            <>
              <dt id={`trust-${t}`}>
                <TrustMark trust={t} plain />
              </dt>
              <dd>{TRUST_HELP[t]}</dd>
            </>
          ))}
        </dl>
        <p class="muted">
          Changing a loan's facts by hand relabels it Community-edited. If the FIO sync later finds the same contract with the same lender, amount and
          currency, it becomes FIO-verified again.
        </p>
      </section>

      <section class="panel about" id="combined">
        <h2>Combined amounts</h2>
        <p>
          Where a page shows one figure for several currencies, it is AIC, CIS, ICA and NCC added together as they are, with no exchange rate. The
          amounts per currency are listed beside it.
        </p>
      </section>

      <section class="panel about" id="tracking">
        <h2>Automatic tracking</h2>
        <p>
          Lenders can{' '}
          <a class="track-link" href="/track">
            connect their FIO account
          </a>
          . The bureau then reads their loan contracts every hour and keeps each loan's status
          current without anyone typing it in. Only loans the lender paid out are recorded; loans they received are reported by their own lenders.
        </p>
        <p>
The <a href="/lenders">Lenders</a> page shows when each tracked lender was last read, and flags any whose sync is failing.
        </p>
      </section>

      <section class="panel about" id="editing">
        <h2>Editing</h2>
        <p>
          Sign in with Discord and you can add, correct or remove any loan in the <a href="/ledger">ledger</a>. Each change is recorded under your name
          in <a href="/changes">Recent changes</a>, where anyone signed in can undo it. Loans with Auto track ticked follow FIO, so only their notes are
          open to editing.
        </p>
      </section>

      <section class="panel about" id="disputes">
        <h2>If a record about you is wrong</h2>
        <p>Open the loan from your borrower page. Its page says where the record came from and shows everything that has happened to it.</p>
        <ul class="next">
          <li>
            <strong>A manual entry</strong> can be corrected by anyone signed in, including you. Your change is public and can be undone, so say why in
            the notes.
          </li>
          <li>
            <strong>A loan tracked from FIO</strong> mirrors the in-game contract and cannot be edited by hand. If the contract is the problem, settle it
            with the lender in game; the record follows. You can still add a note.
          </li>
          <li>
            <strong>A loan that is not yours</strong>, such as one recorded under a similar name, should be corrected in the ledger or raised with the
            lender named on it.
          </li>
        </ul>
      </section>

      <section class="panel about" id="api">
        <h2>API</h2>
        <p>
          Everything on this site is also served as JSON under <a href="/api/v1/stats">/api/v1</a>, no key required. For example{' '}
          <code>/api/v1/borrowers/&#123;username&#125;</code>.
        </p>
      </section>
    </Layout>,
  ),
);

/** Used by the app-level 404 handler. */
export const notFoundPage = () => <NotFound what="This page does not exist." />;
