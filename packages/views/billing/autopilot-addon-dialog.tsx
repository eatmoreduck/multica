"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, Loader2 } from "@multica/ui/icons";
import { ApiError, api } from "@multica/core/api";
import { autopilotQuotaUsageOptions } from "@multica/core/autopilots";
import {
  invalidateAfterAutopilotAddon,
  usePurchaseWorkspaceAutopilotAddon,
  workspaceAutopilotAddonOptions,
} from "@multica/core/billing";
import type { WorkspaceAutopilotAddonPurchase } from "@multica/core/types";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { useLocale, useT } from "../i18n";
import { openExternal } from "../platform";
import { formatStripeMinorAmount } from "../settings/components/billing-format";

/** Pack counts the dialog offers; Cloud accepts up to `maxPacks`. */
export const AUTOPILOT_ADDON_PACK_OPTIONS = [1, 3, 5] as const;

/** How long the dialog keeps checking a purchase awaiting card authentication. */
const PURCHASE_POLL_INTERVAL_MS = 3_000;
const PURCHASE_POLL_TIMEOUT_MS = 5 * 60_000;

type Outcome =
  | { kind: "idle" }
  | { kind: "paid"; runs: number }
  | { kind: "awaiting"; purchase: WorkspaceAutopilotAddonPurchase; since: number }
  | { kind: "error"; message: string };

function createAddonIdempotencyKey(wsId: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `autopilot-addon-${wsId}-${suffix}`.slice(0, 200);
}

/**
 * Buy autopilot run add-on packs for the current month, charged in place to
 * the workspace's default card. A payment that needs card authentication
 * opens Stripe's payment page and is polled until Cloud settles it.
 *
 * Only rendered for managers whose summary allows `purchaseAutopilotRuns`;
 * Cloud authorizes the purchase again.
 */
export function AutopilotAddonDialog({
  wsId,
  open,
  onOpenChange,
}: {
  wsId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("billing");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const addonQuery = useQuery(workspaceAutopilotAddonOptions(wsId, open));
  const usageQuery = useQuery({ ...autopilotQuotaUsageOptions(wsId), enabled: open && wsId.length > 0 });
  const purchase = usePurchaseWorkspaceAutopilotAddon(wsId);
  const [packs, setPacks] = useState<number>(AUTOPILOT_ADDON_PACK_OPTIONS[0]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  // One key per purchase intent: a retry after an unknown outcome reuses it so
  // Cloud returns the original purchase instead of charging twice.
  const intentKeyRef = useRef<{ packs: number; key: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setOutcome({ kind: "idle" });
    setPacks(AUTOPILOT_ADDON_PACK_OPTIONS[0]);
    intentKeyRef.current = null;
  }, [open, wsId]);

  const awaiting = outcome.kind === "awaiting" ? outcome : null;
  const statusQuery = useQuery({
    queryKey: [
      "workspace-subscriptions",
      wsId,
      "autopilot-addon-purchase",
      awaiting?.purchase.requestId ?? "",
    ],
    queryFn: () =>
      api.getWorkspaceAutopilotAddonPurchase(awaiting?.purchase.requestId ?? ""),
    enabled: open && awaiting !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "paid" || status === "failed") return false;
      if (awaiting && Date.now() - awaiting.since > PURCHASE_POLL_TIMEOUT_MS) return false;
      return PURCHASE_POLL_INTERVAL_MS;
    },
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 0,
  });

  const polledStatus = statusQuery.data?.status;
  useEffect(() => {
    if (!awaiting || !statusQuery.data) return;
    if (polledStatus === "paid") {
      intentKeyRef.current = null;
      invalidateAfterAutopilotAddon(queryClient, wsId);
      setOutcome({ kind: "paid", runs: statusQuery.data.runs });
    } else if (polledStatus === "failed") {
      intentKeyRef.current = null;
      setOutcome({ kind: "error", message: t(($) => $.autopilot_addon.failed) });
    }
  }, [awaiting, polledStatus, queryClient, statusQuery.data, t, wsId]);

  const addon = addonQuery.data ?? null;
  const packOptions = addon
    ? AUTOPILOT_ADDON_PACK_OPTIONS.filter((count) => count <= addon.maxPacks)
    : [];
  const amountFor = (count: number) =>
    addon ? formatStripeMinorAmount(addon.unitAmount * count, addon.currency, locale) : null;
  const selectedAmount = amountFor(packs);
  const numberFormatter = new Intl.NumberFormat(locale);
  const resetDate = addon
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(addon.periodEnd))
    : null;
  const usage = usageQuery.data;
  const usedLine =
    usage && usage.action !== "off" && usage.total !== null && usage.limit !== null && resetDate
      ? t(($) => $.autopilot_addon.usage_summary, {
          used: numberFormatter.format(usage.total),
          limit: numberFormatter.format(usage.limit),
          date: resetDate,
        })
      : resetDate
        ? t(($) => $.autopilot_addon.resets_summary, { date: resetDate })
        : null;
  const cardLabel = addon?.paymentMethod
    ? t(($) => $.autopilot_addon.card, {
        brand: addon.paymentMethod.brand.charAt(0).toUpperCase() + addon.paymentMethod.brand.slice(1),
        last4: addon.paymentMethod.last4,
      })
    : null;

  const submit = async () => {
    if (!addon || selectedAmount === null) return;
    if (intentKeyRef.current?.packs !== packs) {
      intentKeyRef.current = { packs, key: createAddonIdempotencyKey(wsId) };
    }
    const key = intentKeyRef.current.key;
    setOutcome({ kind: "idle" });
    try {
      const result = await purchase.mutateAsync({
        packs,
        expectedUnitAmount: addon.unitAmount,
        currency: addon.currency,
        idempotencyKey: key,
      });
      if (!result) {
        setOutcome({ kind: "error", message: t(($) => $.autopilot_addon.error) });
        return;
      }
      switch (result.status) {
        case "paid":
          intentKeyRef.current = null;
          setOutcome({ kind: "paid", runs: result.runs });
          return;
        case "failed":
          intentKeyRef.current = null;
          setOutcome({ kind: "error", message: t(($) => $.autopilot_addon.failed) });
          return;
        case "requires_action":
          if (result.paymentUrl) openExternal(result.paymentUrl);
          setOutcome({ kind: "awaiting", purchase: result, since: Date.now() });
          return;
        case "pending":
          setOutcome({ kind: "awaiting", purchase: result, since: Date.now() });
          return;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        intentKeyRef.current = null;
        setOutcome({ kind: "error", message: t(($) => $.autopilot_addon.declined) });
        return;
      }
      if (error instanceof ApiError && (error.status === 409 || error.status === 403)) {
        intentKeyRef.current = null;
        void addonQuery.refetch();
        setOutcome({ kind: "error", message: t(($) => $.autopilot_addon.conflict) });
        return;
      }
      // Unknown outcome: keep the key so a retry cannot charge twice.
      setOutcome({ kind: "error", message: t(($) => $.autopilot_addon.error) });
    }
  };

  const paying = purchase.isPending;
  const showForm = outcome.kind !== "paid" && outcome.kind !== "awaiting";

  return (
    <Dialog open={open} onOpenChange={(next) => !paying && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {outcome.kind === "paid"
              ? t(($) => $.autopilot_addon.success_title)
              : outcome.kind === "awaiting"
                ? t(($) => $.autopilot_addon.action_required_title)
                : t(($) => $.autopilot_addon.title)}
          </DialogTitle>
          <DialogDescription>
            {outcome.kind === "paid"
              ? t(($) => $.autopilot_addon.success_description, {
                  runs: numberFormatter.format(outcome.runs),
                })
              : outcome.kind === "awaiting"
                ? t(($) => $.autopilot_addon.action_required_description)
                : t(($) => $.autopilot_addon.description)}
          </DialogDescription>
        </DialogHeader>

        {awaiting ? (
          <div className="space-y-3">
            {statusQuery.isFetching ? (
              <p className="flex items-center gap-2 text-body text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                {t(($) => $.autopilot_addon.checking)}
              </p>
            ) : (
              <p className="text-body text-muted-foreground" role="status">
                {t(($) => $.autopilot_addon.still_pending)}
              </p>
            )}
          </div>
        ) : null}

        {showForm && addonQuery.isPending ? (
          <p className="flex items-center gap-2 text-body text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            {t(($) => $.autopilot_addon.loading)}
          </p>
        ) : null}
        {showForm && !addonQuery.isPending && !addon ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>
              {addonQuery.error instanceof ApiError && addonQuery.error.status === 409
                ? t(($) => $.autopilot_addon.unavailable)
                : t(($) => $.autopilot_addon.load_failed)}
            </AlertDescription>
          </Alert>
        ) : null}

        {showForm && addon ? (
          <div className="space-y-4">
            <div
              role="radiogroup"
              aria-label={t(($) => $.autopilot_addon.options_label)}
              className="space-y-2"
            >
              {packOptions.map((count) => {
                const selected = count === packs;
                return (
                  <button
                    key={count}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={paying}
                    onClick={() => setPacks(count)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-body transition-colors",
                      selected
                        ? "border-foreground"
                        : "border-surface-border hover:bg-accent/50",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-foreground" : "border-muted-foreground/50",
                      )}
                    >
                      {selected ? <span className="size-2 rounded-full bg-foreground" /> : null}
                    </span>
                    <span className="flex-1 tabular-nums">
                      {t(($) => $.autopilot_addon.option, {
                        runs: numberFormatter.format(count * addon.runsPerPack),
                      })}
                    </span>
                    <span className="tabular-nums">{amountFor(count)}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-caption leading-5 text-muted-foreground tabular-nums">
              {selectedAmount !== null
                ? cardLabel
                  ? t(($) => $.autopilot_addon.charge_summary, { amount: selectedAmount, card: cardLabel })
                  : t(($) => $.autopilot_addon.charge_summary_default, { amount: selectedAmount })
                : null}{" "}
              {usedLine}
            </p>
          </div>
        ) : null}

        {outcome.kind === "error" ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{outcome.message}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {outcome.kind === "paid" ? (
            <Button onClick={() => onOpenChange(false)}>
              {t(($) => $.autopilot_addon.done)}
            </Button>
          ) : awaiting ? (
            <>
              {awaiting.purchase.paymentUrl ? (
                <Button
                  variant="outline"
                  onClick={() => openExternal(awaiting.purchase.paymentUrl ?? "")}
                >
                  <ExternalLink />
                  {t(($) => $.autopilot_addon.open_payment)}
                </Button>
              ) : null}
              <Button
                disabled={statusQuery.isFetching}
                onClick={() => void statusQuery.refetch()}
              >
                {t(($) => $.autopilot_addon.check_payment)}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={paying} onClick={() => onOpenChange(false)}>
                {t(($) => $.autopilot_addon.cancel)}
              </Button>
              <Button
                disabled={paying || !addon || selectedAmount === null}
                onClick={() => void submit()}
              >
                {paying ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
                {selectedAmount !== null
                  ? t(($) => $.autopilot_addon.pay, { amount: selectedAmount })
                  : t(($) => $.autopilot_addon.pay_fallback)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
