import type { ElementFacts, NativeFacts } from '@core/semantics';

const NATIVE: NativeFacts = {
  isControl: false,
  required: false,
  disabled: false,
  empty: false,
  invalid: false,
  nonPristine: false,
  selectedOption: false,
};

type FactsOverrides = Partial<Omit<ElementFacts, 'native'>> & {
  native?: Partial<NativeFacts>;
};

/** A blank element: nothing to see, nothing to say. */
export function facts(overrides: FactsOverrides = {}): ElementFacts {
  const { native, ...rest } = overrides;
  return {
    tag: 'span',
    role: null,
    kind: 'text',
    classTokens: [],
    idTokens: [],
    dataValues: [],
    aria: {},
    title: '',
    text: '',
    textTruncated: false,
    labelText: '',
    describedByText: '',
    native: { ...NATIVE, ...native },
    parentClassTokens: [],
    isInteractive: false,
    colorHint: null,
    hasIcon: false,
    beforeContent: false,
    afterContent: false,
    ...rest,
  };
}
