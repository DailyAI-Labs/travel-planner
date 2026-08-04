import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { itineraryToMarkdown, markdownFilename } from './itineraryMarkdown';

/**
 * Downloads the itinerary as a .md file, entirely client-side: the plan is
 * already in memory, so there is nothing to ask the backend for.
 */
function ExportMarkdownButton({ itinerary, area }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);

  const download = () => {
    try {
      const markdown = itineraryToMarkdown(itinerary, { area, t });
      const blob = new Blob([markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = markdownFilename(area);
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking in the same tick cancels the download on Firefox and Safari.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setFailed(false);
    } catch {
      // Blob or object URLs can be blocked; say so rather than doing nothing.
      setFailed(true);
    }
  };

  return (
    <span className="export-actions">
      <button type="button" onClick={download}>
        {t('export.button')}
      </button>
      {failed && <span className="export-error">{t('export.failed')}</span>}
    </span>
  );
}

export default ExportMarkdownButton;
