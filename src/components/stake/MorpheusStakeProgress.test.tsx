import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MorpheusStakeFlow } from "@/lib/morpheus-stake-flow";
import en from "../../../messages/en/stake.json";
import ptBr from "../../../messages/pt-br/stake.json";
import { MorpheusStakeProgress, type MorpheusStakeProgressProps } from "./MorpheusStakeProgress";

vi.mock("@/i18n/navigation", () => ({ Link: "a" }));

const depositHash = `0x${"a".repeat(64)}` as const;
const approvalHash = `0x${"b".repeat(64)}` as const;
const baseFlow: MorpheusStakeFlow = {
  version: 1,
  id: "stake-render-test",
  chainId: 1,
  account: "0x1111111111111111111111111111111111111111",
  asset: "usdc",
  pool: "0x2222222222222222222222222222222222222222",
  athlete: "0x3333333333333333333333333333333333333333",
  expectedReceiver: "0x4444444444444444444444444444444444444444",
  amount: "25",
  amountRaw: "25000000",
  claimLockEnd: 0,
  step: "receiver",
  status: "ready",
  hashes: { approval: approvalHash, deposit: depositHash },
  previousHashes: [],
  depositConfirmed: true,
  recoveryAvailable: true,
  recoveryOnly: false,
  retryable: false,
  createdAt: 1,
  updatedAt: 1,
};

const catalogs = [
  { locale: "en", messages: en },
  { locale: "pt-br", messages: ptBr },
] as const;

describe.each(catalogs)("MorpheusStakeProgress ($locale)", ({ locale, messages }) => {
  const t = messages.flow;

  function render(
    flow: Partial<MorpheusStakeFlow> = {},
    props: Partial<Omit<MorpheusStakeProgressProps, "flow">> = {},
  ) {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={{ stake: messages }} timeZone="UTC">
        <MorpheusStakeProgress
          flow={{ ...baseFlow, ...flow }}
          busy={false}
          error={null}
          onContinue={vi.fn(async () => {})}
          onCheck={vi.fn(async () => {})}
          onAttachHash={vi.fn(async () => {})}
          onClose={vi.fn()}
          onComplete={vi.fn()}
          {...props}
        />
      </NextIntlClientProvider>,
    );
    return {
      html,
      buttons: html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [],
      steps: html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [],
    };
  }

  function expectNoContinuation(buttons: string[]) {
    for (const action of Object.values(t.actions)) {
      expect(buttons.some((button) => button.includes(action))).toBe(false);
    }
  }

  it.each(["ready", "failed"] as const)(
    "offers only receiver setup for a confirmed deposit in %s recovery",
    (status) => {
      const { html, buttons, steps } = render({
        status,
        retryable: status === "failed",
        recoveryOnly: true,
        hashes: {},
      });
      expect(html).toContain(t.depositSafe);
      expect(steps).toHaveLength(3);
      expect(steps[1]).toContain(t.steps.deposit);
      expect(steps[1]).toContain(t.states.confirmed);
      expect(steps[2]).toContain('aria-current="step"');
      expect(buttons.some((button) => button.includes(t.actions.receiver))).toBe(true);
      expect(buttons.some((button) => button.includes(t.actions.deposit))).toBe(false);
      expect(buttons.some((button) => button.includes(t.actions.approval))).toBe(false);
      expect(html).toContain(`href="/members/${baseFlow.account}"`);
      expect(html).not.toContain("https://etherscan.io/tx/");
    },
  );

  it.each(["pending", "unknown", "wallet", "confirming"] as const)(
    "never offers a transaction continuation while deposit status is %s",
    (status) => {
      const { html, buttons, steps } = render({
        step: "deposit",
        status,
        depositConfirmed: false,
        retryable: true,
      });
      expectNoContinuation(buttons);
      expect(steps[1]).toContain(t.states[status]);
      expect(html).toContain(t.uncertainDescription);
      expect(html).toContain(`href="https://etherscan.io/tx/${depositHash}"`);
      expect(html).toContain(`href="https://etherscan.io/tx/${approvalHash}"`);
      expect(html).not.toContain('placeholder="0x..."');
      expect(buttons.some((button) => button.includes(t.check))).toBe(true);
    },
  );

  it("provides a labelled hash field for an unknown transaction without a known hash", () => {
    const { html, buttons } = render({
      asset: "stEth",
      step: "deposit",
      status: "unknown",
      hashes: { approval: approvalHash },
      depositConfirmed: false,
    });
    expectNoContinuation(buttons);
    expect(html).toContain('for="stake-hash-stEth"');
    expect(html).toContain('id="stake-hash-stEth"');
    expect(html).toContain(t.hashLabel);
    expect(html).toContain('placeholder="0x..."');
    expect(buttons.find((button) => button.includes(t.verifyHash))).toContain('disabled=""');
    expect(html).toContain("25 stETH");
  });

  it("blocks new transactions while busy but leaves status checks and close available", () => {
    const { buttons } = render({}, { busy: true });
    expectNoContinuation(buttons);
    expect(buttons.find((button) => button.includes(t.check))).not.toContain('disabled=""');
    expect(buttons.find((button) => button.includes(t.close))).not.toContain('disabled=""');
  });

  it("shows all steps confirmed and only the completion action when finished", () => {
    const { html, buttons, steps } = render({ status: "complete" });
    expect(html).toContain(t.completeTitle);
    expect(html).toContain(t.completeDescription);
    expect(steps).toHaveLength(3);
    for (const step of steps) expect(step).toContain(t.states.confirmed);
    expect(html).not.toContain('aria-current="step"');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain(t.done);
    expectNoContinuation(buttons);
  });

  it("renders a read failure as an alert without enabling an unverified deposit", () => {
    const { html, buttons } = render(
      { step: "deposit", status: "pending", depositConfirmed: false },
      { error: t.readError },
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(t.readError);
    expect(html).toContain(t.uncertainDescription);
    expect(html).not.toContain(t.completeDescription);
    expectNoContinuation(buttons);
  });

  it("preserves a stored nonretryable failure when no new error is supplied", () => {
    const { html, buttons } = render({ status: "failed", retryable: false, error: t.readError });
    expect(html).toContain('role="alert"');
    expect(html).toContain(t.readError);
    expect(html).toContain(t.depositSafe);
    expectNoContinuation(buttons);
  });

  it("preserves previous transaction links in a deduplicated history section", () => {
    const first = `0x${"c".repeat(64)}` as const;
    const second = `0x${"d".repeat(64)}` as const;
    const { html } = render({ previousHashes: [first, second, first] });
    const history = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(history).toBeDefined();
    expect(history).toContain(t.previousTransactions);
    for (const hash of [first, second]) {
      expect(history?.split(`href="https://etherscan.io/tx/${hash}"`)).toHaveLength(2);
      expect(history).toContain(`${hash.slice(0, 10)}...${hash.slice(-6)}`);
    }
    const links = history?.match(/<a\b[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
    }
    expect(html).toContain(`href="https://etherscan.io/tx/${depositHash}"`);
  });
});
