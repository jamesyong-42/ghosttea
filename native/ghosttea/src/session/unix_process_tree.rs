//! Identity-safe ownership of a PTY process tree on Unix.
//!
//! Job-control process groups are not a lifetime boundary: a shell can put
//! background work in another group, and every numeric PID/PGID is eventually
//! reused.  Capture the root's birth identity once, retain the identities of
//! every process subsequently proven to belong to it, and revalidate those
//! identities before every signal.

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    pid: i32,
    parent_pid: i32,
    process_group_id: i32,
    session_id: i32,
    started_at: u64,
}

fn same_process(left: &ProcessIdentity, right: &ProcessIdentity) -> bool {
    // Parent, group and session can all change while a process lives.  PID plus
    // birth time is the stable identity available on both supported Unixes.
    left.pid == right.pid && left.started_at == right.started_at
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_process_identity(pid: i32, stat: &str) -> Option<ProcessIdentity> {
    // `comm` may contain spaces and parentheses. Everything after its final
    // ')' starts at field 3 (state); ppid/pgrp/session are fields 4/5/6 and
    // process start ticks are field 22.
    let fields = stat
        .get(stat.rfind(')')? + 1..)?
        .split_whitespace()
        .collect::<Vec<_>>();
    Some(ProcessIdentity {
        pid,
        parent_pid: fields.get(1)?.parse().ok()?,
        process_group_id: fields.get(2)?.parse().ok()?,
        session_id: fields.get(3)?.parse().ok()?,
        started_at: fields.get(19)?.parse().ok()?,
    })
}

#[cfg(target_os = "linux")]
fn unix_process_identity(pid: i32) -> Option<ProcessIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    linux_process_identity(pid, &stat)
}

#[cfg(target_os = "linux")]
fn unix_process_snapshot() -> Vec<ProcessIdentity> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<i32>().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            linux_process_identity(pid, &stat)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn mac_process_identity(pid: i32) -> Option<ProcessIdentity> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if read != expected {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(ProcessIdentity {
        pid,
        parent_pid: i32::try_from(info.pbi_ppid).ok()?,
        process_group_id: i32::try_from(info.pbi_pgid).ok()?,
        // Filled by `unix_process_identity`, bracketed by birth-identity reads
        // so a PID replacement cannot donate its session identifier.
        session_id: 0,
        started_at: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(target_os = "macos")]
fn unix_process_identity(pid: i32) -> Option<ProcessIdentity> {
    let before = mac_process_identity(pid)?;
    let session_id = unsafe { libc::getsid(pid) };
    if session_id <= 0 {
        return None;
    }
    let after = mac_process_identity(pid)?;
    if !same_process(&before, &after) {
        return None;
    }
    let confirmed_session_id = unsafe { libc::getsid(pid) };
    if confirmed_session_id != session_id {
        return None;
    }
    Some(ProcessIdentity {
        session_id,
        ..after
    })
}

#[cfg(target_os = "macos")]
fn unix_process_snapshot() -> Vec<ProcessIdentity> {
    let requested = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if requested <= 0 {
        return Vec::new();
    }
    let mut pids = vec![0_i32; requested as usize + 64];
    let bytes = pids
        .len()
        .saturating_mul(std::mem::size_of::<i32>())
        .min(i32::MAX as usize) as i32;
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if count <= 0 {
        return Vec::new();
    }
    pids.truncate((count as usize).min(pids.len()));
    pids.into_iter()
        .filter(|pid| *pid > 1)
        .filter_map(unix_process_identity)
        .collect()
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unix_process_identity(_pid: i32) -> Option<ProcessIdentity> {
    None
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unix_process_snapshot() -> Vec<ProcessIdentity> {
    Vec::new()
}

/// Select the current members that are provably connected to `known`.
///
/// The terminal session is a useful transitive container only while one of
/// our original identities still anchors it. Once the last such member leaves,
/// its numeric SID may be reused and cannot prove ownership by itself.
fn select_targets(
    root: ProcessIdentity,
    isolated_session_id: Option<i32>,
    known: &HashMap<i32, ProcessIdentity>,
    snapshot: &[ProcessIdentity],
) -> Vec<ProcessIdentity> {
    let by_pid = snapshot
        .iter()
        .map(|process| (process.pid, *process))
        .collect::<HashMap<_, _>>();
    let mut selected = known
        .values()
        .filter_map(|known_process| {
            by_pid
                .get(&known_process.pid)
                .copied()
                .filter(|current| same_process(current, known_process))
        })
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();

    if let Some(session_id) = isolated_session_id.filter(|session_id| {
        selected
            .values()
            .any(|process| process.session_id == *session_id)
    }) {
        for process in snapshot {
            // The root's numeric PID is never allowed to acquire a new birth
            // identity. That is the identity from which all ownership flows.
            if process.session_id == session_id
                && (process.pid != root.pid || same_process(process, &root))
            {
                selected.insert(process.pid, *process);
            }
        }
    }

    // A known process may have been reparented out of the original shell's
    // topology. Seed from every verified survivor so work it subsequently
    // forks is still collected at the next ladder rung.
    loop {
        let mut changed = false;
        for process in snapshot {
            if selected.contains_key(&process.pid) || !selected.contains_key(&process.parent_pid) {
                continue;
            }
            if process.pid == root.pid && !same_process(process, &root) {
                continue;
            }
            selected.insert(process.pid, *process);
            changed = true;
        }
        if !changed {
            break;
        }
    }
    selected.into_values().collect()
}

fn signal_group(process_group_id: i32, signal: libc::c_int) -> std::io::Result<()> {
    if process_group_id <= 1 {
        return Ok(());
    }
    if unsafe { libc::kill(-process_group_id, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

fn current_identity(identity: &ProcessIdentity) -> Option<ProcessIdentity> {
    unix_process_identity(identity.pid).filter(|current| same_process(current, identity))
}

fn group_is_safely_isolated(process: &ProcessIdentity, isolated_session_id: Option<i32>) -> bool {
    // A process group is safe to address only when its whole POSIX session is
    // known to be detached from the daemon, or when this verified process is
    // itself the leader of a newly isolated session and group. Otherwise an
    // early spawn observation could still share the daemon's process group.
    isolated_session_id == Some(process.session_id)
        || (process.pid > 1
            && process.session_id == process.pid
            && process.process_group_id == process.pid)
}

#[derive(Clone, Debug)]
pub(crate) struct ProcessTree {
    root: ProcessIdentity,
    isolated_session_id: Option<i32>,
    known: HashMap<i32, ProcessIdentity>,
}

impl ProcessTree {
    /// Pin the root before it can be reaped and its numeric PID reused.
    pub(crate) fn capture(pid: u32) -> Option<Self> {
        let pid = i32::try_from(pid).ok()?;
        let root = unix_process_identity(pid)?;
        let isolated_session_id =
            (root.session_id == root.pid && root.session_id > 1).then_some(root.session_id);
        Some(Self {
            root,
            isolated_session_id,
            known: HashMap::from([(root.pid, root)]),
        })
    }

    /// Refresh identities before the interrupt so later rungs retain children
    /// even if the root exits and they are reparented in the meantime.
    pub(crate) fn refresh(&mut self) {
        let snapshot = unix_process_snapshot();
        for process in select_targets(self.root, self.isolated_session_id, &self.known, &snapshot) {
            self.known.insert(process.pid, process);
        }
    }

    pub(crate) fn has_live_members(&mut self) -> bool {
        // A verified survivor may have forked since the previous ladder rung.
        // Refresh before every liveness decision so reparented branches remain
        // discovery roots for as long as any original identity survives.
        self.refresh();
        self.known
            .values()
            .any(|process| current_identity(process).is_some())
    }

    pub(crate) fn wait_for_exit(&mut self, deadline: Instant) -> bool {
        loop {
            if !self.has_live_members() {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            std::thread::sleep(
                deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_millis(50)),
            );
        }
    }

    pub(crate) fn signal(&mut self, signal: libc::c_int, step: &str, session_id: &str) {
        self.refresh();
        let targets = self
            .known
            .values()
            .filter_map(current_identity)
            .collect::<Vec<_>>();

        let process_groups = targets
            .iter()
            .filter(|process| group_is_safely_isolated(process, self.isolated_session_id))
            .map(|process| process.process_group_id)
            .filter(|process_group_id| *process_group_id > 1)
            .collect::<HashSet<_>>();
        for process_group_id in process_groups {
            // Re-check immediately before addressing the group. A cached PGID
            // with no verified member is merely a number another job may own.
            let still_owned = targets.iter().any(|process| {
                current_identity(process).is_some_and(|current| {
                    current.process_group_id == process_group_id
                        && group_is_safely_isolated(&current, self.isolated_session_id)
                })
            });
            if !still_owned {
                continue;
            }
            if let Err(error) = signal_group(process_group_id, signal) {
                eprintln!(
                    "[ghosttea] failed to {step} process group {process_group_id} for {session_id}: {error}"
                );
            }
        }

        for process in targets {
            if current_identity(&process).is_none() {
                continue;
            }
            if unsafe { libc::kill(process.pid, signal) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    eprintln!(
                        "[ghosttea] failed to {step} descendant {} for {session_id}: {error}",
                        process.pid
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: i32, parent_pid: i32, group: i32, session: i32, start: u64) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            parent_pid,
            process_group_id: group,
            session_id: session,
            started_at: start,
        }
    }

    #[test]
    fn identity_survives_reparenting_but_rejects_pid_reuse() {
        let observed = process(42, 10, 42, 42, 1_000);
        assert!(same_process(&observed, &process(42, 1, 99, 99, 1_000)));
        assert!(!same_process(&observed, &process(42, 1, 42, 42, 1_001)));
    }

    #[test]
    fn only_detached_sessions_authorize_group_signals() {
        let daemon_group_child = process(100, 50, 50, 50, 1_000);
        assert!(!group_is_safely_isolated(&daemon_group_child, None));

        let terminal_group_child = process(101, 100, 101, 100, 1_001);
        assert!(group_is_safely_isolated(&terminal_group_child, Some(100)));

        let escaped_session_leader = process(102, 1, 102, 102, 1_002);
        assert!(group_is_safely_isolated(&escaped_session_leader, None));
    }

    #[test]
    fn parses_linux_identity_after_a_parenthesized_command_name() {
        let identity = linux_process_identity(
            123,
            "123 (worker (nested)) S 42 41 40 0 -1 4194304 10 0 0 0 1 2 0 0 20 0 1 0 987654 4096",
        )
        .unwrap();
        assert_eq!(identity, process(123, 42, 41, 40, 987654));
    }

    #[test]
    fn a_reused_root_cannot_adopt_an_unrelated_tree() {
        let root = process(100, 1, 100, 100, 1_000);
        let orphan = process(101, 1, 101, 101, 1_001);
        let known = HashMap::from([(root.pid, root), (orphan.pid, orphan)]);
        let replacement = process(100, 1, 100, 100, 2_000);
        let unrelated_child = process(102, 100, 100, 100, 2_001);

        let targets = select_targets(
            root,
            Some(100),
            &known,
            &[replacement, unrelated_child, orphan],
        );

        assert_eq!(targets, vec![orphan]);
    }

    #[test]
    fn verified_reparented_members_seed_later_descendants() {
        let root = process(100, 1, 100, 100, 1_000);
        let orphan = process(101, 1, 101, 101, 1_001);
        let child = process(102, 101, 102, 102, 1_002);
        let known = HashMap::from([(root.pid, root), (orphan.pid, orphan)]);

        let targets = select_targets(root, Some(100), &known, &[orphan, child]);
        let target_ids = targets
            .into_iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();

        assert_eq!(target_ids, HashSet::from([101, 102]));
    }

    #[test]
    fn an_unanchored_numeric_session_is_not_ownership_evidence() {
        let root = process(100, 1, 100, 100, 1_000);
        let known = HashMap::from([(root.pid, root)]);
        let replacement = process(100, 1, 100, 100, 2_000);
        let unrelated_child = process(102, 100, 100, 100, 2_001);

        assert!(
            select_targets(root, Some(100), &known, &[replacement, unrelated_child]).is_empty()
        );
    }
}
