use std::{env, sync::Arc};

use anyhow::{Context, Result, bail};
use ghosttea::{TerminalService, TerminalServiceConfig};
use ghosttea_truffle::{TruffleTerminalConfig, TruffleTerminalMesh};
use truffle_core::{Node, network::tailscale::TailscaleProvider};

const DEFAULT_APP_ID: &str = "ghosttea-terminal";

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let service = TerminalService::new(TerminalServiceConfig {
        control_socket: required_env("GHOSTTEA_CONTROL_SOCKET", "TERMINALD_CONTROL_SOCKET")?,
        frame_socket: required_env("GHOSTTEA_FRAME_SOCKET", "TERMINALD_FRAME_SOCKET")?,
        auth_token: required_env("GHOSTTEA_AUTH_TOKEN", "TERMINALD_AUTH_TOKEN")?,
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
    let terminal_mesh = TruffleTerminalMesh::new(
        node,
        TruffleTerminalConfig {
            service_name: config.service_name,
            quic_port: config.quic_port,
            capability: config.capability,
            allow_tailnet_write: config.allow_tailnet_write,
        },
    )?;
    service.with_terminal_mesh(terminal_mesh).run().await
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
            capability: nonempty_aliased_env(
                "GHOSTTEA_TRUFFLE_CAPABILITY",
                "TERMINALD_TRUFFLE_CAPABILITY",
            ),
            allow_tailnet_write: env_bool(
                "GHOSTTEA_TRUFFLE_ALLOW_WRITE",
                "TERMINALD_TRUFFLE_ALLOW_WRITE",
            )?
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
