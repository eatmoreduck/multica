package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cloudruntime"
	"github.com/multica-ai/multica/server/internal/featureflags"
)

func clearAutopilotAddonPolicyChange(t *testing.T) {
	t.Helper()
	testPool.Exec(context.Background(), `DELETE FROM entitlement_policy_changes WHERE workspace_id = $1`, testWorkspaceID)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM entitlement_policy_changes WHERE workspace_id = $1`, testWorkspaceID)
	})
}

func autopilotAddonPolicyChangeRecorded(t *testing.T) bool {
	t.Helper()
	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM entitlement_policy_changes WHERE workspace_id = $1`, testWorkspaceID,
	).Scan(&count); err != nil {
		t.Fatalf("count policy changes: %v", err)
	}
	return count > 0
}

func TestCloudWorkspaceAutopilotAddonReadUsesScopedPathForManagers(t *testing.T) {
	withFeatureFlag(t, testHandler, featureflags.BillingWorkspaceSubscriptions, true)
	proxy := &fakeCloudRuntimeProxy{enabled: true, resp: &cloudruntime.Response{StatusCode: http.StatusOK, Body: []byte(`{"runs_per_pack":1000}`)}}
	useCloudRuntimeProxy(t, proxy)

	w := httptest.NewRecorder()
	testHandler.GetCloudWorkspaceAutopilotAddon(w, withCloudSubscriptionWorkspace(
		newRequest(http.MethodGet, "/api/cloud-subscriptions/autopilot-addon", nil), "admin"))
	if w.Code != http.StatusOK || proxy.req.Path != "/api/v1/subscriptions/"+testWorkspaceID+"/autopilot-addon" || proxy.req.UserID != testUserID {
		t.Fatalf("status=%d upstream=%s %s user=%s", w.Code, proxy.req.Method, proxy.req.Path, proxy.req.UserID)
	}

	member := &fakeCloudRuntimeProxy{enabled: true}
	useCloudRuntimeProxy(t, member)
	w = httptest.NewRecorder()
	testHandler.GetCloudWorkspaceAutopilotAddon(w, withCloudSubscriptionWorkspace(
		newRequest(http.MethodGet, "/api/cloud-subscriptions/autopilot-addon", nil), "member"))
	if w.Code != http.StatusForbidden || member.called {
		t.Fatalf("member read status=%d called=%v; the payment method is manager-only", w.Code, member.called)
	}
}

func TestCloudWorkspaceAutopilotAddonPurchaseForwardsOnlyAllowlistedFields(t *testing.T) {
	withFeatureFlag(t, testHandler, featureflags.BillingWorkspaceSubscriptions, true)
	clearAutopilotAddonPolicyChange(t)
	proxy := &fakeCloudRuntimeProxy{enabled: true, resp: &cloudruntime.Response{
		StatusCode: http.StatusOK,
		Body:       []byte(`{"request_id":"r","status":"requires_action","payment_url":"https://invoice.stripe.com/i/x"}`),
	}}
	useCloudRuntimeProxy(t, proxy)
	req := withCloudSubscriptionWorkspace(newRequest(http.MethodPost, "/api/cloud-subscriptions/autopilot-addon/purchases", map[string]any{
		"workspace_id":         "00000000-0000-0000-0000-000000000001",
		"runs":                 999999,
		"packs":                3,
		"expected_unit_amount": 1000,
		"currency":             "USD",
		"idempotency_key":      "addon-request-1",
	}), "owner")
	w := httptest.NewRecorder()
	testHandler.PurchaseCloudWorkspaceAutopilotAddon(w, req)

	if w.Code != http.StatusOK || proxy.req.Method != http.MethodPost ||
		proxy.req.Path != "/api/v1/subscriptions/"+testWorkspaceID+"/autopilot-addon/purchases" {
		t.Fatalf("status=%d upstream=%s %s body=%s", w.Code, proxy.req.Method, proxy.req.Path, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(proxy.req.Body, &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["workspace_id"]; ok {
		t.Fatalf("client workspace leaked upstream: %v", body)
	}
	if _, ok := body["runs"]; ok {
		t.Fatalf("client run count leaked upstream: %v", body)
	}
	if body["packs"] != float64(3) || body["expected_unit_amount"] != float64(1000) ||
		body["currency"] != "usd" || body["idempotency_key"] != "addon-request-1" {
		t.Fatalf("upstream body=%v", body)
	}
	if proxy.req.Headers.Get(idempotencyKeyHeader) != "addon-request-1" {
		t.Fatalf("upstream idempotency=%q", proxy.req.Headers.Get(idempotencyKeyHeader))
	}
	if autopilotAddonPolicyChangeRecorded(t) {
		t.Fatal("a purchase still waiting for card authentication must not record a policy change")
	}
}

func TestCloudWorkspaceAutopilotAddonPaidPurchaseRecordsPolicyChange(t *testing.T) {
	withFeatureFlag(t, testHandler, featureflags.BillingWorkspaceSubscriptions, true)
	clearAutopilotAddonPolicyChange(t)
	paid := []byte(`{"request_id":"r","status":"paid","runs":1000}`)
	proxy := &fakeCloudRuntimeProxy{enabled: true, resp: &cloudruntime.Response{StatusCode: http.StatusOK, Body: paid}}
	useCloudRuntimeProxy(t, proxy)
	w := httptest.NewRecorder()
	testHandler.PurchaseCloudWorkspaceAutopilotAddon(w, withCloudSubscriptionWorkspace(
		newRequest(http.MethodPost, "/api/cloud-subscriptions/autopilot-addon/purchases", map[string]any{
			"packs": 1, "expected_unit_amount": 1000, "currency": "usd", "idempotency_key": "addon-paid-1",
		}), "admin"))
	if w.Code != http.StatusOK || w.Body.String() != string(paid) {
		t.Fatalf("status=%d body=%s; Cloud's body is forwarded unchanged", w.Code, w.Body.String())
	}
	if !autopilotAddonPolicyChangeRecorded(t) {
		t.Fatal("a paid purchase must record a policy change for other API instances")
	}
}

func TestCloudWorkspaceAutopilotAddonStatusPollRecordsPaidPurchase(t *testing.T) {
	withFeatureFlag(t, testHandler, featureflags.BillingWorkspaceSubscriptions, true)
	clearAutopilotAddonPolicyChange(t)
	requestID := uuid.NewString()
	proxy := &fakeCloudRuntimeProxy{enabled: true, resp: &cloudruntime.Response{StatusCode: http.StatusOK, Body: []byte(`{"status":"paid"}`)}}
	useCloudRuntimeProxy(t, proxy)

	req := withURLParam(withCloudSubscriptionWorkspace(
		newRequest(http.MethodGet, "/api/cloud-subscriptions/autopilot-addon/purchases/"+requestID, nil), "owner"),
		"requestId", requestID)
	w := httptest.NewRecorder()
	testHandler.GetCloudWorkspaceAutopilotAddonPurchase(w, req)
	if w.Code != http.StatusOK || proxy.req.Method != http.MethodGet ||
		proxy.req.Path != "/api/v1/subscriptions/"+testWorkspaceID+"/autopilot-addon/purchases/"+requestID {
		t.Fatalf("status=%d upstream=%s %s", w.Code, proxy.req.Method, proxy.req.Path)
	}
	if !autopilotAddonPolicyChangeRecorded(t) {
		t.Fatal("a purchase confirmed by a status poll must record a policy change")
	}

	invalid := &fakeCloudRuntimeProxy{enabled: true}
	useCloudRuntimeProxy(t, invalid)
	req = withURLParam(withCloudSubscriptionWorkspace(
		newRequest(http.MethodGet, "/api/cloud-subscriptions/autopilot-addon/purchases/x", nil), "owner"),
		"requestId", "../../billing/balance")
	w = httptest.NewRecorder()
	testHandler.GetCloudWorkspaceAutopilotAddonPurchase(w, req)
	if w.Code != http.StatusBadRequest || invalid.called {
		t.Fatalf("invalid id status=%d called=%v", w.Code, invalid.called)
	}
}

func TestCloudWorkspaceAutopilotAddonPurchaseValidatesLocally(t *testing.T) {
	withFeatureFlag(t, testHandler, featureflags.BillingWorkspaceSubscriptions, true)
	cases := map[string]map[string]any{
		"zero packs":          {"packs": 0, "expected_unit_amount": 1000, "currency": "usd", "idempotency_key": "k"},
		"too many packs":      {"packs": 11, "expected_unit_amount": 1000, "currency": "usd", "idempotency_key": "k"},
		"missing price":       {"packs": 1, "currency": "usd", "idempotency_key": "k"},
		"bad currency":        {"packs": 1, "expected_unit_amount": 1000, "currency": "us", "idempotency_key": "k"},
		"missing idempotency": {"packs": 1, "expected_unit_amount": 1000, "currency": "usd"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			proxy := &fakeCloudRuntimeProxy{enabled: true}
			useCloudRuntimeProxy(t, proxy)
			w := httptest.NewRecorder()
			testHandler.PurchaseCloudWorkspaceAutopilotAddon(w, withCloudSubscriptionWorkspace(
				newRequest(http.MethodPost, "/api/cloud-subscriptions/autopilot-addon/purchases", body), "owner"))
			if w.Code != http.StatusBadRequest || proxy.called {
				t.Fatalf("status=%d called=%v body=%s", w.Code, proxy.called, w.Body.String())
			}
		})
	}

	declined := &fakeCloudRuntimeProxy{enabled: true, resp: &cloudruntime.Response{StatusCode: http.StatusPaymentRequired, Body: []byte(`{"error":"payment failed"}`)}}
	useCloudRuntimeProxy(t, declined)
	clearAutopilotAddonPolicyChange(t)
	w := httptest.NewRecorder()
	testHandler.PurchaseCloudWorkspaceAutopilotAddon(w, withCloudSubscriptionWorkspace(
		newRequest(http.MethodPost, "/api/cloud-subscriptions/autopilot-addon/purchases", map[string]any{
			"packs": 1, "expected_unit_amount": 1000, "currency": "usd", "idempotency_key": "declined",
		}), "owner"))
	if w.Code != http.StatusPaymentRequired || autopilotAddonPolicyChangeRecorded(t) {
		t.Fatalf("declined status=%d; Cloud's 402 passes through and records nothing", w.Code)
	}

	member := &fakeCloudRuntimeProxy{enabled: true}
	useCloudRuntimeProxy(t, member)
	w = httptest.NewRecorder()
	testHandler.PurchaseCloudWorkspaceAutopilotAddon(w, withCloudSubscriptionWorkspace(
		newRequest(http.MethodPost, "/api/cloud-subscriptions/autopilot-addon/purchases", map[string]any{
			"packs": 1, "expected_unit_amount": 1000, "currency": "usd", "idempotency_key": "member",
		}), "member"))
	if w.Code != http.StatusForbidden || member.called {
		t.Fatalf("member purchase status=%d called=%v", w.Code, member.called)
	}
}
