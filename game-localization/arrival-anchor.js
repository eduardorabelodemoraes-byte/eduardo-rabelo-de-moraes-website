// Runs before Games initialization; never consumes its handoff marker.
// No intermediate spark and no delayed repositioning after fonts/layout.
(() => {
  if (!document.documentElement.classList.contains('threshold-handoff')) return;
  try {
    const marker = JSON.parse(sessionStorage.getItem('phase1dThresholdHandoff'));
    if (Number.isFinite(marker?.sparkY) && marker.sparkY > 0 && marker.sparkY < innerHeight) {
      document.documentElement.style.setProperty('--river-spark-y', `${marker.sparkY}px`);
    }
  } catch (_) { /* Shared responsive CSS remains the fallback. */ }
})();
