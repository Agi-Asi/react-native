# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

require 'json'
require 'fileutils'

# Facade podspecs for the prebuilt React Native Core path.
#
# In prebuilt mode the compiled code AND headers for the React core pods live
# entirely inside React.xcframework + React-Core-prebuilt (which flattens the
# ReactNativeHeaders namespaces into its Headers/). Re-installing the SOURCE
# podspecs in that mode is what makes them ship duplicate headers that shadow the
# prebuilt artifact (via HEADER_SEARCH_PATHS, CocoaPods .hmap header maps, and
# the all-product-headers VFS overlay) and break the React framework's clang
# explicit-module precompile.
#
# Instead we install dependency-only FACADE podspecs for those names: they ship
# no source files and no headers, so CocoaPods makes them PBXAggregateTarget
# placeholders (should_build? == false) and nothing is laid down to shadow. Each
# facade depends on React-Core-prebuilt so its consumers transitively pick up the
# prebuilt framework + headers. The pod NAMES still resolve, so ReactCodegen,
# third-party modules, and RN's own podspec graph keep resolving `React-Core`,
# `Yoga`, `React-Core/Default`, etc.
#
# MAINTENANCE MODEL: the set of facaded pods is explicit (FACADE_PODS) so the
# prebuilt rollout can be staged, but each facade's VERSION and SUBSPECS are
# DERIVED from the real podspec at `pod install` time (Pod::Specification.from_file).
# That removes the drift risk that would otherwise bite third-party libraries:
# if React adds/renames `React-Core/<Subspec>`, the facade exposes it
# automatically — nobody has to hand-maintain a parallel subspec list.
#
# This is staged: phase 1 facades a small set and KEEPS the existing
# podspec_sources / add_rncore_dependency / configure_aggregate_xcconfig /
# -fmodule-map-file machinery. The set is expanded until the cold prebuilt
# build passes; the distributed prebuilt helpers are only deleted afterwards.
module RNCoreFacades
    # pod name => podspec path (relative to the react-native package root).
    # These are the React-core pods whose code + headers are fully provided by
    # the prebuilt React.xcframework / React-Core-prebuilt. Start small; expand as
    # the cold build surfaces more shadowing pods. (NOTE: not every caller of
    # add_rncore_dependency belongs here — e.g. ReactCodegen depends on the
    # prebuilt but still builds its own generated sources, so it is NOT a facade.)
    FACADE_PODS = {
        "React-Core"       => "React-Core.podspec",
        "React-RCTFabric"  => "React/React-RCTFabric.podspec",
        "React-RCTRuntime" => "React/Runtime/React-RCTRuntime.podspec",
        "Yoga"             => "ReactCommon/yoga/Yoga.podspec",
        "RCTDeprecation"   => "ReactApple/Libraries/RCTFoundation/RCTDeprecation/RCTDeprecation.podspec",
        "FBLazyVector"     => "Libraries/FBLazyVector/FBLazyVector.podspec",
        "RCTRequired"      => "Libraries/Required/RCTRequired.podspec",
    }

    # Sub-directory (relative to the install root) that holds the generated facades.
    FACADE_RELDIR = File.join("build", "rncore-facades")

    @@install_root = nil

    # True when `name` should be installed as a facade instead of its source podspec.
    def self.facade?(name)
        FACADE_PODS.key?(name)
    end

    # Generates the facade podspecs and returns the base directory holding them.
    # Each facade gets its OWN sub-directory containing a single
    # `<Name>.podspec.json`, so it can be installed as a LOCAL pod via
    # `:path => <dir>`. `:path` (PathSource) uses the spec in place and never
    # downloads `spec.source` — unlike `:podspec` (PodspecSource), which is an
    # *external* source whose `root_spec.source` CocoaPods would actually fetch
    # (i.e. git-clone react-native for every empty facade). Idempotent; safe to
    # call once per `pod install`.
    #
    # `react_native_path` locates the real podspecs we mirror. version + subspecs +
    # default_subspecs + resources are all DERIVED from the real spec so the facade
    # stays graph- and resource-equivalent to the source pod. A facaded pod whose
    # real podspec can't be read is a hard error (see load_real_spec) — silently
    # shipping an empty facade would hide exactly the drift this guards against.
    def self.generate(react_native_path, install_root, version, ios_version)
        @@install_root = install_root.to_s
        abs_base = File.join(@@install_root, FACADE_RELDIR)
        FileUtils.mkdir_p(abs_base)
        FACADE_PODS.each do |name, podspec_rel_path|
            podspec_path = File.join(react_native_path.to_s, podspec_rel_path)
            real = load_real_spec(podspec_path, name)
            podspec_dir = File.dirname(podspec_path)
            dir = File.join(abs_base, name)
            FileUtils.mkdir_p(dir)

            spec = {
                "name" => name,
                "version" => real.version.to_s,
                "summary" => "Prebuilt facade for #{name} (code + headers live in React-Core-prebuilt).",
                "homepage" => "https://reactnative.dev/",
                "license" => "MIT",
                "authors" => "Meta Platforms, Inc. and its affiliates",
                "platforms" => { "ios" => ios_version },
                # Required podspec attribute, but never fetched: the pod is installed
                # as a LOCAL pod (`:path => <dir>`), which uses this spec in place and
                # ships no source_files. Placeholder only.
                "source" => { "git" => "https://github.com/facebook/react-native.git" },
                "dependencies" => { "React-Core-prebuilt" => [] },
            }

            # Preserve non-code RESOURCES (privacy manifest, i18n bundles, ...). They
            # don't shadow headers, and React-Core-prebuilt doesn't vend them, so the
            # facade must carry them or prebuilt installs lose them. Globs are made
            # relative to the facade dir so they resolve back to the real source tree.
            resource_bundles = derive_resource_bundles(real, podspec_dir, dir)
            spec["resource_bundles"] = resource_bundles unless resource_bundles.empty?
            resources = derive_resources(real, podspec_dir, dir)
            spec["resources"] = resources unless resources.empty?

            # Preserve default_subspec so a bare `pod '<Name>'` resolves to the SAME
            # subspec graph as the source pod (without it CocoaPods pulls every
            # subspec, which is not graph-equivalent).
            defaults = Array(real.default_subspecs)
            spec["default_subspecs"] = defaults unless defaults.empty?

            subspecs = derive_subspecs(real)
            unless subspecs.empty?
                spec["subspecs"] = subspecs.map do |ss|
                    { "name" => ss, "dependencies" => { "React-Core-prebuilt" => [] } }
                end
            end

            File.write(File.join(dir, "#{name}.podspec.json"), JSON.pretty_generate(spec))
        end
        abs_base
    end

    # Facade dir for `<name>`, RELATIVE to the install root — pass to `pod :path =>`.
    # Relative (not absolute) so the path CocoaPods records in Podfile.lock is
    # portable rather than machine-specific.
    def self.facade_path(name)
        File.join(FACADE_RELDIR, name)
    end

    # Loads the real podspec so we can mirror its structure. A facaded pod MUST have
    # a readable real podspec — if it's missing or unparseable we raise rather than
    # ship an empty facade, since that would silently drop subspecs/resources (the
    # very drift this mechanism exists to prevent).
    def self.load_real_spec(path, name)
        unless File.exist?(path)
            raise "[RNCoreFacades] Real podspec for facaded pod '#{name}' not found at #{path}. " \
                  "Update FACADE_PODS in rncore_facades.rb if the podspec moved."
        end
        Pod::Specification.from_file(path)
    rescue => e
        raise "[RNCoreFacades] Failed to read real podspec for facaded pod '#{name}' at #{path}: #{e.message}"
    end
    private_class_method :load_real_spec

    # Library (non-test, non-app) subspec names of the real spec, so third-party
    # libs depending on `<pod>/<subspec>` keep resolving. Derived, never hand-listed.
    def self.derive_subspecs(real)
        real.subspecs
            .reject { |ss| ss.test_specification? || (ss.respond_to?(:app_specification?) && ss.app_specification?) }
            .map(&:base_name)
    end
    private_class_method :derive_subspecs

    # Effective resource_bundles of the real spec (e.g. React-Core_privacy), with
    # globs rewritten relative to the facade dir so they point back at the real
    # source files. Unions the `resource_bundle` (singular) and `resource_bundles`
    # (plural) DSL forms.
    def self.derive_resource_bundles(real, podspec_dir, facade_dir)
        out = {}
        [real.attributes_hash["resource_bundle"], real.attributes_hash["resource_bundles"]].each do |rb|
            next unless rb.is_a?(Hash)
            rb.each do |bundle, globs|
                out[bundle] = Array(globs).map { |g| rel_glob(g, podspec_dir, facade_dir) }
            end
        end
        out
    end
    private_class_method :derive_resource_bundles

    # Loose `resources` of the real spec, rewritten relative to the facade dir.
    def self.derive_resources(real, podspec_dir, facade_dir)
        Array(real.attributes_hash["resources"]).map { |g| rel_glob(g, podspec_dir, facade_dir) }
    end
    private_class_method :derive_resources

    # Rewrite a glob declared relative to `podspec_dir` into one relative to
    # `facade_dir`, so the generated facade (which lives under the app's build/)
    # still resolves the resource in the react-native source tree.
    def self.rel_glob(glob, podspec_dir, facade_dir)
        require "pathname"
        abs = File.expand_path(glob, podspec_dir)
        Pathname.new(abs).relative_path_from(Pathname.new(facade_dir)).to_s
    end
    private_class_method :rel_glob
end
