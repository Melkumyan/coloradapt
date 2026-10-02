import { useCallback, useState } from 'react';
import { getActiveTabId, sendToTab } from '@infrastructure/messaging';
import type { AnalysisResult } from '@domain/models';

export interface UsePageAnalysisResult {
  readonly analysis: AnalysisResult | null;
  readonly analyzing: boolean;
  readonly error: string | null;
  readonly analyze: () => Promise<void>;
}

/** Drives the active tab's content script to analyze the current page. Popup-only concern. */
export function usePageAnalysis(): UsePageAnalysisResult {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const tabId = await getActiveTabId();
      if (tabId === undefined) throw new Error('No active tab');
      const result = await sendToTab(tabId, 'ANALYZE_PAGE', undefined);
      setAnalysis(result);
    } catch {
      setError(
        'Could not analyze this page. It may not support ColorAdapt (e.g. a browser settings page).',
      );
    } finally {
      setAnalyzing(false);
    }
  }, []);

  return { analysis, analyzing, error, analyze };
}
