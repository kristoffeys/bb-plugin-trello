import { describe, expect, test } from 'vitest';
import { flagValue, positionalArgs } from '../cli-args.js';

describe('positionalArgs', () => {
  test('reads the locator whichever side of the flags it lands on', () => {
    // The regression: flags-first ordering used to yield "--project" as the
    // locator and report a misleading "not found" for a valid task.
    const flagsFirst = ['show', '--project', 'proj_abc', '5f2a1b3c4d5e6f7a8b9c0d1e'];
    const locatorFirst = ['show', '5f2a1b3c4d5e6f7a8b9c0d1e', '--project', 'proj_abc'];
    expect(positionalArgs(flagsFirst)).toEqual(['show', '5f2a1b3c4d5e6f7a8b9c0d1e']);
    expect(positionalArgs(locatorFirst)).toEqual(['show', '5f2a1b3c4d5e6f7a8b9c0d1e']);
  });

  test('drops boolean flags without eating the next argument', () => {
    expect(positionalArgs(['show', '--json', '5f2a1b3c4d5e6f7a8b9c0d1e'])).toEqual([
      'show',
      '5f2a1b3c4d5e6f7a8b9c0d1e'
    ]);
    expect(
      positionalArgs(['list', '--cached', '--json', '--query', 'video'])
    ).toEqual(['list']);
  });

  test('keeps a subcommand that follows a value flag', () => {
    expect(positionalArgs(['presets', '--project', 'proj_abc', 'list'])).toEqual(
      ['presets', 'list']
    );
  });

  test('keeps multi-word positional text together', () => {
    expect(
      positionalArgs([
        'comment',
        '--project',
        'proj_abc',
        '5f2a1b3c4d5e6f7a8b9c0d1e',
        'looks',
        'good'
      ])
    ).toEqual(['comment', '5f2a1b3c4d5e6f7a8b9c0d1e', 'looks', 'good']);
  });

  test('a value flag with no value does not swallow the next flag', () => {
    expect(positionalArgs(['show', '--project', '--json', '5f2a1b3c4d5e6f7a8b9c0d1e'])).toEqual([
      'show',
      '5f2a1b3c4d5e6f7a8b9c0d1e'
    ]);
  });

  test('a board flag consumes its value', () => {
    expect(positionalArgs(['config', '--board', 'board-1'])).toEqual(['config']);
  });

  test('the connect credential-file flags consume their values', () => {
    expect(
      positionalArgs([
        'connect',
        '--key-file',
        '/tmp/key',
        '--token-file',
        '/tmp/token'
      ])
    ).toEqual(['connect']);
  });

  test('an unknown flag is not mistaken for a positional argument', () => {
    expect(positionalArgs(['show', '--nope', '5f2a1b3c4d5e6f7a8b9c0d1e'])).toEqual([
      'show',
      '5f2a1b3c4d5e6f7a8b9c0d1e'
    ]);
  });
});

describe('flagValue', () => {
  test('reads a value regardless of position', () => {
    expect(flagValue(['show', '5f2a1b3c4d5e6f7a8b9c0d1e', '--project', 'proj_abc'], '--project'))
      .toBe('proj_abc');
    expect(flagValue(['show', '--project', 'proj_abc', '5f2a1b3c4d5e6f7a8b9c0d1e'], '--project'))
      .toBe('proj_abc');
  });

  test('returns null for a missing flag, a trailing flag, or a flag followed by a flag', () => {
    expect(flagValue(['show', '5f2a1b3c4d5e6f7a8b9c0d1e'], '--project')).toBeNull();
    expect(flagValue(['show', '--project'], '--project')).toBeNull();
    expect(flagValue(['show', '--project', '--json'], '--project')).toBeNull();
  });
});
