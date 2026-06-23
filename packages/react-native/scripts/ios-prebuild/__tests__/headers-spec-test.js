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

const {planFromInventory, renderReactModuleMap} = require('../headers-spec');

// Minimal inventory entry. isUmbrellaSafe reads the source off disk for React/
// headers; the synthetic paths don't exist so it falls back to false — which is
// fine here, these tests exercise the R9 allowlist, not umbrella membership.
const entry = (naturalPath /*: string */, bucket /*: string */) => ({
  naturalPath,
  bucket,
  lang: 'objc',
  identities: [{source: `does/not/exist/${naturalPath}`}],
});

// A manifest that satisfies the R9 private-header allowlist.
const validManifest = () => ({
  headers: [
    entry('React/RCTBridge+Private.h', 'objc-modular-candidate'),
    entry('React/RCTComponentViewFactory.h', 'objc-blocked'),
    entry('React/RCTComponentViewProtocol.h', 'objc-blocked'),
    entry('React/RCTComponentViewRegistry.h', 'objc-blocked'),
    entry('React/RCTMountingManager.h', 'objc-blocked'),
    entry('React/RCTSurfacePresenter.h', 'objc-blocked'),
    entry('React/RCTViewComponentView.h', 'objc-blocked'),
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
