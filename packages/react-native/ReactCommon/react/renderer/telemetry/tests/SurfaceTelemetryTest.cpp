/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <chrono>
#include <memory>

#include <gtest/gtest.h>

#include <react/renderer/telemetry/SurfaceTelemetry.h>
#include <react/renderer/telemetry/TransactionTelemetry.h>
#include <react/utils/Telemetry.h>

using namespace facebook::react;

namespace {

using namespace std::chrono_literals;

/*
 * Builds a fully-completed `TransactionTelemetry` with deterministic phase
 * durations by driving a lambda-backed clock whose time we advance explicitly
 * between each `will`/`did` pair. `SurfaceTelemetry::incorporate` reads every
 * phase's start/end time, so all four phases (diff, layout, commit, mount) must
 * be signaled or the telemetry getters would assert.
 */
TransactionTelemetry makeCompletedTelemetry(
    std::chrono::milliseconds diff,
    std::chrono::milliseconds layout,
    std::chrono::milliseconds commit,
    std::chrono::milliseconds mount,
    std::chrono::milliseconds textMeasurePerCall,
    int numberOfTextMeasurements,
    int revisionNumber) {
  auto now = std::make_shared<TelemetryTimePoint>();
  auto telemetry = TransactionTelemetry{[now]() { return *now; }};

  telemetry.willDiff();
  *now += diff;
  telemetry.didDiff();

  telemetry.willLayout();
  *now += layout;
  telemetry.didLayout();

  for (int i = 0; i < numberOfTextMeasurements; ++i) {
    telemetry.willMeasureText();
    *now += textMeasurePerCall;
    telemetry.didMeasureText();
  }

  telemetry.willCommit();
  *now += commit;
  telemetry.didCommit();

  telemetry.willMount();
  *now += mount;
  telemetry.didMount();

  telemetry.setRevisionNumber(revisionNumber);
  return telemetry;
}

} // namespace

TEST(SurfaceTelemetryTest, incorporateAggregatesSingleTransaction) {
  auto telemetry = makeCompletedTelemetry(
      /* diff */ 10ms,
      /* layout */ 20ms,
      /* commit */ 30ms,
      /* mount */ 40ms,
      /* textMeasurePerCall */ 5ms,
      /* numberOfTextMeasurements */ 3,
      /* revisionNumber */ 7);

  auto surface = SurfaceTelemetry{};
  surface.incorporate(telemetry, /* numberOfMutations */ 11);

  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getDiffTime()), 10);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getLayoutTime()), 20);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getCommitTime()), 30);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getMountTime()), 40);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getTextMeasureTime()), 15);

  EXPECT_EQ(surface.getNumberOfTransactions(), 1);
  EXPECT_EQ(surface.getNumberOfMutations(), 11);
  EXPECT_EQ(surface.getNumberOfTextMeasurements(), 3);
  EXPECT_EQ(surface.getLastRevisionNumber(), 7);
  EXPECT_EQ(surface.getRecentTransactionTelemetries().size(), 1);
}

TEST(SurfaceTelemetryTest, incorporateAccumulatesAcrossTransactions) {
  auto first = makeCompletedTelemetry(
      /* diff */ 10ms,
      /* layout */ 20ms,
      /* commit */ 30ms,
      /* mount */ 40ms,
      /* textMeasurePerCall */ 5ms,
      /* numberOfTextMeasurements */ 2,
      /* revisionNumber */ 3);
  auto second = makeCompletedTelemetry(
      /* diff */ 1ms,
      /* layout */ 2ms,
      /* commit */ 3ms,
      /* mount */ 4ms,
      /* textMeasurePerCall */ 7ms,
      /* numberOfTextMeasurements */ 1,
      /* revisionNumber */ 9);

  auto surface = SurfaceTelemetry{};
  surface.incorporate(first, /* numberOfMutations */ 4);
  surface.incorporate(second, /* numberOfMutations */ 6);

  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getDiffTime()), 11);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getLayoutTime()), 22);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getCommitTime()), 33);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getMountTime()), 44);
  EXPECT_EQ(telemetryDurationToMilliseconds(surface.getTextMeasureTime()), 17);

  EXPECT_EQ(surface.getNumberOfTransactions(), 2);
  EXPECT_EQ(surface.getNumberOfMutations(), 10);
  EXPECT_EQ(surface.getNumberOfTextMeasurements(), 3);
  // The last revision number must reflect the most recently incorporated
  // transaction, not an aggregate.
  EXPECT_EQ(surface.getLastRevisionNumber(), 9);
  EXPECT_EQ(surface.getRecentTransactionTelemetries().size(), 2);
}

TEST(SurfaceTelemetryTest, recentTransactionTelemetriesRetainAllAtCapBoundary) {
  const auto cap =
      static_cast<int>(SurfaceTelemetry::kMaxNumberOfRecordedCommitTelemetries);

  auto surface = SurfaceTelemetry{};
  for (int revision = 1; revision <= cap; ++revision) {
    auto telemetry = makeCompletedTelemetry(
        1ms, 1ms, 1ms, 1ms, 0ms, /* numberOfTextMeasurements */ 0, revision);
    surface.incorporate(telemetry, /* numberOfMutations */ 1);
  }

  auto recent = surface.getRecentTransactionTelemetries();
  // Exactly `cap` transactions fit without any eviction.
  EXPECT_EQ(recent.size(), static_cast<size_t>(cap));
  EXPECT_EQ(recent.front().getRevisionNumber(), 1);
  EXPECT_EQ(recent.back().getRevisionNumber(), cap);
}

TEST(SurfaceTelemetryTest, recentTransactionTelemetriesEvictOldestBeyondCap) {
  const auto cap =
      static_cast<int>(SurfaceTelemetry::kMaxNumberOfRecordedCommitTelemetries);
  const int total = cap + 4;

  auto surface = SurfaceTelemetry{};
  for (int revision = 1; revision <= total; ++revision) {
    auto telemetry = makeCompletedTelemetry(
        1ms, 1ms, 1ms, 1ms, 0ms, /* numberOfTextMeasurements */ 0, revision);
    surface.incorporate(telemetry, /* numberOfMutations */ 1);
  }

  auto recent = surface.getRecentTransactionTelemetries();
  // The buffer is capped, but the running transaction counter is not.
  EXPECT_EQ(recent.size(), static_cast<size_t>(cap));
  EXPECT_EQ(surface.getNumberOfTransactions(), total);
  // The oldest `total - cap` transactions are evicted in FIFO order, so the
  // retained window is [total - cap + 1, total].
  EXPECT_EQ(recent.front().getRevisionNumber(), total - cap + 1);
  EXPECT_EQ(recent.back().getRevisionNumber(), total);
}
