use std::{
    env,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use ghosttea::tunnel_protocol::{
    CompactChannel, LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalPatch, LogicalTerminalSnapshot, MAX_STATE_MESSAGE_BYTES, RowReplacement,
    StateCodec, StateMessage, decode_compact_message, decode_state_message, encode_compact_message,
    encode_state_message,
};
use ghosttea::{RemoteReplica, TextEngine};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{Barrier, broadcast};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Workload {
    Sparse,
    Dense,
    Truecolor,
    Resync,
}

impl Workload {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "sparse" => Ok(Self::Sparse),
            "dense" => Ok(Self::Dense),
            "truecolor" => Ok(Self::Truecolor),
            "resync" => Ok(Self::Resync),
            _ => bail!("unknown workload {value:?}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ApplyMode {
    Decode,
    Replica,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Transport {
    QuicProtocolLoopback,
    CompactLoopback,
}

impl Transport {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "quic-protocol-loopback" => Ok(Self::QuicProtocolLoopback),
            "compact-loopback" => Ok(Self::CompactLoopback),
            _ => bail!("unknown transport {value:?}"),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::QuicProtocolLoopback => "quic-protocol-loopback",
            Self::CompactLoopback => "compact-loopback",
        }
    }
}

impl ApplyMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "decode" => Ok(Self::Decode),
            "replica" => Ok(Self::Replica),
            _ => bail!("unknown apply mode {value:?}"),
        }
    }
}

#[derive(Clone, Debug)]
struct Options {
    transport: Transport,
    state_codec: StateCodec,
    workload: Workload,
    apply: ApplyMode,
    updates: usize,
    cols: u16,
    rows: u16,
    fanout: usize,
    warmup: usize,
    iterations: usize,
    cooldown_ms: u64,
    duplex_bytes: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            transport: Transport::QuicProtocolLoopback,
            state_codec: StateCodec::CompactJsonV1,
            workload: Workload::Sparse,
            apply: ApplyMode::Replica,
            updates: 180,
            cols: 120,
            rows: 40,
            fanout: 1,
            warmup: 1,
            iterations: 5,
            cooldown_ms: 250,
            duplex_bytes: 64 * 1024,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct ResourceUsage {
    user_ms: f64,
    system_ms: f64,
    peak_rss_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LatencySummary {
    count: usize,
    min_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    wall_ms: f64,
    producer_encode_ms: f64,
    producer_write_ms: f64,
    receiver_decode_ms: f64,
    replica_apply_ms: f64,
    text_engine_wait_ms: f64,
    text_engine_hold_ms: f64,
    replica_row_prepare_ms: f64,
    trf1_encode_ms: f64,
    replica_other_ms: f64,
    wire_bytes: u64,
    source_wire_bytes: u64,
    messages_sent: usize,
    messages_received: usize,
    snapshots: usize,
    patches: usize,
    row_replacements: usize,
    trf1_frames: usize,
    trf1_bytes: u64,
    throughput_mib_per_second: f64,
    latency: LatencySummary,
    user_cpu_ms: f64,
    system_cpu_ms: f64,
    peak_rss_bytes: u64,
    checksum: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    schema_version: u32,
    suite: &'a str,
    transport: &'a str,
    state_codec: &'a str,
    workload: Workload,
    apply: ApplyMode,
    updates: usize,
    cols: u16,
    rows: u16,
    fanout: usize,
    warmup_iterations: usize,
    measured_iterations: usize,
    cooldown_ms: u64,
    duplex_bytes: usize,
    samples: Vec<Sample>,
}

struct ReceiverResult {
    decode: Duration,
    apply: Duration,
    text_engine_wait: Duration,
    text_engine_hold: Duration,
    row_prepare: Duration,
    frame_encode: Duration,
    messages: usize,
    snapshots: usize,
    patches: usize,
    row_replacements: usize,
    trf1_frames: usize,
    trf1_bytes: u64,
    latencies_ms: Vec<f64>,
    checksum: u64,
}

struct ProducerResult {
    encode: Duration,
    write: Duration,
    wire_bytes: u64,
    messages: usize,
}

#[derive(Clone)]
struct ReceiverConfig {
    apply: ApplyMode,
    engine: Option<Arc<Mutex<TextEngine>>>,
    sent_at_ns: Arc<Vec<AtomicU64>>,
    started: Instant,
    cols: u16,
    rows: u16,
    transport: Transport,
    state_codec: StateCodec,
}

struct ProtocolReader {
    stream: DuplexStream,
    buffered: Vec<u8>,
    start: usize,
    transport: Transport,
    state_codec: StateCodec,
}

impl ProtocolReader {
    fn new(stream: DuplexStream, transport: Transport, state_codec: StateCodec) -> Self {
        Self {
            stream,
            buffered: Vec::new(),
            start: 0,
            transport,
            state_codec,
        }
    }

    async fn read_message(&mut self) -> Result<Option<StateMessage>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let framed_len = u32::from_be_bytes(
            self.buffered[self.start..self.start + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        match self.transport {
            Transport::QuicProtocolLoopback if framed_len > MAX_STATE_MESSAGE_BYTES => {
                bail!("terminal protocol message exceeds limit");
            }
            Transport::CompactLoopback
                if framed_len == 0 || framed_len - 1 > MAX_STATE_MESSAGE_BYTES =>
            {
                bail!("compact terminal message exceeds limit");
            }
            _ => {}
        }
        let total = 4 + framed_len;
        if !self.fill(total).await? {
            bail!("EOF in terminal benchmark message");
        }
        let encoded = &self.buffered[self.start..self.start + total];
        let message = match self.transport {
            Transport::QuicProtocolLoopback => {
                decode_state_message(encoded, self.state_codec, MAX_STATE_MESSAGE_BYTES)?.0
            }
            Transport::CompactLoopback => {
                decode_compact_message(encoded, CompactChannel::State, MAX_STATE_MESSAGE_BYTES)?.0
            }
        };
        self.consume(total);
        Ok(Some(message))
    }

    async fn fill(&mut self, length: usize) -> Result<bool> {
        while self.buffered.len() - self.start < length {
            self.compact();
            self.buffered.reserve(64 * 1024);
            let read = self.stream.read_buf(&mut self.buffered).await?;
            if read == 0 {
                if self.buffered.len() == self.start {
                    return Ok(false);
                }
                bail!("truncated terminal benchmark stream");
            }
        }
        Ok(true)
    }

    fn consume(&mut self, length: usize) {
        self.start += length;
        if self.start == self.buffered.len() {
            self.buffered.clear();
            self.start = 0;
        }
    }

    fn compact(&mut self) {
        if self.start == 0 {
            return;
        }
        let available = self.buffered.len() - self.start;
        self.buffered.copy_within(self.start.., 0);
        self.buffered.truncate(available);
        self.start = 0;
    }
}

fn parse_options() -> Result<Options> {
    let mut options = Options::default();
    for argument in env::args().skip(1) {
        if let Some(value) = argument.strip_prefix("--transport=") {
            options.transport = Transport::parse(value)?;
        } else if let Some(value) = argument.strip_prefix("--state-codec=") {
            options.state_codec = match value {
                "json" => StateCodec::Json,
                "compact-json-v1" => StateCodec::CompactJsonV1,
                _ => bail!("unknown state codec {value:?}"),
            };
        } else if let Some(value) = argument.strip_prefix("--workload=") {
            options.workload = Workload::parse(value)?;
        } else if let Some(value) = argument.strip_prefix("--apply=") {
            options.apply = ApplyMode::parse(value)?;
        } else if let Some(value) = argument.strip_prefix("--updates=") {
            options.updates = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--cols=") {
            options.cols = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--rows=") {
            options.rows = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--fanout=") {
            options.fanout = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--warmup=") {
            options.warmup = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--iterations=") {
            options.iterations = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--cooldown-ms=") {
            options.cooldown_ms = value.parse()?;
        } else if let Some(value) = argument.strip_prefix("--duplex-bytes=") {
            options.duplex_bytes = value.parse()?;
        } else if argument == "--help" || argument == "-h" {
            println!(
                "Usage: replication_bench [--transport=quic-protocol-loopback|compact-loopback] [--state-codec=json|compact-json-v1] [--workload=sparse|dense|truecolor|resync] [--apply=decode|replica] [--updates=180] [--fanout=1] [--warmup=1] [--iterations=5] [--cooldown-ms=250] [--cols=120] [--rows=40] [--duplex-bytes=65536]"
            );
            std::process::exit(0);
        } else {
            bail!("unknown argument {argument:?}");
        }
    }
    if options.updates == 0
        || options.rows == 0
        || options.cols == 0
        || options.fanout == 0
        || options.iterations == 0
        || options.duplex_bytes < 1024
    {
        bail!("updates, dimensions, fanout, iterations, and duplex capacity must be positive");
    }
    if options.transport == Transport::CompactLoopback && options.state_codec != StateCodec::Json {
        bail!("compact-loopback models the Apple JSON contract and requires --state-codec=json");
    }
    Ok(options)
}

fn state_codec_label(codec: StateCodec) -> &'static str {
    match codec {
        StateCodec::Json => "json",
        StateCodec::CompactJsonV1 => "compact-json-v1",
    }
}

fn plain_row(cols: u16, row: usize, revision: u64) -> LogicalRow {
    let marker = format!("{revision:08x}:{row:04x} ");
    let text = marker
        .chars()
        .cycle()
        .take(cols as usize)
        .collect::<String>();
    LogicalRow {
        cells: vec![LogicalCell {
            column: 0,
            span: cols,
            text: text.clone(),
            style: LogicalCellStyle::default(),
        }],
        text,
    }
}

fn truecolor_row(cols: u16, row: usize, revision: u64) -> LogicalRow {
    let text = "▀".repeat(cols as usize);
    let cells = (0..cols)
        .map(|column| {
            let value = revision
                .wrapping_mul(17)
                .wrapping_add(row as u64 * 13 + column as u64);
            LogicalCell {
                column,
                span: 1,
                text: "▀".into(),
                style: LogicalCellStyle {
                    foreground: Some([
                        value as u8,
                        value.wrapping_mul(3) as u8,
                        value.wrapping_mul(7) as u8,
                    ]),
                    background: Some([
                        value.wrapping_mul(11) as u8,
                        value.wrapping_mul(5) as u8,
                        value.wrapping_mul(2) as u8,
                    ]),
                    ..LogicalCellStyle::default()
                },
            }
        })
        .collect();
    LogicalRow { text, cells }
}

fn snapshot(options: &Options, revision: u64) -> LogicalTerminalSnapshot {
    let rows = (0..options.rows as usize)
        .map(|row| match options.workload {
            Workload::Truecolor => truecolor_row(options.cols, row, revision),
            _ => plain_row(options.cols, row, revision),
        })
        .collect();
    LogicalTerminalSnapshot {
        session_epoch: 1,
        layout_epoch: 1,
        terminal_revision: revision,
        cols: options.cols,
        rows,
        cursor: LogicalCursor {
            x: 0,
            y: 0,
            visible: true,
            style: 0,
            blinking: false,
        },
        mouse_tracking: false,
        scrollbar: LogicalScrollbar {
            total: options.rows as u64,
            offset: 0,
            len: options.rows as u64,
        },
        title: Some("Truffle replication benchmark".into()),
        cwd: Some("/benchmark".into()),
    }
}

fn messages(options: &Options) -> Vec<StateMessage> {
    let mut output = Vec::with_capacity(options.updates + 1);
    output.push(StateMessage::Snapshot(snapshot(options, 1)));
    for update in 0..options.updates {
        let revision = update as u64 + 2;
        if matches!(options.workload, Workload::Resync) {
            output.push(StateMessage::Snapshot(snapshot(options, revision)));
            continue;
        }
        let changed_rows: Vec<usize> = match options.workload {
            Workload::Sparse => vec![update % options.rows as usize],
            Workload::Dense | Workload::Truecolor => (0..options.rows as usize).collect(),
            Workload::Resync => unreachable!(),
        };
        output.push(StateMessage::Patch(LogicalTerminalPatch {
            session_epoch: 1,
            layout_epoch: 1,
            patch_sequence: update as u64 + 1,
            terminal_revision: revision,
            row_replacements: changed_rows
                .into_iter()
                .map(|row| RowReplacement {
                    row_index: row as u16,
                    row_revision: revision,
                    row: match options.workload {
                        Workload::Truecolor => truecolor_row(options.cols, row, revision),
                        _ => plain_row(options.cols, row, revision),
                    },
                })
                .collect(),
            cursor: Some(LogicalCursor {
                x: (revision % options.cols as u64) as u16,
                y: (revision % options.rows as u64) as u16,
                visible: true,
                style: 0,
                blinking: false,
            }),
            mouse_tracking: None,
            scrollbar: None,
        }));
    }
    output
}

async fn receive(stream: DuplexStream, config: ReceiverConfig) -> Result<ReceiverResult> {
    let mut reader = ProtocolReader::new(stream, config.transport, config.state_codec);
    let mut replica = None;
    let mut frames = None;
    if config.apply == ApplyMode::Replica {
        let (frame_tx, frame_rx) = broadcast::channel(config.sent_at_ns.len() + 1);
        replica = Some(RemoteReplica::new(
            "remote".into(),
            None,
            config.cols,
            config.rows,
            None,
            frame_tx,
            config
                .engine
                .context("replica mode requires a text engine")?,
        ));
        frames = Some(frame_rx);
    }
    let mut result = ReceiverResult {
        decode: Duration::ZERO,
        apply: Duration::ZERO,
        text_engine_wait: Duration::ZERO,
        text_engine_hold: Duration::ZERO,
        row_prepare: Duration::ZERO,
        frame_encode: Duration::ZERO,
        messages: 0,
        snapshots: 0,
        patches: 0,
        row_replacements: 0,
        trf1_frames: 0,
        trf1_bytes: 0,
        latencies_ms: Vec::with_capacity(config.sent_at_ns.len()),
        checksum: 0,
    };
    while result.messages < config.sent_at_ns.len() {
        let decode_started = Instant::now();
        let message = reader
            .read_message()
            .await?
            .context("benchmark stream closed early")?;
        result.decode += decode_started.elapsed();
        let apply_started = Instant::now();
        let mut rendered = false;
        let revision = match message {
            StateMessage::Snapshot(snapshot) => {
                result.snapshots += 1;
                result.row_replacements += snapshot.rows.len();
                let revision = snapshot.terminal_revision;
                if let Some(replica) = replica.as_ref() {
                    replica.publish(snapshot)?;
                    rendered = true;
                }
                revision
            }
            StateMessage::Patch(patch) => {
                result.patches += 1;
                result.row_replacements += patch.row_replacements.len();
                let revision = patch.terminal_revision;
                if let Some(replica) = replica.as_ref() {
                    replica.publish_patch(patch)?;
                    rendered = true;
                }
                revision
            }
            StateMessage::ControlChanged { control_epoch, .. } => control_epoch,
        };
        result.apply += apply_started.elapsed();
        if rendered {
            let performance = replica.as_ref().unwrap().text_engine_performance();
            result.text_engine_wait += Duration::from_nanos(performance.wait_nanoseconds);
            result.text_engine_hold += Duration::from_nanos(performance.hold_nanoseconds);
            let performance = replica.as_ref().unwrap().render_performance();
            result.row_prepare += Duration::from_nanos(performance.row_prepare_nanoseconds);
            result.frame_encode += Duration::from_nanos(performance.frame_encode_nanoseconds);
        }
        if let Some(frames) = frames.as_mut() {
            let frame = frames
                .try_recv()
                .context("replica did not publish a TRF1 frame")?;
            result.trf1_frames += 1;
            result.trf1_bytes += frame.len() as u64;
        }
        result.checksum = result
            .checksum
            .wrapping_mul(16_777_619)
            .wrapping_add(revision);
        let sent = config.sent_at_ns[result.messages].load(Ordering::Acquire);
        let received = config.started.elapsed().as_nanos() as u64;
        result
            .latencies_ms
            .push(received.saturating_sub(sent) as f64 / 1_000_000.0);
        result.messages += 1;
    }
    Ok(result)
}

async fn send(
    mut stream: DuplexStream,
    messages: Arc<Vec<StateMessage>>,
    sent_at_ns: Arc<Vec<AtomicU64>>,
    started: Instant,
    transport: Transport,
    state_codec: StateCodec,
    start_barrier: Arc<Barrier>,
) -> Result<ProducerResult> {
    let mut result = ProducerResult {
        encode: Duration::ZERO,
        write: Duration::ZERO,
        wire_bytes: 0,
        messages: 0,
    };
    start_barrier.wait().await;
    for (index, message) in messages.iter().enumerate() {
        sent_at_ns[index].store(started.elapsed().as_nanos() as u64, Ordering::Release);
        let encode_started = Instant::now();
        let encoded = match transport {
            Transport::QuicProtocolLoopback => {
                encode_state_message(message, state_codec, MAX_STATE_MESSAGE_BYTES)?
            }
            Transport::CompactLoopback => {
                encode_compact_message(CompactChannel::State, message, MAX_STATE_MESSAGE_BYTES)?
            }
        };
        result.encode += encode_started.elapsed();
        result.wire_bytes += encoded.len() as u64;
        let write_started = Instant::now();
        stream.write_all(&encoded).await?;
        result.write += write_started.elapsed();
        result.messages += 1;
    }
    stream.shutdown().await?;
    Ok(result)
}

async fn run_sample(options: &Options, engine: Option<Arc<Mutex<TextEngine>>>) -> Result<Sample> {
    let messages = Arc::new(messages(options));
    let start_barrier = Arc::new(Barrier::new(options.fanout + 1));
    let mut producers = Vec::with_capacity(options.fanout);
    let mut receivers = Vec::with_capacity(options.fanout);
    let started = Instant::now();
    for _ in 0..options.fanout {
        let (writer, reader) = tokio::io::duplex(options.duplex_bytes);
        let sent_at_ns = Arc::new(
            (0..messages.len())
                .map(|_| AtomicU64::new(0))
                .collect::<Vec<_>>(),
        );
        receivers.push(tokio::spawn(receive(
            reader,
            ReceiverConfig {
                apply: options.apply,
                engine: engine.clone(),
                sent_at_ns: Arc::clone(&sent_at_ns),
                started,
                cols: options.cols,
                rows: options.rows,
                transport: options.transport,
                state_codec: options.state_codec,
            },
        )));
        producers.push(tokio::spawn(send(
            writer,
            Arc::clone(&messages),
            sent_at_ns,
            started,
            options.transport,
            options.state_codec,
            Arc::clone(&start_barrier),
        )));
    }
    let resources_before = resource_usage();
    start_barrier.wait().await;
    let mut encode = Duration::ZERO;
    let mut write = Duration::ZERO;
    let mut wire_bytes = 0_u64;
    let mut source_wire_bytes = 0_u64;
    let mut messages_sent = 0;
    for (client, producer) in producers.into_iter().enumerate() {
        let result = producer
            .await
            .context("replication producer task failed")??;
        encode += result.encode;
        write += result.write;
        wire_bytes += result.wire_bytes;
        messages_sent += result.messages;
        if client == 0 {
            source_wire_bytes = result.wire_bytes;
        }
    }

    let mut receiver_decode = Duration::ZERO;
    let mut replica_apply = Duration::ZERO;
    let mut text_engine_wait = Duration::ZERO;
    let mut text_engine_hold = Duration::ZERO;
    let mut row_prepare = Duration::ZERO;
    let mut frame_encode = Duration::ZERO;
    let mut messages_received = 0;
    let mut snapshots = 0;
    let mut patches = 0;
    let mut row_replacements = 0;
    let mut trf1_frames = 0;
    let mut trf1_bytes = 0;
    let mut latencies_ms = Vec::with_capacity(messages.len() * options.fanout);
    let mut checksum = 0_u64;
    for receiver in receivers {
        let result = receiver
            .await
            .context("replication receiver task failed")??;
        receiver_decode += result.decode;
        replica_apply += result.apply;
        text_engine_wait += result.text_engine_wait;
        text_engine_hold += result.text_engine_hold;
        row_prepare += result.row_prepare;
        frame_encode += result.frame_encode;
        messages_received += result.messages;
        snapshots += result.snapshots;
        patches += result.patches;
        row_replacements += result.row_replacements;
        trf1_frames += result.trf1_frames;
        trf1_bytes += result.trf1_bytes;
        latencies_ms.extend(result.latencies_ms);
        checksum = checksum.wrapping_add(result.checksum);
    }
    let wall = started.elapsed();
    let resources_after = resource_usage();
    let replica_other = replica_apply.saturating_sub(text_engine_wait + text_engine_hold);
    Ok(Sample {
        wall_ms: milliseconds(wall),
        producer_encode_ms: milliseconds(encode),
        producer_write_ms: milliseconds(write),
        receiver_decode_ms: milliseconds(receiver_decode),
        replica_apply_ms: milliseconds(replica_apply),
        text_engine_wait_ms: milliseconds(text_engine_wait),
        text_engine_hold_ms: milliseconds(text_engine_hold),
        replica_row_prepare_ms: milliseconds(row_prepare),
        trf1_encode_ms: milliseconds(frame_encode),
        replica_other_ms: milliseconds(replica_other),
        wire_bytes,
        source_wire_bytes,
        messages_sent,
        messages_received,
        snapshots,
        patches,
        row_replacements,
        trf1_frames,
        trf1_bytes,
        throughput_mib_per_second: wire_bytes as f64 / wall.as_secs_f64() / (1024.0 * 1024.0),
        latency: summarize(latencies_ms),
        user_cpu_ms: (resources_after.user_ms - resources_before.user_ms).max(0.0),
        system_cpu_ms: (resources_after.system_ms - resources_before.system_ms).max(0.0),
        peak_rss_bytes: resources_after.peak_rss_bytes,
        checksum,
    })
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn percentile(sorted: &[f64], value: f64) -> f64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = value * (sorted.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower as f64)
}

fn summarize(mut values: Vec<f64>) -> LatencySummary {
    values.sort_by(f64::total_cmp);
    LatencySummary {
        count: values.len(),
        min_ms: values[0],
        p50_ms: percentile(&values, 0.50),
        p95_ms: percentile(&values, 0.95),
        p99_ms: percentile(&values, 0.99),
        max_ms: *values.last().unwrap(),
    }
}

#[cfg(unix)]
fn resource_usage() -> ResourceUsage {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return ResourceUsage::default();
    }
    let usage = unsafe { usage.assume_init() };
    let timeval_ms =
        |value: libc::timeval| value.tv_sec as f64 * 1_000.0 + value.tv_usec as f64 / 1_000.0;
    #[cfg(target_os = "macos")]
    let peak_rss_bytes = usage.ru_maxrss as u64;
    #[cfg(not(target_os = "macos"))]
    let peak_rss_bytes = usage.ru_maxrss as u64 * 1024;
    ResourceUsage {
        user_ms: timeval_ms(usage.ru_utime),
        system_ms: timeval_ms(usage.ru_stime),
        peak_rss_bytes,
    }
}

#[cfg(not(unix))]
fn resource_usage() -> ResourceUsage {
    ResourceUsage::default()
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let options = parse_options()?;
    let engine = if options.apply == ApplyMode::Replica {
        Some(Arc::new(Mutex::new(TextEngine::discover()?)))
    } else {
        None
    };
    for _ in 0..options.warmup {
        let _ = run_sample(&options, engine.clone()).await?;
        tokio::time::sleep(Duration::from_millis(options.cooldown_ms)).await;
    }
    let mut samples = Vec::with_capacity(options.iterations);
    for iteration in 0..options.iterations {
        samples.push(run_sample(&options, engine.clone()).await?);
        if iteration + 1 < options.iterations {
            tokio::time::sleep(Duration::from_millis(options.cooldown_ms)).await;
        }
    }
    println!(
        "{}",
        serde_json::to_string(&Report {
            schema_version: 1,
            suite: "ghosttea-truffle-replication-v1",
            transport: options.transport.label(),
            state_codec: state_codec_label(options.state_codec),
            workload: options.workload,
            apply: options.apply,
            updates: options.updates,
            cols: options.cols,
            rows: options.rows,
            fanout: options.fanout,
            warmup_iterations: options.warmup,
            measured_iterations: options.iterations,
            cooldown_ms: options.cooldown_ms,
            duplex_bytes: options.duplex_bytes,
            samples,
        })?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(workload: Workload) -> Options {
        Options {
            workload,
            updates: 3,
            cols: 8,
            rows: 4,
            fanout: 1,
            warmup: 0,
            iterations: 1,
            cooldown_ms: 0,
            ..Options::default()
        }
    }

    #[test]
    fn sparse_workload_starts_with_a_snapshot_then_replaces_one_row() {
        let generated = messages(&options(Workload::Sparse));
        assert_eq!(generated.len(), 4);
        assert!(matches!(generated[0], StateMessage::Snapshot(_)));
        for message in &generated[1..] {
            let StateMessage::Patch(patch) = message else {
                panic!("sparse update was not a patch");
            };
            assert_eq!(patch.row_replacements.len(), 1);
        }
    }

    #[test]
    fn truecolor_workload_replaces_every_cell_in_every_row() {
        let generated = messages(&options(Workload::Truecolor));
        let StateMessage::Patch(patch) = &generated[1] else {
            panic!("truecolor update was not a patch");
        };
        assert_eq!(patch.row_replacements.len(), 4);
        assert!(patch.row_replacements.iter().all(|replacement| {
            replacement.row.cells.len() == 8
                && replacement
                    .row
                    .cells
                    .iter()
                    .all(|cell| cell.style.foreground.is_some() && cell.style.background.is_some())
        }));
    }

    #[test]
    fn resync_workload_uses_only_full_snapshots() {
        let generated = messages(&options(Workload::Resync));
        assert!(
            generated
                .iter()
                .all(|message| matches!(message, StateMessage::Snapshot(_)))
        );
    }

    #[tokio::test]
    async fn both_protocol_tiers_account_for_every_message_and_receiver() -> Result<()> {
        let mut options = options(Workload::Sparse);
        options.apply = ApplyMode::Decode;
        options.fanout = 2;
        for transport in [Transport::QuicProtocolLoopback, Transport::CompactLoopback] {
            options.transport = transport;
            options.state_codec = if transport == Transport::CompactLoopback {
                StateCodec::Json
            } else {
                StateCodec::CompactJsonV1
            };
            let sample = run_sample(&options, None).await?;
            assert_eq!(sample.messages_sent, 8);
            assert_eq!(sample.messages_received, 8);
            assert_eq!(sample.snapshots, 2);
            assert_eq!(sample.patches, 6);
            assert_eq!(sample.row_replacements, 14);
            assert_eq!(sample.latency.count, 8);
            assert_eq!(sample.wire_bytes, sample.source_wire_bytes * 2);
        }
        Ok(())
    }
}
