/**
 * A computed-style property by its CSS name, or `''` when the style object cannot say. Real
 * `CSSStyleDeclaration`s always can; the guard is for the plain objects tests and hostile pages hand over,
 * and for properties an engine does not implement (then the empty string is exactly the right answer).
 */
export function readStyleProperty(style: CSSStyleDeclaration, name: string): string {
  try {
    return typeof style.getPropertyValue === 'function' ? style.getPropertyValue(name) : '';
  } catch {
    return '';
  }
}
