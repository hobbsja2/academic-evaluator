import type { JSX } from 'react';
import type { AiUseAssessment, AiUseIndicator } from '../shared/types';

const LOW_BAND_MAX = 3;
const CAPPED_SCORE = LOW_BAND_MAX;
const MIXED_BAND_MAX = 6;

interface ScoreBand {
  label: string;
  badgeClass: string;
}

/** Plain-language band for a 0-10 AI-use score. */
export function aiUseBand(score: number): ScoreBand {
  if (score <= LOW_BAND_MAX) return { label: 'Mostly human indicators', badgeClass: 'ready' };
  if (score <= MIXED_BAND_MAX) return { label: 'Mixed or inconclusive', badgeClass: 'review' };
  return { label: 'Strong AI indicators', badgeClass: 'ai-high' };
}

interface IndicatorListProps {
  title: string;
  items: AiUseIndicator[];
}

function IndicatorList({ title, items }: IndicatorListProps): JSX.Element {
  return (
    <div>
      <h4>{title}</h4>
      {items.length ? <ul>{items.map((item: AiUseIndicator, index: number) => (
        <li key={index}><q>{item.quote}</q> {item.observation}</li>
      ))}</ul> : <p>None verified.</p>}
    </div>
  );
}

function verificationNote(unverifiedCount: number, scoreCapped: boolean): string {
  const dropped: string = unverifiedCount
    ? `${unverifiedCount} indicator(s) were discarded because the quote was not in the submission or a "human" quote contained chatbot stock phrasing. `
    : '';
  const capped: string = scoreCapped
    ? `The score was lowered to ${CAPPED_SCORE} because no AI indicator could be matched to the submission.`
    : '';
  return `${dropped}${capped}`.trim();
}

interface AiUsePanelProps {
  assessment: AiUseAssessment;
}

/** Advisory AI-use estimate shown beside, never inside, the rubric scores. */
export function AiUsePanel({ assessment }: AiUsePanelProps): JSX.Element {
  const {
    score, aiIndicators, humanIndicators, summary, unverifiedCount, scoreCapped,
    stockPhrases, phraseDensity, phraseFloorApplied
  } = assessment;
  const band: ScoreBand = aiUseBand(score);
  const note: string = verificationNote(unverifiedCount, scoreCapped);
  return (
    <section className="panel" aria-labelledby="ai-use-heading">
      <div className="section-heading">
        <div><span className="step">AI</span><h2 id="ai-use-heading">AI use indicators</h2></div>
        <p>0 = more likely than not written solely by the student; 10 = heavy AI use throughout.</p>
      </div>
      <div className="ai-use-score">
        <strong>{score} / 10</strong>
        <span className={`badge ${band.badgeClass}`}>{band.label}</span>
      </div>
      {summary && <p className="ai-use-summary">{summary}</p>}
      {note && <p className="warning-text">{note}</p>}
      <p className="ai-use-summary">
        <strong>Stock-phrase scan:</strong>{' '}
        {stockPhrases.length
          ? `${stockPhrases.length} phrase(s) common in chatbot output (${phraseDensity} per 1,000 words): ${stockPhrases.join(', ')}.`
          : 'no phrases common in chatbot output were found.'}
        {phraseFloorApplied && ' The model scored this lower, but its reasoning conflicted with this density, so the score was raised and the model\'s summary is not shown.'}
      </p>
      <div className="ai-use-indicators analysis-copy">
        <IndicatorList title="AI indicators observed" items={aiIndicators} />
        <IndicatorList title="Human indicators observed" items={humanIndicators} />
      </div>
      <div className="privacy-warning">
        <p><strong>Advisory only. Not evidence of misconduct.</strong> This estimate comes from a small local model reading the text. It does not use an AI detector, and even dedicated detectors produce false positives, especially for non-native English writers and grammar-checked work. It does not change any rubric points. Treat it as a reason to look closer or talk with the student, not as a finding.</p>
      </div>
    </section>
  );
}
