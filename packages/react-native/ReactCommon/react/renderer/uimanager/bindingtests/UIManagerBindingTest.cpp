/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <memory>
#include <span>
#include <string>

#include <gtest/gtest.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <react/renderer/bridging/bridging.h>
#include <react/renderer/core/ReactEventPriority.h>
#include <react/renderer/core/ValueFactoryEventPayload.h>
#include <react/renderer/element/Element.h>
#include <react/renderer/element/testUtils.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/uimanager/UIManagerBinding.h>
#include <react/renderer/uimanager/primitives.h>
#include <react/timing/primitives.h>

namespace facebook::react {

class UIManagerBindingTest : public ::testing::Test {
 public:
  UIManagerBindingTest() {
    runtime_ = facebook::hermes::makeHermesRuntime();
    contextContainer_ = std::make_shared<ContextContainer>();

    // The component-descriptor registry requires an EventDispatcher, but these
    // tests never emit native->JS events through shadow-node EventEmitters,
    // which is the only path that dereferences it. A null dispatcher is
    // therefore safe here and matches the established UIManager test harnesses
    // (FindShadowNodeByTagTest, FabricUIManagerTest, ShadowNodeFamilyTest).
    ComponentDescriptorProviderRegistry componentDescriptorProviderRegistry{};
    auto componentDescriptorRegistry =
        componentDescriptorProviderRegistry.createComponentDescriptorRegistry(
            ComponentDescriptorParameters{
                .eventDispatcher = EventDispatcher::Shared{},
                .contextContainer = contextContainer_,
                .flavor = nullptr});

    componentDescriptorProviderRegistry.add(
        concreteComponentDescriptorProvider<RootComponentDescriptor>());
    componentDescriptorProviderRegistry.add(
        concreteComponentDescriptorProvider<ViewComponentDescriptor>());

    builder_ = std::make_unique<ComponentBuilder>(componentDescriptorRegistry);

    // No-op executor: these tests never rely on the UIManager scheduling work
    // back onto a JS runtime thread, so the callback is intentionally dropped
    // to keep the tests synchronous and hermetic (matching the sibling
    // UIManager test fixtures).
    RuntimeExecutor runtimeExecutor =
        [](std::function<void(
               facebook::jsi::Runtime & runtime)>&& /*callback*/) {};
    uiManager_ =
        std::make_shared<UIManager>(runtimeExecutor, contextContainer_);
    uiManager_->setComponentDescriptorRegistry(componentDescriptorRegistry);

    buildAndCommitTree();
  }

  void TearDown() override {
    uiManager_->stopSurface(surfaceId_);
  }

 protected:
  std::shared_ptr<RootShadowNode> buildTree() {
    std::shared_ptr<RootShadowNode> rootNode;

    // clang-format off
    auto element =
        Element<RootShadowNode>()
          .tag(1)
          .surfaceId(surfaceId_)
          .reference(rootNode)
          .props([] {
            auto sharedProps = std::make_shared<RootProps>();
            sharedProps->layoutConstraints = LayoutConstraints{
                .minimumSize = {.width = 0, .height = 0},
                .maximumSize = {.width = 500, .height = 500}};
            return sharedProps;
          })
          .children({
            Element<ViewShadowNode>()
              .tag(viewTag_)
              .surfaceId(surfaceId_)
              .props([] {
                return std::make_shared<ViewShadowNodeProps>();
              })
          });
    // clang-format on

    builder_->build(element);
    return rootNode;
  }

  void buildAndCommitTree() {
    auto rootNode = buildTree();

    auto shadowTree = std::make_unique<ShadowTree>(
        surfaceId_,
        LayoutConstraints{},
        LayoutContext{},
        *uiManager_,
        *contextContainer_);

    shadowTree->commit(
        [&rootNode](const RootShadowNode& /*oldRootShadowNode*/) {
          return std::static_pointer_cast<RootShadowNode>(rootNode);
        },
        {true});

    uiManager_->startSurface(
        std::move(shadowTree),
        "test",
        folly::dynamic::object,
        DisplayMode::Visible);
  }

  UIManagerBinding& installBinding() {
    UIManagerBinding::createAndInstallIfNeeded(*runtime_, uiManager_);
    return *UIManagerBinding::getBinding(*runtime_);
  }

  jsi::Function getMethod(UIManagerBinding& binding, const char* name) {
    return binding.get(*runtime_, jsi::PropNameID::forAscii(*runtime_, name))
        .asObject(*runtime_)
        .asFunction(*runtime_);
  }

  std::shared_ptr<const ShadowNode> currentViewNode() const {
    auto revision =
        uiManager_->getShadowTreeRevisionProvider()->getCurrentRevision(
            surfaceId_);
    return revision->getChildren().front();
  }

  SurfaceId surfaceId_{0};
  Tag viewTag_{42};
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime_;
  std::shared_ptr<ContextContainer> contextContainer_;
  std::unique_ptr<ComponentBuilder> builder_;
  std::shared_ptr<UIManager> uiManager_;
};

// `createAndInstallIfNeeded` must publish the binding into the runtime's
// global namespace such that `getBinding` recovers the very same
// `UIManagerBinding` wrapping the `UIManager` we installed. Before install,
// the lookup must return nullptr.
TEST_F(UIManagerBindingTest, getBindingRecoversInstalledBinding) {
  EXPECT_EQ(UIManagerBinding::getBinding(*runtime_), nullptr);

  UIManagerBinding::createAndInstallIfNeeded(*runtime_, uiManager_);

  auto binding = UIManagerBinding::getBinding(*runtime_);
  ASSERT_NE(binding, nullptr);
  EXPECT_EQ(&binding->getUIManager(), uiManager_.get());
}

// Host functions returned by `get` validate their argument count and must
// raise a `jsi::JSError` when called with fewer arguments than required.
// `appendChild` requires two arguments; calling it with one must throw.
TEST_F(UIManagerBindingTest, hostFunctionThrowsWhenMissingArguments) {
  auto& binding = installBinding();
  auto appendChild = getMethod(binding, "appendChild");

  auto onlyArgument = valueFromShadowNode(*runtime_, currentViewNode());
  EXPECT_THROW(
      appendChild.call(*runtime_, std::move(onlyArgument)), jsi::JSError);
}

// The `findShadowNodeByTag_DEPRECATED` host function must route through the
// UIManager and marshal the result across JSI: an existing tag yields a
// ShadowNode reference (recoverable via Bridging with the same tag), while a
// missing tag yields JS `null`.
TEST_F(UIManagerBindingTest, findShadowNodeByTagBridgesResult) {
  auto& binding = installBinding();
  auto findByTag = getMethod(binding, "findShadowNodeByTag_DEPRECATED");

  auto found =
      findByTag.call(*runtime_, jsi::Value{static_cast<double>(viewTag_)});
  ASSERT_TRUE(found.isObject());
  auto recovered =
      Bridging<std::shared_ptr<const ShadowNode>>::fromJs(*runtime_, found);
  ASSERT_NE(recovered, nullptr);
  EXPECT_EQ(recovered->getTag(), viewTag_);

  auto missing = findByTag.call(*runtime_, jsi::Value{9999.0});
  EXPECT_TRUE(missing.isNull());
}

// A non-pointer event dispatched through `dispatchEvent` must reach the
// registered JS handler with the event type, the factory-produced payload, and
// a `timeStamp` property injected from the supplied event timestamp.
TEST_F(UIManagerBindingTest, dispatchEventForwardsTypePayloadAndTimestamp) {
  auto& binding = installBinding();

  struct Captured {
    bool called{false};
    std::string type;
    double foo{0};
    double timeStamp{-1};
  };
  auto captured = std::make_shared<Captured>();

  auto handler = jsi::Function::createFromHostFunction(
      *runtime_,
      jsi::PropNameID::forAscii(*runtime_, "handler"),
      3,
      [captured](
          jsi::Runtime& rt,
          const jsi::Value& /*thisValue*/,
          const jsi::Value* args,
          size_t count) -> jsi::Value {
        auto arguments = std::span<const jsi::Value>(args, count);
        captured->called = true;
        captured->type = arguments[1].getString(rt).utf8(rt);
        auto payload = arguments[2].getObject(rt);
        captured->foo = payload.getProperty(rt, "foo").getNumber();
        captured->timeStamp = payload.getProperty(rt, "timeStamp").getNumber();
        return jsi::Value::undefined();
      });

  getMethod(binding, "registerEventHandler")
      .call(*runtime_, std::move(handler));

  ValueFactory factory = [](jsi::Runtime& rt) {
    auto payload = jsi::Object(rt);
    payload.setProperty(rt, "foo", 42);
    return jsi::Value(rt, payload);
  };
  auto eventPayload = ValueFactoryEventPayload(std::move(factory));

  auto timestamp = HighResTimeStamp::fromDOMHighResTimeStamp(1234.0);
  binding.dispatchEvent(
      *runtime_,
      /*eventTarget=*/nullptr,
      "topMyEvent",
      ReactEventPriority::Discrete,
      eventPayload,
      timestamp);

  ASSERT_TRUE(captured->called);
  EXPECT_EQ(captured->type, "topMyEvent");
  EXPECT_EQ(captured->foo, 42);
  EXPECT_DOUBLE_EQ(captured->timeStamp, 1234.0);
}

} // namespace facebook::react
