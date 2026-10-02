import { describe, expect, it } from 'vitest';
import { createMessage, isColorAdaptMessage } from '@infrastructure/messaging';

describe('createMessage / isColorAdaptMessage', () => {
  it('builds a well-formed message', () => {
    const message = createMessage('GET_SETTINGS', undefined);
    expect(message).toEqual({ channel: 'coloradapt', type: 'GET_SETTINGS', payload: undefined });
  });

  it('accepts messages created by createMessage', () => {
    expect(isColorAdaptMessage(createMessage('ANALYZE_PAGE', undefined))).toBe(true);
    expect(isColorAdaptMessage(createMessage('UPDATE_SETTINGS', { enabled: false }))).toBe(true);
  });

  it('rejects messages from unrelated extensions or unknown shapes', () => {
    expect(isColorAdaptMessage(undefined)).toBe(false);
    expect(isColorAdaptMessage(null)).toBe(false);
    expect(isColorAdaptMessage('GET_SETTINGS')).toBe(false);
    expect(isColorAdaptMessage({ channel: 'some-other-extension', type: 'GET_SETTINGS' })).toBe(
      false,
    );
    expect(isColorAdaptMessage({ channel: 'coloradapt', type: 'NOT_A_REAL_TYPE' })).toBe(false);
    expect(isColorAdaptMessage({ channel: 'coloradapt' })).toBe(false);
  });
});
