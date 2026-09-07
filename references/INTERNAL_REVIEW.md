# Internal review contract

Root chooses one stable stage boundary and dispatches `v3-sol-medium-reviewer` at Sol Medium as a fresh read-only leaf. Use the same profile for plan and code review, explicitly naming the mode. Never substitute Astra as reviewer or invoke standalone Loop Review automatically.

Provide scope paths, exclusions, governing requirements, artifact purpose, stable revision/diff marker and validation expectations. Do not provide implementation reasoning, earlier findings or scores to a fresh full review. Root must ensure the target is not being modified during review; changed inputs invalidate affected conclusions.

Plan review covers blockers, critical and serious defects by default, preserving the document's abstraction level. Code review also covers material medium defects in valid edge/recovery behavior. Exclude style and speculative improvements. Require evidence anchors, a concrete failure or contradiction, impact, and verification of each finding. Report obvious critical risks outside selected scope once.

Maintain a compact open-finding register with IDs, evidence and disposition. Omission in a later report does not close an item. Close only by verified repair or evidence-based rejection. Root assigns bounded repairs to Luna XHigh or Astra Low when implementation context is necessary. The reviewer does not supervise repair agents.

One substantive pass is the default. There is no score target or mandatory multi-round loop. Locally verify repaired findings and affected tests; this targeted verification may use the same reviewer and prior finding IDs. A fresh full review is warranted only when changes materially alter reviewed behavior, architecture, contracts or risk boundaries. Root records that reason. If review/repair repeats without new evidence, reframe the issue or request the missing owner decision rather than starting another automatic round.

Return findings, scope examined, validation evidence considered and unresolved uncertainty. Root owns acceptance; an unresolved material finding or missing required evidence prevents acceptance. Terra High may answer one concrete unresolved factual question, never provide a routine second overview.
