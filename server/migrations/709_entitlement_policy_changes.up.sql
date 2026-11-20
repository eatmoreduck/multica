-- When Multica itself confirmed a change to a workspace's Cloud policy, such
-- as a paid autopilot add-on. Every API instance caches the policy for up to
-- a minute; before rejecting an autopilot run an instance compares this time
-- with its cached policy and refetches when the policy predates the change.
--
-- One row per workspace, keyed by the unique index built concurrently in 710.
-- No foreign keys (repo rule): workspace deletion removes the row explicitly.
CREATE TABLE IF NOT EXISTS entitlement_policy_changes (
    workspace_id UUID NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
