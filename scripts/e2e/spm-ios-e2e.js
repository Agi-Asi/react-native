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

/*:: import type {ProjectInfo} from '../shared/monorepoUtils'; */

/**
 * spm-ios-e2e.js
 *
 * Converts a React Native iOS app to Swift Package Manager (SPM) mode using
 * prebuilt XCFrameworks and compiles it — the per-app half of the SPM iOS CI
 * gate. NONE of this uses @react-native-community/cli.
 *
 * Apps:
 *   rntester    The in-repo packages/rn-tester app (flat layout).
 *   helloworld  The in-repo private/helloworld app.
 *   newapp      A fresh copy of private/helloworld in a temp dir, wired to a
 *               Verdaccio-published build of this monorepo (react-native from a
 *               local tarball via --rn-tarball, @react-native/* from the proxy).
 *
 * Flow (per app):
 *   1. Resolve/prepare the app's ios dir.
 *   2. `npx react-native spm scaffold`      (tolerate non-zero)
 *   3. `npx react-native spm add --deintegrate --artifacts <dir> --download skip`
 *   4. Assert the .spm-injected.json marker + that the Podfile lost use_react_native!.
 *   5. xcodebuild the requested configuration for the iOS simulator. For Release,
 *      point HERMES_CLI_PATH at the app's hermes-compiler hermesc so JS bundling
 *      to Hermes bytecode resolves (SPM has no hermes-engine pod to set it).
 *   6. Light sanity check: the embedded React.framework flavor matches the build.
 *
 * `--artifacts <dir>` must already contain complete debug/ and release/ slots
 * (see spm-prime-artifacts.js). `spm add` validates BOTH regardless of the
 * single configuration this run builds.
 *
 * Usage (from the repo root):
 *   node scripts/e2e/spm-ios-e2e.js --app helloworld --flavor Debug \
 *     --artifacts /tmp/spm-artifacts
 *   node scripts/e2e/spm-ios-e2e.js --app newapp --flavor Release \
 *     --artifacts /tmp/spm-artifacts --rn-tarball /tmp/rn/react-native-*.tgz
 */

const {PRIVATE_DIR, REPO_ROOT} = require('../shared/consts');
const {getPackages} = require('../shared/monorepoUtils');
const {
  VERDACCIO_SERVER_URL,
  VERDACCIO_STORAGE_PATH,
  setupVerdaccio,
} = require('./utils/verdaccio');
const {execFileSync, execSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseArgs} = require('node:util');

const HELP = `
Usage: node scripts/e2e/spm-ios-e2e.js [options]

Converts a React Native iOS app to SwiftPM mode with prebuilt XCFrameworks and
compiles it. Does not use @react-native-community/cli.

Options:
  --app <rntester|helloworld|newapp>  (required) App to convert + build.
  --flavor <Debug|Release>            (required) Build configuration.
  --artifacts <dir>                   (required) Primed artifact root with
                                      debug/ and release/ slots.
  --rn-tarball <path>                 (newapp only) The react-native .tgz to
                                      install (e.g. the react-native-package
                                      CI artifact).
  --simulator <name>                  [optional] Simulator name for the build
                                      destination (default: a generic iOS
                                      Simulator destination).
  --help                              Show this help.
`;

const config = {
  options: {
    app: {type: 'string'},
    flavor: {type: 'string'},
    artifacts: {type: 'string'},
    'rn-tarball': {type: 'string'},
    simulator: {type: 'string'},
    help: {type: 'boolean', default: false},
  },
};

/*::
type AppMeta = {
  // Directory the `spm` command runs in (holds the .xcodeproj).
  iosDir: string,
  // The .xcodeproj basename.
  projectName: string,
  // The scheme to build.
  scheme: string,
};
*/

function log(msg /*: string */) {
  console.log(`\x1b[36m[spm-ios-e2e]\x1b[0m ${msg}`);
}
function step(msg /*: string */) {
  console.log(`\n\x1b[35m==> ${msg}\x1b[0m`);
}

function run(
  cmd /*: string */,
  args /*: Array<string> */,
  cwd /*: string */,
  env /*:: ?: {[string]: string} */,
) /*: void */ {
  console.log(`$ (cd ${cwd} && ${cmd} ${args.join(' ')})`);
  // execFileSync's `env` option is invariantly typed as
  // {[string]: string | number | void}. process.env is {[string]: string | void}
  // and our overrides are strings, so a plain spread's narrower type is rejected;
  // build the object into a correctly-typed indexer instead.
  const childEnv /*: {[string]: string | number | void} */ = {};
  for (const key of Object.keys(process.env)) {
    childEnv[key] = process.env[key];
  }
  if (env != null) {
    for (const key of Object.keys(env)) {
      childEnv[key] = env[key];
    }
  }
  execFileSync(cmd, args, {cwd, stdio: 'inherit', env: childEnv});
}

function resolveInRepoApp(app /*: 'rntester' | 'helloworld' */) /*: AppMeta */ {
  if (app === 'rntester') {
    return {
      iosDir: path.join(REPO_ROOT, 'packages', 'rn-tester'),
      projectName: 'RNTesterPods.xcodeproj',
      scheme: 'RNTester',
    };
  }
  return {
    iosDir: path.join(PRIVATE_DIR, 'helloworld', 'ios'),
    projectName: 'HelloWorld.xcodeproj',
    scheme: 'HelloWorld',
  };
}

/**
 * Copy private/helloworld into a fresh temp dir, skipping build/dependency
 * output that must not (or need not) travel with the source.
 */
function copyHelloWorld(dest /*: string */) /*: void */ {
  const src = path.join(PRIVATE_DIR, 'helloworld');
  const skipTop = new Set(['node_modules', 'android', 'vendor']);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from /*: string */) => {
      const rel = path.relative(src, from);
      if (rel === '') {
        return true;
      }
      const segments = rel.split(path.sep);
      if (segments.length === 1 && skipTop.has(segments[0])) {
        return false;
      }
      // Drop gitignored iOS byproducts from any prior local build.
      if (
        segments[0] === 'ios' &&
        (segments[1] === 'build' || segments[1] === 'Pods')
      ) {
        return false;
      }
      return true;
    },
  });
}

/**
 * Mirror init-project-e2e.js's _prepareHelloWorld against a standalone copy:
 * repoint react-native at the local tarball and every in-repo @react-native/*
 * dependency at the version published to the proxy (or a file: path for the
 * unpublished `*` reference packages).
 */
function wireNewAppPackageJson(
  appDir /*: string */,
  version /*: string */,
  rnTarball /*: string */,
  localPackages /*: ProjectInfo */,
) /*: void */ {
  const pkgPath = path.join(appDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const updateDependencies = (deps /*: ?{[string]: string} */) => {
    if (deps == null) {
      return;
    }
    for (const key of Object.keys(deps)) {
      if (!key.startsWith('@react-native/')) {
        continue;
      }
      if (deps[key] === '*') {
        const localPackage = localPackages[key];
        if (localPackage != null) {
          deps[key] = `file:${path.relative(appDir, localPackage.path)}`;
        }
      } else {
        deps[key] = version;
      }
    }
  };
  updateDependencies(packageJson.dependencies);
  updateDependencies(packageJson.devDependencies);

  packageJson.dependencies['react-native'] = `file:${rnTarball}`;

  fs.writeFileSync(pkgPath, JSON.stringify(packageJson, null, 2));
}

/**
 * The helloworld Xcode "Bundle React Native code and images" phase reads
 * .react-native.config, which ships with REACT_NATIVE_PATH / HELLOWORLD_PATH
 * placeholders. For a standalone copy, substitute concrete paths so Release JS
 * bundling resolves react-native from the app's own node_modules.
 */
function fixupNewAppConfig(appDir /*: string */) /*: void */ {
  const cfg = path.join(appDir, '.react-native.config');
  if (!fs.existsSync(cfg)) {
    return;
  }
  const rnPath = path.join(appDir, 'node_modules', 'react-native');
  const content = fs
    .readFileSync(cfg, 'utf8')
    .replace(/REACT_NATIVE_PATH/g, rnPath)
    .replace(/HELLOWORLD_PATH/g, appDir);
  fs.writeFileSync(cfg, content);
}

async function prepareNewApp(rnTarball /*: ?string */) /*: Promise<AppMeta> */ {
  if (rnTarball == null) {
    throw new Error('--app newapp requires --rn-tarball <path>');
  }
  const resolvedTarball = path.resolve(rnTarball);
  if (!fs.existsSync(resolvedTarball)) {
    throw new Error(`--rn-tarball not found: ${resolvedTarball}`);
  }

  step('newapp: starting Verdaccio + publishing this monorepo');
  const verdaccioPid = setupVerdaccio();
  try {
    execSync('node ./scripts/build/build.js', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });

    const packages = await getPackages({
      includeReactNative: false,
      includePrivate: false,
    });
    // Packages are versioned in lockstep — any of them yields the version.
    const version = packages[Object.keys(packages)[0]].packageJson.version;

    for (const {path: packagePath} of Object.values(packages)) {
      execSync(
        `npm publish --registry ${VERDACCIO_SERVER_URL} --access public --tag react-native-e2e`,
        {cwd: packagePath, stdio: 'inherit'},
      );
    }

    step('newapp: copying private/helloworld to a temp dir');
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-newapp-'));
    copyHelloWorld(appDir);

    const localPackages = await getPackages({
      includeReactNative: false,
      includePrivate: true,
    });
    wireNewAppPackageJson(appDir, version, resolvedTarball, localPackages);

    step('newapp: npm install via the local proxy');
    execSync(`npm install --registry ${VERDACCIO_SERVER_URL}`, {
      cwd: appDir,
      stdio: 'inherit',
    });

    fixupNewAppConfig(appDir);

    return {
      iosDir: path.join(appDir, 'ios'),
      projectName: 'HelloWorld.xcodeproj',
      scheme: 'HelloWorld',
    };
  } finally {
    try {
      execSync(`kill ${verdaccioPid} || kill -9 ${verdaccioPid}`);
      execSync('killall verdaccio');
    } catch {
      console.warn('Failed to kill Verdaccio process');
    }
    try {
      execSync(`rm -rf ${VERDACCIO_STORAGE_PATH}`);
    } catch {}
  }
}

/**
 * Resolve the app's hermes-compiler host hermesc so react-native-xcode.sh can
 * compile JS to Hermes bytecode under SwiftPM (no hermes-engine pod to set
 * HERMES_CLI_PATH). Returns null when unresolved (Debug skips bundling anyway).
 */
function resolveHermesc(iosDir /*: string */) /*: ?string */ {
  try {
    const pkg = require.resolve('hermes-compiler/package.json', {
      paths: [iosDir],
    });
    const hermesc = path.join(
      path.dirname(pkg),
      'hermesc',
      'osx-bin',
      'hermesc',
    );
    return fs.existsSync(hermesc) ? hermesc : null;
  } catch {
    return null;
  }
}

/**
 * Light, best-effort sanity check: the embedded React.framework flavor should
 * match the build (Debug ships getDebugProps symbols, Release strips them).
 * Skips quietly when the framework or `nm` is unavailable.
 */
function assertEmbeddedFlavor(
  derivedData /*: string */,
  flavor /*: string */,
) /*: void */ {
  const productsDir = path.join(
    derivedData,
    'Build',
    'Products',
    `${flavor}-iphonesimulator`,
  );
  if (!fs.existsSync(productsDir)) {
    log('Skipping flavor check: no products dir.');
    return;
  }
  const app = fs.readdirSync(productsDir).find(name => name.endsWith('.app'));
  if (app == null) {
    log('Skipping flavor check: no .app found.');
    return;
  }
  const binary = path.join(
    productsDir,
    app,
    'Frameworks',
    'React.framework',
    'React',
  );
  if (!fs.existsSync(binary)) {
    log('Skipping flavor check: no embedded React.framework binary.');
    return;
  }
  let count = 0;
  try {
    const out = execFileSync('nm', [binary], {encoding: 'utf8'});
    count = (out.match(/getDebugProps/g) ?? []).length;
  } catch {
    log('Skipping flavor check: `nm` unavailable.');
    return;
  }
  const isDebug = flavor === 'Debug';
  if (isDebug && count === 0) {
    throw new Error(
      `Embedded React.framework has no getDebugProps symbols in a Debug build (expected >0).`,
    );
  }
  if (!isDebug && count !== 0) {
    throw new Error(
      `Embedded React.framework has getDebugProps symbols in a Release build (expected 0, got ${count}).`,
    );
  }
  log(`Embedded framework flavor matches ${flavor} (getDebugProps=${count}).`);
}

async function main() /*: Promise<void> */ {
  const {
    values,
    /* $FlowFixMe[incompatible-type] Natural Inference rollout. See
     * https://fburl.com/workplace/6291gfvu */
  } = parseArgs(config);

  if (values.help) {
    console.log(HELP);
    return;
  }

  const app = values.app;
  if (app !== 'rntester' && app !== 'helloworld' && app !== 'newapp') {
    throw new Error(
      `--app must be one of rntester|helloworld|newapp, got "${String(app)}"`,
    );
  }
  const flavor = values.flavor;
  if (flavor !== 'Debug' && flavor !== 'Release') {
    throw new Error(
      `--flavor must be Debug or Release, got "${String(flavor)}"`,
    );
  }
  if (values.artifacts == null) {
    throw new Error('--artifacts <dir> is required');
  }
  const artifacts = path.resolve(String(values.artifacts));
  for (const slot of ['debug', 'release']) {
    if (!fs.existsSync(path.join(artifacts, slot))) {
      throw new Error(
        `--artifacts is missing the ${slot}/ slot: ${path.join(artifacts, slot)}`,
      );
    }
  }

  const meta =
    app === 'newapp'
      ? await prepareNewApp(values['rn-tarball'])
      : resolveInRepoApp(app);
  const {iosDir, projectName, scheme} = meta;
  const pbxprojDir = path.join(iosDir, projectName);

  step(`Scaffold community Package.swift manifests (${app})`);
  try {
    run('npx', ['react-native', 'spm', 'scaffold'], iosDir);
  } catch {
    log('scaffold exited non-zero (tolerated).');
  }

  step(`Convert to SwiftPM: spm add --deintegrate (${app})`);
  run(
    'npx',
    [
      'react-native',
      'spm',
      'add',
      '--deintegrate',
      '--artifacts',
      artifacts,
      '--download',
      'skip',
    ],
    iosDir,
  );

  const marker = path.join(pbxprojDir, '.spm-injected.json');
  if (!fs.existsSync(marker)) {
    throw new Error(`spm add did not inject SPM (${marker} missing)`);
  }
  const podfile = path.join(iosDir, 'Podfile');
  if (
    fs.existsSync(podfile) &&
    /use_react_native!/.test(fs.readFileSync(podfile, 'utf8'))
  ) {
    throw new Error(
      'spm add --deintegrate did not strip use_react_native! from the Podfile',
    );
  }
  log('SPM injected in place; Podfile de-integrated.');

  step(`Build ${scheme} (${flavor}, SwiftPM)`);
  const derivedData = path.join(iosDir, 'build', 'spm-e2e-dd');
  fs.rmSync(derivedData, {recursive: true, force: true});

  const destination =
    values.simulator != null
      ? `platform=iOS Simulator,name=${String(values.simulator)}`
      : 'generic/platform=iOS Simulator';

  const buildEnv /*: {[string]: string} */ = {};
  if (flavor === 'Release') {
    const hermesc = resolveHermesc(iosDir);
    if (hermesc == null) {
      throw new Error(
        'Release build needs a hermes-compiler hermesc to bundle JS to Hermes ' +
          'bytecode (SwiftPM has no hermes-engine pod to set HERMES_CLI_PATH), but none was ' +
          `resolved from ${iosDir}'s node_modules. Ensure hermes-compiler is installed. ` +
          'Failing early so this is not mistaken for an xcodebuild bundling error.',
      );
    }
    buildEnv.HERMES_CLI_PATH = hermesc;
    log(`HERMES_CLI_PATH=${hermesc}`);
  }

  run(
    'xcodebuild',
    [
      '-project',
      path.join(iosDir, projectName),
      '-scheme',
      scheme,
      '-configuration',
      flavor,
      '-sdk',
      'iphonesimulator',
      '-destination',
      destination,
      '-derivedDataPath',
      derivedData,
      'build',
    ],
    iosDir,
    Object.keys(buildEnv).length > 0 ? buildEnv : undefined,
  );

  step('Sanity check: embedded framework flavor');
  assertEmbeddedFlavor(derivedData, flavor);

  console.log(`\n\x1b[32m[spm-ios-e2e] PASS — ${app} (${flavor})\x1b[0m`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\x1b[31m[spm-ios-e2e] ${err.message}\x1b[0m`);
    process.exit(1);
  });
}

module.exports = {main};
