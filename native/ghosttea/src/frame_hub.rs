use std::{
    collections::{HashMap, HashSet, VecDeque},
    ops::Deref,
    sync::{Arc, Mutex},
};

use tokio::sync::broadcast;

const FRAME_HISTORY_CAPACITY: usize = 16_384;

#[derive(Clone, Debug)]
pub struct FramePacket {
    pub ordinal: u64,
    pub session_handle: u64,
    bytes: Arc<[u8]>,
}

impl Deref for FramePacket {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}

#[derive(Clone, Copy, Debug)]
struct FrameMetadata {
    ordinal: u64,
    session_handle: u64,
}

struct FrameHubState {
    next_ordinal: u64,
    history: VecDeque<FrameMetadata>,
}

#[derive(Clone)]
pub struct FrameHub {
    sender: broadcast::Sender<FramePacket>,
    state: Arc<Mutex<FrameHubState>>,
    history_capacity: usize,
}

impl FrameHub {
    pub fn new(channel_capacity: usize) -> Self {
        Self::with_history_capacity(channel_capacity, FRAME_HISTORY_CAPACITY)
    }

    fn with_history_capacity(channel_capacity: usize, history_capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(channel_capacity);
        Self {
            sender,
            state: Arc::new(Mutex::new(FrameHubState {
                next_ordinal: 0,
                history: VecDeque::new(),
            })),
            history_capacity,
        }
    }

    pub fn publish(&self, frame: Vec<u8>) {
        let Some(session_handle) = frame_u64(&frame, 8) else {
            return;
        };
        let mut state = self.state.lock().unwrap();
        state.next_ordinal = state
            .next_ordinal
            .checked_add(1)
            .expect("terminal frame ordinal overflow");
        let ordinal = state.next_ordinal;
        state.history.push_back(FrameMetadata {
            ordinal,
            session_handle,
        });
        while state.history.len() > self.history_capacity {
            state.history.pop_front();
        }
        let _ = self.sender.send(FramePacket {
            ordinal,
            session_handle,
            bytes: Arc::from(frame),
        });
    }

    pub fn subscribe(&self) -> (broadcast::Receiver<FramePacket>, u64) {
        // Publish uses the same lock through broadcast insertion, so no packet
        // can land between the receiver cursor and its ordinal baseline.
        let state = self.state.lock().unwrap();
        let receiver = self.sender.subscribe();
        let baseline = state.next_ordinal;
        (receiver, baseline)
    }

    pub fn current_ordinal(&self) -> u64 {
        self.state.lock().unwrap().next_ordinal
    }

    pub(crate) fn affected_handles(
        &self,
        first_ordinal: u64,
        last_ordinal: u64,
        subscription_starts: &HashMap<u64, u64>,
    ) -> (Vec<u64>, bool) {
        if first_ordinal > last_ordinal || subscription_starts.is_empty() {
            return (Vec::new(), true);
        }
        let state = self.state.lock().unwrap();
        let history = &state.history;
        let complete = history
            .front()
            .zip(history.back())
            .is_some_and(|(first, last)| {
                first.ordinal <= first_ordinal && last.ordinal >= last_ordinal
            });
        let mut affected = history
            .iter()
            .filter(|metadata| {
                (first_ordinal..=last_ordinal).contains(&metadata.ordinal)
                    && subscription_starts
                        .get(&metadata.session_handle)
                        .is_some_and(|start| metadata.ordinal > *start)
            })
            .map(|metadata| metadata.session_handle)
            .collect::<HashSet<_>>();
        if !complete {
            // History is intentionally bounded. Falling back to the active set
            // preserves correctness after an extreme stall; renderer-side
            // recovery limits concurrency so this cannot become an unbounded
            // refresh fan-out.
            affected.extend(
                subscription_starts
                    .iter()
                    .filter_map(|(handle, start)| (last_ordinal > *start).then_some(*handle)),
            );
        }
        let mut affected = affected.into_iter().collect::<Vec<_>>();
        affected.sort_unstable();
        (affected, complete)
    }
}

fn frame_u64(frame: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        frame.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(handle: u64, sequence: u64) -> Vec<u8> {
        let mut frame = vec![0_u8; 48];
        frame[8..16].copy_from_slice(&handle.to_le_bytes());
        frame[40..48].copy_from_slice(&sequence.to_le_bytes());
        frame
    }

    #[test]
    fn attributes_retained_gap_history_to_only_affected_subscriptions() {
        let hub = FrameHub::with_history_capacity(2, 8);
        hub.publish(frame(11, 1));
        hub.publish(frame(22, 1));
        hub.publish(frame(11, 2));
        let subscriptions = HashMap::from([(11, 0), (22, 1), (33, 0)]);

        let (affected, complete) = hub.affected_handles(1, 3, &subscriptions);

        assert!(complete);
        assert_eq!(affected, vec![11, 22]);
    }

    #[test]
    fn bounded_history_falls_back_without_false_negatives() {
        let hub = FrameHub::with_history_capacity(2, 2);
        hub.publish(frame(11, 1));
        hub.publish(frame(22, 1));
        hub.publish(frame(11, 2));
        let subscriptions = HashMap::from([(11, 0), (22, 0), (33, 0)]);

        let (affected, complete) = hub.affected_handles(1, 3, &subscriptions);

        assert!(!complete);
        assert_eq!(affected, vec![11, 22, 33]);
    }

    #[test]
    fn subscribers_share_frame_storage_instead_of_cloning_payloads() {
        let hub = FrameHub::new(2);
        let (mut first, _) = hub.subscribe();
        let (mut second, _) = hub.subscribe();
        hub.publish(frame(11, 1));

        let first = first.try_recv().unwrap();
        let second = second.try_recv().unwrap();

        assert_eq!(first.as_ptr(), second.as_ptr());
    }
}
