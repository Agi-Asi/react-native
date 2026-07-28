/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const COMMANDS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/**
 * The command wrappers reach into the `react-native` package with
 * `require.resolve('react-native/...')`. Those specifiers go through
 * react-native's `exports` map, which — unlike legacy CJS resolution — neither
 * appends extensions nor falls back to a directory's `index.js`. A specifier
 * missing either therefore throws, but only at runtime when the command is
 * invoked.
 *
 * Resolution must be checked in a real `node` process: Jest's `moduleNameMapper`
 * remaps `react-native` to the source tree and bypasses the `exports` map
 * entirely, so resolving in-band here would pass even when production fails.
 */
function collectReactNativeSpecifiers(): Array<{file: string, spec: string}> {
  const found = [];
  for (const entry of fs.readdirSync(COMMANDS_DIR, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }
    const source = fs.readFileSync(path.join(COMMANDS_DIR, entry.name), 'utf8');
    for (const match of source.matchAll(/'(react-native\/[^']+)'/g)) {
      found.push({file: entry.name, spec: match[1]});
    }
  }
  return found;
}

function resolvesInNode(spec: string): boolean {
  try {
    execFileSync(
      process.execPath,
      ['-e', `require.resolve(${JSON.stringify(spec)})`],
      {cwd: REPO_ROOT, stdio: 'ignore'},
    );
    return true;
  } catch {
    return false;
  }
}

describe('react-native subpath specifiers used by the command wrappers', () => {
  const specifiers = collectReactNativeSpecifiers();

  test('at least one specifier is covered by this test', () => {
    expect(specifiers.length).toBeGreaterThan(0);
  });

  test.each(specifiers)(
    "$file resolves $spec through react-native's exports map",
    ({spec}) => {
      expect(resolvesInNode(spec)).toBe(true);
    },
  );
});
