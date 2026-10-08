import type { AnalysisRoot } from '@core/analysis';
import { parseColor, relativeLuminance } from '@core/color';
import {
  EQUIVALENCE,
  assessColorOnly,
  classifyElement,
  decideCue,
  detectExistingCues,
  tokenStates,
  type ColorOnlyVerdict,
  type CueDecision,
  type CueSpec,
  type ElementKind,
  type ElementFacts,
  type PeerFacts,
  type SemanticCuePlan,
  type SemanticResult,
} from '@core/semantics';
import type { SemanticDiagnostics } from '@domain/models';
import { EMPTY_SEMANTIC_DIAGNOSTICS } from '@domain/models';
import { CUE_ATTRIBUTE, cueKey, cueSheet, renderedGlyph, type DotTone } from './cue-css';
import {
  ARIA_ATTRIBUTES,
  defaultFactsEnvironment,
  readElementFacts,
  readStyleSnapshot,
  type FactsEnvironment,
} from './dom-facts';

/** Structural limits (docs/SEMANTIC_ACCESSIBILITY.md, "Performance"). No wall-clock gates. */
export const SEMANTIC_LIMITS = {
  /** Elements walked per subtree root. */
  maxWalkedPerRoot: 5000,
  /** Candidate elements examined per pass. */
  maxCandidatesPerPass: 1500,
  /** Comparable elements looked at per candidate. */
  maxPeers: 24,
  /** Differently-stated peers whose styles are read per candidate. */
  maxContrastingPeers: 4,
  /** Ancestors of a changed element that may be the semantic unit (`<b>` inside `.badge`). */
  ancestorLevels: 3,
  /** How far up the tree comparable elements are searched. */
  peerLevels: 4,
  /** Elements of one peer group re-examined when one of them changes. */
  expansionPeers: 100,
  /** Elements of an added or restyled region (beyond its candidates) that name their peer group. */
  peerSourcesPerRoot: 24,
  /** Peer groups searched per pass (one search per changed element that is not already covered). */
  maxPeerSearches: 300,
  /** Peers added to a pass on top of the candidates M4 named. */
  maxPeerExtras: 400,
  /** Elements looked at in total by the peer searches of one pass. */
  maxPeerScan: 6000,
} as const;

/**
 * An element that left the page: its former peers (what is left of the same component under
 * `anchor`, the node it was removed from) may no longer be compared with anything.
 * `template` is the detached element; only its tag, role, input type and class names are read.
 */
export interface PeerSeed {
  readonly anchor: Element;
  readonly template: Element;
}

/**
 * Relative luminance at which black and white glyphs have the same WCAG contrast against a fill
 * (`(L + .05) / .05 = 1.05 / (L + .05)`): lighter fills get a dark glyph, darker ones a light glyph.
 */
const GLYPH_TONE_CROSSOVER = 0.179;

/** What the semantic layer needs from the stylesheet. */
export interface CueSheetHost {
  setCueCss(css: string | null): void;
  /** Runs `read` with the page's own styles in effect (cues and recoloring suspended). */
  withOriginalStyles<T>(read: () => T): T;
}

export interface SemanticCueOptions {
  readonly doc: Document;
  readonly sheet: CueSheetHost;
  readonly env?: FactsEnvironment;
}

interface Examined {
  readonly facts: ElementFacts;
  readonly result: SemanticResult;
}

/** What {@link SemanticCueController.inspect} reports. */
export interface SemanticInspection {
  readonly result: SemanticResult;
  readonly decision: CueDecision;
  readonly kind: ElementKind;
}

/** One element as the developer audit sees it (docs/DEVELOPER_AUDIT.md): what it means and whether color is all that says so. */
export interface SemanticAuditRecord {
  readonly element: Element;
  readonly result: SemanticResult;
  readonly decision: CueDecision;
  /** The color-only verdict, when the decision got far enough to ask for one. */
  readonly verdict: ColorOnlyVerdict | null;
  readonly kind: ElementKind;
  /** The element carries one of this layer's cues right now. */
  readonly hasCue: boolean;
}

export interface SemanticAuditScan {
  readonly records: readonly SemanticAuditRecord[];
  /** The layer is adding cues right now (so a missing cue means something). */
  readonly enabled: boolean;
  /** Candidates examined (a structural cap ends the scan, never the clock). */
  readonly candidates: number;
}

/** Layout facts read before a cue exists, to compare with the layout after it. */
interface Metrics {
  readonly rect: DOMRect;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

function measure(element: Element): Metrics {
  return {
    rect: element.getBoundingClientRect(),
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  };
}

/** Placements that put something into the element's box or its line: the ones whose layout is checked. */
function isInFlowGlyph(placement: CueSpec['placement']): boolean {
  return placement === 'after' || placement === 'before' || placement === 'inner';
}

interface Desired {
  readonly key: string;
  readonly spec: CueSpec;
}

/** Class-name substrings that make an element worth a closer look (a superset of the real vocabulary). */
const CLASS_HINT =
  /error|danger|fail|invalid|success|valid|warn|caution|info|select|active|disabled|required|positive|negative|online|offline|increase|decrease|status|badge|pill|chip|tag|alert|message|notice|toast|banner|callout|feedback|indicator|presence|delta|trend|change|tab|nav|menu|dot/i;

const DATA_HINTS = [
  'data-state',
  'data-status',
  'data-variant',
  'data-type',
  'data-severity',
  'data-kind',
  'data-validity',
  'data-selected',
  'data-active',
  'data-invalid',
] as const;

const FORM_FIELD = /^(?:input|select|textarea)$/;

function hasHint(element: Element): boolean {
  if (element.hasAttribute(CUE_ATTRIBUTE)) return true;
  for (const name of ARIA_ATTRIBUTES) if (element.hasAttribute(name)) return true;
  const role = element.getAttribute('role');
  if (role === 'alert' || role === 'status' || role === 'tab') return true;
  if (FORM_FIELD.test(element.localName)) return true;
  if (element.localName === 'label') return (element as HTMLLabelElement).control !== null;
  for (const name of DATA_HINTS) if (element.hasAttribute(name)) return true;
  const cls = element.getAttribute('class');
  return cls !== null && CLASS_HINT.test(cls);
}

/** Skipped entirely: not page content, or a world of its own (M5 owns inline SVG). */
function isSkippedTag(element: Element): boolean {
  const tag = element.localName;
  return (
    tag === 'svg' ||
    tag === 'script' ||
    tag === 'style' ||
    tag === 'template' ||
    tag === 'noscript' ||
    tag === 'head'
  );
}

/**
 * The semantic-cue layer (M6, docs/SEMANTIC_ACCESSIBILITY.md): reads elements, asks the pure
 * semantic core what they mean and whether color is all that says so, and applies the answer as
 * one attribute per element plus one static stylesheet.
 *
 * It owns no observer. {@link update} receives the regions M4 already decided to look at.
 * Reading happens with the page's own styles in effect; applying is verified against the
 * browser and a cue is only counted when it renders as planned.
 */
export class SemanticCueController {
  readonly #doc: Document;
  readonly #sheet: CueSheetHost;
  readonly #env: FactsEnvironment;
  #enabled = false;
  /** The cue CSS last written to the sheet (`null`: none), to prune rules whose cues are gone. */
  #sheetCss: string | null = null;
  #counters: Omit<SemanticDiagnostics, 'cuesActive'> = EMPTY_SEMANTIC_DIAGNOSTICS;

  constructor(options: SemanticCueOptions) {
    this.#doc = options.doc;
    this.#sheet = options.sheet;
    this.#env = options.env ?? defaultFactsEnvironment(options.doc);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Starts (or restarts) with these settings. Turning the setting off removes every cue. */
  begin(settings: { readonly enabled: boolean; readonly semanticCuesEnabled: boolean }): void {
    this.#enabled = settings.enabled && settings.semanticCuesEnabled;
    if (!this.#enabled) this.end();
  }

  /** Removes every cue and the cue stylesheet. Counters are kept. */
  end(): void {
    this.#enabled = false;
    let removed = 0;
    for (const element of this.#doc.querySelectorAll(`[${CUE_ATTRIBUTE}]`)) {
      element.removeAttribute(CUE_ATTRIBUTE);
      removed += 1;
    }
    this.#add({ cuesRemoved: removed });
    this.#sheet.setCueCss(null);
    this.#sheetCss = null;
  }

  diagnostics(): SemanticDiagnostics {
    return {
      ...this.#counters,
      cuesActive: this.#doc.querySelectorAll(`[${CUE_ATTRIBUTE}]`).length,
    };
  }

  /** Full pass over the document body. */
  scanDocument(): void {
    const body = this.#doc.body;
    if (!this.#enabled || !body) return;
    this.update([{ element: body, scope: 'subtree' }]);
  }

  /**
   * Examines the given regions (and the nearest ancestors that could be the semantic unit), and
   * the peer groups of whatever changed: whether color is the *only* difference between two
   * elements depends on both, so a change at one invalidates the verdict of the other.
   */
  update(roots: readonly AnalysisRoot[], seeds: readonly PeerSeed[] = []): void {
    if (!this.#enabled || (roots.length === 0 && seeds.length === 0)) return;
    this.#add({ semanticPasses: 1, semanticRoots: roots.length });

    // Attribute reads only: a page with nothing semantic in the region pays no style flush at all.
    const candidates = this.#collectCandidates(roots);
    this.#expandPeers(roots, candidates, seeds);
    if (candidates.size === 0) {
      this.#pruneSheet();
      return;
    }

    const desired = new Map<Element, Desired | null>();
    this.#sheet.withOriginalStyles(() => {
      const cache = new Map<Element, Examined>();
      const examine = (element: Element): Examined => {
        let examined = cache.get(element);
        if (!examined) {
          const facts = readElementFacts(element, this.#env);
          examined = { facts, result: classifyElement(facts) };
          cache.set(element, examined);
        }
        return examined;
      };
      for (const element of candidates) {
        desired.set(element, this.#plan(element, examine));
      }
    });
    this.#apply(desired);
  }

  // ------------------------------------------------------------------ candidates

  /** Adds `element` (and, for a control, its labels) when it is worth examining; `false` when not. */
  #addCandidate(found: Set<Element>, element: Element, limit: number): boolean {
    if (found.size >= limit) return false;
    if (
      isSkippedTag(element) ||
      element === this.#doc.body ||
      element === this.#doc.documentElement ||
      !hasHint(element)
    ) {
      return false;
    }
    found.add(element);
    // A control's label is where "required" is drawn.
    const labels = (element as HTMLInputElement).labels;
    if (labels) for (const label of labels) found.add(label);
    return true;
  }

  /**
   * Peer-group invalidation (docs/SEMANTIC_ACCESSIBILITY.md, "Peer invalidation"): every changed
   * element, and every element that left, brings the *rest of its group* into the pass. One
   * search per group, bounded in searches and in elements; never a document scan.
   */
  #expandPeers(
    roots: readonly AnalysisRoot[],
    candidates: Set<Element>,
    seeds: readonly PeerSeed[],
  ): void {
    const body = this.#doc.body;
    const limit = SEMANTIC_LIMITS.maxCandidatesPerPass + SEMANTIC_LIMITS.maxPeerExtras;
    const scan: PeerScan = { groups: new Map(), keys: new WeakMap(), scanned: 0 };
    let searches = 0;
    let extras = 0;
    // Each peer is judged once per pass, however many searches found it (a 1000-row list asks 1000 times).
    const considered = new Set<Element>();
    const include = (group: readonly Element[]) => {
      for (const peer of group) {
        if (considered.has(peer)) continue;
        considered.add(peer);
        if (candidates.has(peer) || extras >= SEMANTIC_LIMITS.maxPeerExtras) continue;
        if (this.#addCandidate(candidates, peer, limit)) extras += 1;
      }
    };

    // A full-document pass already holds every candidate: there is nothing to invalidate.
    const wholeDocument = roots.some((root) => root.element === body && root.scope === 'subtree');
    if (!wholeDocument) {
      const searched = new Set<Element>();
      // Whatever changed (roots, candidates) *and* the first elements of an added region: a plain
      // `<li><a>` that is not itself a candidate can still be the peer a lone `aria-current` link had none of.
      const sources: Element[] = [...roots.map((root) => root.element), ...candidates];
      for (const root of roots) {
        if (root.scope !== 'subtree') continue;
        const walker = this.#doc.createTreeWalker(root.element, NodeFilter.SHOW_ELEMENT, {
          acceptNode: (node) =>
            isSkippedTag(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        for (let i = 0; i < SEMANTIC_LIMITS.peerSourcesPerRoot; i += 1) {
          const node = walker.nextNode();
          if (!node) break;
          sources.push(node as Element);
        }
      }
      for (const source of sources) {
        if (searches >= SEMANTIC_LIMITS.maxPeerSearches) break;
        if (searched.has(source) || !source.isConnected || !body?.contains(source)) continue;
        if (source === body || isSkippedTag(source) || source.closest('svg')) continue;
        searched.add(source);
        searches += 1;
        const group = this.#findPeers(
          source,
          source.parentElement,
          source,
          SEMANTIC_LIMITS.expansionPeers,
          undefined,
          scan,
        );
        for (const peer of group) searched.add(peer);
        include(group);
      }
    }

    // Elements walked inside removed subtrees, across all seeds of the pass.
    let seedWalk = 0;
    for (const { anchor, template } of seeds) {
      if (!anchor.isConnected || !body?.contains(anchor) || anchor.closest('svg')) continue;
      // The removed node and what was inside it: each kind of element that could have been a peer.
      const kinds = new Set<string>();
      const visit = (element: Element) => {
        const kind = `${peerKey(element)}|${element.getAttribute('class') ?? ''}`;
        if (kinds.has(kind) || searches >= SEMANTIC_LIMITS.maxPeerSearches) return;
        kinds.add(kind);
        searches += 1;
        include(
          this.#findPeers(
            element,
            element.parentElement ?? anchor,
            element === template ? null : element,
            SEMANTIC_LIMITS.expansionPeers,
            { root: template, anchor },
            scan,
          ),
        );
      };
      visit(template);
      const walker = this.#doc.createTreeWalker(template, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) =>
          isSkippedTag(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let walked = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (seedWalk >= SEMANTIC_LIMITS.maxWalkedPerRoot) break;
        seedWalk += 1;
        walked += 1;
        // The first few elements name their group even when plain; beyond them, only candidates do.
        if (walked <= SEMANTIC_LIMITS.peerSourcesPerRoot || hasHint(node as Element)) {
          visit(node as Element);
        }
      }
    }
    if (searches > 0 || extras > 0) {
      this.#add({ semanticPeerSearches: searches, semanticPeersReexamined: extras });
    }
  }

  #collectCandidates(roots: readonly AnalysisRoot[]): Set<Element> {
    const found = new Set<Element>();
    const body = this.#doc.body;
    const add = (element: Element) =>
      this.#addCandidate(found, element, SEMANTIC_LIMITS.maxCandidatesPerPass);

    for (const root of roots) {
      const { element } = root;
      if (!element.isConnected || !body?.contains(element) || element.closest('svg')) continue;
      add(element);
      let ancestor = element.parentElement;
      for (let level = 0; ancestor && level < SEMANTIC_LIMITS.ancestorLevels; level += 1) {
        if (ancestor === body) break;
        add(ancestor);
        ancestor = ancestor.parentElement;
      }
      if (root.scope !== 'subtree') continue;

      const walker = this.#doc.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) =>
          isSkippedTag(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let walked = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (walked >= SEMANTIC_LIMITS.maxWalkedPerRoot) break;
        walked += 1;
        add(node as Element);
      }
    }
    return found;
  }

  // ------------------------------------------------------------------ decision

  #plan(element: Element, examine: (element: Element) => Examined): Desired | null {
    const { result, decision } = this.#decide(element, examine, true);
    if (result.status === 'classified') this.#add({ semanticClassified: 1 });
    else if (result.status === 'conflict') this.#add({ semanticConflicts: 1 });
    else this.#add({ semanticUnknown: 1 });
    this.#add({ semanticCandidates: 1 });
    if (decision.action !== 'cue') return null;
    this.#add({ cuesPlanned: 1 });
    return this.#desiredFor(element, decision.plan);
  }

  /** What the semantic core makes of `element`, and what it would do. Counts color-only when asked to. */
  #decide(
    element: Element,
    examine: (element: Element) => Examined,
    count: boolean,
  ): { result: SemanticResult; decision: CueDecision; verdict: ColorOnlyVerdict | null } {
    const { facts, result } = examine(element);
    if (result.status !== 'classified') {
      return {
        result,
        decision: decideCue({ ...this.#inputFor(facts, result), enabled: true }),
        verdict: null,
      };
    }
    const existing = detectExistingCues(facts, result);
    let counted = false;
    // The color-only verdict, when the decision got far enough to ask for one (the developer audit reports it).
    let seen: ColorOnlyVerdict | null = null;
    const note = (colorOnly: boolean | undefined) => {
      if (count && colorOnly && !counted) {
        counted = true;
        this.#add({ colorOnlyDetected: 1 });
      }
    };
    const decision = decideCue({
      result,
      kind: facts.kind,
      textLength: facts.text.length,
      existing,
      enabled: true,
      assessColorOnly: () => {
        const verdict = this.#assess(element, examine, facts, result, existing);
        seen = verdict;
        note(verdict.colorOnly);
        return verdict;
      },
    });
    if (decision.action === 'none') note(decision.colorOnly);
    // An underline under text the page already underlines (most links) would add nothing.
    if (
      decision.action === 'cue' &&
      decision.plan.cue.placement === 'underline' &&
      this.#env.view.getComputedStyle(element).textDecorationLine.includes('underline')
    ) {
      return {
        result,
        decision: { action: 'none', reason: 'no-safe-placement', detail: 'already-underlined' },
        verdict: seen,
      };
    }
    // A grid container turns `::after` into a grid item of its own: the glyph would land in a
    // new row (or a zero-height one), not beside the text. Not a placement that can be trusted.
    if (
      decision.action === 'cue' &&
      (decision.plan.cue.placement === 'after' || decision.plan.cue.placement === 'before') &&
      /grid/.test(this.#env.view.getComputedStyle(element).display)
    ) {
      return {
        result,
        decision: { action: 'none', reason: 'no-safe-placement', detail: 'grid-host' },
        verdict: seen,
      };
    }
    return { result, decision, verdict: seen };
  }

  #inputFor(facts: ElementFacts, result: SemanticResult) {
    return {
      result,
      kind: facts.kind,
      textLength: facts.text.length,
      existing: { cues: [], beforeBusy: false, afterBusy: false },
      assessColorOnly: (): ColorOnlyVerdict => ({ colorOnly: false, reason: 'cannot-compare' }),
    };
  }

  /** Whether a pass that reaches `element` will examine it (the layer is on and the element carries a hint). */
  examines(element: Element): boolean {
    return this.#enabled && !isSkippedTag(element) && hasHint(element);
  }

  /** Read-only look at one element, for tests and debugging: no counters, no DOM writes. */
  inspect(element: Element): SemanticInspection {
    return this.#sheet.withOriginalStyles(() => {
      const cache = new Map<Element, Examined>();
      const examine = (target: Element): Examined => {
        let examined = cache.get(target);
        if (!examined) {
          const facts = readElementFacts(target, this.#env);
          examined = { facts, result: classifyElement(facts) };
          cache.set(target, examined);
        }
        return examined;
      };
      const { result, decision } = this.#decide(element, examine, false);
      return { result, decision, kind: examine(element).facts.kind };
    });
  }

  /**
   * The developer audit's read-only look at every candidate under `root`: the same decision the
   * layer makes, with the page's own styles in effect, whether or not the layer is adding cues.
   * Nothing is written and no counter moves. Peers are found exactly as for a normal pass.
   */
  auditScan(root: Element): SemanticAuditScan {
    const candidates = this.#collectCandidates([{ element: root, scope: 'subtree' }]);
    const records: SemanticAuditRecord[] = [];
    if (candidates.size === 0) return { records, enabled: this.#enabled, candidates: 0 };
    this.#sheet.withOriginalStyles(() => {
      const cache = new Map<Element, Examined>();
      const examine = (target: Element): Examined => {
        let examined = cache.get(target);
        if (!examined) {
          const facts = readElementFacts(target, this.#env);
          examined = { facts, result: classifyElement(facts) };
          cache.set(target, examined);
        }
        return examined;
      };
      for (const element of candidates) {
        try {
          const { result, decision, verdict } = this.#decide(element, examine, false);
          records.push({
            element,
            result,
            decision,
            verdict,
            kind: examine(element).facts.kind,
            hasCue: element.hasAttribute(CUE_ATTRIBUTE),
          });
        } catch {
          // An element that cannot be read is not audited.
        }
      }
    });
    return { records, enabled: this.#enabled, candidates: candidates.size };
  }

  #assess(
    element: Element,
    examine: (element: Element) => Examined,
    facts: ElementFacts,
    result: Extract<SemanticResult, { status: 'classified' }>,
    existing: ReturnType<typeof detectExistingCues>,
  ): ColorOnlyVerdict {
    const peers = this.#contrastingPeers(element, examine, result);
    return assessColorOnly({
      state: result.state,
      style: readStyleSnapshot(element, this.#env.view, facts.kind),
      existing,
      hasText: facts.text.length > 0,
      kind: facts.kind,
      contrastingPeers: peers.map((peer) => {
        const examined = examine(peer);
        const state = examined.result.status === 'classified' ? examined.result.state : null;
        const peerFacts: PeerFacts = {
          state,
          style: readStyleSnapshot(peer, this.#env.view, examined.facts.kind),
          hasIcon: examined.facts.hasIcon,
          hasText: examined.facts.text.length > 0,
        };
        return peerFacts;
      }),
    });
  }

  /** Comparable elements (same component) that are in a *different* state, one per distinct state. */
  #contrastingPeers(
    element: Element,
    examine: (element: Element) => Examined,
    result: Extract<SemanticResult, { status: 'classified' }>,
  ): Element[] {
    const own = EQUIVALENCE[result.state];
    const picked = new Map<string, Element>();
    for (const peer of this.#findPeers(element, element.parentElement, element)) {
      const examined = examine(peer);
      const cls =
        examined.result.status === 'classified' ? EQUIVALENCE[examined.result.state] : 'unknown';
      if (cls === own || picked.has(cls)) continue;
      picked.set(cls, peer);
      if (picked.size >= SEMANTIC_LIMITS.maxContrastingPeers) break;
    }
    return [...picked.values()];
  }

  /**
   * Elements of the same component: same tag, role and input type, and at least one class name
   * in common once the ones that name a state are set aside (`badge badge-success` and
   * `badge badge-pending` share `badge`; two classless elements count as sharing). Whether they
   * also *look* alike is decided later, from computed styles. Searched among the siblings first,
   * then outward a few levels until another exists; never beyond the document.
   */
  #findPeers(
    template: Element,
    parent: Element | null,
    exclude: Element | null,
    limit: number = SEMANTIC_LIMITS.maxPeers,
    removed?: RemovedFrom,
    scan?: PeerScan,
  ): Element[] {
    const info = (element: Element): ElementKey => keyOf(element, scan);
    const { key, tokens: own } = info(template);
    let scope = parent;
    for (let level = 0; scope && level < SEMANTIC_LIMITS.peerLevels; level += 1) {
      if (scope === this.#doc.documentElement) break;
      // The wrappers between the element and the scope: a peer must sit in the same kind of wrappers.
      const lineage = lineageBelow(parent, scope, removed, info);
      const signature = `${limit}|${key}|${[...own].sort().join(' ')}|${lineage
        .map((wrapper) => `${wrapper.key}:${[...wrapper.tokens].sort().join(' ')}`)
        .join('>')}`;
      let group = scan?.groups.get(scope)?.get(signature);
      if (!group) {
        group = [];
        const candidates = scope.getElementsByTagName(template.localName);
        // One more than asked for: the element itself may be among them and is left out below.
        for (let i = 0; i < candidates.length && i < 400; i += 1) {
          if (scan) {
            if (scan.scanned >= SEMANTIC_LIMITS.maxPeerScan) return [];
            scan.scanned += 1;
          }
          const candidate = candidates[i]!;
          const theirs = info(candidate);
          if (
            theirs.key === key &&
            sharesTokens(own, theirs.tokens) &&
            sameLineage(lineage, candidate, scope, info)
          ) {
            group.push(candidate);
          }
          if (group.length > limit) break;
        }
        if (scan) {
          const bySignature = scan.groups.get(scope) ?? new Map<string, Element[]>();
          scan.groups.set(scope, bySignature);
          bySignature.set(signature, group);
        }
      }
      const peers = exclude ? group.filter((candidate) => candidate !== exclude) : group;
      if (peers.length >= 1) return peers.slice(0, limit);
      scope = parentOf(scope, removed);
    }
    return [];
  }

  #desiredFor(element: Element, plan: SemanticCuePlan): Desired {
    if (plan.cue.placement !== 'inner') return { key: cueKey(plan.cue), spec: plan.cue };
    const style = this.#env.view.getComputedStyle(element);
    const size = Math.round(Math.min(parseFloat(style.width) || 0, parseFloat(style.height) || 0));
    const bg = parseColor(style.backgroundColor);
    const tone: DotTone =
      bg && bg.alpha >= 0.5 ? (relativeLuminance(bg) > GLYPH_TONE_CROSSOVER ? 'd' : 'l') : 'c';
    return { key: cueKey(plan.cue, { tone, size }), spec: plan.cue };
  }

  // ------------------------------------------------------------------ application

  #apply(desired: ReadonlyMap<Element, Desired | null>): void {
    const toAdd: [Element, Desired][] = [];
    let removed = 0;
    // Removals and replacements first, so that layout is measured below with no cue on the element.
    for (const [element, want] of desired) {
      const current = element.getAttribute(CUE_ATTRIBUTE);
      if (want === null) {
        if (current !== null) {
          element.removeAttribute(CUE_ATTRIBUTE);
          removed += 1;
        }
        continue;
      }
      if (current === want.key) continue;
      if (current !== null) element.removeAttribute(CUE_ATTRIBUTE);
      toAdd.push([element, want]);
    }

    // Layout before the new rules exist: the baseline for "the cue moved and clipped nothing".
    const before = new Map<Element, Metrics>();
    for (const [element, want] of toAdd) {
      if (isInFlowGlyph(want.spec.placement)) before.set(element, measure(element));
    }
    for (const [element, want] of toAdd) element.setAttribute(CUE_ATTRIBUTE, want.key);

    this.#writeSheet();

    // The browser has the last word: a cue that does not render as planned is taken back.
    let notApplied = 0;
    for (const [element, want] of desired) {
      if (want === null || !element.hasAttribute(CUE_ATTRIBUTE)) continue;
      if (this.#renders(element, want, before.get(element))) continue;
      element.removeAttribute(CUE_ATTRIBUTE);
      notApplied += 1;
    }
    if (notApplied > 0) this.#writeSheet();

    const applied = toAdd.filter(([element]) => element.hasAttribute(CUE_ATTRIBUTE)).length;
    this.#add({ cuesApplied: applied, cuesNotApplied: notApplied, cuesRemoved: removed });
  }

  #writeSheet(): void {
    this.#sheetCss = cueSheet(this.#keysInUse());
    this.#sheet.setCueCss(this.#sheetCss);
  }

  /** Elements that left the page took their cues with them; the rules for cues nobody carries go too. */
  #pruneSheet(): void {
    if (this.#sheetCss === null) return;
    if (cueSheet(this.#keysInUse()) !== this.#sheetCss) this.#writeSheet();
  }

  #keysInUse(): Set<string> {
    const keys = new Set<string>();
    for (const element of this.#doc.querySelectorAll(`[${CUE_ATTRIBUTE}]`)) {
      const value = element.getAttribute(CUE_ATTRIBUTE);
      if (value) keys.add(value);
    }
    return keys;
  }

  /**
   * Verifies the cue against the browser's computed output (docs/SEMANTIC_ACCESSIBILITY.md,
   * "Verified placement"): the pseudo-element exists with the planned content and is laid out as
   * a box; a dot did not move or resize; a glyph beside text did not make its host taller or end up
   * clipped by the host's own overflow.
   */
  #renders(element: Element, want: Desired, baseline: Metrics | undefined): boolean {
    const { spec } = want;
    switch (spec.placement) {
      case 'after':
      case 'before':
      case 'inner': {
        const pseudo = spec.placement === 'before' ? '::before' : '::after';
        const expected = renderedGlyph(spec.glyph ?? '\u0000');
        const content = this.#env.pseudoContent(element, pseudo);
        // A shape has no text: its content is the empty string, which is not `none`.
        if (expected === '' ? !content.startsWith('""') : !content.includes(expected)) return false;
        const box = this.#env.pseudoBox?.(element, pseudo);
        if (box) {
          if (box.display === 'none') return false;
          if (
            (expected === '' || spec.placement === 'inner') &&
            (box.width <= 0 || box.height <= 0)
          )
            return false;
        }
        if (!baseline) return true;
        const now = measure(element);
        const was = baseline;
        if (spec.placement === 'inner') {
          // An in-box glyph must not resize the box or shift it vertically (no reflow). Sideways
          // is a neighbor's glyph pushing it, which is not this cue's doing.
          return (
            Math.abs(now.rect.width - was.rect.width) < 0.5 &&
            Math.abs(now.rect.height - was.rect.height) < 0.5 &&
            Math.abs(now.rect.top - was.rect.top) < 0.5
          );
        }
        // Beside text: the host may grow wider by the glyph, never taller. Where it sits is not its
        // own doing: a neighbor's glyph moves it, and that is fine.
        if (Math.abs(now.rect.height - was.rect.height) >= 0.5) return false;
        return !this.#clipsGlyph(element, now);
      }
      case 'outline': {
        if (element === this.#doc.activeElement) return true; // the focus ring is showing instead
        return this.#env.view.getComputedStyle(element).outlineStyle === spec.outline;
      }
      case 'underline':
        return this.#env.view.getComputedStyle(element).textDecorationLine.includes('underline');
    }
  }

  /** A host that clips its overflow and has more content than room: the glyph is where it would be cut. */
  #clipsGlyph(element: Element, metrics: Metrics): boolean {
    const style = this.#env.view.getComputedStyle(element);
    const clips = (value: string) => value !== 'visible' && value !== '';
    const horizontal = clips(style.overflowX) && metrics.scrollWidth > metrics.clientWidth + 0.5;
    const vertical = clips(style.overflowY) && metrics.scrollHeight > metrics.clientHeight + 0.5;
    return horizontal || vertical;
  }

  #add(delta: Partial<Record<keyof Omit<SemanticDiagnostics, 'cuesActive'>, number>>): void {
    const next: Record<string, number> = { ...this.#counters };
    for (const [name, value] of Object.entries(delta))
      next[name] = (next[name] ?? 0) + (value ?? 0);
    this.#counters = next as unknown as Omit<SemanticDiagnostics, 'cuesActive'>;
  }
}

/** Input types that look like a text box: an email field and a plain one are the same component. */
const TEXTUAL_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** Same tag, role and kind of input. */
export function peerKey(element: Element): string {
  const role = element.getAttribute('role') ?? '';
  let type = '';
  if (element.localName === 'input') {
    const declared = (element.getAttribute('type') ?? 'text').toLowerCase();
    type = TEXTUAL_INPUT_TYPES.has(declared) ? 'text' : declared;
  }
  return `${element.localName}|${role}|${type}`;
}

/** Class names that do not name a state: what says "this is a badge / tab / dot". */
function componentTokens(element: Element): Set<string> {
  const tokens = new Set<string>();
  for (const token of (element.getAttribute('class') ?? '').split(/\s+/)) {
    if (token !== '' && tokenStates(token).length === 0) tokens.add(token);
  }
  return tokens;
}

interface Wrapper {
  readonly key: string;
  readonly tokens: Set<string>;
}

/** What identifies an element as a member of a component: read once per pass. */
interface ElementKey {
  readonly key: string;
  readonly tokens: Set<string>;
}

/** The memory of one pass's peer searches: groups found, keys read, elements looked at. */
interface PeerScan {
  readonly groups: Map<Element, Map<string, Element[]>>;
  readonly keys: WeakMap<Element, ElementKey>;
  scanned: number;
}

function keyOf(element: Element, scan: PeerScan | undefined): ElementKey {
  const known = scan?.keys.get(element);
  if (known) return known;
  const made = { key: peerKey(element), tokens: componentTokens(element) };
  scan?.keys.set(element, made);
  return made;
}

function sharesTokens(own: ReadonlySet<string>, theirs: ReadonlySet<string>): boolean {
  if (own.size === 0 && theirs.size === 0) return true;
  for (const token of own) if (theirs.has(token)) return true;
  return false;
}

/** Where a detached subtree used to hang: its root's parent is `anchor` again for the walk upward. */
interface RemovedFrom {
  readonly root: Element;
  readonly anchor: Element;
}

function parentOf(node: Element, removed: RemovedFrom | undefined): Element | null {
  return node.parentElement ?? (removed && node === removed.root ? removed.anchor : null);
}

/** The elements from `start` up to (not including) `scope`, innermost first. */
function lineageBelow(
  start: Element | null,
  scope: Element,
  removed: RemovedFrom | undefined,
  info: (element: Element) => ElementKey,
): Wrapper[] {
  const chain: Wrapper[] = [];
  for (let node = start; node && node !== scope; node = parentOf(node, removed)) {
    chain.push(info(node));
  }
  return chain;
}

/**
 * Whether `candidate` is wrapped like the element it is compared with: as many wrappers below
 * `scope`, each of the same kind (`ul.nav > li` is not `ul.footer > li`). Two lists under one
 * parent, or a row of tabs and a row of chips, are therefore not one component.
 */
function sameLineage(
  lineage: readonly Wrapper[],
  candidate: Element,
  scope: Element,
  info: (element: Element) => ElementKey,
): boolean {
  let index = 0;
  for (let node = candidate.parentElement; node && node !== scope; node = node.parentElement) {
    const wrapper = lineage[index];
    if (!wrapper) return false;
    const theirs = info(node);
    if (theirs.key !== wrapper.key || !sharesTokens(wrapper.tokens, theirs.tokens)) return false;
    index += 1;
  }
  return index === lineage.length;
}
