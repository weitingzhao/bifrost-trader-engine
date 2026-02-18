/**
 * Make FSM transition tables sortable by clicking column headers.
 * Uses Tablesort (loaded via extra_javascript).
 */
(function () {
  function initSortableTables() {
    if (typeof Tablesort === "undefined") return;
    const tables = document.querySelectorAll("article table:not([class])");
    tables.forEach(function (table) {
      try {
        new Tablesort(table);
      } catch (e) {
        console.debug("Tablesort init:", e);
      }
    });
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(initSortableTables);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSortableTables);
  } else {
    initSortableTables();
  }
})();
