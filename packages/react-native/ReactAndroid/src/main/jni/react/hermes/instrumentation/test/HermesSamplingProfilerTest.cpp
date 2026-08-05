/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "HermesSamplingProfiler.h"

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <gtest/gtest.h>

#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <system_error>

namespace facebook::jsi::jni {
namespace {

// The JNI entry points ignore their `jclass` argument, so a null alias_ref is
// sufficient to drive them from a host unit test without a live JVM.
jni::alias_ref<jclass> noClass() {
  return jni::alias_ref<jclass>{};
}

// Creates a HermesRuntime that automatically registers itself with the global
// sampling profiler. Without such a runtime the global profiler has nothing to
// serialize.
std::unique_ptr<facebook::hermes::HermesRuntime> makeProfilingRuntime() {
  auto config = ::hermes::vm::RuntimeConfig::Builder()
                    .withEnableSampleProfiling(true)
                    .build();
  auto* rootAPI = castInterface<facebook::hermes::IHermesRootAPI>(
      facebook::hermes::makeHermesRootAPI());
  return rootAPI->makeHermesRuntime(config);
}

std::string readFile(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  std::stringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

class HermesSamplingProfilerTest : public ::testing::Test {
 protected:
  std::string tracePath(const std::string& name) const {
    return ::testing::TempDir() + "HermesSamplingProfilerTest_" + name;
  }
};

// Enabling the profiler, dumping while a runtime is registered, then disabling
// should forward the requested filename all the way to Hermes and write a
// well-formed Chrome trace document to exactly that path.
TEST_F(HermesSamplingProfilerTest, dumpWhileProfilingWritesChromeTrace) {
  const std::string path = tracePath("profiling.json");
  std::remove(path.c_str());

  HermesSamplingProfiler::enable(noClass());
  auto runtime = makeProfilingRuntime();
  HermesSamplingProfiler::dumpSampledTraceToFile(noClass(), path);
  HermesSamplingProfiler::disable(noClass());

  const std::string contents = readFile(path);
  EXPECT_NE(contents.find("traceEvents"), std::string::npos);
  EXPECT_NE(contents.find("samples"), std::string::npos);
  EXPECT_NE(contents.find("stackFrames"), std::string::npos);

  std::remove(path.c_str());
}

// A destination that cannot be opened (its parent directory does not exist)
// must surface the underlying I/O failure to the caller rather than being
// swallowed.
TEST_F(HermesSamplingProfilerTest, dumpToUnwritablePathThrows) {
  const std::string path = ::testing::TempDir() + "hsp_missing_dir/trace.json";

  EXPECT_THROW(
      HermesSamplingProfiler::dumpSampledTraceToFile(noClass(), path),
      std::system_error);
}

// With no runtime registered the global profiler has no data to serialize, but
// the JNI entry point must still create the exact file it was asked to write.
TEST_F(
    HermesSamplingProfilerTest,
    dumpWithoutRegisteredRuntimeCreatesEmptyFile) {
  const std::string path = tracePath("no_runtime.json");
  std::remove(path.c_str());

  HermesSamplingProfiler::dumpSampledTraceToFile(noClass(), path);

  std::ifstream stream(path, std::ios::binary);
  ASSERT_TRUE(stream.good());
  EXPECT_TRUE(readFile(path).empty());

  std::remove(path.c_str());
}

} // namespace
} // namespace facebook::jsi::jni
