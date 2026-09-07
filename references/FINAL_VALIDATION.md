# Final validation contract

Root dispatches `v3-luna-xhigh-validator` after stable integration and any scheduled review repairs. This leaf owns one stage/e2e validation pass; avoid duplicate expensive runs by root and workers.

The packet includes stable revision/diff marker, acceptance criteria, required user journeys, commands, environment and service prerequisites, real versus mocked integration assumptions, permitted fixture changes and artifact directory. Root checks that the selected journeys represent the intended result. The validator flags missing coverage rather than assuming existing tests are sufficient.

Execute deterministic checks with scripts. Verify they actually ran on the intended version, inspect skipped tests and relevant failures, and map observed results to acceptance criteria. For UI work inspect screenshots/traces or the running UI where visual or interaction requirements require it. Check persistence or downstream effects when those are part of the outcome; a success message alone is insufficient. Do not mechanically inspect every passing log or rerun broad suites after each small change.

Only test artifacts and explicitly permitted isolated runtime/fixture state may be written. Do not change product code, assertions, baselines or acceptance criteria to obtain a pass. Report failures and bounded diagnostic evidence to root. Root assigns repairs separately and requests affected retesting; repeat broad validation only if a repair invalidates broad evidence. Preserve failure evidence and justify retries for suspected transient infrastructure failures; a later pass does not silently erase flakiness.

Return `PASS`, `FAIL` or `INCOMPLETE`, tested revision, environment, commands/results, per-criterion evidence, skips, artifacts, and residual uncertainty. Missing prerequisites, untested required journeys or invalidated inputs mean incomplete. Root makes final acceptance; a successful process exit is only one piece of evidence.
