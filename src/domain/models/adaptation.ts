import type { ElementDescriptor, ElementRole } from './element';
import type { UserSettings } from './settings';
import type { VisionProfile } from './vision-profile';

/**
 * A pure function that inspects one analyzed element and optionally
 * proposes a change. Rules are composed by the Adaptation Engine and never
 * touch the DOM themselves, so they stay unit-testable in isolation.
 */
export interface AdaptationRule {
  readonly id: string;
  readonly appliesTo: readonly ElementRole[];
  readonly description: string;
  evaluate(
    descriptor: ElementDescriptor,
    profile: VisionProfile,
    settings: UserSettings,
  ): AdaptationChange | null;
}

/**
 * A single reversible style change applied to one element, expressed as a
 * CSS custom property so it can be injected via a stylesheet rule
 * (targeting `[data-coloradapt-id="..."]`) rather than mutating element
 * styles directly. Restoring is just removing the stylesheet.
 */
export interface AdaptationChange {
  readonly elementId: string;
  readonly property: string;
  readonly originalValue: string;
  readonly adaptedValue: string;
  readonly reason: string;
}

export interface AdaptationResult {
  readonly changes: readonly AdaptationChange[];
  readonly appliedAt: number;
}
