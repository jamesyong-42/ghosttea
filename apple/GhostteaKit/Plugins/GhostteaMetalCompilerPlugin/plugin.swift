import Foundation
import PackagePlugin

@main
struct GhostteaMetalCompilerPlugin: BuildToolPlugin {
  func createBuildCommands(
    context: PluginContext,
    target: any Target
  ) async throws -> [Command] {
    let source = target.directoryURL.appending(path: "GhostteaTerminal.metal")
    guard FileManager.default.fileExists(atPath: source.path) else { return [] }

    let library = context.pluginWorkDirectoryURL.appending(path: "GhostteaTerminal.metallib")
    let moduleCache = context.pluginWorkDirectoryURL.appending(path: "ModuleCache")
    let xcrun = URL(filePath: "/usr/bin/xcrun")

    return [
      .buildCommand(
        displayName: "Compile Ghosttea Metal shaders",
        executable: xcrun,
        arguments: [
          "metal", source.path, "-o", library.path,
          "-fmodules-cache-path=\(moduleCache.path)",
        ],
        inputFiles: [source],
        outputFiles: [library]
      )
    ]
  }
}
