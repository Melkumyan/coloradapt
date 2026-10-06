import type { JSX } from 'react';
import {
  ASSIST_COVERAGE_LABEL,
  ASSIST_LABELS,
  ASSIST_STATUS_LABEL,
  type AuditSemanticAssistEntry,
} from '@core/audit';
import type { SemanticAssistState } from './use-semantic-assist';

/** The words of an accepted interpretation: text and a shape, never color alone. */
function meaningText(entry: AuditSemanticAssistEntry): string {
  return entry.validatorStatus === 'ACCEPTED_ADVISORY' && entry.hypothesis
    ? `${ASSIST_LABELS.likelyMeaning}: ${entry.hypothesis}`
    : ASSIST_LABELS.needsReview;
}

/** One line on a finding's card header: the interpretation, if there is one. */
export function AssistBadge({ entry }: { entry: AuditSemanticAssistEntry }): JSX.Element {
  return (
    <span data-testid="assist-badge" data-assist-status={entry.validatorStatus}>
      {ASSIST_STATUS_LABEL[entry.validatorStatus].slice(0, 1)} {ASSIST_LABELS.heading}:{' '}
      {meaningText(entry)}
    </span>
  );
}

/** The interpretation, with its provenance, apart from the deterministic evidence. */
export function AssistBlock({
  entry,
  provider,
}: {
  entry: AuditSemanticAssistEntry;
  provider: SemanticAssistState['provider'];
}): JSX.Element {
  const local = provider.provider.startsWith('local-');
  return (
    <section className="assist" aria-label={ASSIST_LABELS.heading} data-testid="assist-block">
      <h4>{ASSIST_LABELS.heading}</h4>
      <p>
        <strong>{ASSIST_STATUS_LABEL[entry.validatorStatus]}.</strong> {meaningText(entry)}.{' '}
        {ASSIST_LABELS.advisory}.
      </p>
      <ul>
        <li>Source: AI semantic assist{local ? ` · ${ASSIST_LABELS.local}` : ''}.</li>
        {entry.instances > 1 && (
          <li data-testid="assist-scope">
            Representative element: {entry.sampled} of {entry.instances} elements of this finding
            were compared and gave identical evidence; the others were not read individually.
          </li>
        )}
        <li>
          Provider: <code>{provider.provider}</code>
          {provider.model ? (
            <>
              {' '}
              · model <code>{provider.model}</code>
            </>
          ) : null}
          .
        </li>
        {entry.modelConfidence !== null && (
          <li>
            Model confidence: {entry.modelConfidence.toFixed(2)} (the model’s own number; not the
            finding’s confidence, and it authorizes nothing).
          </li>
        )}
        <li>
          Validator: {ASSIST_STATUS_LABEL[entry.validatorStatus]} (
          <code>{entry.validatorReason}</code>
          ).
        </li>
        {entry.supportingEvidence.length > 0 && (
          <li>
            Supporting deterministic evidence:
            <ul>
              {entry.supportingEvidence.map((item) => (
                <li key={item.id}>
                  <code>{item.id}</code> {item.source}: <code>{item.value}</code>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
      <p className="muted">
        The finding above is unchanged. This interpretation can only help a person review it.
      </p>
    </section>
  );
}

export function AssistPanel({ assist }: { assist: SemanticAssistState }): JSX.Element {
  const stats = assist.stats;
  const local = assist.enabled && assist.provider.provider.startsWith('local-');
  return (
    <section aria-labelledby="assist-heading" className="assist" data-testid="assist-panel">
      <h2 id="assist-heading">{ASSIST_LABELS.heading}</h2>
      <p data-testid="assist-coverage" data-coverage={assist.coverage}>
        <strong>{ASSIST_COVERAGE_LABEL[assist.coverage]}</strong>
        {local && ` · ${ASSIST_LABELS.localPrivacy}`}
      </p>
      {!assist.enabled ? (
        <p className="muted">
          Optional and off by default. It runs a model on this computer to suggest a meaning for
          findings that need manual review. Turn it on in the extension’s settings. Everything else
          in this audit works without it.
        </p>
      ) : (
        <>
          <div className="audit__actions">
            <button
              type="button"
              onClick={() => void assist.run()}
              disabled={assist.running}
              data-testid="assist-run"
            >
              {assist.running ? 'Running AI-assisted review…' : 'Run AI-assisted review'}
            </button>
          </div>
          <p className="muted">
            Only the findings that need manual review are sent, as small redacted summaries, to the
            model on this computer. A case without an interpretation says nothing about the page.
          </p>
        </>
      )}
      {stats && (
        <p role="status" data-testid="assist-stats">
          {stats.eligible} eligible · {stats.queried} sent to the model · {stats.accepted} likely
          meaning · {stats.unresolved} needs review · {stats.rejected} rejected ·{' '}
          {stats.modelErrors} model errors · {stats.notQueued} not queued.
        </p>
      )}
      {assist.heterogeneous > 0 && (
        <p data-testid="assist-heterogeneous">
          {assist.heterogeneous} finding{assist.heterogeneous === 1 ? '' : 's'} not sent to the
          model: the elements grouped in {assist.heterogeneous === 1 ? 'it' : 'them'} have different
          evidence, so one interpretation would not fit all of them. They stay manual review.
        </p>
      )}
      {assist.coverage === 'unavailable' && (
        <p role="alert" className="notice">
          Local AI unavailable{assist.failure ? ` (${assist.failure})` : ''}. Nothing was sent
          anywhere else; findings stay as they are.
          {assist.failure === 'http-error' &&
            ' The runtime refused the request: Ollama only accepts requests from this extension if OLLAMA_ORIGINS includes chrome-extension://* .'}
        </p>
      )}
    </section>
  );
}
