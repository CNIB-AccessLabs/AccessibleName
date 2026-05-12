/*
 * a11y: Accessible Names — background script.
 *
 * Toolbar click flow:
 *   1. Inject `scanFrame` into every frame in the active tab. Each frame returns
 *      its own results, including coordinates relative to its own viewport.
 *   2. Aggregate per-frame results in the background.
 *   3. Inject `displayResults` into the top frame with the aggregated data.
 *      The top frame draws one panel and positions badges over both same-origin
 *      and cross-origin frame content using each iframe's bounding rect.
 *
 * scanFrame and displayResults must be self-contained — `scripting.executeScript`
 * with `func:` serializes the function source and cannot capture outer scope.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

api.action.onClicked.addListener(handleClick);

async function handleClick(tab) {
  if (!tab || tab.id == null) return;
  try {
    // First, check whether the panel is already up in the top frame. If so,
    // this click is a toggle-off — skip the scan entirely and tell the top
    // frame to clean up.
    const probe = await api.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => !!window.__a11yn_ext_cleanup
    });
    const panelUp = !!(probe[0] && probe[0].result);

    if (panelUp) {
      await api.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: () => { if (window.__a11yn_ext_cleanup) window.__a11yn_ext_cleanup(); }
      });
      return;
    }

    const injection = await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanFrame
    });

    const aggregated = injection.map(i => ({
      frameId: i.frameId,
      url: (i.result && i.result.url) || "",
      isTop: !!(i.result && i.result.isTop),
      results: (i.result && i.result.results) || [],
      shadowRoots: (i.result && i.result.shadowRoots) || 0,
      error: i.result && i.result.error
    }));

    await api.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: displayResults,
      args: [aggregated]
    });
  } catch (e) {
    console.error("[a11y-names] injection failed:", e);
  }
}

/* ============================================================
 * scanFrame — runs in every frame. Must be self-contained.
 * ============================================================ */
function scanFrame() {
  "use strict";
  try {
    function txt(s) { return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim(); }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.getAttribute("aria-hidden") === "true") return true;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win) return false;
        var st = win.getComputedStyle(el);
        return st.display === "none" || st.visibility === "hidden";
      } catch (e) { return false; }
    }

    function nameFromContent(el, seen) {
      if (!el || seen.has(el)) return "";
      seen.add(el);
      var parts = [];
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) parts.push(n.nodeValue);
        else if (n.nodeType === 1) {
          if (isHidden(n)) continue;
          var aLab = n.getAttribute && n.getAttribute("aria-labelledby");
          if (aLab) { parts.push(refNames(aLab, n, seen)); continue; }
          var aL = n.getAttribute && n.getAttribute("aria-label");
          if (aL && aL.trim()) { parts.push(aL); continue; }
          if (n.tagName === "IMG") { var alt = n.getAttribute("alt"); if (alt) parts.push(alt); continue; }
          if (n.tagName === "INPUT") {
            var t = (n.getAttribute("type") || "text").toLowerCase();
            if (t === "button" || t === "submit" || t === "reset") { if (n.value) parts.push(n.value); }
            else if (t === "image" && n.alt) parts.push(n.alt);
            continue;
          }
          parts.push(nameFromContent(n, seen));
        }
      }
      return txt(parts.join(" "));
    }

    function refNames(idrefs, contextEl, seen) {
      var doc = contextEl.ownerDocument || document;
      var root = contextEl.getRootNode ? contextEl.getRootNode() : doc;
      return idrefs.split(/\s+/).map(function (id) {
        var ref = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
        if (!ref) return "";
        var aL = ref.getAttribute("aria-label");
        if (aL && aL.trim()) return aL.trim();
        return nameFromContent(ref, seen);
      }).filter(Boolean).join(" ");
    }

    function accName(el) {
      var seen = new Set();
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;

      var aLab = el.getAttribute("aria-labelledby");
      if (aLab) { var n1 = refNames(aLab, el, seen); if (n1) return { name: n1, src: "aria-labelledby" }; }
      var aL = el.getAttribute("aria-label");
      if (aL && aL.trim()) return { name: aL.trim(), src: "aria-label" };

      var tag = el.tagName.toLowerCase();

      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "meter" || tag === "progress") {
        if (el.id) {
          var sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"')) + '"]';
          var lab = (root.querySelector && root.querySelector(sel)) || doc.querySelector(sel);
          if (lab) { var n2 = nameFromContent(lab, seen); if (n2) return { name: n2, src: "label[for]" }; }
        }
        var wrap = el.closest && el.closest("label");
        if (wrap) { var n3 = nameFromContent(wrap, seen); if (n3) return { name: n3, src: "wrapping <label>" }; }
        if (tag === "input") {
          var t2 = (el.getAttribute("type") || "text").toLowerCase();
          if (t2 === "button" || t2 === "submit" || t2 === "reset") {
            if (el.value) return { name: el.value, src: "value" };
            if (t2 === "submit") return { name: "Submit", src: "default (submit)" };
            if (t2 === "reset") return { name: "Reset", src: "default (reset)" };
          }
          if (t2 === "image" && el.getAttribute("alt")) return { name: el.getAttribute("alt"), src: "alt" };
        }
      }

      if (tag === "img") {
        var alt2 = el.getAttribute("alt");
        if (alt2 !== null) return { name: alt2, src: "alt" };
      }

      if (tag === "fieldset") {
        var lg = el.querySelector(":scope > legend");
        if (lg) { var n4 = nameFromContent(lg, seen); if (n4) return { name: n4, src: "legend" }; }
      }

      if (tag === "a" || tag === "button" || tag === "summary" || tag === "details" ||
          (el.matches && el.matches('[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"]'))) {
        var n5 = nameFromContent(el, seen);
        if (n5) return { name: n5, src: "subtree text" };
      }

      var ti = el.getAttribute("title");
      if (ti && ti.trim()) return { name: ti.trim(), src: "title" };

      var ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return { name: ph.trim(), src: "placeholder (not spec accname)" };

      return { name: "", src: "" };
    }

    function role(el) {
      var explicit = el.getAttribute("role");
      if (explicit) return explicit;
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href") ? "link" : "";
      if (tag === "button") return "button";
      if (tag === "select") return el.multiple ? "listbox" : "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "summary") return "button";
      if (tag === "details") return "group";
      if (tag === "input") {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        return ({
          checkbox: "checkbox", radio: "radio",
          button: "button", submit: "button", reset: "button", image: "button",
          range: "slider", number: "spinbutton",
          search: "searchbox", email: "textbox", tel: "textbox",
          url: "textbox", text: "textbox"
        })[t] || (t === "password" ? "" : "textbox");
      }
      if (tag === "img") return el.getAttribute("alt") === "" ? "presentation" : "img";
      return "";
    }

    function shortSelector(el) {
      if (el.id) return "#" + el.id;
      var tag = el.tagName.toLowerCase();
      var cls = "";
      if (typeof el.className === "string" && el.className.trim()) {
        cls = el.className.trim().split(/\s+/).slice(0, 2).map(function (c) { return "." + c; }).join("");
      }
      return tag + cls;
    }

    var SELECTOR = [
      "a[href]", "button",
      'input:not([type="hidden"])', "select", "textarea",
      "summary", "details",
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable=""]', '[contenteditable="true"]',
      "[onclick]",
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
      '[role="searchbox"]', '[role="slider"]', '[role="spinbutton"]', '[role="treeitem"]'
    ].join(",");

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        if (r.width === 0 && r.height === 0) return;
        if (isHidden(el)) return;
        var an = accName(el);
        results.push({
          tag: el.tagName.toLowerCase(),
          role: role(el),
          name: an.name,
          src: an.src,
          missing: !an.name || an.src === "placeholder (not spec accname)",
          selector: shortSelector(el),
          // Coordinates relative to THIS frame's viewport; display.js will add frame offset.
          rect: { top: r.top, left: r.left, width: r.width, height: r.height }
        });
      });
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
      Array.prototype.forEach.call(all, function (el) {
        if (el.shadowRoot) {
          shadowRoots++;
          walk(el.shadowRoot);
        }
      });
    }

    walk(document);

    return {
      url: window.location.href,
      isTop: window === window.top,
      results: results,
      shadowRoots: shadowRoots
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

/* ============================================================
 * displayResults — runs in the top frame only.
 * ============================================================ */
function displayResults(framesData) {
  "use strict";
  var P = "__a11yn_ext_";

  // Defensive: clean up any stale state before redrawing.
  if (window[P + "cleanup"]) window[P + "cleanup"]();

  // Build a map: frame URL -> iframe rect in top doc viewport (for direct children).
  // For cross-origin iframes we can't access contentWindow, but iframe.src usually
  // matches the frame's reported URL. We also keep a list of iframes for fallback.
  var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe, frame"));
  var iframeByUrl = new Map();
  var iframeUnknown = []; // iframes whose URL we couldn't determine for cross-frame matching
  iframes.forEach(function (f) {
    var url = "";
    try {
      if (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href !== "about:blank") {
        url = f.contentWindow.location.href;
      }
    } catch (e) { /* cross-origin */ }
    if (!url && f.src) url = f.src;
    if (url && !iframeByUrl.has(url)) iframeByUrl.set(url, f);
    else iframeUnknown.push(f);
  });

  /* ---------- styles ---------- */
  var style = document.createElement("style");
  style.id = P + "style";
  style.textContent =
    "." + P + "badge{position:absolute;z-index:2147483646;background:#003876;color:#fff;font:11px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2px 6px;border-radius:3px;pointer-events:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    "." + P + "badge-miss{background:#b00020;}" +
    "." + P + "badge-frame{background:#0a5d2e;}" +
    "." + P + "badge-frame." + P + "badge-miss{background:#7a1518;}" +
    "#" + P + "panel{position:fixed;top:12px;right:12px;width:400px;max-height:85vh;display:flex;flex-direction:column;z-index:2147483647;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}" +
    "#" + P + "panel header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#003876;color:#fff;border-radius:6px 6px 0 0;flex:0 0 auto;}" +
    "#" + P + "panel header strong{font-size:13px;}" +
    "#" + P + "panel .btns{display:flex;gap:6px;}" +
    "#" + P + "panel button{background:transparent;border:1px solid #fff;color:#fff;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:11px;font-family:inherit;}" +
    "#" + P + "panel button:hover{background:rgba(255,255,255,.15);}" +
    "#" + P + "panel .summary{padding:8px 12px;border-bottom:1px solid #eee;background:#f5f7fa;flex:0 0 auto;}" +
    "#" + P + "panel .summary .miss{color:#b00020;font-weight:600;}" +
    "#" + P + "panel .summary .ok{color:#0a8043;font-weight:600;}" +
    "#" + P + "panel .summary .warn{color:#b45309;font-weight:600;}" +
    "#" + P + "panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    "#" + P + "panel li{padding:7px 12px;border-bottom:1px solid #eee;cursor:pointer;}" +
    "#" + P + "panel li:hover{background:#eef4ff;}" +
    "#" + P + "panel li .meta{color:#555;font-size:11px;}" +
    "#" + P + "panel li .name{font-weight:600;color:#111;}" +
    "#" + P + "panel li .miss{color:#b00020;font-weight:600;}" +
    "#" + P + "panel li .src{color:#777;font-size:10px;font-style:italic;word-break:break-all;}" +
    "#" + P + "panel li.frame-tag{border-left:3px solid #0a5d2e;}";
  document.head.appendChild(style);

  /* ---------- flatten results with computed top-doc coords ---------- */
  var allResults = [];
  var unmatchedFrames = 0;
  var frameLabelByUrl = new Map();
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
    if (!frame.results || !frame.results.length) return;
    var offX = 0, offY = 0, positioned = true, inFrame = !frame.isTop;
    if (inFrame) {
      var iframe = iframeByUrl.get(frame.url);
      if (iframe) {
        var ir = iframe.getBoundingClientRect();
        offX = ir.left; offY = ir.top;
        try { frame.iframeEl = iframe; } catch (e) {}
      } else {
        positioned = false;
        unmatchedFrames++;
      }
    }
    if (inFrame) {
      try {
        var u = new URL(frame.url);
        frameLabelByUrl.set(frame.url, u.hostname + u.pathname.replace(/\/$/, ""));
      } catch (e) {
        frameLabelByUrl.set(frame.url, frame.url);
      }
    }
    frame.results.forEach(function (r) {
      allResults.push({
        tag: r.tag, role: r.role, name: r.name, src: r.src, missing: r.missing,
        selector: r.selector,
        frameUrl: frame.url,
        frameLabel: inFrame ? frameLabelByUrl.get(frame.url) : null,
        isTop: !inFrame,
        pageTop: window.scrollY + offY + r.rect.top,
        pageLeft: window.scrollX + offX + r.rect.left,
        positioned: positioned,
        // For same-origin frames we can later resolve a real element via selector;
        // for cross-origin we can scroll the iframe element into view.
        iframeEl: inFrame ? iframeByUrl.get(frame.url) || null : null
      });
    });
  });

  // Stable indexing
  allResults.forEach(function (r, i) { r.index = i + 1; });

  /* ---------- badges ---------- */
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var badge = document.createElement("div");
    var cls = P + "badge";
    if (r.missing) cls += " " + P + "badge-miss";
    if (!r.isTop) cls += " " + P + "badge-frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    badge.textContent = "#" + r.index + " " + prefix + (r.role || r.tag) + ": " + (r.missing ? (r.name ? "⚠ " + r.name : "NO NAME") : r.name);
    badge.style.top = (r.pageTop - 18) + "px";
    badge.style.left = r.pageLeft + "px";
    document.body.appendChild(badge);
    badges.push(badge);
  });

  /* ---------- panel + console output ---------- */
  var missCount = allResults.filter(function (r) { return r.missing; }).length;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Tag | Role | Accessible Name | Source | Selector |\n";
  md += "|---|-------|-----|------|-----------------|--------|----------|\n";
  allResults.forEach(function (r) {
    var n = r.missing && !r.name ? "⚠ **MISSING**" : (r.missing ? "⚠ " + mdEsc(r.name) : mdEsc(r.name));
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | `" + r.tag + "` | " + (r.role || "") + " | " + n + " | " + (r.src || "") + " | `" + mdEsc(r.selector) + "` |\n";
  });

  console.group("%c[a11y-names] " + allResults.length + " interactive elements (" + missCount + " missing) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return { "#": r.index, frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl), tag: r.tag, role: r.role,
      name: r.missing && !r.name ? "⚠ MISSING" : r.name, source: r.src, selector: r.selector };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  if (unmatchedFrames > 0) {
    console.warn("[a11y-names] " + unmatchedFrames + " frame(s) could not be matched to an iframe element in the top doc — their results are in the panel but badges are not drawn. This usually means nested iframes; the panel still includes everything.");
  }
  console.groupEnd();

  var panelEl = document.createElement("div");
  panelEl.id = P + "panel";

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var summary = "";
  if (allResults.length === 0) summary += '<span class="warn">No interactive elements found.</span>';
  else if (missCount) summary += '<span class="miss">' + missCount + " element" + (missCount === 1 ? "" : "s") + " missing an accessible name.</span>";
  else summary += '<span class="ok">All elements have an accessible name.</span>';
  if (unmatchedFrames) summary += '<br><span class="warn">⚠ ' + unmatchedFrames + " frame(s) couldn't be positioned (likely nested iframes).</span>";
  summary += '<div style="margin-top:4px;color:#555;font-size:11px">Top doc' + (frameCount ? " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s") : "") + ".</div>";

  panelEl.innerHTML =
    "<header><strong>Accessible Names (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    if (!r.isTop) li.classList.add("frame-tag");
    var location = r.isTop ? "" : '<span style="color:#0a5d2e">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    li.innerHTML =
      '<div class="meta">#' + r.index + " " + location + "<code>" + esc(r.tag) + "</code>" + (r.role ? " [" + esc(r.role) + "]" : "") + "</div>" +
      '<div class="' + (r.missing && !r.name ? "miss" : "name") + '">' + (r.missing && !r.name ? "⚠ NO ACCESSIBLE NAME" : esc(r.name)) + "</div>" +
      (r.src ? '<div class="src">via ' + esc(r.src) + " &middot; " + esc(r.selector) + "</div>" : "");
    li.addEventListener("click", function () {
      // For cross-origin frames we can scroll the IFRAME element into view; for
      // top-frame elements we'd need a real reference. With cross-origin we don't
      // have one in the top doc, so just scroll the badge into view.
      if (r.isTop) {
        // best-effort: scroll the badge
        var badge = badges.find(function (b) { return b.textContent.indexOf("#" + r.index + " ") === 0; });
        if (badge) {
          badge.scrollIntoView({ behavior: "smooth", block: "center" });
          var prev = badge.style.boxShadow;
          badge.style.boxShadow = "0 0 0 4px #ffeb3b";
          setTimeout(function () { badge.style.boxShadow = prev; }, 1400);
        }
      } else {
        if (r.iframeEl) {
          r.iframeEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        var b2 = badges.find(function (b) { return b.textContent.indexOf("#" + r.index + " ") === 0; });
        if (b2) {
          var prev2 = b2.style.boxShadow;
          b2.style.boxShadow = "0 0 0 4px #ffeb3b";
          setTimeout(function () { b2.style.boxShadow = prev2; }, 1400);
        }
      }
    });
    list.appendChild(li);
  });
  document.body.appendChild(panelEl);

  panelEl.querySelector("#" + P + "close").addEventListener("click", function () { window[P + "cleanup"](); });
  panelEl.querySelector("#" + P + "copy").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    var done = function (ok) { btn.textContent = ok ? "Copied!" : "Copy failed"; setTimeout(function () { btn.textContent = "Copy MD"; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(true); } catch (err) { done(false); } ta.remove();
    }
  });

  window[P + "cleanup"] = function () {
    try { panelEl.remove(); } catch (e) {}
    try { style.remove(); } catch (e) {}
    badges.forEach(function (b) { try { b.remove(); } catch (e) {} });
    delete window[P + "cleanup"];
    console.log("%c[a11y-names] cleared.", "color:#003876");
  };
}
