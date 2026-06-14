// Export card runner — the export card is an ACTION host, not a compute step.
// The real work (pick a selection, generate RIS, download) happens live in
// the export panel. This prep job just stamps the card so it exists in the
// tree, is selectable, and auto-opens its panel on completion. The chosen
// selection config is persisted on the card by the panel via setCardExport.

export function buildExportPrepJob() {
  return async function runExportPrepJob(ctx) {
    ctx.setPhase    && ctx.setPhase("ready to export");
    ctx.setProgress && ctx.setProgress(1);
    return {
      capturedAt: new Date().toISOString(),
      // Last selection the user exported with (panel updates this). Null until
      // the user downloads something.
      lastSelection: null,
    };
  };
}
