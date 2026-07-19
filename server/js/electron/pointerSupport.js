/*
 * pointerSupport.js — Mouse + keyboard support for the Crunchyroll HTPC frontend.
 *
 * The UI is a "10-foot" TV interface: every screen navigates a highlighted
 * element with the D-pad (arrow keys) and activates it with OK (Enter). There
 * are no per-element click handlers. Rather than rewrite each screen, this
 * layer translates pointer input into the app's OWN navigation:
 *
 *   - Move the mouse over an item  -> synthesize the arrow presses that walk
 *     the existing highlight onto that item (geometric hill-climb).
 *   - Click an item                -> walk the highlight there, then Enter.
 *   - Right click / mouse "back"    -> Escape (back).
 *   - Mouse wheel                   -> Up/Down navigation.
 *
 * Because it drives each screen's real keyDown handlers, internal state
 * (home.position, slick carousels, keyboard.selected, etc.) stays in sync and
 * side effects (scrolling, backgrounds) keep working. The main screen ("home")
 * uses slick carousels with no per-item highlight class, so it gets a dedicated
 * driver. Everything is wrapped in try/catch so a pointer bug can never break
 * the remote/keyboard experience.
 */
(function () {
  "use strict";

  var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, BACK: 27 };
  var ACTIVE = ["selected", "focus", "active"]; // priority order
  // Elements that count as "navigable" targets for hover/click.
  var NAV =
    ".item,.option,.col,.button,.season,.buttons a,.options li," +
    "#settings-details li,#setting-options i,#languages-content .option," +
    ".login-screen-option,#search-screen_input,.list-container-over .item," +
    "#exit-screen .button,.browse-content .item";

  function press(code) {
    if (window.app && typeof app.keyDown === "function") {
      app.keyDown({ keyCode: code });
    }
  }

  function screenEl() {
    return window.main && main.state ? document.getElementById(main.state) : null;
  }

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function centerOfRect(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  function dist(a, b) {
    var dx = a.x - b.x,
      dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pointInRect(p, r, pad) {
    pad = pad || 4;
    return (
      p.x >= r.left - pad &&
      p.x <= r.right + pad &&
      p.y >= r.top - pad &&
      p.y <= r.bottom + pad
    );
  }

  /* The rect/center of the element the app currently considers focused. */
  function activeInfo() {
    var scr = screenEl();
    if (!scr) return null;

    // home screen: highlight lives in slick carousels, not a class.
    if (main.state === "home-screen" && window.home) {
      if (home.position > 0) {
        var rows = scr.querySelectorAll(".row-content");
        var rowEl = rows[home.position - 1];
        if (rowEl && rowEl.slick) {
          var idx = rowEl.slick.currentSlide;
          var slide =
            rowEl.querySelector('.slick-slide[data-slick-index="' + idx + '"]') ||
            rowEl.querySelectorAll(".slick-slide")[idx];
          if (slide && visible(slide))
            return { el: slide, c: centerOfRect(slide.getBoundingClientRect()) };
        }
        if (rowEl && visible(rowEl))
          return { el: rowEl, c: centerOfRect(rowEl.getBoundingClientRect()) };
      } else {
        var b = scr.querySelector(".details .buttons a.selected");
        if (b && visible(b))
          return { el: b, c: centerOfRect(b.getBoundingClientRect()) };
      }
    }

    // generic: the most specific visible element carrying an active class.
    var best = null;
    for (var i = 0; i < ACTIVE.length; i++) {
      var els = scr.querySelectorAll("." + ACTIVE[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!visible(el)) continue;
        var r = el.getBoundingClientRect();
        var area = r.width * r.height;
        if (!best || area < best.area) best = { el: el, area: area, rect: r };
      }
      if (best) break; // prefer higher-priority class
    }
    if (best) return { el: best.el, c: centerOfRect(best.rect) };
    return null;
  }

  function deadZone(info) {
    var r = info.c.rect;
    return Math.max(24, Math.min(r.width, r.height) * 0.45);
  }

  /*
   * Walk the app's highlight toward a screen point using synthetic arrow keys.
   * Returns true if the highlight ended on/over the target. Aborts safely if the
   * screen changes (e.g. an edge press opened the menu) or progress stalls.
   */
  function walkTo(target, guardState) {
    var info = activeInfo();
    if (!info) return false;
    var prev = dist(info.c, target);
    var stalls = 0;

    for (var step = 0; step < 80 && stalls < 3; step++) {
      info = activeInfo();
      if (!info) return false;
      if (pointInRect(target, info.c.rect)) return true;

      var dx = target.x - info.c.x;
      var dy = target.y - info.c.y;
      var dz = deadZone(info);

      var moves = [];
      if (Math.abs(dy) > dz) moves.push(dy > 0 ? KEY.DOWN : KEY.UP);
      if (Math.abs(dx) > dz) moves.push(dx > 0 ? KEY.RIGHT : KEY.LEFT);
      if (moves.length === 0) return true; // within a tile
      if (Math.abs(dx) > Math.abs(dy)) moves.reverse(); // dominant axis first

      var moved = false;
      for (var m = 0; m < moves.length; m++) {
        var before = activeInfo();
        press(moves[m]);
        if (!window.main || main.state !== guardState) return false; // screen left
        var after = activeInfo();
        if (
          after &&
          before &&
          (after.c.x !== before.c.x || after.c.y !== before.c.y)
        ) {
          var nd = dist(after.c, target);
          prev = Math.min(prev, nd);
          moved = true;
          break;
        }
      }
      stalls = moved ? 0 : stalls + 1;
    }
    info = activeInfo();
    return info ? pointInRect(target, info.c.rect) : false;
  }

  /* ---- home screen dedicated driver (slick carousels) ---- */
  function homeDrive(node, doEnter) {
    if (!window.home || main.state !== "home-screen") return;
    var scr = screenEl();
    var guard = main.state;
    var desiredPos, desiredCol;

    var btn = node.closest("#home-screen .details .buttons a");
    if (btn) {
      var btns = Array.prototype.slice.call(
        scr.querySelectorAll(".details .buttons a")
      );
      desiredPos = 0;
      desiredCol = btns.indexOf(btn);
      if (desiredCol < 0) return;
    } else {
      var item = node.closest("#home-screen .row-content .item");
      if (!item) return;
      var rowEl = item.closest(".row-content");
      var rows = Array.prototype.slice.call(scr.querySelectorAll(".row-content"));
      var r = rows.indexOf(rowEl);
      if (r < 0) return;
      var slide = item.closest(".slick-slide");
      var sIdx = slide
        ? parseInt(slide.getAttribute("data-slick-index"), 10)
        : Array.prototype.slice
            .call(rowEl.querySelectorAll(".item"))
            .indexOf(item);
      if (isNaN(sIdx) || sIdx < 0) return;
      // Ignore the empty placeholder items appended after real content.
      var list =
        home.data && home.data.main && home.data.main.lists
          ? home.data.main.lists[r]
          : null;
      if (!list || sIdx >= list.items.length) return;
      desiredPos = r + 1;
      desiredCol = sIdx;
    }

    // vertical: change home.position
    var vs = 0;
    while (home.position !== desiredPos && vs++ < 60) {
      var pb = home.position;
      press(home.position < desiredPos ? KEY.DOWN : KEY.UP);
      if (main.state !== guard) return;
      if (home.position === pb) break;
    }

    // horizontal
    var hs = 0;
    if (desiredPos === 0) {
      var getBtn = function () {
        var b = scr.querySelectorAll(".details .buttons a");
        for (var i = 0; i < b.length; i++)
          if (b[i].classList.contains("selected")) return i;
        return 0;
      };
      var cur = getBtn();
      while (cur !== desiredCol && hs++ < 12) {
        if (cur < desiredCol) press(KEY.RIGHT);
        else {
          if (cur <= 0) break; // never press LEFT at index 0 (opens menu)
          press(KEY.LEFT);
        }
        if (main.state !== guard) return;
        var nc = getBtn();
        if (nc === cur) break;
        cur = nc;
      }
    } else {
      var row = scr.querySelectorAll(".row-content")[home.position - 1];
      var getSlide = function () {
        return row && row.slick ? row.slick.currentSlide : 0;
      };
      var cs = getSlide();
      while (cs !== desiredCol && hs++ < 150) {
        if (cs < desiredCol) press(KEY.RIGHT);
        else {
          if (cs <= 0) break; // never press LEFT at slide 0 (opens menu)
          press(KEY.LEFT);
        }
        if (main.state !== guard) return;
        var ns = getSlide();
        if (ns === cs) break;
        cs = ns;
      }
    }

    if (doEnter) press(KEY.ENTER);
  }

  /* ---- pointer event handling ---- */
  var NO_HOVER = { "video-screen": 1, "loading-screen": 1 };
  var lastHoverKey = null;
  var hoverThrottle = 0;

  function navTarget(node) {
    return node && node.closest ? node.closest(NAV) : null;
  }

  function handleHover(e) {
    try {
      if (!window.main || !main.state || NO_HOVER[main.state]) return;
      var now = Date.now ? Date.now() : new Date().getTime();
      if (now - hoverThrottle < 60) return;
      var t = navTarget(e.target);
      if (!t) return;
      var key = main.state + ":" + hoverKey(t);
      if (key === lastHoverKey) return;
      hoverThrottle = now;
      lastHoverKey = key;
      if (main.state === "home-screen") {
        homeDrive(t, false);
      } else {
        walkTo(centerOfRect(t.getBoundingClientRect()), main.state);
      }
    } catch (err) {
      /* never let hover break the app */
    }
  }

  function hoverKey(el) {
    // cheap stable identity for an element within a render
    var p = el;
    var idx = 0;
    if (p.parentNode) {
      var sibs = p.parentNode.children;
      for (var i = 0; i < sibs.length; i++)
        if (sibs[i] === p) {
          idx = i;
          break;
        }
    }
    return (el.className || "") + "#" + idx + "@" + (el.textContent || "").slice(0, 12);
  }

  // Screens where clicking a text field should only focus it (so the user can
  // type with a real keyboard) instead of firing Enter.
  function isFocusOnlyField(node) {
    if (main.state === "search-screen" && node.closest("#search-screen_input"))
      return true;
    if (
      main.state === "login-screen" &&
      node.closest(".login-screen-option") &&
      node.closest(".login-screen-option").querySelector("input")
    )
      return true;
    return false;
  }

  function handleClick(e) {
    try {
      if (!window.main || !main.state) return;
      var t = navTarget(e.target);
      if (!t) return;
      e.preventDefault();
      lastHoverKey = null;

      if (main.state === "home-screen") {
        homeDrive(t, true);
        return;
      }

      var focusOnly = isFocusOnlyField(t);
      var arrived = walkTo(centerOfRect(t.getBoundingClientRect()), main.state);
      if (!window.main || main.state !== e._startState) {
        /* main.state may legitimately not be tracked; ignore */
      }
      if (arrived && !focusOnly) press(KEY.ENTER);
    } catch (err) {
      /* swallow */
    }
  }

  function handleContext(e) {
    try {
      e.preventDefault();
      press(KEY.BACK);
    } catch (err) {}
  }

  function handleAux(e) {
    // mouse "back" button (button 3) -> Escape
    try {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        press(KEY.BACK);
      }
    } catch (err) {}
  }

  var wheelThrottle = 0;
  function handleWheel(e) {
    try {
      if (!window.main || !main.state || main.state === "video-screen") return;
      var now = Date.now ? Date.now() : new Date().getTime();
      if (now - wheelThrottle < 110) return;
      wheelThrottle = now;
      press(e.deltaY > 0 ? KEY.DOWN : KEY.UP);
    } catch (err) {}
  }

  function injectStyles() {
    var css =
      "html,body,*{cursor:default}" +
      NAV.split(",").join(":hover,") +
      ":hover{cursor:pointer}" +
      // keep the old cursor-blocker overlay from ever showing / catching clicks
      ".no-cursor{display:none !important;pointer-events:none !important}";
    var style = document.createElement("style");
    style.id = "pointer-support-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function removeBlocker() {
    var b = document.querySelectorAll(".no-cursor");
    for (var i = 0; i < b.length; i++)
      b[i].parentNode && b[i].parentNode.removeChild(b[i]);
  }

  function init() {
    try {
      injectStyles();
      removeBlocker();
      document.addEventListener("mousemove", handleHover, true);
      document.addEventListener("click", handleClick, true);
      document.addEventListener("contextmenu", handleContext, true);
      document.addEventListener("mouseup", handleAux, true);
      document.addEventListener("wheel", handleWheel, { passive: true });
      // The blocker overlay is appended during main.init(); clear it again shortly.
      setTimeout(removeBlocker, 1000);
    } catch (err) {
      console.log("pointerSupport init failed", err);
    }
  }

  if (document.readyState === "complete") init();
  else window.addEventListener("load", init);
})();
