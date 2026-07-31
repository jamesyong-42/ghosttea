use std::{env, fs, path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use ghosttea::{
    FontResource, FontResources, RASTER_SCALE, TerminalService, TerminalServiceConfig, TextEngine,
    TextMetrics,
};
use ghosttea_truffle::{TruffleTerminalConfig, TruffleTerminalMesh};
use truffle_core::{Node, network::tailscale::TailscaleProvider};

const DEFAULT_APP_ID: &str = "ghosttea-terminal";

#[tokio::main]
async fn main() -> Result<()> {
    // The daemon is configured entirely through its environment, so this is
    // deliberately the only argument it understands: a binary distributed
    // through a registry has to be able to say which release it came from,
    // and the post-publish smoke test asks it.
    if env::args().nth(1).as_deref() == Some("--version") {
        println!("ghosttead {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let _ = dotenvy::dotenv();
    let mut service = TerminalService::new(TerminalServiceConfig {
        control_socket: required_env("GHOSTTEA_CONTROL_SOCKET", "TERMINALD_CONTROL_SOCKET")?,
        frame_socket: required_env("GHOSTTEA_FRAME_SOCKET", "TERMINALD_FRAME_SOCKET")?,
        auth_token: required_env("GHOSTTEA_AUTH_TOKEN", "TERMINALD_AUTH_TOKEN")?,
    });
    if let Some(path) = nonempty_env("GHOSTTEA_CONFIG_PATH") {
        service = service.with_config_path(path);
    }
    if let Some(text_engine) = configured_text_engine()? {
        service = service.with_text_engine(text_engine);
    }
    // The readiness handshake belongs to the binary: three supervisors parse
    // this line off our stdout, and the library must stay silent so an
    // embedding host can own that stream. `--version` above already writes
    // here, so both of this process's stdout contracts now live together.
    service = service.with_ready(|ready| {
        println!(
            "ghosttead ready ({}; {:?})",
            ready.primary_family, ready.font_mode
        );
    });
    let Some(config) = TruffleHostConfig::from_env()? else {
        return serve_until_signal(service).await;
    };

    let mut builder = Node::<TailscaleProvider>::builder()
        .app_id(&config.app_id)?
        .sidecar_path(&config.sidecar_path);
    if let Some(auth_key) = config.auth_key.as_deref() {
        builder = builder.auth_key(auth_key);
    }
    if let Some(device_name) = config.device_name.as_deref() {
        builder = builder.device_name(device_name);
    }
    if let Some(state_dir) = config.state_dir.as_deref() {
        builder = builder.state_dir(state_dir);
    }
    if config.ephemeral {
        builder = builder.ephemeral(true);
    }
    let node = Arc::new(
        builder
            .build_with_auth_handler(|_| {
                eprintln!("[terminal-host] Truffle authentication requires user interaction");
            })
            .await
            .context("start host-owned Truffle node")?,
    );
    let terminal_mesh = TruffleTerminalMesh::new(
        node,
        TruffleTerminalConfig {
            service_name: config.service_name,
            quic_port: config.quic_port,
            compact_port: config.compact_port,
            capability: config.capability,
            allow_tailnet_write: config.allow_tailnet_write,
            ..TruffleTerminalConfig::default()
        },
    )?;
    serve_until_signal(service.with_terminal_mesh(terminal_mesh)).await
}

/// How long a drain may take before the deadline forces the ladder to the end.
///
/// A supervisor that sends SIGTERM is usually counting too — systemd's default
/// patience is 90 s — so this has to leave room for the escalation it triggers
/// rather than spend the whole allowance waiting politely.
const SHUTDOWN_DRAIN_BUDGET: Duration = Duration::from_secs(10);

/// Serve until a listener fails or the supervisor asks us to leave.
///
/// `run()` cannot do this: it holds the handle for the lifetime of the future,
/// so nothing can ask it to stop, and SIGTERM used to end the process outright
/// — no drain, no exit stamps, and every PTY orphaned mid-write. The drain
/// machinery already existed; it simply had no way in.
async fn serve_until_signal(service: TerminalService) -> Result<()> {
    let listeners = service.bind()?;
    let (handle, serving) = service.serve_managed(listeners);
    // Spawned rather than selected on where it stands. The drain runs *inside*
    // this future, and `shutdown()` waits for the report it sends back — so a
    // `select!` holding the future inline stops polling it the instant the
    // signal arm wins, and the two wait on each other forever. SIGTERM then
    // hangs the daemon instead of ending it, which is worse than the abrupt
    // death this replaced. On its own task the runtime keeps driving it.
    let mut serving = tokio::spawn(serving);
    tokio::select! {
        served = &mut serving => served.context("terminal service task stopped")?,
        signal = shutdown_signal() => {
            eprintln!("[ghosttead] {signal}: draining sessions");
            let report = handle.shutdown(SHUTDOWN_DRAIN_BUDGET).await?;
            // Say what the drain actually managed, the way the report itself
            // is written to: "stopped" and "stopped in time" are different
            // claims, and a supervisor reading logs deserves the difference.
            eprintln!(
                "[ghosttead] drained {} session(s), killed {}, unresponsive {:?}, viewers told: {}, in {:?}",
                report.drained,
                report.killed,
                report.unresponsive,
                report.announced_shutdown,
                report.spent
            );
            Ok(())
        }
    }
}

/// Resolve when the supervisor asks this process to stop.
///
/// SIGINT as well as SIGTERM: a daemon run in a terminal during development is
/// stopped with ctrl-c, and that path deserves the same drain as production.
#[cfg(unix)]
async fn shutdown_signal() -> &'static str {
    use tokio::signal::unix::{SignalKind, signal};

    // A process that cannot install a handler still has to serve; it simply
    // loses the graceful path, which is where it started.
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("[ghosttead] cannot listen for SIGTERM, shutdown will not drain: {error}");
            return std::future::pending().await;
        }
    };
    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("[ghosttead] cannot listen for SIGINT: {error}");
            terminate.recv().await;
            return "SIGTERM";
        }
    };
    tokio::select! {
        _ = terminate.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
    }
}

#[cfg(windows)]
async fn shutdown_signal() -> &'static str {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("[ghosttead] cannot listen for ctrl-c, shutdown will not drain: {error}");
        return std::future::pending().await;
    }
    "ctrl-c"
}

fn configured_text_engine() -> Result<Option<TextEngine>> {
    let Some(directory) = nonempty_aliased_env("GHOSTTEA_FONT_DIR", "TERMINALD_FONT_DIR") else {
        return Ok(None);
    };
    let directory = Path::new(&directory);
    let resource = |name: &str| -> Result<FontResource> {
        Ok(FontResource::new(
            name,
            fs::read(directory.join(name)).with_context(|| format!("read bundled font {name}"))?,
        ))
    };
    let mut fonts = FontResources::new(resource("JetBrainsMonoNerdFont-Regular.ttf")?);
    fonts.bold = Some(resource("JetBrainsMonoNerdFont-Bold.ttf")?);
    fonts.italic = Some(resource("JetBrainsMonoNerdFont-Italic.ttf")?);
    fonts.bold_italic = Some(resource("JetBrainsMonoNerdFont-BoldItalic.ttf")?);
    fonts.fallbacks = vec![resource("NotoColorEmoji.ttf")?];
    Ok(Some(TextEngine::from_fonts(
        fonts,
        TextMetrics::default(),
        RASTER_SCALE,
    )?))
}

struct TruffleHostConfig {
    app_id: String,
    sidecar_path: String,
    auth_key: Option<String>,
    device_name: Option<String>,
    state_dir: Option<String>,
    service_name: String,
    quic_port: u16,
    compact_port: u16,
    capability: Option<String>,
    allow_tailnet_write: bool,
    ephemeral: bool,
}

impl TruffleHostConfig {
    fn from_env() -> Result<Option<Self>> {
        let auth_key = nonempty_env("TRUFFLE_TEST_AUTHKEY");
        let explicitly_enabled = env_bool("GHOSTTEA_TRUFFLE_ENABLED", "TERMINALD_TRUFFLE_ENABLED")?;
        if explicitly_enabled == Some(false) || (explicitly_enabled.is_none() && auth_key.is_none())
        {
            return Ok(None);
        }
        let sidecar_path = nonempty_env("TRUFFLE_SIDECAR_PATH")
            .context("TRUFFLE_SIDECAR_PATH is required when Truffle networking is enabled")?;
        let quic_port = match aliased_env("GHOSTTEA_TRUFFLE_PORT", "TERMINALD_TRUFFLE_PORT") {
            Some(value) => value
                .parse::<u16>()
                .context("GHOSTTEA_TRUFFLE_PORT must be a valid nonzero port")?,
            None => ghosttea_truffle::DEFAULT_QUIC_PORT,
        };
        if quic_port == 0 {
            bail!("GHOSTTEA_TRUFFLE_PORT must be nonzero");
        }
        let compact_port = match aliased_env(
            "GHOSTTEA_TRUFFLE_COMPACT_PORT",
            "TERMINALD_TRUFFLE_COMPACT_PORT",
        ) {
            Some(value) => value
                .parse::<u16>()
                .context("GHOSTTEA_TRUFFLE_COMPACT_PORT must be a valid nonzero port")?,
            None => ghosttea_truffle::DEFAULT_COMPACT_PORT,
        };
        if compact_port == 0 {
            bail!("GHOSTTEA_TRUFFLE_COMPACT_PORT must be nonzero");
        }
        Ok(Some(Self {
            app_id: nonempty_aliased_env("GHOSTTEA_TRUFFLE_APP_ID", "TERMINALD_TRUFFLE_APP_ID")
                .unwrap_or_else(|| DEFAULT_APP_ID.to_owned()),
            sidecar_path,
            auth_key,
            device_name: nonempty_aliased_env(
                "GHOSTTEA_TRUFFLE_DEVICE_NAME",
                "TERMINALD_TRUFFLE_DEVICE_NAME",
            ),
            state_dir: nonempty_aliased_env(
                "GHOSTTEA_TRUFFLE_STATE_DIR",
                "TERMINALD_TRUFFLE_STATE_DIR",
            ),
            service_name: nonempty_aliased_env(
                "GHOSTTEA_TRUFFLE_SERVICE",
                "TERMINALD_TRUFFLE_SERVICE",
            )
            .unwrap_or_else(|| "terminal.v1".to_owned()),
            quic_port,
            compact_port,
            capability: nonempty_aliased_env(
                "GHOSTTEA_TRUFFLE_CAPABILITY",
                "TERMINALD_TRUFFLE_CAPABILITY",
            ),
            allow_tailnet_write: env_bool(
                "GHOSTTEA_TRUFFLE_ALLOW_WRITE",
                "TERMINALD_TRUFFLE_ALLOW_WRITE",
            )?
            .unwrap_or(false),
            ephemeral: env_bool("GHOSTTEA_TRUFFLE_EPHEMERAL", "TERMINALD_TRUFFLE_EPHEMERAL")?
                .unwrap_or(false),
        }))
    }
}

fn required_env(name: &str, legacy_name: &str) -> Result<String> {
    nonempty_aliased_env(name, legacy_name).with_context(|| format!("{name} is required"))
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn aliased_env(name: &str, legacy_name: &str) -> Option<String> {
    env::var(name).ok().or_else(|| env::var(legacy_name).ok())
}

fn nonempty_aliased_env(name: &str, legacy_name: &str) -> Option<String> {
    aliased_env(name, legacy_name).filter(|value| !value.trim().is_empty())
}

fn env_bool(name: &str, legacy_name: &str) -> Result<Option<bool>> {
    let Some(value) = aliased_env(name, legacy_name) else {
        return Ok(None);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => bail!("{name} must be a boolean"),
    }
}
