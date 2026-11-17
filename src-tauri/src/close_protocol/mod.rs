use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClosePhase {
    #[default]
    Idle,
    Pending,
    Armed,
    Negative,
    Cancelled,
    Consumed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSnapshot {
    pub generation: u64,
    pub phase: ClosePhase,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CloseDecision {
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseAckDisposition {
    Armed,
    Denied,
    AlreadyArmed,
    AlreadyDenied,
    Cancelled,
    Consumed,
    Stale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseCancelDisposition {
    Cancelled,
    Negative,
    Consumed,
    Stale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseRequestAction {
    Pending { generation: u64 },
    Allow,
    Blocked,
}

#[derive(Debug, Default)]
pub struct CloseProtocol {
    generation: u64,
    phase: ClosePhase,
}

impl CloseProtocol {
    pub fn snapshot(&self) -> CloseSnapshot {
        CloseSnapshot {
            generation: self.generation,
            phase: self.phase,
        }
    }

    /// Records an OS close attempt. A consumed authorization is permanent for this window.
    pub fn on_close_requested(&mut self) -> CloseRequestAction {
        match self.phase {
            ClosePhase::Idle | ClosePhase::Negative | ClosePhase::Cancelled => {
                let Some(generation) = self.generation.checked_add(1) else {
                    return CloseRequestAction::Blocked;
                };
                self.generation = generation;
                self.phase = ClosePhase::Pending;
                CloseRequestAction::Pending { generation }
            }
            ClosePhase::Pending => CloseRequestAction::Pending {
                generation: self.generation,
            },
            ClosePhase::Armed => {
                self.phase = ClosePhase::Consumed;
                CloseRequestAction::Allow
            }
            ClosePhase::Consumed => CloseRequestAction::Allow,
        }
    }

    /// Applies a decision only to the current, still-pending native request.
    pub fn acknowledge(&mut self, generation: u64, decision: CloseDecision) -> CloseAckDisposition {
        if generation != self.generation {
            return CloseAckDisposition::Stale;
        }

        match (self.phase, decision) {
            (ClosePhase::Pending, CloseDecision::Allow) => {
                self.phase = ClosePhase::Armed;
                CloseAckDisposition::Armed
            }
            (ClosePhase::Pending, CloseDecision::Deny) => {
                self.phase = ClosePhase::Negative;
                CloseAckDisposition::Denied
            }
            (ClosePhase::Armed, _) => CloseAckDisposition::AlreadyArmed,
            (ClosePhase::Negative, _) => CloseAckDisposition::AlreadyDenied,
            (ClosePhase::Cancelled, _) => CloseAckDisposition::Cancelled,
            (ClosePhase::Consumed, _) => CloseAckDisposition::Consumed,
            (ClosePhase::Idle, _) => CloseAckDisposition::Stale,
        }
    }

    /// Invalidates a request only while its authorization has not been consumed.
    pub fn cancel(&mut self, generation: u64) -> CloseCancelDisposition {
        if generation != self.generation {
            return CloseCancelDisposition::Stale;
        }

        match self.phase {
            ClosePhase::Pending | ClosePhase::Armed => {
                self.phase = ClosePhase::Cancelled;
                CloseCancelDisposition::Cancelled
            }
            ClosePhase::Negative => CloseCancelDisposition::Negative,
            ClosePhase::Cancelled => CloseCancelDisposition::Cancelled,
            ClosePhase::Consumed => CloseCancelDisposition::Consumed,
            ClosePhase::Idle => CloseCancelDisposition::Stale,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CloseAckDisposition, CloseCancelDisposition, CloseDecision, ClosePhase, CloseProtocol,
        CloseRequestAction,
    };

    #[test]
    fn request_is_pending_coalesced_and_replayed_by_snapshot() {
        let mut protocol = CloseProtocol::default();

        assert_eq!(
            protocol.on_close_requested(),
            CloseRequestAction::Pending { generation: 1 }
        );
        assert_eq!(
            protocol.on_close_requested(),
            CloseRequestAction::Pending { generation: 1 }
        );
        assert_eq!(protocol.snapshot().generation, 1);
        assert_eq!(protocol.snapshot().phase, ClosePhase::Pending);
    }

    #[test]
    fn only_a_positive_current_ack_arms_and_the_real_close_request_consumes_once() {
        let mut protocol = CloseProtocol::default();
        assert_eq!(
            protocol.on_close_requested(),
            CloseRequestAction::Pending { generation: 1 }
        );

        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Allow),
            CloseAckDisposition::Armed
        );
        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Allow),
            CloseAckDisposition::AlreadyArmed
        );
        assert_eq!(protocol.on_close_requested(), CloseRequestAction::Allow);
        assert_eq!(protocol.snapshot().phase, ClosePhase::Consumed);
        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Deny),
            CloseAckDisposition::Consumed
        );
        assert_eq!(protocol.on_close_requested(), CloseRequestAction::Allow);
        assert_eq!(protocol.snapshot().generation, 1);
        assert_eq!(protocol.snapshot().phase, ClosePhase::Consumed);
    }

    #[test]
    fn denial_is_final_for_its_generation_and_retry_gets_a_fresh_generation() {
        let mut protocol = CloseProtocol::default();
        protocol.on_close_requested();

        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Deny),
            CloseAckDisposition::Denied
        );
        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Allow),
            CloseAckDisposition::AlreadyDenied
        );
        assert_eq!(
            protocol.on_close_requested(),
            CloseRequestAction::Pending { generation: 2 }
        );
        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Allow),
            CloseAckDisposition::Stale
        );
        assert_eq!(protocol.snapshot().phase, ClosePhase::Pending);
        assert_eq!(protocol.snapshot().generation, 2);
    }

    #[test]
    fn cancellation_invalidates_pending_or_armed_but_never_consumed() {
        for phase_to_cancel in [ClosePhase::Pending, ClosePhase::Armed] {
            let mut protocol = CloseProtocol::default();
            protocol.on_close_requested();
            if phase_to_cancel == ClosePhase::Armed {
                protocol.acknowledge(1, CloseDecision::Allow);
            }

            assert_eq!(protocol.cancel(1), CloseCancelDisposition::Cancelled);
            assert_eq!(protocol.snapshot().phase, ClosePhase::Cancelled);
            assert_eq!(
                protocol.acknowledge(1, CloseDecision::Allow),
                CloseAckDisposition::Cancelled
            );
        }

        let mut consumed = CloseProtocol::default();
        consumed.on_close_requested();
        consumed.acknowledge(1, CloseDecision::Allow);
        assert_eq!(consumed.on_close_requested(), CloseRequestAction::Allow);
        assert_eq!(consumed.cancel(1), CloseCancelDisposition::Consumed);
        assert_eq!(consumed.snapshot().phase, ClosePhase::Consumed);
    }

    #[test]
    fn stale_acknowledgements_and_cancellations_cannot_change_a_newer_request() {
        let mut protocol = CloseProtocol::default();
        protocol.on_close_requested();
        protocol.cancel(1);
        protocol.on_close_requested();

        assert_eq!(
            protocol.acknowledge(1, CloseDecision::Allow),
            CloseAckDisposition::Stale
        );
        assert_eq!(protocol.cancel(1), CloseCancelDisposition::Stale);
        assert_eq!(protocol.snapshot().generation, 2);
        assert_eq!(protocol.snapshot().phase, ClosePhase::Pending);
    }

    #[test]
    fn an_exhausted_generation_counter_blocks_without_authorizing_close() {
        let mut protocol = CloseProtocol {
            generation: u64::MAX,
            phase: ClosePhase::Cancelled,
        };

        assert_eq!(protocol.on_close_requested(), CloseRequestAction::Blocked);
        assert_eq!(protocol.snapshot().phase, ClosePhase::Cancelled);
        assert_eq!(protocol.snapshot().generation, u64::MAX);
    }
}

#[cfg(test)]
mod independent_tests;
