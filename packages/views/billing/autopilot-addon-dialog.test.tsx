import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type {
  WorkspaceAutopilotAddon,
  WorkspaceAutopilotAddonPurchase,
} from "@multica/core/types";
import enBilling from "../locales/en/billing.json";

const apiMock = vi.hoisted(() => ({
  getWorkspaceAutopilotAddon: vi.fn(),
  purchaseWorkspaceAutopilotAddon: vi.fn(),
  getWorkspaceAutopilotAddonPurchase: vi.fn(),
  getAutopilotQuotaUsage: vi.fn(),
}));
const mockOpenExternal = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: apiMock,
}));

vi.mock("../platform", () => ({ openExternal: mockOpenExternal }));

import { ApiError } from "@multica/core/api";
import { AutopilotAddonDialog } from "./autopilot-addon-dialog";

const addon: WorkspaceAutopilotAddon = {
  runsPerPack: 1000,
  maxPacks: 10,
  currency: "usd",
  unitAmount: 1000,
  paymentMethod: { brand: "visa", last4: "4242" },
  purchasedRuns: 0,
  periodStart: "2026-11-01T00:00:00Z",
  periodEnd: "2026-12-01T00:00:00Z",
};

const purchase = (
  overrides: Partial<WorkspaceAutopilotAddonPurchase> = {},
): WorkspaceAutopilotAddonPurchase => ({
  requestId: "33333333-3333-3333-3333-333333333333",
  packs: 3,
  runs: 3000,
  currency: "usd",
  amount: 3000,
  status: "paid",
  paymentUrl: null,
  paidAt: "2026-11-20T00:00:00Z",
  ...overrides,
});

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onOpenChange = vi.fn();
  render(
    <I18nProvider locale="en" resources={{ en: { billing: enBilling } }}>
      <QueryClientProvider client={client}>
        <AutopilotAddonDialog wsId="ws-1" open onOpenChange={onOpenChange} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { invalidate, onOpenChange };
}

describe("AutopilotAddonDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getWorkspaceAutopilotAddon.mockResolvedValue(addon);
    apiMock.getAutopilotQuotaUsage.mockResolvedValue({
      action: "enforce",
      used: 12000,
      reserved: 0,
      total: 12000,
      limit: 12000,
      reached: true,
      period_start: "2026-11-01T00:00:00Z",
      period_end: "2026-12-01T00:00:00Z",
      reset_at: "2026-12-01T00:00:00Z",
      blocked_counts: {},
    });
  });

  afterEach(cleanup);

  it("buys the chosen packs at the shown price and refreshes the limit", async () => {
    apiMock.purchaseWorkspaceAutopilotAddon.mockResolvedValue(purchase());
    const user = userEvent.setup();
    const { invalidate } = renderDialog();

    expect(await screen.findByRole("radio", { name: /1,000 runs/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Visa •••• 4242/)).toBeInTheDocument();
    expect(screen.getByText(/12,000 \/ 12,000 used this month/)).toBeInTheDocument();
    // No auto top-up in the first release.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /3,000 runs/ }));
    await user.click(screen.getByRole("button", { name: "Pay $30.00 and add" }));

    expect(await screen.findByText("Runs added")).toBeInTheDocument();
    const request = apiMock.purchaseWorkspaceAutopilotAddon.mock.calls[0]?.[0];
    expect(request).toMatchObject({ packs: 3, expectedUnitAmount: 1000, currency: "usd" });
    expect(request.idempotencyKey).toMatch(/^autopilot-addon-ws-1-/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspace-subscriptions", "ws-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["autopilots", "ws-1", "usage"] });
  });

  it("sends the payer to Stripe when the card needs authentication, then polls", async () => {
    apiMock.purchaseWorkspaceAutopilotAddon.mockResolvedValue(
      purchase({ packs: 1, runs: 1000, amount: 1000, status: "requires_action", paymentUrl: "https://invoice.stripe.com/i/test", paidAt: null }),
    );
    apiMock.getWorkspaceAutopilotAddonPurchase.mockResolvedValue(
      purchase({ packs: 1, runs: 1000, amount: 1000 }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Pay $10.00 and add" }));

    expect(mockOpenExternal).toHaveBeenCalledWith("https://invoice.stripe.com/i/test");
    expect(await screen.findByText("Runs added")).toBeInTheDocument();
    expect(apiMock.getWorkspaceAutopilotAddonPurchase).toHaveBeenCalledWith(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("reports a declined card and starts a new purchase on retry", async () => {
    apiMock.purchaseWorkspaceAutopilotAddon
      .mockRejectedValueOnce(new ApiError("payment failed", 402, "Payment Required"))
      .mockResolvedValueOnce(purchase({ packs: 1, runs: 1000, amount: 1000 }));
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Pay $10.00 and add" }));
    expect(await screen.findByText(/The card was declined/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pay $10.00 and add" }));
    await screen.findByText("Runs added");
    const [first, second] = apiMock.purchaseWorkspaceAutopilotAddon.mock.calls.map(
      (call) => call[0].idempotencyKey,
    );
    expect(second).not.toBe(first);
  });

  it("retries an unknown outcome with the same key so it cannot charge twice", async () => {
    apiMock.purchaseWorkspaceAutopilotAddon
      .mockRejectedValueOnce(new ApiError("unavailable", 503, "Service Unavailable"))
      .mockResolvedValueOnce(purchase({ packs: 1, runs: 1000, amount: 1000 }));
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Pay $10.00 and add" }));
    expect(await screen.findByText(/won't be charged twice/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pay $10.00 and add" }));
    await screen.findByText("Runs added");

    const [first, second] = apiMock.purchaseWorkspaceAutopilotAddon.mock.calls.map(
      (call) => call[0].idempotencyKey,
    );
    expect(second).toBe(first);
  });

  it("offers no purchase when the workspace cannot buy add-ons", async () => {
    apiMock.getWorkspaceAutopilotAddon.mockRejectedValue(
      new ApiError("not purchasable", 409, "Conflict"),
    );
    renderDialog();

    expect(
      await screen.findByText("This workspace can't buy add-on runs right now."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pay and add" })).toBeDisabled(),
    );
  });
});
