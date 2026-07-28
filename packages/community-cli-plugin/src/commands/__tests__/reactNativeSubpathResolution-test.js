/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

// The wrappers load scripts as `react-native/<subpath>`, resolved through
// react-native's `exports` map: no extension guessing, no index.js fallback.
// Must run in a real node process — Jest's moduleNameMapper bypasses `exports`
// and would pass either way.
const specifiers = fs
  .readdirSync(COMMANDS_DIR)
  .filter(name => name.endsWith('.js'))
  .flatMap(name =>
    [
      ...fs
        .readFileSync(path.join(COMMANDS_DIR, name), 'utf8')
        .matchAll(/'(react-native\/[^']+)'/g),
    ].map(match => ({file: name, spec: match[1]})),
  );

test('found specifiers to check', () => {
  expect(specifiers.length).toBeGreaterThan(0);
});

test.each(specifiers)('$file resolves $spec', ({spec}) => {
  execFileSync(
    process.execPath,
    ['-e', `require.resolve(${JSON.stringify(spec)})`],
    {cwd: REPO_ROOT, stdio: 'ignore'},
  );
});
