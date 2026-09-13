// Argument parsing for the `bb trello` command.
//
// Split out of server.ts so it can be tested directly: reading positional args
// off a raw argv without knowing which flags consume a value silently
// mis-parses the very ordinary `show --project <id> <locator>` form, taking
// "--project" as the locator and reporting a misleading "not found".

/** Flags that consume the following argument. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--project',
  '--query',
  '--state',
  '--status',
  '--title',
  '--description',
  '--list',
  '--assignee',
  '--due',
  '--board',
  '--assigned-to-me',
  '--include-closed',
  '--key-file',
  '--token-file'
]);

/** Flags that stand alone. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--json',
  '--cached',
  '--worktree',
  '--browser'
]);

export function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  // A flag at the end of argv, or one followed by another flag, has no value.
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

/**
 * Everything that is not a flag or a flag's value, in order. The first entry is
 * the command, the rest are its positional arguments.
 */
export function positionalArgs(argv: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      // Skip the value too, unless the flag was given without one.
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) index += 1;
      continue;
    }
    // An unknown `--flag` is not a positional argument either.
    if (arg.startsWith('--')) continue;
    positionals.push(arg);
  }
  return positionals;
}
