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

    let intermediate = context.pluginWorkDirectoryURL.appending(path: "GhostteaTerminal.air")
    let library = context.pluginWorkDirectoryURL.appending(path: "GhostteaTerminal.metallib")
    let xcrun = URL(filePath: "/usr/bin/xcrun")

    return [
      .buildCommand(
        displayName: "Compile Ghosttea Metal shaders",
        executable: xcrun,
        arguments: ["metal", "-c", source.path, "-o", intermediate.path],
        inputFiles: [source],
        outputFiles: [intermediate]
      ),
      .buildCommand(
        displayName: "Link Ghosttea Metal library",
        executable: xcrun,
        arguments: ["metallib", intermediate.path, "-o", library.path],
        inputFiles: [intermediate],
        outputFiles: [library]
      ),
    ]
  }
}
