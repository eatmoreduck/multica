package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cloudruntime"
	"github.com/multica-ai/multica/server/internal/entitlement"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
)

// Autopilot add-on packs (MUL-9487): a one-time purchase of extra autopilot
// runs for the current month. Cloud owns the Price, the Stripe invoice and the
// limit; Multica forwards an allowlisted request and, once Cloud reports the
// purchase paid, makes every API instance read the raised limit before it
// rejects another run.

// maxAutopilotAddonPacks mirrors Cloud's bound on one purchase.
const maxAutopilotAddonPacks = 10

const maxCloudSubscriptionAutopilotAddonIdempotencyKeyLength = 200

type cloudSubscriptionAutopilotAddonPurchaseRequest struct {
	Packs              int    `json:"packs"`
	ExpectedUnitAmount int64  `json:"expected_unit_amount"`
	Currency           string `json:"currency"`
	IdempotencyKey     string `json:"idempotency_key,omitempty"`
}

// cloudSubscriptionAutopilotAddonPurchaseStatus is the one field Multica reads
// from Cloud's purchase response; the body is forwarded unchanged.
type cloudSubscriptionAutopilotAddonPurchaseStatus struct {
	Status string `json:"status"`
}

// GetCloudWorkspaceAutopilotAddon forwards the add-on purchase options: pack
// size, price, the card that will be charged and this month's purchases.
// Managers only, because it names the payment method.
func (h *Handler) GetCloudWorkspaceAutopilotAddon(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireCloudSubscriptionWorkspace(w, r, "owner", "admin")
	if !ok {
		return
	}
	h.proxyCloudSubscription(w, r, http.MethodGet, "/api/v1/subscriptions/"+workspaceID+"/autopilot-addon", userID, nil, nil)
}

// PurchaseCloudWorkspaceAutopilotAddon forwards a confirmed add-on purchase.
// The allowlisted body names only the pack count and the price the caller
// saw; Cloud repeats the price check and owns idempotency and Stripe writes.
func (h *Handler) PurchaseCloudWorkspaceAutopilotAddon(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireCloudSubscriptionWorkspace(w, r, "owner", "admin")
	if !ok {
		return
	}
	body, ok := readCloudRuntimeJSONBody(w, r)
	if !ok {
		return
	}
	var in cloudSubscriptionAutopilotAddonPurchaseRequest
	if err := json.Unmarshal(body, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if in.Packs < 1 || in.Packs > maxAutopilotAddonPacks || in.ExpectedUnitAmount < 1 || !isASCIICurrency(in.Currency) {
		writeError(w, http.StatusBadRequest, "invalid autopilot add-on purchase")
		return
	}
	key, ok := requireCloudSubscriptionIdempotencyKey(w, r, in.IdempotencyKey)
	if !ok {
		return
	}
	if len(key) > maxCloudSubscriptionAutopilotAddonIdempotencyKeyLength {
		writeError(w, http.StatusBadRequest, "autopilot add-on idempotency key must be at most 200 bytes")
		return
	}
	in.Currency = strings.ToLower(in.Currency)
	in.IdempotencyKey = key
	upstreamBody, err := json.Marshal(in)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build autopilot add-on purchase")
		return
	}
	h.proxyCloudAutopilotAddonPurchase(w, r, http.MethodPost,
		"/api/v1/subscriptions/"+workspaceID+"/autopilot-addon/purchases", workspaceID, userID, upstreamBody,
		http.Header{idempotencyKeyHeader: []string{key}})
}

// GetCloudWorkspaceAutopilotAddonPurchase forwards a purchase status read.
// Cloud settles a purchase that waited for card authentication before
// answering, so a client polls this after the payer returns.
func (h *Handler) GetCloudWorkspaceAutopilotAddonPurchase(w http.ResponseWriter, r *http.Request) {
	workspaceID, userID, ok := h.requireCloudSubscriptionWorkspace(w, r, "owner", "admin")
	if !ok {
		return
	}
	requestID, err := uuid.Parse(chi.URLParam(r, "requestId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request id")
		return
	}
	h.proxyCloudAutopilotAddonPurchase(w, r, http.MethodGet,
		"/api/v1/subscriptions/"+workspaceID+"/autopilot-addon/purchases/"+requestID.String(), workspaceID, userID, nil, nil)
}

func (h *Handler) proxyCloudAutopilotAddonPurchase(
	w http.ResponseWriter,
	r *http.Request,
	method, path, workspaceID, userID string,
	body []byte,
	headers http.Header,
) {
	if h.CloudRuntime == nil || !h.CloudRuntime.Enabled() {
		writeFeatureDisabled(w, "cloud_runtime_not_configured", "cloud runtime is not configured")
		return
	}
	resp, err := h.CloudRuntime.Do(r.Context(), cloudruntime.Request{
		Method:    method,
		Path:      path,
		Body:      body,
		UserID:    userID,
		RequestID: cloudRuntimeRequestID(r),
		Op:        "billing",
		Headers:   headers,
	})
	if err != nil {
		writeCloudRuntimeError(w, r, err)
		return
	}
	if resp.StatusCode == http.StatusOK {
		var status cloudSubscriptionAutopilotAddonPurchaseStatus
		if json.Unmarshal(resp.Body, &status) == nil && status.Status == "paid" {
			h.recordAutopilotAddonPaid(r, workspaceID)
		}
	}
	writeCloudRuntimeResponse(w, resp)
}

// recordAutopilotAddonPaid makes the raised limit effective on every API
// instance: it records the change in the shared database, which any instance
// reads before rejecting a run, and refreshes this instance's cached policy
// so the Billing page shows the new limit at once. Both are best effort: the
// purchase is already paid, and without them the cached policy still expires
// within a minute.
func (h *Handler) recordAutopilotAddonPaid(r *http.Request, workspaceID string) {
	workspaceUUID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if err := h.Queries.RecordEntitlementPolicyChange(ctx, workspaceUUID); err != nil {
		slog.Warn("record autopilot add-on policy change failed",
			append(logger.RequestAttrs(r), "workspace_id", workspaceID, "error", err)...)
	}
	if refresher, ok := h.Entitlements.(entitlement.ChangeRefresher); ok {
		refresher.RefreshGateSince(ctx, uuid.UUID(workspaceUUID.Bytes), entitlement.GateAutopilotRuns, time.Now())
	}
}
