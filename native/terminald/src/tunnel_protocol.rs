use anyhow::{Context, Result, bail};
pub use ghosttea_core::{
    LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalPatch, LogicalTerminalSnapshot, RowReplacement,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::session::{KeyInput, MouseInput};

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 3;
pub const MAX_PREFACE_METADATA_BYTES: usize = 4 * 1024;
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_STATE_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

const MAGIC: [u8; 4] = *b"TSP1";
const PREFACE_HEADER_BYTES: usize = 16;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamKind {
    ConnectionControl,
    SessionControl,
    LiveState,
    Scrollback,
    Asset,
}

impl StreamKind {
    fn as_byte(self) -> u8 {
        match self {
            Self::ConnectionControl => 1,
            Self::SessionControl => 2,
            Self::LiveState => 3,
            Self::Scrollback => 4,
            Self::Asset => 5,
        }
    }

    fn from_byte(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::ConnectionControl),
            2 => Ok(Self::SessionControl),
            3 => Ok(Self::LiveState),
            4 => Ok(Self::Scrollback),
            5 => Ok(Self::Asset),
            _ => bail!("unknown terminal stream kind"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamPreface {
    pub stream_kind: StreamKind,
    pub session_id: Option<String>,
    pub view_id: Option<String>,
}

pub fn encode_preface(preface: &StreamPreface) -> Result<Vec<u8>> {
    let metadata = serde_json::to_vec(preface).context("serialize stream preface")?;
    if metadata.len() > MAX_PREFACE_METADATA_BYTES {
        bail!("stream preface metadata exceeds limit");
    }
    let mut encoded = Vec::with_capacity(PREFACE_HEADER_BYTES + metadata.len());
    encoded.extend_from_slice(&MAGIC);
    encoded.extend_from_slice(&PROTOCOL_MAJOR.to_be_bytes());
    encoded.extend_from_slice(&PROTOCOL_MINOR.to_be_bytes());
    encoded.push(preface.stream_kind.as_byte());
    encoded.extend_from_slice(&[0; 3]);
    encoded.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&metadata);
    Ok(encoded)
}

pub fn decode_preface(bytes: &[u8]) -> Result<(StreamPreface, usize)> {
    if bytes.len() < PREFACE_HEADER_BYTES {
        bail!("truncated stream preface");
    }
    if bytes[..4] != MAGIC {
        bail!("invalid stream preface magic");
    }
    let major = u16::from_be_bytes(bytes[4..6].try_into().unwrap());
    if major != PROTOCOL_MAJOR {
        bail!("unsupported terminal protocol major {major}");
    }
    let kind = StreamKind::from_byte(bytes[8])?;
    let metadata_len = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if metadata_len > MAX_PREFACE_METADATA_BYTES {
        bail!("stream preface metadata exceeds limit");
    }
    let total = PREFACE_HEADER_BYTES + metadata_len;
    if bytes.len() < total {
        bail!("truncated stream preface metadata");
    }
    let preface: StreamPreface = serde_json::from_slice(&bytes[PREFACE_HEADER_BYTES..total])
        .context("decode stream preface")?;
    if preface.stream_kind != kind {
        bail!("stream preface kind mismatch");
    }
    Ok((preface, total))
}

pub fn encode_message<T: Serialize>(message: &T, limit: usize) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(message).context("serialize terminal protocol message")?;
    if payload.len() > limit {
        bail!("terminal protocol message exceeds limit");
    }
    let mut encoded = Vec::with_capacity(4 + payload.len());
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub fn decode_message<T: DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<(T, usize)> {
    if bytes.len() < 4 {
        bail!("truncated terminal protocol frame");
    }
    let payload_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if payload_len > limit {
        bail!("terminal protocol message exceeds limit");
    }
    let total = 4 + payload_len;
    if bytes.len() < total {
        bail!("truncated terminal protocol payload");
    }
    let message =
        serde_json::from_slice(&bytes[4..total]).context("decode terminal protocol message")?;
    Ok((message, total))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionMessage {
    ClientHello {
        protocol_major: u16,
        protocol_minor: u16,
        host_instance_id: String,
        local_device_id: String,
        nonce: String,
    },
    ServerHello {
        protocol_major: u16,
        protocol_minor: u16,
        host_instance_id: String,
        nonce: String,
    },
    ListSessions {
        request_id: String,
    },
    Sessions {
        request_id: String,
        sessions: Vec<SharedSessionSummary>,
    },
    Error {
        request_id: Option<String>,
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionControlMessage {
    AttachView {
        request_id: String,
        session_id: String,
        view_id: String,
        access_token: Option<String>,
        cols: u16,
        rows: u16,
    },
    ViewAttached {
        request_id: String,
        session_epoch: u64,
        layout_epoch: u64,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        read_write: bool,
    },
    FocusAndResize {
        view_id: String,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        client_sequence: u64,
    },
    ControlChanged {
        controller_view_id: String,
        control_epoch: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    Resize {
        view_id: String,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    },
    ResizeRejected {
        current_controller_view_id: Option<String>,
        current_control_epoch: Option<u64>,
        cols: u16,
        rows: u16,
    },
    Input {
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    },
    StateAck {
        session_epoch: u64,
        layout_epoch: u64,
        patch_sequence: u64,
        terminal_revision: u64,
    },
    RequestSnapshot,
    SelectionText {
        request_id: String,
        view_id: String,
        attachment_epoch: u64,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
    },
    SelectionTextResult {
        request_id: String,
        text: String,
    },
    Detach {
        view_id: String,
        attachment_epoch: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TunnelInput {
    Text(String),
    Paste(String),
    Key(KeyInput),
    Mouse(MouseInput),
    Scroll(i64),
    ScrollTo(u64),
    Focus(bool),
    Interrupt,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StateMessage {
    Snapshot(LogicalTerminalSnapshot),
    Patch(LogicalTerminalPatch),
    ControlChanged {
        controller_view_id: String,
        control_epoch: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostAdvertisement {
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub quic_port: u16,
    pub host_instance_id: String,
    pub published_at_ms: u64,
    pub expires_at_ms: u64,
    pub sessions: Vec<SharedSessionSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSessionSummary {
    pub session_id: String,
    pub title: String,
    pub cwd_label: Option<String>,
    pub running: bool,
    pub attachable: bool,
    pub read_write: bool,
    pub created_at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preface_round_trips_and_rejects_kind_tampering() {
        let preface = StreamPreface {
            stream_kind: StreamKind::LiveState,
            session_id: Some("session".into()),
            view_id: Some("view".into()),
        };
        let encoded = encode_preface(&preface).unwrap();
        let (decoded, consumed) = decode_preface(&encoded).unwrap();
        assert_eq!(decoded, preface);
        assert_eq!(consumed, encoded.len());

        let mut tampered = encoded;
        tampered[8] = StreamKind::Asset.as_byte();
        assert!(decode_preface(&tampered).is_err());
    }

    #[test]
    fn framed_messages_round_trip_and_enforce_limits() {
        let message = ConnectionMessage::ListSessions {
            request_id: "request".into(),
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, consumed) = decode_message::<ConnectionMessage>(&encoded, 1024).unwrap();
        assert!(matches!(decoded, ConnectionMessage::ListSessions { .. }));
        assert_eq!(consumed, encoded.len());

        let mut oversized = vec![0, 0, 4, 1];
        oversized.resize(1029, 0);
        assert!(decode_message::<ConnectionMessage>(&oversized, 1024).is_err());
    }

    #[test]
    fn apple_connection_control_fixture_matches_rust_contract() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            client_hello: ConnectionMessage,
            server_hello: ConnectionMessage,
            sessions: ConnectionMessage,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../apple/GhostteaKit/Tests/GhostteaTruffleTests/Fixtures/connection-control-v1.json"
        ))
        .unwrap();
        assert!(matches!(
            fixture.client_hello,
            ConnectionMessage::ClientHello {
                protocol_major: 1,
                protocol_minor: 3,
                ref host_instance_id,
                ref local_device_id,
                ref nonce,
            } if host_instance_id == "desktop-instance"
                && local_device_id == "01J4K9M2Z8AB3RNYQPW6H5TC0X"
                && nonce == "nonce-1"
        ));
        assert!(matches!(
            fixture.server_hello,
            ConnectionMessage::ServerHello {
                protocol_major: 1,
                protocol_minor: 3,
                ref host_instance_id,
                ref nonce,
            } if host_instance_id == "desktop-instance" && nonce == "nonce-1"
        ));
        assert!(matches!(
            fixture.sessions,
            ConnectionMessage::Sessions {
                ref request_id,
                ref sessions,
            } if request_id == "request-1"
                && sessions.len() == 1
                && sessions[0].session_id == "session-1"
                && sessions[0].read_write
        ));
    }

    #[test]
    fn typed_terminal_input_round_trips() {
        let message = SessionControlMessage::Input {
            view_id: "view".into(),
            attachment_epoch: 7,
            input_sequence: 9,
            operation: TunnelInput::Interrupt,
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::Input {
                attachment_epoch: 7,
                input_sequence: 9,
                operation: TunnelInput::Interrupt,
                ..
            }
        ));
    }

    #[test]
    fn absolute_scroll_input_round_trips() {
        let message = SessionControlMessage::Input {
            view_id: "view".into(),
            attachment_epoch: 7,
            input_sequence: 10,
            operation: TunnelInput::ScrollTo(42),
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::Input {
                operation: TunnelInput::ScrollTo(42),
                ..
            }
        ));
    }

    #[test]
    fn control_changes_round_trip_on_the_live_state_stream() {
        let message = StateMessage::ControlChanged {
            controller_view_id: "view".into(),
            control_epoch: 11,
            cols: 120,
            rows: 40,
            layout_epoch: 5,
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<StateMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            StateMessage::ControlChanged {
                control_epoch: 11,
                cols: 120,
                rows: 40,
                layout_epoch: 5,
                ..
            }
        ));
    }

    #[test]
    fn unknown_protocol_major_is_rejected_before_json() {
        let mut encoded = encode_preface(&StreamPreface {
            stream_kind: StreamKind::ConnectionControl,
            session_id: None,
            view_id: None,
        })
        .unwrap();
        encoded[4..6].copy_from_slice(&2_u16.to_be_bytes());
        assert!(decode_preface(&encoded).is_err());
    }
}
