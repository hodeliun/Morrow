use super::resolve_data_dir;
use std::io::ErrorKind;
use std::path::PathBuf;

const LEGACY_IDENTIFIER: &str = "app.morrow.desktop";
const PILOT_IDENTIFIER: &str = "app.morrow.polaris-dados-pilot";

fn profile_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("morrow-e003-profile-{label}"))
}

#[test]
fn original_identifier_keeps_desktop_mobile_and_empty_fallback_precedence() {
    let app_config = profile_path("legacy-app-config");
    let legacy_config = profile_path("legacy-config");

    // Published desktop builds keep the pre-pilot Morrow config directory.
    assert_eq!(
        resolve_data_dir(
            LEGACY_IDENTIFIER,
            Some(app_config.clone()),
            Some(legacy_config.clone()),
            None,
            false,
            false,
        )
        .unwrap(),
        legacy_config
    );

    // Mobile historically prefers Tauri's app config directory.
    assert_eq!(
        resolve_data_dir(
            LEGACY_IDENTIFIER,
            Some(app_config.clone()),
            Some(legacy_config.clone()),
            None,
            false,
            true,
        )
        .unwrap(),
        app_config
    );

    // If the preferred mobile fallback is absent, retain the legacy config fallback.
    assert_eq!(
        resolve_data_dir(
            LEGACY_IDENTIFIER,
            None,
            Some(legacy_config.clone()),
            None,
            false,
            true,
        )
        .unwrap(),
        legacy_config
    );

    // Desktop falls back to Tauri's path only when the legacy config root is unavailable.
    assert_eq!(
        resolve_data_dir(
            LEGACY_IDENTIFIER,
            Some(app_config.clone()),
            None,
            None,
            false,
            false,
        )
        .unwrap(),
        app_config
    );

    // Preserve the upstream last resort for the original identifier exactly.
    assert_eq!(
        resolve_data_dir(LEGACY_IDENTIFIER, None, None, None, false, false).unwrap(),
        PathBuf::from(".")
    );
    assert_eq!(
        resolve_data_dir(LEGACY_IDENTIFIER, None, None, None, false, true).unwrap(),
        PathBuf::from(".")
    );
}

#[test]
fn original_identifier_keeps_debug_override_literal_and_release_ignores_it() {
    let app_config = profile_path("legacy-app-fallback");
    let legacy_config = profile_path("legacy-release-config");

    for literal_override in [PathBuf::from("relative/debug-profile"), PathBuf::new()] {
        assert_eq!(
            resolve_data_dir(
                LEGACY_IDENTIFIER,
                Some(app_config.clone()),
                Some(legacy_config.clone()),
                Some(literal_override.clone()),
                true,
                false,
            )
            .unwrap(),
            literal_override
        );
    }

    assert_eq!(
        resolve_data_dir(
            LEGACY_IDENTIFIER,
            Some(app_config),
            Some(legacy_config.clone()),
            Some(PathBuf::from("relative/ignored-in-release")),
            false,
            false,
        )
        .unwrap(),
        legacy_config
    );
}

#[test]
fn alternate_identifier_requires_its_own_absolute_nonempty_app_config_path() {
    let app_config = profile_path("pilot-app-config");
    let legacy_config = profile_path("must-not-use-legacy");

    assert_eq!(
        resolve_data_dir(
            PILOT_IDENTIFIER,
            Some(app_config.clone()),
            Some(legacy_config.clone()),
            None,
            false,
            false,
        )
        .unwrap(),
        app_config
    );

    // Debug mode without an explicit override still uses the identifier's own path.
    for is_mobile in [false, true] {
        let app_config = profile_path(if is_mobile {
            "pilot-debug-mobile-config"
        } else {
            "pilot-debug-desktop-config"
        });
        assert_eq!(
            resolve_data_dir(
                PILOT_IDENTIFIER,
                Some(app_config.clone()),
                Some(profile_path("must-not-use-debug-legacy")),
                None,
                true,
                is_mobile,
            )
            .unwrap(),
            app_config
        );
    }

    // A valid app config path is returned verbatim; this resolver does not normalize it.
    let unnormalized = std::env::temp_dir()
        .join("morrow-e003-profile-parent")
        .join("..")
        .join("morrow-e003-profile-alternate");
    assert!(unnormalized.is_absolute());
    assert_eq!(
        resolve_data_dir(
            PILOT_IDENTIFIER,
            Some(unnormalized.clone()),
            None,
            None,
            false,
            false,
        )
        .unwrap(),
        unnormalized
    );

    for unavailable_or_invalid in [
        None,
        Some(PathBuf::new()),
        Some(PathBuf::from("relative/app-config")),
    ] {
        let error = resolve_data_dir(
            PILOT_IDENTIFIER,
            unavailable_or_invalid,
            Some(legacy_config.clone()),
            None,
            false,
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
    }

    // Desktop and mobile must reject the same missing profile instead of using legacy data.
    for is_mobile in [false, true] {
        let error = resolve_data_dir(
            PILOT_IDENTIFIER,
            None,
            Some(legacy_config.clone()),
            None,
            false,
            is_mobile,
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
    }
}

#[test]
fn alternate_debug_override_is_explicit_and_must_be_absolute_nonempty() {
    let override_path = profile_path("pilot-debug-override");
    assert_eq!(
        resolve_data_dir(
            PILOT_IDENTIFIER,
            None,
            Some(profile_path("must-not-use-legacy")),
            Some(override_path.clone()),
            true,
            false,
        )
        .unwrap(),
        override_path
    );

    for invalid_override in [PathBuf::new(), PathBuf::from("relative/debug-profile")] {
        let error = resolve_data_dir(
            PILOT_IDENTIFIER,
            Some(profile_path("available-config")),
            None,
            Some(invalid_override),
            true,
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }
}

#[test]
fn alternate_release_ignores_even_an_invalid_debug_override() {
    let app_config = profile_path("pilot-release-config");
    assert_eq!(
        resolve_data_dir(
            PILOT_IDENTIFIER,
            Some(app_config.clone()),
            Some(profile_path("must-not-use-legacy")),
            Some(PathBuf::from("relative/ignored-in-release")),
            false,
            false,
        )
        .unwrap(),
        app_config
    );

    let error = resolve_data_dir(
        PILOT_IDENTIFIER,
        None,
        None,
        Some(profile_path("ignored-in-release")),
        false,
        false,
    )
    .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::NotFound);
}
