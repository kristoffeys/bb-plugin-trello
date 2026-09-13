// Why: the plugin once shipped route paths without a leading slash. The whole
// suite stayed green because nothing exercised registration — bb.http.route
// rejects such a path at load time, so the plugin failed to load and the
// previous instance kept serving. These assert the contract the SDK enforces.
import { describe, expect, it } from 'vitest';
import {
  AUTH_CALLBACK_PATH,
  AUTH_COMPLETE_PATH,
  trelloAuthCallbackUrl
} from '../trello/browser-auth';

describe('http route paths', () => {
  for (const [name, path] of [
    ['AUTH_CALLBACK_PATH', AUTH_CALLBACK_PATH],
    ['AUTH_COMPLETE_PATH', AUTH_COMPLETE_PATH]
  ] as const) {
    it(`${name} starts with a slash, as bb.http.route requires`, () => {
      expect(path.startsWith('/')).toBe(true);
    });
  }

  it('builds a callback URL with no doubled slash', () => {
    const url = trelloAuthCallbackUrl(
      'http://127.0.0.1:38886',
      'trello',
      'nonce'
    );
    expect(url).toContain('/api/v1/plugins/trello/http/auth/callback');
    expect(new URL(url).pathname).not.toContain('//');
  });
});
