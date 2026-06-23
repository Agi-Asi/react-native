/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

/**
 * THE HEADERS SPEC — executable contract for the packaged header layout.
 *
 * One source of truth: the prebuild compose step (headers-compose.js) EMITS
 * artifacts from it, and the SPM tooling derives what consumers need from it
 * (nothing extra, by design).
 *
 * The rules:
 *
 * R1. React.framework/Headers ROOT serves the `React/` namespace (contents
 *     hoisted to root) plus the bare root aliases. The framework name supplies
 *     the `React/` prefix, so `<React/RCTBridge.h>` resolves verbatim through
 *     FRAMEWORK_SEARCH_PATHS. The `react/` (lowercase) namespace is NOT here —
 *     it ships in ReactNativeHeaders (R2). Resolving it through React.framework
 *     would require case-folding `react.framework` → `React.framework`, which
 *     only works on case-insensitive filesystems; the header-search-path route
 *     is exact and works everywhere.
 * R2. Every other namespace (incl. `react/`) ships in ONE headers-only library
 *     xcframework ("ReactNativeHeaders"), namespace dirs at its Headers root,
 *     INCLUDING the third-party deps namespaces (folly/glog/boost/fmt/
 *     double-conversion/fast_float, sourced from the deps artifact) — making
 *     ReactNativeDependencies binary-only. Served by exact header-search-path
 *     lookup, so resolution is filesystem-case-independent.
 * R3. NO include rewriting anywhere — source headers are byte-identical to
 *     the repo (content authority = source files; layout authority = this
 *     spec). Consumers compile unchanged except bare-form angle includes
 *     (R6).
 * R4. React.framework gets a framework module map with an umbrella over the
 *     ObjC modular surface: objc-modular-candidate ∧ React/-namespace ∧ no
 *     '+'-category header ∧ no C extern-inline definition (C99 extern inline
 *     emits a STRONG symbol per importing .m TU → duplicate symbols;
 *     RCTTextInputNativeCommands.h found empirically).
 * R5. Every namespace with objc-modular-candidates gets a module declaring
 *     exactly those candidates (framework modules may not textually include
 *     non-modular framework headers; yoga + RCTDeprecation found
 *     empirically). Namespaces whose name is not a valid module identifier
 *     (e.g. jsinspector-modern) are exempt — they have no candidates today;
 *     the verifier asserts that stays true. `react/` is also exempt: its few
 *     objc-modular-candidates stay textual (as they already were inside
 *     React.framework) so no `react` module aliases the `React` framework
 *     module.
 * R6. Bare root aliases are servable only as `<React/X>` — bare angle forms
 *     (`#import <RCTAppDelegate.h>`) have no framework spelling. This is the
 *     accepted, measured consumer migration (~4 lines ecosystem-wide).
 * R7. Artifacts are code-signed AFTER header composition (signature pins the
 *     header manifest).
 * R8. Collisions are ERRORS: two different source files may never project to
 *     the same destination path.
 */

const fs = require('fs');
const path = require('path');

const RN_ROOT = path.join(__dirname, '..', '..');

/*::
export type SpecEntry = {
  relPath: string, // destination under the artifact's Headers root
  source: string, // repo-relative source file
  naturalPath: string, // canonical include identity (inventory key)
};

export type HeadersSpecPlan = {
  // React.xcframework -> React.framework/Headers (R1)
  react: Array<SpecEntry>,
  // ReactNativeHeaders.xcframework -> Headers (R2); deps namespaces are
  // added by the emitter from the deps artifact (not per-file here).
  reactNativeHeaders: Array<SpecEntry>,
  depsNamespaces: Array<string>,
  // R4: umbrella header list (React/-relative paths)
  umbrella: Array<string>,
  // R5: plain modules for ReactNativeHeaders' module.modulemap
  namespaceModules: {[ns: string]: Array<string>},
  // R9: private headers added to the React module map (allowlist).
  privateReactHeaders: {modular: Array<string>, textual: Array<string>},
  collisions: Array<string>,
};
*/

// R2: third-party namespaces relocated from the deps artifact.
const DEPS_NAMESPACES = [
  'folly',
  'glog',
  'boost',
  'fmt',
  'double-conversion',
  'fast_float',
];

// R4/R5 umbrella exclusion: C extern-inline definitions.
const EXTERN_INLINE_RE /*: RegExp */ =
  /\b(RCT_EXTERN\s+inline|extern\s+inline)\b/;

const MODULE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// R9: Private React headers — a curated allowlist of `<React/...>` headers that
// privileged framework consumers (e.g. Expo) import, but which the public
// umbrella (R4) excludes (they are `+`-suffixed and/or objc-blocked). They are
// already shipped in React.framework/Headers; adding them to the React module
// map keeps the existing `#import <React/...>` sites MODULAR under explicit
// modules — backwards-compatible, no consumer import (or Swift) changes. Split
// by inventory bucket:
//   - modular: objc-modular-candidate (reach no C++) -> real `header`.
//   - textual: objc-blocked (reach C++ via `<react/...>`) -> `textual header`
//     (a real member would re-trip -Wnon-modular-include; the C++ includes
//     resolve at the consumer's use site, exactly as under the old VFS overlay).
// Privacy is by convention (the `+Private`/internal naming): a single binary
// artifact cannot hard-gate apps from headers a framework legitimately needs.
const PRIVATE_REACT_HEADERS /*: {modular: Array<string>, textual: Array<string>} */ =
  {
    modular: ['RCTBridge+Private.h'],
    textual: [
      'RCTComponentViewFactory.h',
      'RCTComponentViewProtocol.h',
      'RCTComponentViewRegistry.h',
      'RCTMountingManager.h',
      'RCTSurfacePresenter.h',
      'RCTViewComponentView.h',
    ],
  };

// Fail closed if an allowlisted private header drifts: it must exist in the
// inventory (else it was removed/renamed in source — e.g. RCTUIKit.h /
// RCTRootContentView.h, which need restoration, NOT this allowlist), and a
// `modular` entry must really be objc-modular-candidate (else it now reaches
// C++/third-party and must move to `textual`).
function validatePrivateReactHeaders(manifest /*: any */) /*: void */ {
  const byNatural = new Map(manifest.headers.map(h => [h.naturalPath, h]));
  const requireShipped = (name /*: string */) => {
    const e = byNatural.get(`React/${name}`);
    if (e == null) {
      throw new Error(
        `Private React header allowlist: React/${name} is absent from the ` +
          `inventory (removed/renamed in source?). Restore the header or remove ` +
          `it from PRIVATE_REACT_HEADERS.`,
      );
    }
    return e;
  };
  for (const name of PRIVATE_REACT_HEADERS.modular) {
    const e = requireShipped(name);
    if (e.bucket !== 'objc-modular-candidate') {
      throw new Error(
        `Private React header React/${name} is bucket '${e.bucket}', not ` +
          `'objc-modular-candidate' — it now reaches C++/third-party. Move it ` +
          `to PRIVATE_REACT_HEADERS.textual.`,
      );
    }
  }
  for (const name of PRIVATE_REACT_HEADERS.textual) {
    requireShipped(name);
  }
}

function isUmbrellaSafe(h /*: any */) /*: boolean */ {
  if (h.bucket !== 'objc-modular-candidate' || h.naturalPath.includes('+')) {
    return false;
  }
  try {
    return !EXTERN_INLINE_RE.test(
      fs.readFileSync(path.join(RN_ROOT, h.identities[0].source), 'utf8'),
    );
  } catch {
    return false;
  }
}

/**
 * Computes the full layout plan from the header inventory manifest
 * (build/header-inventory.json — regenerate with header-inventory.js).
 */
function planFromInventory(manifest /*: any */) /*: HeadersSpecPlan */ {
  validatePrivateReactHeaders(manifest); // R9: fail closed on allowlist drift
  const react /*: Array<SpecEntry> */ = [];
  const reactNativeHeaders /*: Array<SpecEntry> */ = [];
  const umbrella /*: Array<string> */ = [];
  const namespaceModules /*: {[string]: Array<string>} */ = {};
  const collisions /*: Array<string> */ = [];
  const seen /*: Map<string, string> */ = new Map();

  for (const h of manifest.headers) {
    const np = h.naturalPath;
    const source = h.identities[0].source;
    let bucketKey;
    let entryList;
    let relPath;
    if (np.startsWith('React/')) {
      relPath = np.slice(6); // R1: hoist React/ to the framework Headers root
      bucketKey = `React.framework/${relPath}`;
      entryList = react;
    } else if (!np.includes('/')) {
      relPath = np; // R1/R6: bare alias at root
      bucketKey = `React.framework/${relPath}`;
      entryList = react;
    } else {
      // R2: every other namespace (incl. react/) keeps its prefix and is
      // served from ReactNativeHeaders via the header search path.
      relPath = np;
      bucketKey = `ReactNativeHeaders/${relPath}`;
      entryList = reactNativeHeaders;
    }
    const prev = seen.get(bucketKey);
    if (prev != null) {
      if (prev !== source) {
        collisions.push(`${bucketKey}: ${prev} vs ${source}`); // R8
      }
      continue;
    }
    seen.set(bucketKey, source);
    entryList.push({relPath, source, naturalPath: np});

    // R4: React umbrella membership.
    if (np.startsWith('React/') && isUmbrellaSafe(h)) {
      umbrella.push(np);
    }
    // R5: namespace modules (only for ReactNativeHeaders namespaces). Every
    // namespace with modular candidates gets a module so that React.framework's
    // modular headers can `#import <ns/...>` as a MODULAR include (otherwise
    // clang's -Wnon-modular-include-in-framework-module rejects it). `react/` is
    // included here too — its module is renamed in renderNamespaceModuleMap so a
    // `react` module never aliases the `React` framework module on a
    // case-insensitive filesystem.
    if (entryList === reactNativeHeaders) {
      const ns = np.split('/')[0];
      if (MODULE_IDENT_RE.test(ns) && isUmbrellaSafe(h)) {
        if (!namespaceModules[ns]) {
          namespaceModules[ns] = [];
        }
        namespaceModules[ns].push(np);
      }
    }
  }

  umbrella.sort();
  for (const ns of Object.keys(namespaceModules)) {
    namespaceModules[ns].sort();
  }

  return {
    react,
    reactNativeHeaders,
    depsNamespaces: DEPS_NAMESPACES,
    umbrella,
    namespaceModules,
    privateReactHeaders: PRIVATE_REACT_HEADERS,
    collisions,
  };
}

/**
 * Renders React.framework's module map (R4 + R9). The umbrella covers the
 * public modular surface; the allowlisted private headers (R9) are appended as
 * explicit `header` (modular) / `textual header` (objc-blocked) entries so
 * `#import <React/...>` of them stays modular without polluting the umbrella.
 */
function renderReactModuleMap(
  privateReactHeaders /*:: ?: {modular: Array<string>, textual: Array<string>} */,
) /*: string */ {
  const pv = privateReactHeaders ?? {modular: [], textual: []};
  const extra = [
    ...pv.modular.map(h => `  header "${h}"`),
    ...pv.textual.map(h => `  textual header "${h}"`),
  ];
  const extraBlock = extra.length > 0 ? '\n' + extra.join('\n') : '';
  return `framework module React {
  umbrella header "React-umbrella.h"${extraBlock}
  export *
  module * { export * }
}
`;
}

/** Renders the umbrella header content (R4). */
function renderUmbrellaHeader(umbrella /*: Array<string> */) /*: string */ {
  return umbrella.map(u => `#import <${u}>`).join('\n') + '\n';
}

/**
 * Renders ReactNativeHeaders' module.modulemap (R5): PLAIN (non-framework)
 * modules, one per namespace with modular candidates — discovered implicitly
 * by clang via the auto-added header search path. Headers are referenced by
 * their path relative to the Headers root (= the modulemap's directory).
 */
function renderNamespaceModuleMap(
  namespaceModules /*: {[string]: Array<string>} */,
) /*: string */ {
  // The module NAME is internal to clang's module graph (consumers never
  // `@import` these; they `#import <ns/...>` and clang maps the header to its
  // module). It only has to be unique and must not alias the `React` framework
  // module on a case-insensitive filesystem — so the lowercase `react`
  // namespace is given a distinct module name. Header paths are unchanged, so
  // `<react/...>` still resolves and is now a modular include.
  const moduleNameFor = (ns /*: string */) /*: string */ =>
    ns === 'react' ? 'ReactNativeHeaders_react' : ns;
  const blocks = [];
  for (const ns of Object.keys(namespaceModules).sort()) {
    blocks.push(
      `module ${moduleNameFor(ns)} {\n` +
        namespaceModules[ns].map(hh => `  header "${hh}"`).join('\n') +
        `\n  export *\n}`,
    );
  }
  return blocks.join('\n\n') + '\n';
}

module.exports = {
  planFromInventory,
  renderReactModuleMap,
  renderUmbrellaHeader,
  renderNamespaceModuleMap,
  DEPS_NAMESPACES,
};
