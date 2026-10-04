import type { ImageConfidence, ImageKind } from '@domain/models';
import { IMAGE_LIMITS, IMAGE_THRESHOLDS } from '@shared/constants';
import type { ImageClassification, ImageEvidence, ImageFacts, PixelStats } from './types';

/**
 * The only words the image classifier recognizes (docs/IMAGE_ADAPTATION.md, "Vocabulary").
 * Whole-token matches after splitting on non-letters, never substrings, never sentences: text is
 * secondary evidence and only ever points an image toward *not* being touched or toward being a
 * functional icon; it never makes a photograph adaptable.
 */
export const IMAGE_VOCABULARY = {
  chart: ['chart', 'graph', 'plot', 'histogram', 'sparkline', 'график', 'диаграмма'],
  diagram: ['diagram', 'flowchart', 'scheme', 'schematic', 'legend', 'схема', 'легенда'],
  status: [
    'status',
    'warning',
    'error',
    'success',
    'danger',
    'failed',
    'online',
    'offline',
    'статус',
    'ошибка',
    'предупреждение',
    'успех',
  ],
  logo: [
    'logo',
    'logotype',
    'wordmark',
    'brand',
    'branding',
    'favicon',
    'emblem',
    'trademark',
    'sponsor',
    'sponsors',
    'partner',
    'partners',
    'лого',
    'логотип',
    'бренд',
    'спонсор',
    'партнер',
  ],
  icon: ['icon', 'ico', 'glyph', 'pictogram', 'иконка', 'значок'],
  /**
   * What a functional control icon is *called*: the words of its alt text, aria-label or title.
   * A single-color image named anything else ("Acme", "Sponsor of the year") may be a brand mark,
   * so it never reaches HIGH confidence on a class name or a button around it alone.
   */
  action: [
    'search',
    'find',
    'close',
    'dismiss',
    'cancel',
    'menu',
    'hamburger',
    'download',
    'upload',
    'settings',
    'setting',
    'preferences',
    'gear',
    'cog',
    'notification',
    'notifications',
    'bell',
    'arrow',
    'chevron',
    'caret',
    'back',
    'next',
    'previous',
    'forward',
    'play',
    'pause',
    'share',
    'edit',
    'delete',
    'remove',
    'trash',
    'add',
    'plus',
    'minus',
    'check',
    'tick',
    'cross',
    'info',
    'help',
    'alert',
    'refresh',
    'reload',
    'print',
    'copy',
    'save',
    'filter',
    'sort',
    'expand',
    'collapse',
    'open',
    'more',
    'bookmark',
    'cart',
    'lock',
    'loading',
    'spinner',
    'поиск',
    'закрыть',
    'меню',
    'скачать',
    'настройки',
    'уведомления',
    'стрелка',
    'удалить',
    'добавить',
  ],
  screenshot: ['screenshot', 'screengrab', 'скриншот'],
  /** Weakest evidence of all; only used to explain a photograph, never to find one. */
  photo: ['photo', 'photograph', 'portrait', 'landscape', 'avatar', 'hero', 'фото'],
} as const;

type Vocabulary = keyof typeof IMAGE_VOCABULARY;

/** Own words that say "a person or a picture": such a bitmap is never a control icon. */
const IDENTITY_WORDS: readonly string[] = ['avatar', 'photo', 'photograph', 'portrait', 'фото'];

/** Lower-cased runs of letters and digits. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function has(tokens: readonly string[], word: Vocabulary): boolean {
  const list: readonly string[] = IMAGE_VOCABULARY[word];
  return tokens.some((token) => list.includes(token));
}

interface Builder {
  readonly evidence: ImageEvidence[];
}

function result(
  kind: ImageKind,
  confidence: ImageConfidence,
  builder: Builder,
): ImageClassification {
  return { kind, confidence, evidence: builder.evidence };
}

function note(builder: Builder, signal: string, supports: ImageKind): void {
  builder.evidence.push({ signal, supports });
}

/** True when `facts` carries an explicit author statement that the image is decoration. */
export function isDecorative(facts: ImageFacts): boolean {
  return (
    facts.ariaHidden ||
    facts.role === 'presentation' ||
    facts.role === 'none' ||
    (facts.source === 'img' && facts.alt === '')
  );
}

function maxSide(facts: ImageFacts): number {
  return Math.max(facts.naturalWidth, facts.naturalHeight);
}

/**
 * Classifies one image from DOM facts and (when readable) pixel statistics. Deterministic rules
 * over engineering signals; the confidence says how much those signals agree, not how likely the
 * guess is to be right about the picture. Automatic recoloring needs `monochrome-icon` + `HIGH`.
 */
export function classifyImage(facts: ImageFacts, stats: PixelStats | null): ImageClassification {
  const builder: Builder = { evidence: [] };
  const own = [...facts.ownTokens, ...facts.labelTokens];
  const context = facts.contextTokens;

  if (isDecorative(facts)) {
    note(builder, 'author marked it decorative (alt="", role, aria-hidden)', 'decorative');
    return result('decorative', 'HIGH', builder);
  }

  // Brand marks: never recolored, whatever else is true of them.
  if (has(own, 'logo')) {
    note(builder, 'logo token on the image itself', 'logo');
    return result('logo', 'HIGH', builder);
  }
  if (has(context, 'logo') || facts.linksHome) {
    note(builder, 'brand token or home link around the image', 'logo');
    return result('logo', 'MEDIUM', builder);
  }

  if (has(own, 'screenshot')) {
    note(builder, 'screenshot token', 'screenshot');
    return result('screenshot', 'HIGH', builder);
  }

  if (!stats) {
    // Unreadable or not analysed: text can still say "chart", never more.
    if (has(own, 'chart')) {
      note(builder, 'chart token (pixels not read)', 'chart-raster');
      return result('chart-raster', 'MEDIUM', builder);
    }
    if (has(own, 'diagram')) {
      note(builder, 'diagram token (pixels not read)', 'diagram');
      return result('diagram', 'MEDIUM', builder);
    }
    return result('unknown', 'UNKNOWN', builder);
  }

  const chromatic = stats.clusters.filter((cluster) => !cluster.neutral);
  const entropyHigh = stats.entropyBits >= IMAGE_THRESHOLDS.photoEntropy;
  const cellsHigh = stats.distinctCells >= IMAGE_THRESHOLDS.photoCells;

  if (entropyHigh || cellsHigh) {
    const both = entropyHigh && cellsHigh;
    note(
      builder,
      `${stats.distinctCells} color cells, ${stats.entropyBits.toFixed(1)} bits of color entropy`,
      'photograph',
    );
    if (has(own, 'photo') || has(context, 'photo')) note(builder, 'photo token', 'photograph');
    // A big, flat, opaque, sharp image with a lot of cells is more likely UI than a photograph.
    if (stats.flatShare >= 0.85 && stats.edgeShare >= 0.04 && maxSide(facts) >= 320) {
      note(builder, 'flat regions with sharp edges at a large size', 'screenshot');
      return result('screenshot', 'MEDIUM', builder);
    }
    return result('photograph', both ? 'HIGH' : 'MEDIUM', builder);
  }

  if (has(own, 'chart') || has(context, 'chart')) {
    note(builder, 'chart token', 'chart-raster');
    return result('chart-raster', has(own, 'chart') ? 'HIGH' : 'MEDIUM', builder);
  }
  const big = maxSide(facts) >= 120 && Math.min(facts.naturalWidth, facts.naturalHeight) >= 80;
  if (
    big &&
    stats.transparentShare < 0.1 &&
    stats.neutralShare >= 0.45 &&
    chromatic.filter((cluster) => cluster.share >= 0.02).length >= 2 &&
    stats.flatShare >= 0.8
  ) {
    note(
      builder,
      'neutral ground with several flat colored regions (chart-like structure)',
      'chart-raster',
    );
    return result('chart-raster', 'MEDIUM', builder);
  }

  if (has(own, 'diagram') || has(context, 'diagram')) {
    note(builder, 'diagram token', 'diagram');
    return result('diagram', has(own, 'diagram') ? 'HIGH' : 'MEDIUM', builder);
  }

  const small = maxSide(facts) <= IMAGE_LIMITS.maxIconDimension;
  if (has(own, 'status') || has(context, 'status')) {
    if (maxSide(facts) <= 96 && chromatic.length >= 1) {
      note(builder, 'status token on a small image with a chromatic paint', 'status-graphic');
      return result('status-graphic', has(own, 'status') ? 'HIGH' : 'MEDIUM', builder);
    }
  }

  if (small) {
    // Positive evidence that this is a control's icon: its name says what it does, or (when it
    // has no name of its own) its class, id or file says "icon". An image named something else may
    // be a brand mark; a button or a non-empty alt around it is not evidence of function.
    const named = facts.labelTokens.length > 0;
    const functional = named ? has(facts.labelTokens, 'action') : has(facts.ownTokens, 'icon');
    // A person or a picture, not a control: only the image's own words count (a close button
    // inside a `.hero` banner is still a close button).
    const identity = own.some((token) => IDENTITY_WORDS.includes(token));
    if (chromatic.length === 1 && stats.transparentShare >= 0.15) {
      note(builder, 'one chromatic paint on a transparent ground', 'monochrome-icon');
      if (functional) note(builder, 'named or marked as a control icon', 'monochrome-icon');
      else note(builder, 'no functional name: could be a brand mark', 'logo');
      if (identity) note(builder, 'avatar or photo token', 'photograph');
      const clean = stats.noiseShare <= 0.1 && stats.distinctCells <= 60;
      const iconSized =
        Math.max(facts.renderedWidth, facts.renderedHeight) <=
        IMAGE_LIMITS.maxIconRenderedDimension;
      return result(
        'monochrome-icon',
        functional && !identity && clean && iconSized ? 'HIGH' : 'MEDIUM',
        builder,
      );
    }
    if (chromatic.length >= 1) {
      note(builder, 'small bitmap with several paints', 'ui-raster');
      return result('ui-raster', 'LOW', builder);
    }
    note(builder, 'small bitmap without chromatic paint', 'ui-raster');
    return result('ui-raster', 'MEDIUM', builder);
  }

  if (stats.flatShare >= 0.8 && stats.clusters.length <= 6) {
    note(builder, 'flat colored regions at a medium or large size', 'illustration');
    return result('illustration', 'MEDIUM', builder);
  }
  if (stats.clusters.length > 4) {
    note(builder, 'many clusters', 'complex-artwork');
    return result('complex-artwork', 'MEDIUM', builder);
  }
  return result('unknown', 'LOW', builder);
}
