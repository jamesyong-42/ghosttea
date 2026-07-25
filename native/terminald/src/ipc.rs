//! Local IPC endpoints for the control and frame channels.
//!
//! Both channels are private to the host user and carry the same bearer token.
//! The transport underneath differs by platform:
//!
//! - Unix hosts use a filesystem-bound Unix-domain socket per channel, scoped
//!   by the runtime directory's permissions.
//! - Windows hosts use a named pipe per channel, because Windows has no
//!   equivalent filesystem socket that Node's `net` module can dial. Pipes get
//!   a permissive default DACL, so [`security`] narrows each one to the account
//!   running the service.
//!
//! A Unix listener yields a fresh stream from every `accept`. A named pipe
//! server instance instead *becomes* the connection once a client arrives, so
//! the Windows listener holds one idle instance and creates its replacement
//! each time it hands a connection out.
//!
//! # Windows client contract
//!
//! Only the idle instance can take a client, so a client that dials while the
//! listener is between instances, or while another client is being accepted,
//! gets `ERROR_PIPE_BUSY`. Windows expects clients to wait and retry, and this
//! transport requires the same: see `openEndpoint` in
//! `@vibecook/ghosttea-client`. Holding several idle instances would not remove
//! the retry, because Windows attaches a client to an arbitrary free instance
//! while the listener can only await one at a time.

use anyhow::Result;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
mod security;

/// One authenticated local connection.
///
/// Both platform types already implement `AsyncRead` and `AsyncWrite`, so the
/// service reads and writes framed packets without naming the transport.
#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub type Stream = tokio::net::windows::named_pipe::NamedPipeServer;

/// Remove an endpoint left behind by a previous process.
///
/// A Unix-domain socket outlives the process that bound it and would make a
/// later bind fail with `EADDRINUSE`. Windows reclaims a pipe name once its
/// last handle closes, so there is nothing to remove.
pub fn remove_stale_endpoint(endpoint: &str) -> Result<()> {
    #[cfg(unix)]
    {
        if std::path::Path::new(endpoint).exists() {
            std::fs::remove_file(endpoint)?;
        }
    }
    #[cfg(windows)]
    {
        let _ = endpoint;
    }
    Ok(())
}

/// Accepts local connections on one channel's endpoint.
pub struct Listener {
    #[cfg(unix)]
    inner: tokio::net::UnixListener,
    #[cfg(windows)]
    name: std::ffi::OsString,
    // Always `Some` between accepts; taken only while a replacement is made.
    #[cfg(windows)]
    idle: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    // Built once: every instance of one pipe carries the same access rules.
    #[cfg(windows)]
    security: security::CurrentUserOnly,
}

#[cfg(unix)]
impl Listener {
    /// Bind the channel's socket path.
    pub fn bind(endpoint: &str) -> Result<Self> {
        Ok(Self {
            inner: tokio::net::UnixListener::bind(endpoint)?,
        })
    }

    pub async fn accept(&mut self) -> Result<Stream> {
        let (stream, _) = self.inner.accept().await?;
        Ok(stream)
    }
}

#[cfg(unix)]
impl From<tokio::net::UnixListener> for Listener {
    fn from(inner: tokio::net::UnixListener) -> Self {
        Self { inner }
    }
}

#[cfg(windows)]
impl Listener {
    /// Create the channel's pipe and its first server instance.
    ///
    /// `first_pipe_instance` fails the bind when the name already exists, which
    /// stops another process from publishing this pipe first and collecting
    /// connections intended for the service. The descriptor then limits the
    /// pipe to the account running the service.
    pub fn bind(endpoint: &str) -> Result<Self> {
        /// A name released by an exiting process is still refused until its
        /// last handle closes. A supervisor restarting its service reuses the
        /// same name, so wait that teardown out. Kept short: a name held by a
        /// process that is not exiting must still be refused.
        const REBIND_BUDGET: Duration = Duration::from_millis(1_000);
        const REBIND_INTERVAL: Duration = Duration::from_millis(25);
        /// Returned while the previous owner's handles are still open.
        const ERROR_ACCESS_DENIED: i32 = 5;

        let mut security = security::CurrentUserOnly::new()?;
        let deadline = Instant::now() + REBIND_BUDGET;
        loop {
            // SAFETY: `security` owns a valid SECURITY_ATTRIBUTES that lives
            // across this call and every later instance created from it.
            let created = unsafe {
                tokio::net::windows::named_pipe::ServerOptions::new()
                    .first_pipe_instance(true)
                    .create_with_security_attributes_raw(endpoint, security.as_raw())
            };
            match created {
                Ok(idle) => {
                    return Ok(Self {
                        name: endpoint.into(),
                        idle: Some(idle),
                        security,
                    });
                }
                Err(error)
                    if error.raw_os_error() == Some(ERROR_ACCESS_DENIED)
                        && Instant::now() < deadline => {}
                Err(error) => return Err(error.into()),
            }
            std::thread::sleep(REBIND_INTERVAL);
        }
    }

    /// An instance that joins the already-published name.
    ///
    /// `first_pipe_instance` belongs only to the bind: the name exists by now,
    /// and every later instance has to join it rather than claim it.
    fn instance(&mut self) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        // SAFETY: as in `bind`, the descriptor outlives this call.
        Ok(unsafe {
            tokio::net::windows::named_pipe::ServerOptions::new()
                .create_with_security_attributes_raw(&self.name, self.security.as_raw())
        }?)
    }

    pub async fn accept(&mut self) -> Result<Stream> {
        // Recreated rather than asserted: a previous accept may have served its
        // client but failed to leave a replacement behind.
        let server = match self.idle.take() {
            Some(server) => server,
            None => self.instance()?,
        };
        if let Err(error) = server.connect().await {
            // Keep the instance so a later accept can retry on it; dropping it
            // would unbind the name while the service is still running.
            self.idle = Some(server);
            return Err(error.into());
        }
        // Republish the name before handing this connection out. Failing to
        // do so must not cost the caller the connection it just accepted, so
        // the next accept recreates instead.
        match self.instance() {
            Ok(idle) => self.idle = Some(idle),
            Err(error) => {
                eprintln!("[ghosttea] failed to republish {:?}: {error:#}", self.name);
            }
        }
        Ok(server)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// An endpoint name no other test shares.
    struct Endpoint {
        name: String,
        /// Never read: held so the socket's directory outlives the test. A pipe
        /// name needs no directory, so this only exists on Unix.
        #[cfg(unix)]
        #[allow(dead_code)]
        directory: tempfile::TempDir,
    }

    fn unique_endpoint(label: &str) -> Endpoint {
        #[cfg(windows)]
        {
            // Pipe names share one machine-wide namespace, so uniqueness has to
            // come from the name itself.
            let id = uuid::Uuid::new_v4();
            Endpoint {
                name: format!(r"\\.\pipe\ghosttea-test-{label}-{id}"),
            }
        }
        #[cfg(unix)]
        {
            let directory = tempfile::tempdir().unwrap();
            let name = directory
                .path()
                .join(format!("{label}.sock"))
                .to_string_lossy()
                .into_owned();
            Endpoint { name, directory }
        }
    }

    #[cfg(unix)]
    async fn dial(endpoint: &str) -> tokio::net::UnixStream {
        tokio::net::UnixStream::connect(endpoint).await.unwrap()
    }

    /// Dial the way a Windows client must: retry while the listener has no idle
    /// instance to offer. This mirrors `openEndpoint` in the Node client.
    #[cfg(windows)]
    async fn dial(endpoint: &str) -> tokio::net::windows::named_pipe::NamedPipeClient {
        /// The pipe exists but every instance is taken.
        const ERROR_PIPE_BUSY: i32 = 231;
        /// The listener is between instances, so the name is briefly absent.
        const ERROR_FILE_NOT_FOUND: i32 = 2;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint) {
                Ok(client) => return client,
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)
                    ) && std::time::Instant::now() < deadline => {}
                Err(error) => panic!("failed to dial {endpoint}: {error}"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Read one byte and echo it back, mirroring the service's accept-then-serve
    /// shape without pulling in the control protocol.
    async fn echo_once(listener: &mut Listener) -> u8 {
        let mut stream = listener.accept().await.unwrap();
        let byte = stream.read_u8().await.unwrap();
        stream.write_u8(byte).await.unwrap();
        stream.flush().await.unwrap();
        byte
    }

    #[tokio::test]
    async fn round_trips_one_client() {
        let endpoint = unique_endpoint("round-trip");
        let mut listener = Listener::bind(&endpoint.name).unwrap();
        let client = tokio::spawn({
            let name = endpoint.name.clone();
            async move {
                let mut stream = dial(&name).await;
                stream.write_u8(7).await.unwrap();
                stream.flush().await.unwrap();
                stream.read_u8().await.unwrap()
            }
        });

        assert_eq!(echo_once(&mut listener).await, 7);
        assert_eq!(client.await.unwrap(), 7);
    }

    /// Every accept must leave the endpoint able to take the next client. On
    /// Windows this is the instance-rotation path: the accepted connection *is*
    /// the previous server instance, so a replacement has to take its place.
    #[tokio::test]
    async fn serves_clients_one_after_another() {
        let endpoint = unique_endpoint("sequential");
        let mut listener = Listener::bind(&endpoint.name).unwrap();

        for expected in 1..=4_u8 {
            let client = tokio::spawn({
                let name = endpoint.name.clone();
                async move {
                    let mut stream = dial(&name).await;
                    stream.write_u8(expected).await.unwrap();
                    stream.flush().await.unwrap();
                    stream.read_u8().await.unwrap()
                }
            });
            assert_eq!(echo_once(&mut listener).await, expected);
            assert_eq!(client.await.unwrap(), expected);
        }
    }

    /// The service opens its control and frame channels together and an
    /// application may hold several control connections, so queued clients must
    /// all be served rather than one displacing another.
    #[tokio::test]
    async fn serves_clients_that_arrive_together() {
        let endpoint = unique_endpoint("concurrent");
        let mut listener = Listener::bind(&endpoint.name).unwrap();
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            for _ in 0..3 {
                seen.push(echo_once(&mut listener).await);
            }
            seen.sort_unstable();
            seen
        });

        let mut clients = Vec::new();
        for value in [10_u8, 20, 30] {
            let name = endpoint.name.clone();
            clients.push(tokio::spawn(async move {
                let mut stream = dial(&name).await;
                stream.write_u8(value).await.unwrap();
                stream.flush().await.unwrap();
                stream.read_u8().await.unwrap()
            }));
        }

        let mut echoed = Vec::new();
        for client in clients {
            echoed.push(client.await.unwrap());
        }
        echoed.sort_unstable();
        assert_eq!(echoed, vec![10, 20, 30]);
        assert_eq!(server.await.unwrap(), vec![10, 20, 30]);
    }

    /// A second bind of a live endpoint must fail. On Windows this is the
    /// squatting guard: without it another process could publish the same pipe
    /// name and collect connections meant for the service.
    #[tokio::test]
    async fn refuses_to_bind_a_live_endpoint_twice() {
        let endpoint = unique_endpoint("exclusive");
        let _listener = Listener::bind(&endpoint.name).unwrap();
        assert!(Listener::bind(&endpoint.name).is_err());
    }

    /// The pipe a client can reach must grant only the account running the
    /// service. Windows gives a named pipe a permissive default DACL — read
    /// access for Everyone and for Anonymous — so this asserts against the live
    /// handle rather than against the descriptor the listener built.
    #[cfg(windows)]
    #[tokio::test]
    async fn grants_pipe_access_to_the_owning_account_only() {
        use std::os::windows::io::AsRawHandle;

        let endpoint = unique_endpoint("dacl");
        let mut listener = Listener::bind(&endpoint.name).unwrap();
        // Rendered by Windows rather than written out here: it reports a
        // well-known account through its SDDL alias, so the built-in
        // Administrator reads as `LA` and never as its SID.
        let expected = security::CurrentUserOnly::new().unwrap().dacl().unwrap();
        // `P` protects the DACL, and one entry means one account.
        assert!(
            expected.starts_with("D:P("),
            "not a protected DACL: {expected}"
        );
        assert_eq!(
            expected.matches("(A;").count(),
            1,
            "not one entry: {expected}"
        );

        let bound =
            security::dacl_of(listener.idle.as_ref().unwrap().as_raw_handle() as isize).unwrap();
        assert_eq!(bound, expected, "on bind");

        // The replacement instance created by accept must be just as narrow.
        let client = tokio::spawn({
            let name = endpoint.name.clone();
            async move { dial(&name).await }
        });
        let _accepted = listener.accept().await.unwrap();
        let _client = client.await.unwrap();
        let rotated =
            security::dacl_of(listener.idle.as_ref().unwrap().as_raw_handle() as isize).unwrap();
        assert_eq!(rotated, expected, "after rotation");
    }

    /// A supervisor restarting its service rebinds the endpoint it already
    /// published, because the endpoint has to stay valid across the restart.
    /// Windows refuses a name until the previous owner's last handle closes.
    #[tokio::test]
    async fn rebinds_an_endpoint_its_previous_owner_just_released() {
        let endpoint = unique_endpoint("rebind");
        let first = Listener::bind(&endpoint.name).unwrap();
        // Hold a connection open so the name is as busy as a live service's.
        let client = dial(&endpoint.name).await;
        drop(first);

        let second = Listener::bind(&endpoint.name).expect("rebind after release");
        drop(client);
        drop(second);
    }

    /// The listener has to survive a failed republish rather than strand
    /// itself: the connection it just accepted is already the caller's.
    #[cfg(windows)]
    #[tokio::test]
    async fn accepts_again_after_losing_its_idle_instance() {
        let endpoint = unique_endpoint("recreate");
        let mut listener = Listener::bind(&endpoint.name).unwrap();
        // Stand in for a republish that failed after a connection was served.
        listener.idle = None;

        let client = tokio::spawn({
            let name = endpoint.name.clone();
            async move {
                let mut stream = dial(&name).await;
                stream.write_u8(9).await.unwrap();
                stream.flush().await.unwrap();
                stream.read_u8().await.unwrap()
            }
        });
        assert_eq!(echo_once(&mut listener).await, 9);
        assert_eq!(client.await.unwrap(), 9);
    }
}
