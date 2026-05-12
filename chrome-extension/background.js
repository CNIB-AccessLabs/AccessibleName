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
 *      The panel + badges are wrapped in a Shadow DOM so site CSS can't bleed
 *      into the inspector UI; outlines on inspected elements are set with
 *      !important so site-wide `outline: none` resets can't suppress them.
 *
 * scanFrame and displayResults must be self-contained — `scripting.executeScript`
 * with `func:` serializes the function source and cannot capture outer scope.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

api.action.onClicked.addListener(handleClick);

async function handleClick(tab) {
  if (!tab || tab.id == null) return;
  try {
    // Check whether the panel is already up in the top frame. If so, this click
    // is a toggle-off — skip the scan entirely and tell the top frame to clean up.
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
 * Returns serializable element data; no DOM manipulation here.
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

    /* Build a unique CSS selector for el by walking up the DOM, using
     * :nth-of-type to disambiguate same-tag siblings and short-circuiting on
     * the nearest uniquely-IDed ancestor. The result is valid CSS and pastable
     * into DevTools. displayResults uses this selector to re-find the element
     * in the top doc / iframe doc for outlining and click-to-scroll, so it
     * MUST be unique within its document. */
    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;
      function esc(s) {
        return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["\\])/g, "\\$1");
      }
      function idUnique(id) {
        try { return root.querySelectorAll && root.querySelectorAll("#" + esc(id)).length === 1; }
        catch (e) { return false; }
      }
      if (el.id && idUnique(el.id)) return "#" + esc(el.id);
      var parts = [];
      var cur = el;
      var hops = 0;
      while (cur && cur.nodeType === 1 && hops < 30) {
        var tag = cur.tagName.toLowerCase();
        if (cur !== el && cur.id && idUnique(cur.id)) {
          parts.unshift("#" + esc(cur.id));
          break;
        }
        var part = tag;
        var parent = cur.parentElement;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
          if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
          parts.unshift(part);
          cur = parent;
        } else {
          parts.unshift(part);
          break;
        }
        hops++;
      }
      return parts.join(" > ");
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
          selector: uniqueSelector(el),
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
 * UI lives inside a closed Shadow DOM so site styles don't bleed in.
 * All UI text is at least 16px for accessibility.
 * ============================================================ */
function displayResults(framesData) {
  "use strict";
  var P = "__a11yn_ext_";

  // Defensive: clean up any stale state before redrawing.
  if (window[P + "cleanup"]) window[P + "cleanup"]();

  // Build a map: frame URL -> iframe element in top doc (for direct children).
  var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe, frame"));
  var iframeByUrl = new Map();
  iframes.forEach(function (f) {
    var url = "";
    try {
      if (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href !== "about:blank") {
        url = f.contentWindow.location.href;
      }
    } catch (e) { /* cross-origin */ }
    if (!url && f.src) url = f.src;
    if (url && !iframeByUrl.has(url)) iframeByUrl.set(url, f);
  });

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
        frame.iframeEl = iframe;
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
        iframeEl: inFrame ? iframeByUrl.get(frame.url) || null : null,
        // Keep a reference to the page element so click-to-scroll can scroll it.
        // We can't get a real element reference for cross-origin frames, but we
        // store enough to identify them in same-origin cases via querySelector.
        _resolveEl: null
      });
    });
  });

  allResults.forEach(function (r, i) { r.index = i + 1; });

  /* ---------- outlines on inspected elements (with !important) ---------- */
  // The scanner already ran in each frame; we don't have a direct element handle
  // for elements that live in a child frame. We outline what we can reach in the
  // top doc by re-querying via selector inside the appropriate document.
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) {
      doc = document;
    } else if (r.iframeEl) {
      try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; }
    }
    if (!doc) return;
    // The selector returned by the scanner is best-effort and not always unique.
    // We use it to find the first match, which is good enough for the common case.
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        el.style.setProperty("outline", r.missing ? "2px dashed #b00020" : "2px solid #003876", "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  /* ---------- shadow-DOM host: isolates UI from page styles ---------- */
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  // Lock font-family on the host with generic CSS keywords. @font-face declarations
  // in the page can remap specific font names like "-apple-system" or "Segoe UI",
  // and those remappings leak into shadow trees via inheritance. CSS *generic*
  // family keywords (ui-sans-serif, system-ui, sans-serif, ui-monospace, monospace)
  // are language tokens, not font names, and cannot be overridden by @font-face.
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.miss{background:#b00020;}" +
    ".badge.frame{background:#0a5d2e;}" +
    ".badge.frame.miss{background:#7a1518;}" +
    ".panel{position:fixed;top:12px;right:12px;width:460px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.frame-tag{border-left:3px solid #0a5d2e;}" +
    ".panel li .meta{color:#555;font-size:16px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .name{font-weight:600;color:#111;font-size:16px;}" +
    ".panel li .miss{color:#b00020;font-weight:600;font-size:16px;}" +
    ".panel li .src{color:#666;font-size:16px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:16px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}" +
    ".panel header strong{font-weight:600 !important;font-size:18px;}" +
    ".badge{font-weight:600 !important;}" +
    ".panel .summary .miss,.panel .summary .ok,.panel .summary .warn,.panel li .name,.panel li .miss,.panel li .frame-label{font-weight:600 !important;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  /* ---------- badges (inside shadow, positioned in top-doc coords) ---------- */
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var badge = document.createElement("div");
    var cls = "badge";
    if (r.missing) cls += " miss";
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    badge.textContent = "#" + r.index + " " + prefix + (r.role || r.tag) + ": " + (r.missing ? (r.name ? "⚠ " + r.name : "NO NAME") : r.name);
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  /* ---------- markdown + console ---------- */
  // We count two kinds of problems: truly-missing (no name from any source) and
  // placeholder-only (the only name we found is `placeholder`, which isn't a
  // spec-valid accessible name). Both are real accessibility bugs, but they
  // should be presented distinctly so the auditor can prioritise.
  var missingCount = allResults.filter(function (r) { return r.missing && !r.name; }).length;
  var placeholderOnlyCount = allResults.filter(function (r) { return r.missing && r.name; }).length;
  var missCount = missingCount + placeholderOnlyCount;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Tag | Role | Accessible Name | Source | Selector |\n";
  md += "|---|-------|-----|------|-----------------|--------|----------|\n";
  allResults.forEach(function (r) {
    var n = r.missing && !r.name ? "⚠ **MISSING**" : (r.missing ? "⚠ **Placeholder only:** " + mdEsc(r.name) : mdEsc(r.name));
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
    console.warn("[a11y-names] " + unmatchedFrames + " frame(s) could not be matched to an iframe element in the top doc.");
  }
  console.groupEnd();

  /* ---------- panel ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No interactive elements found.</span>';
  } else if (missCount === 0) {
    summary += '<span class="ok">All elements have an accessible name.</span>';
  } else {
    var bits = [];
    if (missingCount) bits.push(missingCount + " missing an accessible name");
    if (placeholderOnlyCount) bits.push(placeholderOnlyCount + " with placeholder only (not a spec accname)");
    summary += '<span class="miss">' + bits.join(", ") + ".</span>";
  }
  if (unmatchedFrames) summary += '<br><span class="warn">⚠ ' + unmatchedFrames + " frame(s) couldn't be positioned.</span>";
  summary += '<div style="margin-top:6px;color:#555;font-size:16px">Top doc' + (frameCount ? " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s") : "") + ".</div>";

  panelEl.innerHTML =
    "<header><strong>Accessible Names (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    if (!r.isTop) li.classList.add("frame-tag");
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    li.innerHTML =
      '<div class="meta">#' + r.index + " " + location + "<code>" + esc(r.tag) + "</code>" + (r.role ? " [" + esc(r.role) + "]" : "") + "</div>" +
      '<div class="' + (r.missing ? "miss" : "name") + '">' + (r.missing && !r.name ? "⚠ NO ACCESSIBLE NAME" : (r.missing ? "⚠ Placeholder only: " + esc(r.name) : esc(r.name))) + "</div>" +
      (r.src ? '<div class="src">via ' + esc(r.src) + " &middot; " + esc(r.selector) + "</div>" : "");
    li.addEventListener("click", function () {
      try {
        if (r._resolveEl) {
          r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
          r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
          setTimeout(function () { try { r._resolveEl.style.removeProperty("box-shadow"); } catch (e) {} }, 1400);
        } else if (r.iframeEl) {
          r.iframeEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (r.badge) {
          r.badge.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
          setTimeout(function () { try { r.badge.style.removeProperty("box-shadow"); } catch (e) {} }, 1400);
        }
      } catch (e) {}
    });
    list.appendChild(li);
  });
  shadow.appendChild(panelEl);

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
    try { host.remove(); } catch (e) {}
    // Restore outlines on elements we touched
    allResults.forEach(function (r) {
      if (r._resolveEl) {
        try {
          r._resolveEl.style.removeProperty("outline");
          r._resolveEl.style.removeProperty("outline-offset");
        } catch (e) {}
      }
    });
    delete window[P + "cleanup"];
    console.log("%c[a11y-names] cleared.", "color:#003876");
  };
}
