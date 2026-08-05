/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <gtest/gtest.h>

#include <memory>
#include <stdexcept>
#include <string>

#include <cxxreact/RAMBundleRegistry.h>

// RAMBundleRegistry.h compiles to an empty header when RCT_REMOVE_LEGACY_ARCH
// is defined (e.g. the iOS build configs), so this guard is required for the
// test file to compile across all platforms.
#ifndef RCT_REMOVE_LEGACY_ARCH

namespace facebook::react {
namespace {

// Minimal JSModulesUnbundle test double that always returns a preconfigured
// module and records the last module ID it was asked for.
class FakeModulesUnbundle : public JSModulesUnbundle {
 public:
  explicit FakeModulesUnbundle(Module module) : module_(std::move(module)) {}

  Module getModule(uint32_t moduleId) const override {
    lastRequestedModuleId = moduleId;
    return module_;
  }

  mutable uint32_t lastRequestedModuleId = 0;

 private:
  Module module_;
};

std::unique_ptr<FakeModulesUnbundle> makeUnbundle(
    std::string name,
    std::string code) {
  return std::make_unique<FakeModulesUnbundle>(JSModulesUnbundle::Module{
      .name = std::move(name), .code = std::move(code)});
}

} // namespace

TEST(RAMBundleRegistryTest, getModuleFromMainBundleReturnsModuleUnchanged) {
  auto mainBundle = makeUnbundle("mainModule", "main code");
  auto* mainBundleRaw = mainBundle.get();
  RAMBundleRegistry registry(std::move(mainBundle));

  auto module = registry.getModule(RAMBundleRegistry::MAIN_BUNDLE_ID, 42);

  // The main bundle's module is returned verbatim, with no "seg-" prefixing.
  EXPECT_EQ(module.name, "mainModule");
  EXPECT_EQ(module.code, "main code");
  EXPECT_EQ(mainBundleRaw->lastRequestedModuleId, 42u);
}

TEST(RAMBundleRegistryTest, getModuleFromSecondaryBundlePrefixesName) {
  std::string capturedPath;
  auto factory =
      [&capturedPath](std::string path) -> std::unique_ptr<JSModulesUnbundle> {
    capturedPath = std::move(path);
    return makeUnbundle("segModule", "seg code");
  };

  RAMBundleRegistry registry(makeUnbundle("main", "main"), factory);
  registry.registerBundle(7, "/bundles/seg7.js");

  auto module = registry.getModule(7, 3);

  // The factory is resolved using the path registered for bundle 7 and the
  // resulting module name is namespaced with the bundle ID.
  EXPECT_EQ(capturedPath, "/bundles/seg7.js");
  EXPECT_EQ(module.name, "seg-7_segModule");
  EXPECT_EQ(module.code, "seg code");
}

TEST(RAMBundleRegistryTest, getModuleWithoutFactoryThrows) {
  RAMBundleRegistry registry(makeUnbundle("main", "main"));
  registry.registerBundle(1, "/bundles/seg1.js");

  EXPECT_THROW(
      {
        try {
          registry.getModule(1, 0);
        } catch (const std::runtime_error& e) {
          EXPECT_NE(
              std::string(e.what()).find("register factory function"),
              std::string::npos);
          throw;
        }
      },
      std::runtime_error);
}

TEST(RAMBundleRegistryTest, getModuleWithUnregisteredPathThrows) {
  bool factoryCalled = false;
  auto factory =
      [&factoryCalled](std::string) -> std::unique_ptr<JSModulesUnbundle> {
    factoryCalled = true;
    return nullptr;
  };
  RAMBundleRegistry registry(makeUnbundle("main", "main"), factory);

  EXPECT_THROW(
      {
        try {
          registry.getModule(9, 0);
        } catch (const std::runtime_error& e) {
          EXPECT_NE(std::string(e.what()).find("path"), std::string::npos);
          throw;
        }
      },
      std::runtime_error);
  // The factory must not run when the bundle path was never registered.
  EXPECT_FALSE(factoryCalled);
}

TEST(RAMBundleRegistryTest, secondaryBundleCreatedOnceAndCached) {
  int factoryCallCount = 0;
  auto factory =
      [&factoryCallCount](std::string) -> std::unique_ptr<JSModulesUnbundle> {
    ++factoryCallCount;
    return makeUnbundle("segModule", "seg code");
  };
  RAMBundleRegistry registry(makeUnbundle("main", "main"), factory);
  registry.registerBundle(4, "/bundles/seg4.js");

  auto first = registry.getModule(4, 1);
  auto second = registry.getModule(4, 2);

  // The factory is invoked lazily only on the first access; the constructed
  // bundle is cached and reused for subsequent module lookups.
  EXPECT_EQ(factoryCallCount, 1);
  EXPECT_EQ(first.name, "seg-4_segModule");
  EXPECT_EQ(second.name, "seg-4_segModule");
}

} // namespace facebook::react

#endif // RCT_REMOVE_LEGACY_ARCH
