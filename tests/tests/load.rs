//! Every program binary must load into LiteSVM. Pinpoints which one does not.

use hookpool_tests::*;
use litesvm::LiteSVM;

#[test]
fn every_program_loads() {
    let mut failures = vec![];
    for (name, id) in [
        ("hookpool", hookpool::ID),
        ("hooklaunch", hooklaunch::ID),
        ("hook_tax", hook_tax::ID),
        ("hook_launch_guard", hook_launch_guard::ID),
        ("hook_buyback", hook_buyback::ID),
        ("hook_evil", hook_evil::ID),
        ("hook_collectible", hook_collectible::ID),
        ("hook_rules", hook_rules::ID),
    ] {
        let mut svm = LiteSVM::new();
        let bytes = so(name);
        if let Err(e) = svm.add_program(id, &bytes) {
            failures.push(format!("{name} ({} bytes): {e:?}", bytes.len()));
        }
    }
    assert!(failures.is_empty(), "programs that failed to load:\n{}", failures.join("\n"));
}
