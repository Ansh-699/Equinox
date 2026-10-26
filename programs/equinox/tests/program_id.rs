//! The compiled-in program ID is the one the build was told to use
//! (`EQUINOX_PROGRAM_ID`, default: the devnet deployment).
#[test]
fn id_is_the_configured_program_id() {
    let expected = option_env!("EQUINOX_PROGRAM_ID").unwrap_or("8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ").trim();
    assert_eq!(equinox::ID.to_string(), expected);
}
