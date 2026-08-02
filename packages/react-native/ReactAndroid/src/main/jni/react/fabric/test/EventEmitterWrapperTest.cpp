/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <react/fabric/EventEmitterWrapper.h>

#include <react/renderer/core/EventBeat.h>
#include <react/renderer/core/EventDispatcher.h>
#include <react/renderer/core/EventListener.h>
#include <react/renderer/core/EventQueueProcessor.h>
#include <react/renderer/core/RawEvent.h>
#include <react/renderer/runtimescheduler/RuntimeScheduler.h>
#include <react/timing/primitives.h>

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <string>

/*
 * Pure-C++ unit tests for `EventEmitterWrapper`, the JNI adapter that bridges
 * Java-side event dispatch to the C++ `EventEmitter`. The three public methods
 * (`dispatchEvent`, `dispatchUniqueEvent`, `dispatchEventSynchronously`) are
 * plain C++ member functions; the only JNI-coupled argument is the
 * `NativeMap* payload`, which the wrapper explicitly treats as optional. By
 * passing `nullptr` for the payload we exercise the full forwarding logic
 * without any attached JavaVM.
 *
 * Forwarding is observed by wiring the wrapper to a real `EventEmitter` backed
 * by a real `EventDispatcher`, and installing an `EventListener` on that
 * dispatcher. `EventDispatcher::dispatchEvent`/`dispatchUniqueEvent` invoke the
 * listener chain synchronously *before* enqueueing; a listener that returns
 * `true` interrupts default dispatch, letting us capture the fully-formed
 * `RawEvent` (normalized type, category, uniqueness, timestamp) without needing
 * a `jsi::Runtime` or a real event beat to flush the queue.
 *
 * `EventEmitterWrapper` derives from `jni::HybridClass`, but with the default
 * base its C++ part is just a `detail::BaseHybridClass` (a class with a virtual
 * destructor and no JNI state), so instances can be constructed directly on the
 * stack host-side.
 */
namespace facebook::react {
namespace {

// Snapshot of the RawEvent that reached the dispatcher's listener chain.
struct DispatchRecord {
  bool dispatched{false};
  std::string type;
  RawEvent::Category category{RawEvent::Category::Unspecified};
  bool isUnique{false};
  HighResTimeStamp timestamp{HighResTimeStamp::now()};
};

// EventBeat that records synchronous-flush requests. The base `request()` and
// `requestSynchronous()` only flip atomic flags and never dereference the
// `RuntimeScheduler` (that happens in `induce()`, which the interrupt-based
// listener path never triggers), so overriding `requestSynchronous()` to count
// invocations lets us assert that `dispatchEventSynchronously` routes through
// `EventDispatcher::experimental_flushSync`.
class RecordingEventBeat : public EventBeat {
 public:
  RecordingEventBeat(
      std::shared_ptr<OwnerBox> ownerBox,
      RuntimeScheduler& runtimeScheduler,
      int& syncFlushCount)
      : EventBeat(std::move(ownerBox), runtimeScheduler),
        syncFlushCount_(syncFlushCount) {}

  void requestSynchronous() const override {
    ++syncFlushCount_;
  }

 private:
  int& syncFlushCount_;
};

} // namespace

class EventEmitterWrapperTest : public ::testing::Test {
 protected:
  void SetUp() override {
    // A no-op runtime executor is sufficient: it is only invoked when the
    // event beat is induced, which never happens because the listener
    // interrupts dispatch before anything is enqueued.
    runtimeScheduler_ = std::make_unique<RuntimeScheduler>(RuntimeExecutor{});

    record_ = std::make_shared<DispatchRecord>();

    EventQueueProcessor eventProcessor(
        EventPipe{},
        EventPipeConclusion{},
        StatePipe{},
        std::weak_ptr<EventLogger>{});

    auto eventBeat = std::make_unique<RecordingEventBeat>(
        std::make_shared<EventBeat::OwnerBox>(),
        *runtimeScheduler_,
        syncFlushCount_);

    dispatcher_ = std::make_shared<EventDispatcher>(
        eventProcessor,
        std::move(eventBeat),
        StatePipe{},
        std::weak_ptr<EventLogger>{});

    auto record = record_;
    listener_ =
        std::make_shared<EventListener>([record](const RawEvent& event) {
          record->dispatched = true;
          record->type = event.type;
          record->category = event.category;
          record->isUnique = event.isUnique;
          record->timestamp = event.eventStartTimeStamp;
          // Interrupt default dispatch so the event is never enqueued/flushed.
          return true;
        });
    dispatcher_->addListener(listener_);

    emitter_ = std::make_shared<EventEmitter>(
        /*eventTarget=*/nullptr, EventDispatcher::Weak(dispatcher_));
  }

  // Returns the milliseconds-since-steady-clock-epoch encoded in a timestamp
  // produced by the wrapper, so tests can assert the millis->HighResTimeStamp
  // conversion preserves the value and unit.
  static int64_t millisSinceEpoch(HighResTimeStamp timestamp) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               timestamp.toChronoSteadyClockTimePoint().time_since_epoch())
        .count();
  }

  std::unique_ptr<RuntimeScheduler> runtimeScheduler_;
  std::shared_ptr<DispatchRecord> record_;
  std::shared_ptr<EventDispatcher> dispatcher_;
  std::shared_ptr<const EventListener> listener_;
  SharedEventEmitter emitter_;
  int syncFlushCount_{0};
};

/*
 * `dispatchEvent` must (a) normalize the raw JS event name to its "top" form,
 * (b) forward the integer category verbatim as a `RawEvent::Category`, and
 * (c) convert the Java uptime-millis timestamp into a HighResTimeStamp that
 * represents the same number of milliseconds. It must NOT force a synchronous
 * flush.
 *
 * Bug this catches: mis-casting the category (e.g. hardcoding a value), or a
 * unit error in the timestamp conversion (treating millis as nanos/seconds).
 */
TEST_F(
    EventEmitterWrapperTest,
    dispatchEventForwardsNormalizedNameCategoryAndTimestamp) {
  EventEmitterWrapper wrapper(emitter_);
  constexpr jlong kEventTimestampMillis = 1234;

  wrapper.dispatchEvent(
      "onScroll",
      /*payload=*/nullptr,
      static_cast<int>(RawEvent::Category::Continuous),
      kEventTimestampMillis);

  EXPECT_TRUE(record_->dispatched);
  EXPECT_EQ("topScroll", record_->type);
  EXPECT_EQ(RawEvent::Category::Continuous, record_->category);
  EXPECT_FALSE(record_->isUnique);
  EXPECT_EQ(kEventTimestampMillis, millisSinceEpoch(record_->timestamp));
  // Asynchronous events must not trigger a synchronous flush.
  EXPECT_EQ(0, syncFlushCount_);
}

/*
 * `dispatchUniqueEvent` must forward through
 * `EventEmitter::dispatchUniqueEvent`, which marks the RawEvent as unique and
 * tags it as `Continuous`. Uniqueness is what lets the event queue coalesce
 * repeated events (e.g. onLayout) for the same target.
 *
 * Bug this catches: routing a unique event through the non-unique dispatch path
 * would drop the `isUnique` flag and defeat coalescing.
 */
TEST_F(EventEmitterWrapperTest, dispatchUniqueEventMarksEventUnique) {
  EventEmitterWrapper wrapper(emitter_);
  constexpr jlong kEventTimestampMillis = 5000;

  wrapper.dispatchUniqueEvent(
      "onLayout", /*payload=*/nullptr, kEventTimestampMillis);

  EXPECT_TRUE(record_->dispatched);
  EXPECT_EQ("topLayout", record_->type);
  EXPECT_TRUE(record_->isUnique);
  EXPECT_EQ(RawEvent::Category::Continuous, record_->category);
  EXPECT_EQ(kEventTimestampMillis, millisSinceEpoch(record_->timestamp));
}

/*
 * `dispatchEventSynchronously` must (a) force the `Discrete` category
 * regardless of the caller, and (b) route through
 * `EventEmitter::experimental_flushSync`, which asks the event beat for a
 * synchronous flush. This is what makes synchronous events (e.g. controlled
 * text input) observe their effects before returning to Java.
 *
 * Bug this catches: dropping the synchronous flush (making the call behave like
 * an ordinary async dispatch) or using the wrong category.
 */
TEST_F(
    EventEmitterWrapperTest,
    dispatchEventSynchronouslyUsesDiscreteCategoryAndFlushesSync) {
  EventEmitterWrapper wrapper(emitter_);

  wrapper.dispatchEventSynchronously(
      "onChange", /*params=*/nullptr, /*eventTimestamp=*/42);

  EXPECT_TRUE(record_->dispatched);
  EXPECT_EQ("topChange", record_->type);
  EXPECT_EQ(RawEvent::Category::Discrete, record_->category);
  EXPECT_EQ(1, syncFlushCount_);
}

/*
 * A wrapper can be constructed without a valid `EventEmitter` (the source
 * comments call this "marginal, but possible"). In that state every dispatch
 * method must black-hole the event: no crash, and nothing is forwarded.
 *
 * Bug this catches: removing the `eventEmitter != nullptr` guard would
 * dereference a null shared_ptr and crash instead of no-op'ing.
 */
TEST_F(EventEmitterWrapperTest, dispatchOnNullEventEmitterIsNoop) {
  EventEmitterWrapper wrapper(/*eventEmitter=*/nullptr);

  wrapper.dispatchEvent(
      "onScroll",
      /*payload=*/nullptr,
      static_cast<int>(RawEvent::Category::Discrete),
      /*eventTimestamp=*/100);
  wrapper.dispatchUniqueEvent(
      "onLayout", /*payload=*/nullptr, /*eventTimestamp=*/100);
  wrapper.dispatchEventSynchronously(
      "onChange", /*params=*/nullptr, /*eventTimestamp=*/100);

  EXPECT_FALSE(record_->dispatched);
  EXPECT_EQ(0, syncFlushCount_);
}

} // namespace facebook::react
