use super::{initialized_service, service_for_identifier, KEYCHAIN_USER};

const PILOT_IDENTIFIER: &str = "app.morrow.polaris-dados-pilot";
const OTHER_IDENTIFIER: &str = "org.example.morrow-preview";

#[test]
fn published_identifier_keeps_the_legacy_service_name_and_account() {
    assert_eq!(service_for_identifier("app.morrow.desktop"), "Morrow");
    assert_eq!(KEYCHAIN_USER, "assistant");
}

#[test]
fn each_alternate_identifier_gets_a_fixed_namespace_and_its_verbatim_identifier() {
    assert_eq!(
        service_for_identifier(PILOT_IDENTIFIER),
        format!("Morrow/{PILOT_IDENTIFIER}")
    );
    assert_eq!(
        service_for_identifier(OTHER_IDENTIFIER),
        format!("Morrow/{OTHER_IDENTIFIER}")
    );
    assert_eq!(
        service_for_identifier("Com.Example.Morrow-preview"),
        "Morrow/Com.Example.Morrow-preview"
    );
}

#[test]
fn alternate_services_are_deterministic_and_distinct_from_legacy_and_each_other() {
    let pilot_service = service_for_identifier(PILOT_IDENTIFIER);
    let other_service = service_for_identifier(OTHER_IDENTIFIER);

    assert_eq!(service_for_identifier(PILOT_IDENTIFIER), pilot_service);
    assert_ne!(pilot_service, "Morrow");
    assert_ne!(other_service, "Morrow");
    assert_ne!(pilot_service, other_service);
}

#[test]
fn missing_identity_produces_no_service_instead_of_the_legacy_default() {
    assert_eq!(initialized_service(None), None);

    let alternate = service_for_identifier(OTHER_IDENTIFIER);
    assert_eq!(
        initialized_service(Some(&alternate)),
        Some(alternate.as_str())
    );
    assert_ne!(initialized_service(None), Some("Morrow"));
}
