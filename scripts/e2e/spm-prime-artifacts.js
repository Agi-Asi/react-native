/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

// download-spm-artifacts.js uses inline Flow type syntax; register the monorepo
// babel transform so plain `node` can require it from source.
require('../shared/babelRegister').registerForMonorepo();

/**
 * spm-prime-artifacts.js
 *
 * Lays prebuilt React Native iOS xcframework tarballs into the two-flavor
 * `--artifacts <dir>` layout that `npx react-native spm add --artifacts <dir>
 * --download skip` consumes offline:
 *
 *   <dir>/<flavor>/React.xcframework
 *   <dir>/<flavor>/ReactNativeHeaders.xcframework
 *   <dir>/<flavor>/ReactNativeDependencies.xcframework
 *   <dir>/<flavor>/ReactNativeDependenciesHeaders.xcframework
 *   <dir>/<flavor>/hermes-engine.xcframework
 *   <dir>/<flavor>/hermes-headers/hermes
 *   <dir>/<flavor>/artifacts.json
 *
 * `<flavor>` is the lower-cased flavor name (debug / release).
 *
 * This is a per-flavor operation (call it once per flavor into the same
 * `--artifacts` root). `spm add` validates BOTH the debug/ and release/ slots
 * regardless of which configuration is later built, so a full run primes both.
 *
 * The React core + ReactNativeHeaders xcframeworks come from the
 * `ReactCore<Flavor>.xcframework.tar.gz` CI artifact (produced by
 * prebuild-ios-core.yml), and ReactNativeDependencies +
 * ReactNativeDependenciesHeaders from the
 * `ReactNativeDependencies<Flavor>.xcframework.tar.gz` artifact (produced by
 * prebuild-ios-dependencies.yml). Neither prebuild produces hermes-engine, so
 * it is fetched from Maven (the `hermes-compiler` latest-v1 dist-tag by
 * default; override with HERMES_VERSION).
 *
 * Rather than hand-rolling the tar/overlay dance, this delegates to
 * download-spm-artifacts.js, whose `--core-tarball` / `--deps-tarball`
 * local-tarball overrides extract exactly these companions, download + stage
 * hermes (with its public headers), and write a valid artifacts.json — the
 * same code path a real consumer's `spm download` runs. Passing the CI
 * tarballs as-is is sufficient; the deps tarball nests its xcframeworks under
 * `packages/react-native/third-party/`, which the extractor locates.
 *
 * Usage (from the repo root):
 *   node scripts/e2e/spm-prime-artifacts.js \
 *     --artifacts /tmp/spm-artifacts --flavor Debug \
 *     --core-tarball /tmp/rc/ReactCoreDebug.xcframework.tar.gz \
 *     --deps-tarball /tmp/deps/ReactNativeDependenciesDebug.xcframework.tar.gz
 */

const {
  main: downloadArtifacts,
  validateArtifactsCache,
} = require('../../packages/react-native/scripts/spm/download-spm-artifacts');
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');

const HELP = `
Usage: node scripts/e2e/spm-prime-artifacts.js [options]

Lays prebuilt xcframework tarballs into the --artifacts <dir>/<flavor>/ layout
that \`npx react-native spm add --artifacts <dir> --download skip\` consumes.

Options:
  --artifacts <dir>            (required) Output root. Writes <dir>/<flavor>/.
  --flavor <Debug|Release>     (required) Flavor to prime.
  --core-tarball <path>        (required) ReactCore<Flavor>.xcframework.tar.gz
                               (React + ReactNativeHeaders).
  --deps-tarball <path>        (required) ReactNativeDependencies<Flavor>.xcframework.tar.gz
                               (ReactNativeDependencies + …DependenciesHeaders).
  --version <ver>              [optional] React Native version label (for logs).
  --help                       Show this help.

Environment:
  HERMES_VERSION               Override the hermes-engine version to fetch
                               (default: the hermes-compiler latest-v1 dist-tag).
`;

const config = {
  options: {
    artifacts: {type: 'string'},
    flavor: {type: 'string'},
    'core-tarball': {type: 'string'},
    'deps-tarball': {type: 'string'},
    version: {type: 'string'},
    help: {type: 'boolean', default: false},
  },
};

async function main() /*: Promise<void> */ {
  const {values} = parseArgs(config);

  if (values.help) {
    console.log(HELP);
    return;
  }

  const missing = [
    'artifacts',
    'flavor',
    'core-tarball',
    'deps-tarball',
  ].filter(
    // $FlowFixMe[invalid-computed-prop]
    k => values[k] == null,
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required option(s): ${missing
        .map(k => '--' + k)
        .join(', ')}\n${HELP}`,
    );
  }

  const flavorRaw = String(values.flavor);
  const flavor = flavorRaw.toLowerCase();
  if (flavor !== 'debug' && flavor !== 'release') {
    throw new Error(`--flavor must be Debug or Release, got "${flavorRaw}"`);
  }

  const coreTarball = path.resolve(String(values['core-tarball']));
  const depsTarball = path.resolve(String(values['deps-tarball']));
  for (const [label, p] of [
    ['--core-tarball', coreTarball],
    ['--deps-tarball', depsTarball],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(`${label} not found: ${p}`);
    }
  }

  const outputDir = path.join(path.resolve(String(values.artifacts)), flavor);
  fs.mkdirSync(outputDir, {recursive: true});

  const argv = [
    '--flavor',
    flavor,
    '--output',
    outputDir,
    '--core-tarball',
    coreTarball,
    '--deps-tarball',
    depsTarball,
  ];
  if (values.version != null) {
    argv.push('--version', String(values.version));
  }

  console.log(
    `[spm-prime-artifacts] Priming ${flavorRaw} slot at ${outputDir}\n` +
      `  core:  ${coreTarball}\n  deps:  ${depsTarball}`,
  );
  await downloadArtifacts(argv);

  const error = validateArtifactsCache(outputDir);
  if (error != null) {
    throw new Error(`Primed ${flavor} slot is incomplete: ${error}`);
  }
  console.log(`[spm-prime-artifacts] ${flavorRaw} slot ready: ${outputDir}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\x1b[31m[spm-prime-artifacts] ${err.message}\x1b[0m`);
    process.exit(1);
  });
}

module.exports = {main};
