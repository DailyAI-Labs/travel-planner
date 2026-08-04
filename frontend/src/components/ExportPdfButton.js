import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { renderRouteImage } from './staticMap';

/**
 * Downloads the itinerary as a PDF, map included.
 *
 * Unlike the Markdown export this one is asynchronous: the PDF writer is
 * fetched on demand rather than shipped in the first load, and the map has to
 * be drawn from tiles that are fetched on the spot. Both take a moment on a
 * cold cache, so the button says so rather than appearing to do nothing.
 */
function ExportPdfButton({ itinerary, area }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // Roughly a third of the bundle, for a button most sessions end at
      // rather than start from: worth a round trip on the first click.
      const { createItineraryPdf, pdfFilename, MAP_PIXELS } = await import(
        './itineraryPdf'
      );

      let mapImage = null;
      try {
        mapImage = await renderRouteImage(itinerary.days, MAP_PIXELS);
      } catch {
        // An itinerary without its map is still worth having.
        mapImage = null;
      }

      const doc = createItineraryPdf({ itinerary, area, t, mapImage });
      doc.save(pdfFilename(area));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="export-action">
      <button type="button" onClick={download} disabled={busy}>
        {busy ? t('pdf.generating') : t('pdf.button')}
      </button>
      {failed && <span className="export-error">{t('export.failed')}</span>}
    </span>
  );
}

export default ExportPdfButton;
