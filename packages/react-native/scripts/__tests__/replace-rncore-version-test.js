/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @noflow
 */

'use strict';

const {replaceRNCoreConfiguration} = require('../replace-rncore-version');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = '0.87.0-test';
const SLICE = 'ios-arm64_x86_64-simulator';
const BINARY = path.join(SLICE, 'React.framework', 'React');

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, contents);
}

function buildTarball(podsRoot, configuration) {
  const stage = fs.mkdtempSync(path.join(podsRoot, `stage-${configuration}-`));
  writeFile(path.join(stage, 'React.xcframework', 'Info.plist'), '<plist/>');
  writeFile(
    path.join(stage, 'React.xcframework', BINARY),
    `binary-${configuration}`,
  );
  const artifacts = path.join(podsRoot, 'ReactNativeCore-artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  execFileSync('tar', [
    '-czf',
    path.join(
      artifacts,
      `reactnative-core-${VERSION.toLowerCase()}-${configuration.toLowerCase()}.tar.gz`,
    ),
    '-C',
    stage,
    '.',
  ]);
  fs.rmSync(stage, {recursive: true, force: true});
}

describe('replaceRNCoreConfiguration', () => {
  let podsRoot;
  let pod;
  let cwd;

  beforeEach(() => {
    podsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rncore-test-'));
    pod = path.join(podsRoot, 'React-Core-prebuilt');
    // What the podspec prepare_command leaves behind after `pod install`.
    writeFile(
      path.join(pod, 'Headers', 'module.modulemap'),
      'module yoga {}\n',
    );
    writeFile(path.join(pod, 'React.xcframework', 'Info.plist'), '<plist/>');
    writeFile(path.join(pod, 'React.xcframework', BINARY), 'binary-Debug');
    buildTarball(podsRoot, 'Release');
    cwd = process.cwd();
    // The script phase runs with Pods/ as its working directory.
    process.chdir(podsRoot);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(podsRoot, {recursive: true, force: true});
  });

  it('installs the framework for the requested configuration', () => {
    replaceRNCoreConfiguration('Release', VERSION, podsRoot);

    expect(
      fs.readFileSync(path.join(pod, 'React.xcframework', BINARY), 'utf8'),
    ).toBe('binary-Release');
  });

  // Regression test for #57803: recreating the module map mid-build lets a
  // concurrent dependency scan miss it, and the React module then precompiles
  // without -fmodule-map-file and fails on non-modular includes.
  it('leaves Headers/module.modulemap untouched', () => {
    const moduleMap = path.join(pod, 'Headers', 'module.modulemap');
    const before = fs.statSync(moduleMap).ino;

    replaceRNCoreConfiguration('Release', VERSION, podsRoot);

    expect(fs.statSync(moduleMap).ino).toBe(before);
  });

  it('fails when the tarball has no React.xcframework', () => {
    const stage = fs.mkdtempSync(path.join(podsRoot, 'stage-bad-'));
    writeFile(path.join(stage, 'unrelated.txt'), 'nope');
    execFileSync('tar', [
      '-czf',
      path.join(
        podsRoot,
        'ReactNativeCore-artifacts',
        `reactnative-core-${VERSION.toLowerCase()}-release.tar.gz`,
      ),
      '-C',
      stage,
      '.',
    ]);

    expect(() =>
      replaceRNCoreConfiguration('Release', VERSION, podsRoot),
    ).toThrow(/Extraction verification failed/);
  });
});
