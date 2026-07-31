use anyhow::{Context, Result, bail};
use ghosttea_config::TerminalPresentationConfig;
pub use ghosttea_core::{
    LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalPatch, LogicalTerminalSnapshot, RowReplacement,
};
use serde::{
    Deserialize, Serialize,
    de::DeserializeOwned,
    ser::{SerializeSeq, SerializeTuple},
};

use crate::session::{KeyInput, MouseInput, SessionActivity};

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 5;
pub const SESSION_ACTIVITY_PROTOCOL_MINOR: u16 = 4;
pub const TERMINAL_PRESENTATION_PROTOCOL_MINOR: u16 = 5;
pub const MAX_PREFACE_METADATA_BYTES: usize = 4 * 1024;
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_STATE_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

const MAGIC: [u8; 4] = *b"TSP1";
const PREFACE_HEADER_BYTES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactChannel {
    Control,
    State,
}

impl CompactChannel {
    pub fn as_byte(self) -> u8 {
        match self {
            Self::Control => 1,
            Self::State => 2,
        }
    }

    pub fn from_byte(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::Control),
            2 => Ok(Self::State),
            _ => bail!("unknown compact terminal channel"),
        }
    }
}

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

pub fn encode_state_message(
    message: &StateMessage,
    codec: StateCodec,
    limit: usize,
) -> Result<Vec<u8>> {
    match codec {
        StateCodec::Json => encode_message(message, limit),
        StateCodec::CompactJsonV1 => encode_message(&CompactStateMessageRef(message), limit),
    }
}

pub fn decode_state_message(
    bytes: &[u8],
    codec: StateCodec,
    limit: usize,
) -> Result<(StateMessage, usize)> {
    match codec {
        StateCodec::Json => decode_message(bytes, limit),
        StateCodec::CompactJsonV1 => {
            let (message, consumed) = decode_message::<CompactStateMessage>(bytes, limit)?;
            Ok((message.try_into()?, consumed))
        }
    }
}

pub fn encode_compact_message<T: Serialize>(
    channel: CompactChannel,
    message: &T,
    limit: usize,
) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(message).context("serialize compact terminal message")?;
    if payload.len() > limit {
        bail!("compact terminal message exceeds limit");
    }
    let framed_len = payload
        .len()
        .checked_add(1)
        .context("compact terminal message length overflow")?;
    let mut encoded = Vec::with_capacity(4 + framed_len);
    encoded.extend_from_slice(&u32::try_from(framed_len)?.to_be_bytes());
    encoded.push(channel.as_byte());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub fn decode_compact_message<T: DeserializeOwned>(
    bytes: &[u8],
    expected_channel: CompactChannel,
    limit: usize,
) -> Result<(T, usize)> {
    if bytes.len() < 5 {
        bail!("truncated compact terminal frame");
    }
    let framed_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if framed_len == 0 || framed_len - 1 > limit {
        bail!("compact terminal message exceeds limit");
    }
    let total = 4 + framed_len;
    if bytes.len() < total {
        bail!("truncated compact terminal payload");
    }
    let channel = CompactChannel::from_byte(bytes[4])?;
    if channel != expected_channel {
        bail!("compact terminal channel mismatch");
    }
    let message = serde_json::from_slice(&bytes[5..total])
        .context("decode compact terminal protocol message")?;
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state_codecs: Option<Vec<StateCodec>>,
    },
    ServerHello {
        protocol_major: u16,
        protocol_minor: u16,
        host_instance_id: String,
        nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state_codec: Option<StateCodec>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<TerminalPresentationConfig>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
    ActivityChanged {
        activity: SessionActivity,
    },
    ConfigurationChanged {
        presentation: TerminalPresentationConfig,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StateCodec {
    #[default]
    Json,
    CompactJsonV1,
}

struct CompactStateMessageRef<'a>(&'a StateMessage);

impl Serialize for CompactStateMessageRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self.0 {
            StateMessage::Snapshot(snapshot) => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                0,
                "s",
                &CompactSnapshotRef(snapshot),
            ),
            StateMessage::Patch(patch) => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                1,
                "p",
                &CompactPatchRef(patch),
            ),
            StateMessage::ControlChanged {
                controller_view_id,
                control_epoch,
                cols,
                rows,
                layout_epoch,
            } => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                2,
                "c",
                &CompactControlChangedRef {
                    controller_view_id,
                    control_epoch: *control_epoch,
                    cols: *cols,
                    rows: *rows,
                    layout_epoch: *layout_epoch,
                },
            ),
            StateMessage::ActivityChanged { activity } => {
                serializer.serialize_newtype_variant("CompactStateMessage", 3, "a", activity)
            }
            StateMessage::ConfigurationChanged { presentation } => {
                serializer.serialize_newtype_variant("CompactStateMessage", 4, "g", presentation)
            }
        }
    }
}

struct CompactSnapshotRef<'a>(&'a LogicalTerminalSnapshot);

impl Serialize for CompactSnapshotRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let snapshot = self.0;
        let mut tuple = serializer.serialize_tuple(10)?;
        tuple.serialize_element(&snapshot.session_epoch)?;
        tuple.serialize_element(&snapshot.layout_epoch)?;
        tuple.serialize_element(&snapshot.terminal_revision)?;
        tuple.serialize_element(&snapshot.cols)?;
        tuple.serialize_element(&CompactRowsRef(&snapshot.rows))?;
        tuple.serialize_element(&CompactCursor::from(snapshot.cursor))?;
        tuple.serialize_element(&snapshot.mouse_tracking)?;
        tuple.serialize_element(&CompactScrollbar::from(snapshot.scrollbar))?;
        tuple.serialize_element(&snapshot.title)?;
        tuple.serialize_element(&snapshot.cwd)?;
        tuple.end()
    }
}

struct CompactPatchRef<'a>(&'a LogicalTerminalPatch);

impl Serialize for CompactPatchRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let patch = self.0;
        let mut tuple = serializer.serialize_tuple(9)?;
        tuple.serialize_element(&patch.session_epoch)?;
        tuple.serialize_element(&patch.layout_epoch)?;
        tuple.serialize_element(&patch.patch_sequence)?;
        tuple.serialize_element(&patch.terminal_revision)?;
        tuple.serialize_element(&CompactReplacementsRef(&patch.row_replacements))?;
        tuple.serialize_element(&patch.cursor.map(CompactCursor::from))?;
        tuple.serialize_element(&patch.mouse_tracking)?;
        tuple.serialize_element(&patch.scrollbar.map(CompactScrollbar::from))?;
        tuple.serialize_element(&0_u8)?;
        tuple.end()
    }
}

struct CompactRowsRef<'a>(&'a [LogicalRow]);

impl Serialize for CompactRowsRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut rows = serializer.serialize_seq(Some(self.0.len()))?;
        for row in self.0 {
            rows.serialize_element(&CompactRowRef(row))?;
        }
        rows.end()
    }
}

struct CompactReplacementsRef<'a>(&'a [RowReplacement]);

impl Serialize for CompactReplacementsRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut replacements = serializer.serialize_seq(Some(self.0.len()))?;
        for replacement in self.0 {
            replacements.serialize_element(&CompactReplacementRef(replacement))?;
        }
        replacements.end()
    }
}

struct CompactReplacementRef<'a>(&'a RowReplacement);

impl Serialize for CompactReplacementRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let replacement = self.0;
        let mut tuple = serializer.serialize_tuple(3)?;
        tuple.serialize_element(&replacement.row_index)?;
        tuple.serialize_element(&replacement.row_revision)?;
        tuple.serialize_element(&CompactRowRef(&replacement.row))?;
        tuple.end()
    }
}

struct CompactRowRef<'a>(&'a LogicalRow);

impl Serialize for CompactRowRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(&self.0.text)?;
        tuple.serialize_element(&CompactCellsRef(&self.0.cells))?;
        tuple.end()
    }
}

struct CompactCellsRef<'a>(&'a [LogicalCell]);

impl Serialize for CompactCellsRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut cells = serializer.serialize_seq(Some(self.0.len()))?;
        for cell in self.0 {
            cells.serialize_element(&CompactCellRef(cell))?;
        }
        cells.end()
    }
}

struct CompactCellRef<'a>(&'a LogicalCell);

impl Serialize for CompactCellRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let cell = self.0;
        let mut tuple = serializer.serialize_tuple(4)?;
        tuple.serialize_element(&cell.column)?;
        tuple.serialize_element(&cell.span)?;
        tuple.serialize_element(&cell.text)?;
        tuple.serialize_element(&CompactCellStyle::from(cell.style))?;
        tuple.end()
    }
}

struct CompactControlChangedRef<'a> {
    controller_view_id: &'a str,
    control_epoch: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
}

impl Serialize for CompactControlChangedRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut tuple = serializer.serialize_tuple(5)?;
        tuple.serialize_element(self.controller_view_id)?;
        tuple.serialize_element(&self.control_epoch)?;
        tuple.serialize_element(&self.cols)?;
        tuple.serialize_element(&self.rows)?;
        tuple.serialize_element(&self.layout_epoch)?;
        tuple.end()
    }
}

#[derive(Deserialize)]
enum CompactStateMessage {
    #[serde(rename = "s")]
    Snapshot(CompactSnapshot),
    #[serde(rename = "p")]
    Patch(CompactPatch),
    #[serde(rename = "c")]
    ControlChanged(CompactControlChanged),
    #[serde(rename = "a")]
    ActivityChanged(SessionActivity),
    #[serde(rename = "g")]
    ConfigurationChanged(TerminalPresentationConfig),
}

#[derive(Deserialize)]
struct CompactSnapshot(
    u64,
    u64,
    u64,
    u16,
    Vec<CompactRow>,
    CompactCursor,
    bool,
    CompactScrollbar,
    Option<String>,
    Option<String>,
);

#[derive(Deserialize)]
struct CompactPatch(
    u64,
    u64,
    u64,
    u64,
    Vec<CompactReplacement>,
    Option<CompactCursor>,
    Option<bool>,
    Option<CompactScrollbar>,
    u8,
);

#[derive(Deserialize)]
struct CompactReplacement(u16, u64, CompactRow);

#[derive(Deserialize)]
struct CompactRow(String, Vec<CompactCell>);

#[derive(Deserialize)]
struct CompactCell(u16, u16, String, CompactCellStyle);

#[derive(Clone, Copy, Deserialize, Serialize)]
struct CompactCellStyle(u8, Option<[u8; 3]>, Option<[u8; 3]>);

impl From<LogicalCellStyle> for CompactCellStyle {
    fn from(style: LogicalCellStyle) -> Self {
        let flags = u8::from(style.bold)
            | (u8::from(style.italic) << 1)
            | (u8::from(style.faint) << 2)
            | (u8::from(style.inverse) << 3)
            | (u8::from(style.invisible) << 4)
            | (u8::from(style.strikethrough) << 5)
            | (u8::from(style.underline) << 6);
        Self(flags, style.foreground, style.background)
    }
}

impl TryFrom<CompactCellStyle> for LogicalCellStyle {
    type Error = anyhow::Error;

    fn try_from(style: CompactCellStyle) -> Result<Self> {
        if style.0 & !0x7f != 0 {
            bail!("compact state cell style has unknown flags");
        }
        Ok(Self {
            bold: style.0 & 1 != 0,
            italic: style.0 & 2 != 0,
            faint: style.0 & 4 != 0,
            inverse: style.0 & 8 != 0,
            invisible: style.0 & 16 != 0,
            strikethrough: style.0 & 32 != 0,
            underline: style.0 & 64 != 0,
            foreground: style.1,
            background: style.2,
        })
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct CompactCursor(u16, u16, bool, u8, bool);

impl From<LogicalCursor> for CompactCursor {
    fn from(cursor: LogicalCursor) -> Self {
        Self(
            cursor.x,
            cursor.y,
            cursor.visible,
            cursor.style,
            cursor.blinking,
        )
    }
}

impl From<CompactCursor> for LogicalCursor {
    fn from(cursor: CompactCursor) -> Self {
        Self {
            x: cursor.0,
            y: cursor.1,
            visible: cursor.2,
            style: cursor.3,
            blinking: cursor.4,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct CompactScrollbar(u64, u64, u64);

impl From<LogicalScrollbar> for CompactScrollbar {
    fn from(scrollbar: LogicalScrollbar) -> Self {
        Self(scrollbar.total, scrollbar.offset, scrollbar.len)
    }
}

impl From<CompactScrollbar> for LogicalScrollbar {
    fn from(scrollbar: CompactScrollbar) -> Self {
        Self {
            total: scrollbar.0,
            offset: scrollbar.1,
            len: scrollbar.2,
        }
    }
}

#[derive(Deserialize)]
struct CompactControlChanged(String, u64, u16, u16, u64);

impl TryFrom<CompactStateMessage> for StateMessage {
    type Error = anyhow::Error;

    fn try_from(message: CompactStateMessage) -> Result<Self> {
        Ok(match message {
            CompactStateMessage::Snapshot(snapshot) => Self::Snapshot(snapshot.try_into()?),
            CompactStateMessage::Patch(patch) => Self::Patch(patch.try_into()?),
            CompactStateMessage::ControlChanged(control) => Self::ControlChanged {
                controller_view_id: control.0,
                control_epoch: control.1,
                cols: control.2,
                rows: control.3,
                layout_epoch: control.4,
            },
            CompactStateMessage::ActivityChanged(activity) => Self::ActivityChanged { activity },
            CompactStateMessage::ConfigurationChanged(presentation) => {
                Self::ConfigurationChanged { presentation }
            }
        })
    }
}

impl TryFrom<CompactSnapshot> for LogicalTerminalSnapshot {
    type Error = anyhow::Error;

    fn try_from(snapshot: CompactSnapshot) -> Result<Self> {
        Ok(Self {
            session_epoch: snapshot.0,
            layout_epoch: snapshot.1,
            terminal_revision: snapshot.2,
            cols: snapshot.3,
            rows: snapshot
                .4
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            cursor: snapshot.5.into(),
            mouse_tracking: snapshot.6,
            scrollbar: snapshot.7.into(),
            title: snapshot.8,
            cwd: snapshot.9,
        })
    }
}

impl TryFrom<CompactPatch> for LogicalTerminalPatch {
    type Error = anyhow::Error;

    fn try_from(patch: CompactPatch) -> Result<Self> {
        if patch.8 != 0 {
            bail!("compact state patch has unsupported extension flags");
        }
        Ok(Self {
            session_epoch: patch.0,
            layout_epoch: patch.1,
            patch_sequence: patch.2,
            terminal_revision: patch.3,
            row_replacements: patch
                .4
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            cursor: patch.5.map(Into::into),
            mouse_tracking: patch.6,
            scrollbar: patch.7.map(Into::into),
        })
    }
}

impl TryFrom<CompactReplacement> for RowReplacement {
    type Error = anyhow::Error;

    fn try_from(replacement: CompactReplacement) -> Result<Self> {
        Ok(Self {
            row_index: replacement.0,
            row_revision: replacement.1,
            row: replacement.2.try_into()?,
        })
    }
}

impl TryFrom<CompactRow> for LogicalRow {
    type Error = anyhow::Error;

    fn try_from(row: CompactRow) -> Result<Self> {
        Ok(Self {
            text: row.0,
            cells: row
                .1
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
        })
    }
}

impl TryFrom<CompactCell> for LogicalCell {
    type Error = anyhow::Error;

    fn try_from(cell: CompactCell) -> Result<Self> {
        Ok(Self {
            column: cell.0,
            span: cell.1,
            text: cell.2,
            style: cell.3.try_into()?,
        })
    }
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
    #[serde(default)]
    pub activity: SessionActivity,
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
    fn compact_messages_preserve_channel_and_existing_json_contract() {
        let message = SessionControlMessage::RequestSnapshot;
        let encoded = encode_compact_message(CompactChannel::Control, &message, 1024).unwrap();
        assert_eq!(encoded[4], CompactChannel::Control.as_byte());
        let (decoded, consumed) = decode_compact_message::<SessionControlMessage>(
            &encoded,
            CompactChannel::Control,
            1024,
        )
        .unwrap();
        assert!(matches!(decoded, SessionControlMessage::RequestSnapshot));
        assert_eq!(consumed, encoded.len());
        assert!(
            decode_compact_message::<SessionControlMessage>(&encoded, CompactChannel::State, 1024)
                .is_err()
        );
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
                ..
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
                ..
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
    fn activity_changes_round_trip_in_json_and_compact_state_codecs() {
        let message = StateMessage::ActivityChanged {
            activity: SessionActivity {
                kind: crate::SessionActivityKind::ForegroundJob,
                source: crate::SessionActivitySource::ProcessGroup,
                confidence: crate::SessionActivityConfidence::Heuristic,
                root_process_group_id: Some(42),
                foreground_process_group_id: Some(43),
                observed_at_ms: 100,
            },
        };
        for codec in [StateCodec::Json, StateCodec::CompactJsonV1] {
            let encoded = encode_state_message(&message, codec, 4096).unwrap();
            let (decoded, consumed) = decode_state_message(&encoded, codec, 4096).unwrap();
            assert_eq!(decoded, message);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn presentation_changes_round_trip_in_json_and_compact_state_codecs() {
        let mut snapshot = ghosttea_config::ConfigSnapshot::default();
        snapshot.revision = "remote-revision".into();
        let message = StateMessage::ConfigurationChanged {
            presentation: snapshot.terminal_presentation(),
        };
        for codec in [StateCodec::Json, StateCodec::CompactJsonV1] {
            let encoded = encode_state_message(&message, codec, 4096).unwrap();
            let (decoded, consumed) = decode_state_message(&encoded, codec, 4096).unwrap();
            assert_eq!(decoded, message);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn older_shared_summaries_default_activity_to_unknown() {
        let summary: SharedSessionSummary = serde_json::from_value(serde_json::json!({
            "sessionId": "session",
            "title": "shell",
            "cwdLabel": null,
            "running": true,
            "attachable": true,
            "readWrite": true,
            "createdAtMs": 1
        }))
        .unwrap();
        assert_eq!(summary.activity.kind, crate::SessionActivityKind::Unknown);
        assert_eq!(
            summary.activity.source,
            crate::SessionActivitySource::Unsupported
        );
    }

    #[test]
    fn compact_state_codec_round_trips_cells_and_reduces_json_size() {
        let snapshot = LogicalTerminalSnapshot {
            session_epoch: 7,
            layout_epoch: 3,
            terminal_revision: 11,
            cols: 2,
            rows: vec![LogicalRow {
                text: "ab".into(),
                cells: vec![
                    LogicalCell {
                        column: 0,
                        span: 1,
                        text: "a".into(),
                        style: LogicalCellStyle {
                            bold: true,
                            italic: true,
                            underline: true,
                            foreground: Some([1, 2, 3]),
                            background: Some([4, 5, 6]),
                            ..LogicalCellStyle::default()
                        },
                    },
                    LogicalCell {
                        column: 1,
                        span: 1,
                        text: "b".into(),
                        style: LogicalCellStyle {
                            faint: true,
                            inverse: true,
                            invisible: true,
                            strikethrough: true,
                            ..LogicalCellStyle::default()
                        },
                    },
                ],
            }],
            cursor: LogicalCursor {
                x: 1,
                y: 0,
                visible: true,
                style: 2,
                blinking: true,
            },
            mouse_tracking: true,
            scrollbar: LogicalScrollbar {
                total: 20,
                offset: 10,
                len: 1,
            },
            title: Some("title".into()),
            cwd: Some("/cwd".into()),
        };
        let message = StateMessage::Snapshot(snapshot.clone());
        let json = encode_state_message(&message, StateCodec::Json, 4096).unwrap();
        let compact = encode_state_message(&message, StateCodec::CompactJsonV1, 4096).unwrap();
        let (decoded, consumed) =
            decode_state_message(&compact, StateCodec::CompactJsonV1, 4096).unwrap();

        assert!(compact.len() * 2 < json.len());
        assert_eq!(consumed, compact.len());
        let StateMessage::Snapshot(decoded) = decoded else {
            panic!("compact snapshot decoded as the wrong state variant");
        };
        assert_eq!(decoded, snapshot);

        for message in [
            StateMessage::Patch(LogicalTerminalPatch {
                session_epoch: 7,
                layout_epoch: 3,
                patch_sequence: 1,
                terminal_revision: 12,
                row_replacements: vec![RowReplacement {
                    row_index: 0,
                    row_revision: 12,
                    row: snapshot.rows[0].clone(),
                }],
                cursor: Some(snapshot.cursor),
                mouse_tracking: Some(false),
                scrollbar: Some(snapshot.scrollbar),
            }),
            StateMessage::ControlChanged {
                controller_view_id: "view".into(),
                control_epoch: 9,
                cols: 2,
                rows: 1,
                layout_epoch: 3,
            },
        ] {
            let encoded = encode_state_message(&message, StateCodec::CompactJsonV1, 4096).unwrap();
            let decoded = decode_state_message(&encoded, StateCodec::CompactJsonV1, 4096)
                .unwrap()
                .0;
            assert_eq!(decoded, message);
        }
    }

    #[test]
    fn compact_state_fixture_is_canonical_rust_encoding() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apple/GhostteaKit/Tests/GhostteaTruffleTests/Fixtures/compact-state-v1.json"
        ))
        .unwrap();
        for key in ["snapshot", "patch", "controlChanged"] {
            let compact: CompactStateMessage =
                serde_json::from_value(fixture[key].clone()).unwrap();
            let state = StateMessage::try_from(compact).unwrap();
            let encoded = encode_state_message(&state, StateCodec::CompactJsonV1, 4096).unwrap();
            let encoded_value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();
            assert_eq!(encoded_value, fixture[key], "fixture mismatch for {key}");
        }
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
