import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { STYLE_ELEMENT_ID } from '@core/adaptation';

const OWN_ATTRIBUTE_PREFIX = 'data-coloradapt-';

/** True for a node the chart layer (M7) created: its owned `<defs>` and decorative overlays. */
export function isChartOwnedNode(node: Node | null): boolean {
  return node instanceof Element && node.hasAttribute(CHART_NODE_ATTRIBUTE);
}

function isOwnedNode(node: Node): boolean {
  return isColorAdaptStyleElement(node) || isChartOwnedNode(node);
}

/** True for ColorAdapt's own injected `<style>` element. */
export function isColorAdaptStyleElement(node: Node | null): boolean {
  return node instanceof Element && node.id === STYLE_ELEMENT_ID && node.localName === 'style';
}

/**
 * The self-mutation policy (docs/DYNAMIC_ANALYSIS.md, "Self-mutation
 * filtering"). ColorAdapt itself writes only two things to the page: the
 * `data-coloradapt-id` attribute and its single `<style>` element (inserted,
 * rewritten, removed). A mutation is ColorAdapt's own when it is
 *
 * - an attribute change to `data-coloradapt-*`;
 * - anything inside the `<style>` element (its text node, its attributes);
 * - a child-list change whose every added/removed node is that `<style>` or a node the chart
 *   layer owns (`data-coloradapt-chart-node`: its `<defs>` and overlays, docs/CHARTS.md).
 *
 * Such mutations never start analysis — that is what keeps
 * adapt → mutate → analyze → adapt from looping. (`takeRecords()` after every
 * pass additionally drains the records our own writes just produced.)
 */
export function isColorAdaptOwnedMutation(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    return (
      record.attributeName === ELEMENT_ID_ATTRIBUTE ||
      (record.attributeName?.startsWith(OWN_ATTRIBUTE_PREFIX) ?? false) ||
      isColorAdaptStyleElement(record.target)
    );
  }
  if (record.type === 'characterData') {
    return isColorAdaptStyleElement(record.target.parentNode);
  }
  if (isColorAdaptStyleElement(record.target)) return true;

  const touched = [...record.addedNodes, ...record.removedNodes];
  return touched.length > 0 && touched.every(isOwnedNode);
}

/** True if an owned mutation removed ColorAdapt's `<style>` (the page may have done it). */
export function removesColorAdaptStyle(record: MutationRecord): boolean {
  return record.type === 'childList' && [...record.removedNodes].some(isColorAdaptStyleElement);
}
