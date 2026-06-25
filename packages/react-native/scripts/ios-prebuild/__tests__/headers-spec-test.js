/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const {
  planFromInventory,
  renderNamespaceModuleMap,
  renderReactModuleMap,
} = require('../headers-spec');
const fs = require('fs');

// isUmbrellaSafe reads each header's source to reject extern-inline defs. Stub
// it to empty so synthetic objc-modular-candidate headers count as umbrella-safe
// (and thus land in namespaceModules), making these tests deterministic.
jest.spyOn(fs, 'readFileSync').mockReturnValue('');

const entry = (naturalPath /*: string */, bucket /*: string */) => ({
  naturalPath,
  bucket,
  lang: 'objc',
  identities: [{source: `does/not/exist/${naturalPath}`}],
});

// A manifest satisfying both the R9 private-header allowlist and the R10
// umbrella-namespace allowlist (React_RCTAppDelegate).
const validManifest = () => ({
  headers: [
    entry('React/RCTBridge+Private.h', 'objc-modular-candidate'),
    entry('React/RCTComponentViewFactory.h', 'objc-blocked'),
    entry('React/RCTComponentViewProtocol.h', 'objc-blocked'),
    entry('React/RCTComponentViewRegistry.h', 'objc-blocked'),
    entry('React/RCTMountingManager.h', 'objc-blocked'),
    entry('React/RCTSurfacePresenter.h', 'objc-blocked'),
    entry('React/RCTViewComponentView.h', 'objc-blocked'),
    entry(
      'React_RCTAppDelegate/RCTReactNativeFactory.h',
      'objc-modular-candidate',
    ),
    entry(
      'React_RCTAppDelegate/RCTRootViewFactory.h',
      'objc-modular-candidate',
    ),
    entry('React_RCTAppDelegate/RCTAppDelegate.h', 'objc-modular-candidate'),
  ],
});

describe('renderReactModuleMap (R9 private headers)', () => {
  test('appends modular allowlist as `header` and objc-blocked as `textual header`', () => {
    const out = renderReactModuleMap({
      modular: ['RCTBridge+Private.h'],
      textual: ['RCTMountingManager.h'],
    });
    expect(out).toContain('umbrella header "React-umbrella.h"');
    expect(out).toContain('  header "RCTBridge+Private.h"');
    expect(out).toContain('  textual header "RCTMountingManager.h"');
    // A textual header must NOT also appear as a plain modular `header`.
    expect(out).not.toMatch(/^\s*header "RCTMountingManager\.h"/m);
  });

  test('with no private headers renders just the umbrella (backwards compatible)', () => {
    const out = renderReactModuleMap();
    expect(out).toContain('umbrella header "React-umbrella.h"');
    expect(out).not.toContain('textual header');
  });
});

describe('planFromInventory R9 validation', () => {
  test('passes for a valid allowlist and exposes privateReactHeaders', () => {
    const plan = planFromInventory(validManifest());
    expect(plan.privateReactHeaders.modular).toContain('RCTBridge+Private.h');
    expect(plan.privateReactHeaders.textual).toContain('RCTMountingManager.h');
  });

  test('throws when an allowlisted header is absent from the inventory', () => {
    const m = validManifest();
    m.headers = m.headers.filter(
      x => x.naturalPath !== 'React/RCTBridge+Private.h',
    );
    expect(() => planFromInventory(m)).toThrow(
      /RCTBridge\+Private\.h is absent/,
    );
  });

  test('throws when a modular allowlist header is no longer objc-modular-candidate', () => {
    const m = validManifest();
    const h = m.headers.find(
      x => x.naturalPath === 'React/RCTBridge+Private.h',
    );
    if (h == null) {
      throw new Error('fixture missing RCTBridge+Private.h');
    }
    h.bucket = 'objc-blocked';
    expect(() => planFromInventory(m)).toThrow(/not 'objc-modular-candidate'/);
  });
});

describe('R10 per-namespace umbrella (React_RCTAppDelegate)', () => {
  test('emits a derived umbrella for the namespace', () => {
    const plan = planFromInventory(validManifest());
    const u = plan.namespaceUmbrellas.find(
      x => x.relPath === 'React_RCTAppDelegate/React_RCTAppDelegate-umbrella.h',
    );
    expect(u).toBeDefined();
    if (u == null) {
      return;
    }
    // Imports are relative to the namespace dir, derived from the live set.
    expect(u.content).toContain('#import "RCTReactNativeFactory.h"');
    expect(u.content).toContain('#import "RCTRootViewFactory.h"');
    expect(u.content).toContain('#import "RCTAppDelegate.h"');
    expect(u.content).toContain('#ifdef __OBJC__');
    // No CocoaPods version boilerplate.
    expect(u.content).not.toContain('FOUNDATION_EXPORT');
  });

  test('module map lists the umbrella so the import stays modular', () => {
    const plan = planFromInventory(validManifest());
    const mm = renderNamespaceModuleMap(plan.namespaceModules);
    expect(mm).toContain('module React_RCTAppDelegate {');
    expect(mm).toContain(
      'header "React_RCTAppDelegate/React_RCTAppDelegate-umbrella.h"',
    );
  });

  test('fails closed when the umbrella namespace lost its modular headers', () => {
    const m = validManifest();
    m.headers = m.headers.filter(
      x => !x.naturalPath.startsWith('React_RCTAppDelegate/'),
    );
    expect(() => planFromInventory(m)).toThrow(
      /umbrella namespace 'React_RCTAppDelegate'/,
    );
  });
});
