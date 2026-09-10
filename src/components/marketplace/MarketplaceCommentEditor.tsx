"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Pencil, RefreshCw } from "lucide-react";
import type { Account } from "thirdweb/wallets";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useWriteAccount } from "@/hooks/use-write-account";
import {
  communityCommentEditPayload,
  communityListingCommentSchema,
} from "@/lib/marketplace/community-comment";
import { normalizeTxError } from "@/lib/thirdweb-tx";
import { signWalletRequest } from "@/lib/wallet-authorization";
import type { MarketplaceOffer } from "@/types/marketplace";
import { commentRevision, readCommentOffer, updateCachedComment } from "./comment-editor-state";

type Props = {
  offer: MarketplaceOffer;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

export function MarketplaceCommentEditor(props: Props) {
  const writer = useWriteAccount();
  if (
    !writer ||
    props.offer.source !== "gnars-contract" ||
    !props.offer.collectionAddress ||
    writer.account.address.toLowerCase() !== props.offer.seller.toLowerCase()
  )
    return null;
  return (
    <CommentEditor
      key={`${writer.account.address.toLowerCase()}:${props.offer.protocolAddress}:${props.offer.orderHash}`}
      {...props}
      account={writer.account}
    />
  );
}

function CommentEditor({ offer, disabled, onBusyChange, account }: Props & { account: Account }) {
  const t = useTranslations("marketplace.edit");
  const queries = useQueryClient();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(offer.listingComment ?? "");
  const [snapshot, setSnapshot] = useState(offer);
  const [reviewedRevision, setReviewedRevision] = useState(commentRevision(offer));
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [phase, setPhase] = useState<"idle" | "signing" | "saving" | "refresh">("idle");
  const [message, setMessage] = useState<"rejected" | "error" | "conflict" | "commentSaved" | null>(
    null,
  );
  const active = useRef(false);
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange);
  useEffect(() => {
    busyCallback.current = onBusyChange;
  }, [onBusyChange]);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abort.current?.abort();
      if (inFlight.current) busyCallback.current?.(false);
    };
  }, []);

  const current = commentRevision(offer) > commentRevision(snapshot) ? offer : snapshot;
  const review = needsReview || reviewedRevision !== commentRevision(current);
  const normalized = draft.trim() || null;
  const valid = normalized === null || communityListingCommentSchema.safeParse(normalized).success;
  const busy = phase !== "idle";
  const unchanged = normalized === (current.listingComment ?? null);
  const path = `/api/marketplace/community/orders/${offer.orderHash}/comment`;

  function start(next: typeof phase) {
    if (disabled || inFlight.current || !active.current) return false;
    inFlight.current = true;
    setPhase(next);
    busyCallback.current?.(true);
    abort.current = new AbortController();
    return true;
  }
  function finish() {
    inFlight.current = false;
    if (!active.current) return;
    setPhase("idle");
    busyCallback.current?.(false);
  }
  function accept(next: MarketplaceOffer) {
    setSnapshot(next);
    queries.setQueriesData({ queryKey: ["marketplace"] }, (data) =>
      updateCachedComment(data, next),
    );
    void queries.invalidateQueries({ queryKey: ["marketplace"] });
  }
  async function refresh() {
    if (!start("refresh")) return;
    try {
      const response = await fetch(path, { cache: "no-store", signal: abort.current!.signal });
      if (!response.ok) throw new Error("Comment unavailable");
      const next = readCommentOffer(await response.json(), current);
      if (!active.current) return;
      accept(next);
      setNeedsRefresh(false);
      setNeedsReview(true);
      setMessage("conflict");
    } catch {
      if (active.current) setMessage("error");
    } finally {
      finish();
    }
  }
  async function save() {
    if (review || needsRefresh || !valid || unchanged || !start("signing")) return;
    let submitted = false;
    setMessage(null);
    try {
      const payload = communityCommentEditPayload(offer.orderHash, normalized, reviewedRevision);
      const authorization = await signWalletRequest(account, { method: "PATCH", path, payload });
      if (!active.current) return;
      setPhase("saving");
      submitted = true;
      const response = await fetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, authorization }),
        signal: abort.current!.signal,
      });
      const result: unknown = await response.json();
      if (!active.current) return;
      if (!response.ok) {
        setNeedsRefresh(true);
        setMessage(response.status === 409 ? "conflict" : "error");
        void queries.invalidateQueries({ queryKey: ["marketplace"] });
        return;
      }
      const next = readCommentOffer(result, current);
      if (commentRevision(next) <= reviewedRevision)
        throw new Error("Comment revision not advanced");
      accept(next);
      setReviewedRevision(commentRevision(next));
      setEditing(false);
      setMessage("commentSaved");
    } catch (error) {
      if (!active.current) return;
      const rejected = !submitted && normalizeTxError(error).category === "user-rejected";
      setMessage(rejected ? "rejected" : "error");
      if (submitted) {
        setNeedsRefresh(true);
        void queries.invalidateQueries({ queryKey: ["marketplace"] });
      }
    } finally {
      finish();
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      {!editing ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setDraft(current.listingComment ?? "");
            setReviewedRevision(commentRevision(current));
            setNeedsReview(false);
            setMessage(null);
            setEditing(true);
          }}
        >
          <Pencil className="size-4" />
          {t("comment")}
        </Button>
      ) : (
        <div className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={id}>{t("commentLabel")}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{draft.length}/280</span>
          </div>
          <Textarea
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled || busy}
            maxLength={280}
            rows={4}
            aria-invalid={!valid}
            className="min-h-28 resize-y break-words"
          />
          {!valid && <p className="text-xs text-destructive">{t("invalidComment")}</p>}
          {review && !needsRefresh && (
            <div className="space-y-2 border-l-2 pl-3 text-xs">
              <p className="text-muted-foreground">{t("currentComment")}</p>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {current.listingComment ?? t("noComment")}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || busy}
                onClick={() => {
                  setReviewedRevision(commentRevision(current));
                  setNeedsReview(false);
                  setMessage(null);
                }}
              >
                <Check className="size-4" />
                {t("review")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {needsRefresh ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || busy}
                onClick={() => void refresh()}
              >
                <RefreshCw className={`size-4 ${phase === "refresh" ? "animate-spin" : ""}`} />
                {t("refresh")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || busy || review || !valid || unchanged}
                onClick={() => void save()}
              >
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Pencil className="size-4" />
                )}
                {t(phase === "signing" ? "signing" : phase === "saving" ? "saving" : "saveComment")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => setEditing(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
      {(message || (editing && review)) && (
        <p
          role={message === "commentSaved" ? "status" : "alert"}
          className={`text-xs ${message === "commentSaved" ? "text-muted-foreground" : "text-destructive"}`}
        >
          {t(message ?? "conflict")}
        </p>
      )}
    </div>
  );
}
