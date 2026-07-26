use smallvec::SmallVec;

use crate::LogicalTerminalSnapshot;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalMetadata {
    pub cols: u16,
    pub rows: u16,
    pub title: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClipboardRequest {
    Write(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEffect {
    WriteToTransport(Vec<u8>),
    MetadataChanged(TerminalMetadata),
    Bell,
    ClipboardRequest(ClipboardRequest),
    FrameReady(Vec<u8>),
    LogicalSnapshotReady(LogicalTerminalSnapshot),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalUpdate {
    effects: SmallVec<[TerminalEffect; 4]>,
}

impl TerminalUpdate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, effect: TerminalEffect) {
        self.effects.push(effect);
    }

    pub fn as_slice(&self) -> &[TerminalEffect] {
        &self.effects
    }

    pub fn into_effects(self) -> SmallVec<[TerminalEffect; 4]> {
        self.effects
    }

    pub fn len(&self) -> usize {
        self.effects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.effects.is_empty()
    }
}

impl FromIterator<TerminalEffect> for TerminalUpdate {
    fn from_iter<T: IntoIterator<Item = TerminalEffect>>(iter: T) -> Self {
        Self {
            effects: iter.into_iter().collect(),
        }
    }
}

impl IntoIterator for TerminalUpdate {
    type Item = TerminalEffect;
    type IntoIter = smallvec::IntoIter<[TerminalEffect; 4]>;

    fn into_iter(self) -> Self::IntoIter {
        self.effects.into_iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_causal_effect_order() {
        let update: TerminalUpdate = [
            TerminalEffect::WriteToTransport(b"terminal-reply".to_vec()),
            TerminalEffect::MetadataChanged(TerminalMetadata {
                cols: 80,
                rows: 24,
                title: Some("shell".into()),
                cwd: None,
            }),
            TerminalEffect::FrameReady(b"TRF1".to_vec()),
        ]
        .into_iter()
        .collect();

        assert!(matches!(
            &update.as_slice()[0],
            TerminalEffect::WriteToTransport(bytes) if bytes == b"terminal-reply"
        ));
        assert!(matches!(
            &update.as_slice()[1],
            TerminalEffect::MetadataChanged(metadata) if metadata.title.as_deref() == Some("shell")
        ));
        assert!(matches!(
            &update.as_slice()[2],
            TerminalEffect::FrameReady(bytes) if bytes == b"TRF1"
        ));
    }
}
