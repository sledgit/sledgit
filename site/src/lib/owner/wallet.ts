// The browser wallet, through NEAR Wallet Selector. Signing happens in the user's wallet; this site never sees a key.
// Sign-in creates no access key (no contractId), so every transaction goes to the wallet for explicit approval.
import type { WalletSelector } from "@near-wallet-selector/core";
import type { PlannedTx } from "./tx";

export interface SendResult { hash?: string; ok: boolean; error?: string; redirected?: boolean }
export interface OwnerWallet {
  accountId: string | null;
  wallets: { id: string; name: string }[];
  signIn(walletId: string): Promise<void>;
  signOut(): Promise<void>;
  send(plan: PlannedTx): Promise<SendResult>;
  subscribe(cb: () => void): () => void;
}

// Test builds only (NEXT_PUBLIC_OWNER_MOCK_WALLET=1): a page-provided mock records what would be signed. In a normal
// build this constant is "" and the branch is removed.
const MOCK = process.env.NEXT_PUBLIC_OWNER_MOCK_WALLET === "1";
declare global { interface Window { __itMockWallet?: OwnerWallet } }

const TGAS = 10n ** 12n;
const selectors = new Map<string, Promise<WalletSelector>>();

function selector(network: "testnet" | "mainnet"): Promise<WalletSelector> {
  let s = selectors.get(network);
  if (!s) {
    s = (async () => {
      const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
        import("@near-wallet-selector/core"), import("@near-wallet-selector/my-near-wallet"), import("@near-wallet-selector/meteor-wallet")]);
      // HOT is mainnet-only in wallet-selector 10.1.4, so it is added with the mainnet factory.
      return setupWalletSelector({ network, modules: [setupMyNearWallet(), setupMeteorWallet()] });
    })();
    selectors.set(network, s);
  }
  return s;
}

function hashOf(outcome: unknown): string | undefined {
  const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
  return o?.transaction?.hash ?? o?.transaction_outcome?.id;
}
function failureOf(outcome: unknown): string | undefined {
  const s = (outcome as { status?: Record<string, unknown> } | undefined)?.status;
  return s && "Failure" in s ? JSON.stringify(s.Failure) : undefined;
}

const wallets = new Map<string, Promise<OwnerWallet>>();
export function ownerWallet(network: "testnet" | "mainnet"): Promise<OwnerWallet> {
  if (MOCK && typeof window !== "undefined" && window.__itMockWallet) return Promise.resolve(window.__itMockWallet);
  let w = wallets.get(network);
  if (!w) { w = makeWallet(network); wallets.set(network, w); }
  return w;
}

async function makeWallet(network: "testnet" | "mainnet"): Promise<OwnerWallet> {
  const sel = await selector(network);
  const listeners = new Set<() => void>();
  sel.store.observable.subscribe(() => listeners.forEach(l => l()));
  const current = () => sel.store.getState().accounts.find(a => a.active)?.accountId ?? null;
  const w: OwnerWallet = {
    get accountId() { return current(); },
    wallets: sel.store.getState().modules.map(m => ({ id: m.id, name: m.metadata.name })),
    async signIn(id) {
      const wallet = await sel.wallet(id);
      if (wallet.type === "hardware") throw new Error("hardware wallets aren't supported here");
      await wallet.signIn({});
    },
    async signOut() { if (sel.isSignedIn()) await (await sel.wallet()).signOut(); },
    async send(plan) {
      const signerId = current();
      if (!signerId) return { ok: false, error: "connect a wallet first" };
      const { actionCreators } = await import("@near-js/transactions");
      const action = actionCreators.functionCall(plan.methodName, plan.args, BigInt(plan.gasTgas) * TGAS, plan.depositYocto);
      try {
        const outcome = await (await sel.wallet()).signAndSendTransaction({ signerId, receiverId: plan.receiverId, actions: [action] });
        // Redirect wallets (MyNearWallet) leave the page and come back with ?transactionHashes=…; nothing returns here.
        if (!outcome) return { ok: true, redirected: true };
        const fail = failureOf(outcome);
        return { ok: !fail, hash: hashOf(outcome), error: fail };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return w;
}

/** After a redirect wallet returns: the hashes it reports, or its error. */
export function walletReturn(search: string): { hashes: string[]; error?: string } {
  const q = new URLSearchParams(search);
  const hashes = (q.get("transactionHashes") ?? "").split(",").map(s => s.trim()).filter(s => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s));
  // Never echo the URL's free-text errorMessage: a crafted link could put any sentence on this page. Show a fixed
  // sentence and the code only when it looks like a code.
  const code = q.get("errorCode");
  const safe = code && /^[A-Za-z_]{1,40}$/.test(code) ? code : "unknown";
  return { hashes, error: code !== null ? `the wallet didn't send the transaction (code: ${safe})` : undefined };
}
