import type { AuditSnapshot } from '@core/audit';
import type { AssistCase } from './collector';

/**
 * The content script's copy of the current audit: the snapshot (data) and, beside it, the live
 * elements it refers to (never serialized, held weakly so a removed element can be collected).
 *
 * Snapshots carry a generation; one that is not newer than the committed one is refused, so a
 * slow pass can never overwrite the result of a faster, later one (docs/DEVELOPER_AUDIT.md,
 * "Snapshot consistency"). A snapshot is replaced whole, never patched: what a reader sees is
 * always one coherent pass.
 */
export class AuditStore {
  #generation = 0;
  #committed = 0;
  #snapshot: AuditSnapshot | null = null;
  #members = new Map<string, readonly string[]>();
  #refs = new Map<string, WeakRef<Element>>();
  #assist = new Map<string, AssistCase>();

  /** Reserves the generation of the next pass. */
  nextGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }

  get snapshot(): AuditSnapshot | null {
    return this.#snapshot;
  }

  /**
   * Makes `snapshot` current unless a newer one already is.
   * `members`: per finding id, its elements' instance ids in listing order; `elements`: instance id -> element.
   */
  commit(
    snapshot: AuditSnapshot,
    members: ReadonlyMap<string, readonly string[]>,
    elements: ReadonlyMap<string, Element>,
    assist: ReadonlyMap<string, AssistCase> = new Map(),
  ): boolean {
    if (snapshot.generation <= this.#committed) return false;
    this.#committed = snapshot.generation;
    this.#snapshot = snapshot;
    this.#members = new Map(members);
    const refs = new Map<string, WeakRef<Element>>();
    for (const ids of members.values()) {
      for (const id of ids) {
        const element = elements.get(id);
        if (element) refs.set(id, new WeakRef(element));
      }
    }
    this.#refs = refs;
    this.#assist = new Map(assist);
    return true;
  }

  /** The AI-assisted review's case of a finding, when it has one. */
  assistCase(findingId: string): AssistCase | undefined {
    return this.#assist.get(findingId);
  }

  /** How many elements a finding covers (exact, not only the listed sample). */
  count(findingId: string): number {
    return this.#members.get(findingId)?.length ?? 0;
  }

  /** Instance id of the `index`-th element of a finding. */
  instanceAt(findingId: string, index: number): string | null {
    return this.#members.get(findingId)?.[index] ?? null;
  }

  /** The live element behind a finding's `index`-th entry; `null` when it is gone or unknown. */
  elementAt(findingId: string, index: number): Element | null {
    const id = this.instanceAt(findingId, index);
    const element = id ? this.#refs.get(id)?.deref() : undefined;
    return element?.isConnected ? element : null;
  }

  /** Whether `element` is (still) one of the elements the current snapshot refers to. */
  hasElement(element: Element): boolean {
    for (const ref of this.#refs.values()) if (ref.deref() === element) return true;
    return false;
  }

  clear(): void {
    this.#snapshot = null;
    this.#members = new Map();
    this.#refs = new Map();
    this.#assist = new Map();
  }
}
