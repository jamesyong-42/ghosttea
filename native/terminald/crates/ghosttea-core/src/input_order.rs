//! Ordering policy shared by human input, automation, and host-generated input.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputOrderState {
    human_input_epoch: u64,
    input_sequence: u64,
}

impl InputOrderState {
    pub fn human_input_epoch(&self) -> u64 {
        self.human_input_epoch
    }

    pub fn input_sequence(&self) -> u64 {
        self.input_sequence
    }

    pub fn accepts_automation(&self, expected_human_input_epoch: u64) -> bool {
        self.human_input_epoch == expected_human_input_epoch
    }

    pub fn record_input(&mut self, counts_as_human_input: bool) -> u64 {
        if counts_as_human_input {
            self.human_input_epoch = self.human_input_epoch.saturating_add(1);
        }
        self.input_sequence = self.input_sequence.saturating_add(1);
        self.input_sequence
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_input_invalidates_older_automation_epoch() {
        let mut order = InputOrderState::default();
        assert!(order.accepts_automation(0));

        assert_eq!(order.record_input(false), 1);
        assert!(order.accepts_automation(0));

        assert_eq!(order.record_input(true), 2);
        assert_eq!(order.human_input_epoch(), 1);
        assert!(!order.accepts_automation(0));
        assert!(order.accepts_automation(1));
    }
}
