-- Upsert key for RecordEntitlementPolicyChange and the admission-time lookup.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_entitlement_policy_changes_workspace
    ON entitlement_policy_changes (workspace_id);
