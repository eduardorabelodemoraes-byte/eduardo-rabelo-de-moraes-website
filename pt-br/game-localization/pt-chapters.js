(() => {
  "use strict";

  const chapter = document.getElementById("mobile-chapter");
  if (!chapter) return;

  const names = {
    PROLOGUE: "PRÓLOGO",
    "ACT I": "ATO I",
    "ACT II": "ATO II",
    "ACT III": "ATO III",
    "ACT IV": "ATO IV",
    EPILOGUE: "EPÍLOGO",
    CREDITS: "CRÉDITOS",
    EXIT: "SAÍDA"
  };

  const localize = () => {
    const localized = names[chapter.textContent];
    if (localized) chapter.textContent = localized;
  };

  new MutationObserver(localize).observe(chapter, {
    childList: true,
    characterData: true,
    subtree: true
  });
  localize();
})();
