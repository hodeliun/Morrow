use super::{
    CloseAckDisposition, CloseCancelDisposition, CloseDecision, ClosePhase, CloseProtocol,
    CloseRequestAction, CloseSnapshot,
};
use serde_json::json;

#[test]
fn snapshot_stays_armed_until_the_real_close_event_consumes_authorization() {
    let mut protocol = CloseProtocol::default();

    assert_eq!(
        protocol.on_close_requested(),
        CloseRequestAction::Pending { generation: 1 }
    );
    assert_eq!(
        protocol.snapshot(),
        CloseSnapshot {
            generation: 1,
            phase: ClosePhase::Pending,
        }
    );

    assert_eq!(
        protocol.acknowledge(1, CloseDecision::Allow),
        CloseAckDisposition::Armed
    );
    assert_eq!(protocol.snapshot().phase, ClosePhase::Armed);

    // Authorization alone is not consumption. The next native CloseRequested event consumes it.
    assert_eq!(protocol.on_close_requested(), CloseRequestAction::Allow);
    assert_eq!(protocol.snapshot().phase, ClosePhase::Consumed);

    // Consumption is irreversible and does not create a later generation.
    assert_eq!(protocol.cancel(1), CloseCancelDisposition::Consumed);
    assert_eq!(
        protocol.acknowledge(1, CloseDecision::Deny),
        CloseAckDisposition::Consumed
    );
    assert_eq!(protocol.on_close_requested(), CloseRequestAction::Allow);
    assert_eq!(protocol.snapshot().generation, 1);
    assert_eq!(protocol.snapshot().phase, ClosePhase::Consumed);
}

#[test]
fn cancelling_an_armed_request_makes_late_ack_inert_after_retry() {
    let mut protocol = CloseProtocol::default();

    assert_eq!(
        protocol.on_close_requested(),
        CloseRequestAction::Pending { generation: 1 }
    );
    assert_eq!(
        protocol.acknowledge(1, CloseDecision::Allow),
        CloseAckDisposition::Armed
    );
    assert_eq!(protocol.cancel(1), CloseCancelDisposition::Cancelled);
    assert_eq!(protocol.snapshot().phase, ClosePhase::Cancelled);

    assert_eq!(
        protocol.on_close_requested(),
        CloseRequestAction::Pending { generation: 2 }
    );
    assert_eq!(
        protocol.acknowledge(1, CloseDecision::Allow),
        CloseAckDisposition::Stale
    );
    assert_eq!(protocol.cancel(1), CloseCancelDisposition::Stale);
    assert_eq!(
        protocol.snapshot(),
        CloseSnapshot {
            generation: 2,
            phase: ClosePhase::Pending,
        }
    );
}

#[test]
fn snapshot_and_dispositions_keep_the_tauri_wire_names() {
    let snapshot = CloseSnapshot {
        generation: 9,
        phase: ClosePhase::Pending,
    };
    assert_eq!(
        serde_json::to_value(snapshot).unwrap(),
        json!({ "generation": 9, "phase": "pending" })
    );
    assert_eq!(
        serde_json::to_value(ClosePhase::Consumed).unwrap(),
        json!("consumed")
    );
    assert_eq!(
        serde_json::to_value(CloseAckDisposition::AlreadyArmed).unwrap(),
        json!("alreadyArmed")
    );
    assert_eq!(
        serde_json::to_value(CloseCancelDisposition::Consumed).unwrap(),
        json!("consumed")
    );
    assert_eq!(
        serde_json::from_value::<CloseDecision>(json!("allow")).unwrap(),
        CloseDecision::Allow
    );
    assert_eq!(
        serde_json::from_value::<CloseDecision>(json!("deny")).unwrap(),
        CloseDecision::Deny
    );
}
