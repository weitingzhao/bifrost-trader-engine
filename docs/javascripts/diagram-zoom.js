/**
 * Add pan/zoom to Mermaid diagrams using svg-pan-zoom.
 * Load after mermaid2 renders. Uses MutationObserver to catch async-rendered diagrams.
 */
(function () {
  const CDN = "https://unpkg.com/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
  const instances = new WeakSet();

  function initPanZoom(container) {
    const svg = container.querySelector("svg");
    if (!svg || instances.has(container)) return;
    if (typeof svgPanZoom !== "undefined") {
      try {
        svgPanZoom(svg, {
          zoomEnabled: true,
          fit: true,
          center: true,
          minZoom: 0.5,
          maxZoom: 5,
        });
        instances.add(container);
      } catch (e) {
        console.debug("svg-pan-zoom init:", e);
      }
    }
  }

  function loadAndInit() {
    const containers = document.querySelectorAll(".mermaid");
    containers.forEach((c) => {
      if (c.querySelector("svg")) initPanZoom(c);
    });
  }

  function loadScript() {
    if (window.svgPanZoom) {
      loadAndInit();
      observe();
      return;
    }
    const s = document.createElement("script");
    s.src = CDN;
    s.onload = function () {
      loadAndInit();
      observe();
    };
    document.head.appendChild(s);
  }

  function observe() {
    const observer = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains("mermaid")) {
            loadAndInit();
            return;
          }
          if (n.querySelector && n.querySelector(".mermaid")) {
            loadAndInit();
            return;
          }
          /* Mermaid replaces <code> with <svg> inside pre.mermaid */
          if (n.tagName === "SVG" && n.parentElement && n.parentElement.classList && n.parentElement.classList.contains("mermaid")) {
            loadAndInit();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    /* Retry: mermaid renders async, may finish after our first run */
    setTimeout(loadAndInit, 500);
    setTimeout(loadAndInit, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadScript);
  } else {
    loadScript();
  }
})();
