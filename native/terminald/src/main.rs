use std::{env, sync::Arc};

use anyhow::{Context, Result, bail};
use terminald::{TerminalService, TerminalServiceConfig, mesh};
use truffle_core::{Node, network::tailscale::TailscaleProvider};

const DEFAULT_APP_ID: &str = "electron-ghostty-terminal";

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let service = TerminalService::new(TerminalServiceConfig {
        control_socket: required_env("TERMINALD_CONTROL_SOCKET")?,
        frame_socket: required_env("TERMINALD_FRAME_SOCKET")?,
        auth_token: required_env("TERMINALD_AUTH_TOKEN")?,
    });
    let Some(config) = TruffleHostConfig::from_env()? else {
        return service.run().await;
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
    let node = Arc::new(
        builder
            .build_with_auth_handler(|_| {
                eprintln!("[terminal-host] Truffle authentication requires user interaction");
            })
            .await
            .context("start host-owned Truffle node")?,
    );
    let terminal_mesh = mesh::TruffleTerminalMesh::new(
        node,
        mesh::TruffleTerminalConfig {
            service_name: config.service_name,
            quic_port: config.quic_port,
            capability: config.capability,
            allow_tailnet_write: config.allow_tailnet_write,
        },
    )?;
    service.with_truffle_mesh(terminal_mesh).run().await
}

struct TruffleHostConfig {
    app_id: String,
    sidecar_path: String,
    auth_key: Option<String>,
    device_name: Option<String>,
    state_dir: Option<String>,
    service_name: String,
    quic_port: u16,
    capability: Option<String>,
    allow_tailnet_write: bool,
}

impl TruffleHostConfig {
    fn from_env() -> Result<Option<Self>> {
        let auth_key = nonempty_env("TRUFFLE_TEST_AUTHKEY");
        let explicitly_enabled = env_bool("TERMINALD_TRUFFLE_ENABLED")?;
        if explicitly_enabled == Some(false) || (explicitly_enabled.is_none() && auth_key.is_none())
        {
            return Ok(None);
        }
        let sidecar_path = nonempty_env("TRUFFLE_SIDECAR_PATH")
            .context("TRUFFLE_SIDECAR_PATH is required when Truffle networking is enabled")?;
        let quic_port = match env::var("TERMINALD_TRUFFLE_PORT") {
            Ok(value) => value
                .parse::<u16>()
                .context("TERMINALD_TRUFFLE_PORT must be a valid nonzero port")?,
            Err(_) => mesh::DEFAULT_QUIC_PORT,
        };
        if quic_port == 0 {
            bail!("TERMINALD_TRUFFLE_PORT must be nonzero");
        }
        Ok(Some(Self {
            app_id: nonempty_env("TERMINALD_TRUFFLE_APP_ID")
                .unwrap_or_else(|| DEFAULT_APP_ID.to_owned()),
            sidecar_path,
            auth_key,
            device_name: nonempty_env("TERMINALD_TRUFFLE_DEVICE_NAME"),
            state_dir: nonempty_env("TERMINALD_TRUFFLE_STATE_DIR"),
            service_name: nonempty_env("TERMINALD_TRUFFLE_SERVICE")
                .unwrap_or_else(|| "terminal.v1".to_owned()),
            quic_port,
            capability: nonempty_env("TERMINALD_TRUFFLE_CAPABILITY"),
            allow_tailnet_write: env_bool("TERMINALD_TRUFFLE_ALLOW_WRITE")?.unwrap_or(false),
        }))
    }
}

fn required_env(name: &str) -> Result<String> {
    nonempty_env(name).with_context(|| format!("{name} is required"))
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn env_bool(name: &str) -> Result<Option<bool>> {
    let Ok(value) = env::var(name) else {
        return Ok(None);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => bail!("{name} must be a boolean"),
    }
}
