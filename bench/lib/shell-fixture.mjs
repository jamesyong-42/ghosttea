/**
 * Platform-appropriate session fixtures.
 *
 * The integration harnesses drive a real shell, so the command that prints a
 * marker, and the environment able to run it, differ by platform. Everything
 * a harness needs to say "run this trivial thing and exit" lives here so the
 * tests express intent rather than a POSIX command line.
 */
const windows = process.platform === "win32";

/** The interactive shell this platform runs by default. */
export const shellExecutable = windows ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh";

/**
 * Arguments that print `text` on its own line and exit 0, staying alive long
 * enough for a client to attach first.
 *
 * A marker is only observable by a caller that attached a view before the
 * session left the registry, and `printf` returns immediately, so the POSIX
 * form waits briefly on the way out. Windows needs no equivalent: a session
 * ends when its pseudoconsole closes, which `Session::start_exit_watcher`
 * does a drain interval after the child exits.
 *
 * `/d` skips the AutoRun registry command so an unrelated profile cannot add
 * output the harness would then have to tolerate.
 */
export function printAndExitArgs(text) {
  return windows ? ["/d", "/c", `echo ${text}`] : ["-c", `printf '${text}\\n'; sleep 0.08`];
}

/**
 * A clean-mode environment able to run this platform's shell.
 *
 * Clean mode replaces the environment outright, so the shell only gets what is
 * named here. Windows needs `SystemRoot`: without it the loader cannot resolve
 * parts of the system directory and `cmd.exe` fails to start.
 */
export function cleanEnvironment(extra = {}) {
  if (windows) {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return {
      mode: "clean",
      variables: {
        SystemRoot: root,
        PATH: `${root}\\System32;${root}`,
        TERM: "xterm-256color",
        ...extra,
      },
    };
  }
  return {
    mode: "clean",
    variables: {
      PATH: "/usr/bin:/bin",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TERM: "xterm-256color",
      ...extra,
    },
  };
}
