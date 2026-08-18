//! Own a session's whole process tree on Windows.
//!
//! `Child::kill` ends only the process the PTY spawned. A shell that started a
//! build, or any program that outlives its parent, keeps running and keeps the
//! PTY's write handle open. Unix reaches the whole tree by signalling the
//! process group; Windows has no equivalent for a console application, so this
//! assigns the spawned process to a job object and terminates the job instead.
//!
//! The job also carries `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a daemon that
//! crashes cannot leave a session's tree behind: the kernel reaps it when the
//! last job handle closes.

use std::{io, time::Duration};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DuplicateHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, WaitForSingleObject,
        },
    },
};

/// A handle that becomes signalled when a process exits.
///
/// Owning a duplicate lets a session wait for its child without touching the
/// PTY's own handle, so waiting never contends with terminating.
pub struct ExitHandle(HANDLE);

// SAFETY: a duplicated process handle has no thread affinity and this value
// owns it exclusively.
unsafe impl Send for ExitHandle {}

impl ExitHandle {
    /// Duplicate a process handle for waiting only.
    pub fn duplicate(process: HANDLE) -> io::Result<Self> {
        let mut copy = 0;
        // SAFETY: both process arguments are the current-process pseudo-handle,
        // which needs no release, and `copy` is a valid out-pointer.
        let duplicated = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process,
                GetCurrentProcess(),
                &mut copy,
                PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        };
        if duplicated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(copy))
    }

    /// Whether the process has exited, waiting up to `timeout` for it.
    pub fn exited(&self, timeout: Duration) -> bool {
        let milliseconds = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: `self.0` is live until this value drops.
        unsafe { WaitForSingleObject(self.0, milliseconds) == WAIT_OBJECT_0 }
    }
}

impl Drop for ExitHandle {
    fn drop(&mut self) {
        // SAFETY: owned here and closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

/// A job object holding one session's process tree.
pub struct ProcessTree {
    job: HANDLE,
}

// SAFETY: a job handle is a kernel handle with no thread affinity, and this
// value owns it exclusively.
unsafe impl Send for ProcessTree {}
unsafe impl Sync for ProcessTree {}

impl ProcessTree {
    /// Put an already-spawned process, and everything it goes on to start, into
    /// a new job.
    ///
    /// `portable-pty` spawns the process itself, so the assignment happens just
    /// after creation rather than before the first instruction. Descendants
    /// created after the assignment join the job automatically, but any started
    /// inside that window would not — and a session like `cmd /c build.bat`
    /// starts its real work immediately. Those are collected explicitly once
    /// the root is in the job, which closes the window: by then every new
    /// descendant is inherited.
    pub fn adopt(pid: u32) -> io::Result<Self> {
        // SAFETY: a null name creates an unnamed job; a null descriptor takes
        // the default, which is private to this process.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job == 0 {
            return Err(io::Error::last_os_error());
        }
        let tree = Self { job };

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` matches the class being set and outlives the call.
        let configured = unsafe {
            SetInformationJobObject(
                tree.job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }

        tree.assign(pid)?;
        // Only now is every future descendant inherited, so sweep up the ones
        // that already exist. A process that exits mid-sweep simply fails to
        // open, which is not an error worth failing the session over.
        for descendant in descendants_of(pid) {
            let _ = tree.assign(descendant);
        }
        Ok(tree)
    }

    fn assign(&self, pid: u32) -> io::Result<()> {
        // SAFETY: opening by identifier; the handle is closed below in all paths.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both handles are live and owned here.
        let assigned = unsafe { AssignProcessToJobObject(self.job, process) };
        let error = io::Error::last_os_error();
        // SAFETY: `process` was opened above and is closed exactly once.
        unsafe { CloseHandle(process) };
        if assigned == 0 {
            return Err(error);
        }
        Ok(())
    }

    /// Terminate every process still in the job.
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: `self.job` is live until this value drops.
        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// When a process was created, as a comparable tick count.
///
/// `None` for a process that cannot be opened or has already exited, which
/// makes an unverifiable candidate fail the parentage check below.
fn created_at(pid: u32) -> Option<u64> {
    // SAFETY: opening by identifier; the handle is closed on every path.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process == 0 {
        return None;
    }
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut ignored: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: all four out-parameters are valid for the duration of the call.
    let ok = unsafe {
        GetProcessTimes(
            process,
            &mut created,
            &mut ignored,
            &mut ignored,
            &mut ignored,
        )
    };
    // SAFETY: `process` was opened above and is closed exactly once.
    unsafe { CloseHandle(process) };
    if ok == 0 {
        return None;
    }
    Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// Every live descendant of `root`.
///
/// Windows keeps no descendant list, so this walks one process snapshot. A
/// recorded parent identifier is not cleared when that parent exits, and
/// Windows reuses identifiers, so an unrelated process can name a recycled
/// identifier as its parent. An entry therefore only counts as a child when it
/// was created after the parent it names.
fn descendants_of(root: u32) -> Vec<u32> {
    let mut entries: Vec<(u32, u32)> = Vec::new();
    // SAFETY: a process snapshot needs no target process; the handle is closed
    // before returning.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `entry` is sized as the API requires and lives across the walk.
    let mut valid = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while valid {
        entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: as above; iteration ends when this returns zero.
        valid = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: `snapshot` is owned here and closed exactly once.
    unsafe { CloseHandle(snapshot) };

    let mut found = Vec::new();
    let mut frontier = match created_at(root) {
        Some(created) => vec![(root, created)],
        None => return found,
    };
    while let Some((parent, parent_created)) = frontier.pop() {
        for (pid, parent_pid) in &entries {
            if *parent_pid != parent || *pid == parent || found.contains(pid) {
                continue;
            }
            // A child cannot predate its parent; anything that does is naming a
            // reused identifier rather than this tree.
            let Some(created) = created_at(*pid).filter(|it| *it >= parent_created) else {
                continue;
            };
            found.push(*pid);
            frontier.push((*pid, created));
        }
    }
    found
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // Closing the last handle kills whatever is left, by the limit set in
        // `adopt`. A session that already exited leaves an empty job.
        // SAFETY: `self.job` is owned here and closed exactly once.
        unsafe { CloseHandle(self.job) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Child as StdChild, Command},
        thread::sleep,
        time::{Duration, Instant},
    };

    fn powershell(script: &str) -> String {
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .expect("powershell runs");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// Reaps the shell however the test exits, including through a failed
    /// assertion.
    struct Spawned(StdChild);

    impl Spawned {
        fn id(&self) -> u32 {
            self.0.id()
        }
    }

    impl Drop for Spawned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// `cmd /c ping` runs ping as a child, so the spawned process has a
    /// grandchild that outlives a kill aimed only at the direct child. `pause`
    /// cannot be used here: it returns immediately when stdin is not a console.
    fn spawn_with_grandchild() -> (Spawned, u32) {
        let parent = Spawned(
            Command::new("cmd.exe")
                .args(["/c", "ping", "-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("spawn parent"),
        );

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let found = powershell(&format!(
                "(Get-CimInstance Win32_Process -Filter 'ParentProcessId={}').ProcessId",
                parent.id()
            ));
            if let Some(pid) = found
                .lines()
                .next()
                .and_then(|line| line.trim().parse().ok())
            {
                return (parent, pid);
            }
            // Each poll starts a PowerShell process, so keep them sparse.
            sleep(Duration::from_millis(300));
        }
        panic!("grandchild never appeared");
    }

    /// Hold a waitable handle to this exact process object. Checking only its
    /// numeric identifier is racy on a busy runner: Windows can reuse the PID
    /// after the process exits, making an unrelated process look like a leak.
    fn exit_handle(pid: u32) -> ExitHandle {
        // SAFETY: opening a process created by this test for synchronization;
        // `ExitHandle` owns and closes the returned handle.
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert_ne!(
            process,
            0,
            "open process {pid} for waiting: {}",
            io::Error::last_os_error()
        );
        ExitHandle(process)
    }

    fn assert_running(process: &ExitHandle, pid: u32, what: &str) {
        assert!(
            !process.exited(Duration::ZERO),
            "{what} ({pid}) was not running to begin with"
        );
    }

    fn assert_gone(process: &ExitHandle, pid: u32, what: &str) {
        assert!(
            process.exited(Duration::from_secs(10)),
            "{what} ({pid}) survived"
        );
    }

    fn own_handle_count() -> u32 {
        powershell(&format!(
            "(Get-Process -Id {}).HandleCount",
            std::process::id()
        ))
        .parse()
        .expect("handle count")
    }

    /// A job holds a kernel handle for as long as it lives, so a session that
    /// ends has to give it back. The Windows soak measures this across the
    /// whole service; this isolates the job object itself.
    #[test]
    fn adopting_and_dropping_jobs_returns_their_handles() {
        // Live long enough that adoption always finds a running process, which
        // a command that exits immediately would not guarantee.
        let spawn = || {
            Command::new("cmd.exe")
                .args(["/d", "/c", "ping", "-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("spawn")
        };

        // Warm up so first-use allocations are not counted as growth.
        for _ in 0..5 {
            let mut child = spawn();
            drop(ProcessTree::adopt(child.id()).expect("adopt"));
            let _ = child.wait();
        }

        let before = own_handle_count();
        const ROUNDS: u32 = 100;
        for _ in 0..ROUNDS {
            let mut child = spawn();
            let tree = ProcessTree::adopt(child.id()).expect("adopt");
            drop(tree);
            let _ = child.wait();
        }
        let after = own_handle_count();

        assert!(
            after.saturating_sub(before) < ROUNDS / 4,
            "adopting {ROUNDS} jobs retained {} handles ({before} -> {after})",
            after.saturating_sub(before)
        );
    }

    /// The case `Child::kill` misses: it ends the spawned shell but not what
    /// the shell started.
    #[test]
    fn terminating_a_job_reaches_a_grandchild() {
        let (parent, grandchild) = spawn_with_grandchild();
        let parent_exit = exit_handle(parent.id());
        let grandchild_exit = exit_handle(grandchild);
        let tree = ProcessTree::adopt(parent.id()).expect("adopt into a job");
        assert_running(&grandchild_exit, grandchild, "grandchild");

        tree.terminate().expect("terminate the job");
        assert_gone(&parent_exit, parent.id(), "shell");
        assert_gone(&grandchild_exit, grandchild, "grandchild");
    }

    /// Dropping the job is enough, so a daemon that dies without terminating
    /// its sessions still cannot leak their trees.
    #[test]
    fn dropping_a_job_kills_what_is_left() {
        let (parent, grandchild) = spawn_with_grandchild();
        let parent_exit = exit_handle(parent.id());
        let grandchild_exit = exit_handle(grandchild);
        let tree = ProcessTree::adopt(parent.id()).expect("adopt into a job");
        assert_running(&grandchild_exit, grandchild, "grandchild");

        drop(tree);
        assert_gone(&parent_exit, parent.id(), "shell");
        assert_gone(&grandchild_exit, grandchild, "grandchild");
    }
}
