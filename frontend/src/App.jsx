import { useState, useCallback, useEffect, useRef } from "react";
import {
  StarkSDK,
  OnboardStrategy,
  Amount,
  sepoliaTokens,
} from "starkzap";
import { uint256, shortString, RpcProvider } from "starknet";
import HelpBot from "./HelpBot";
import "./App.css";

const STRK = sepoliaTokens.STRK;
const ESCROW_ADDRESS =
  import.meta.env.VITE_ESCROW_ADDRESS ||
  "0x045f0dda5b49e8c994aceeb74f08dcbd47da88cd1ab2085221e76e3f78466c45";
const TEE_SERVER =
  import.meta.env.VITE_TEE_SERVER || "http://localhost:3000";

const SEPOLIA_RPC = "https://starknet-sepolia.public.blastapi.io/rpc/v0_7";
const START_BLOCK = 0;

const EV = {
  Deposit: BigInt("0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2"),
  Claim: BigInt("0x2db6855baf6c374b9d0065771a33d4c31a8627d7b9d40f3fc6aa5dbd7b8a48"),
  Withdraw: BigInt("0x17f87ab38a7f75a63dc465e10aadacecfca64c44ca774040b039bfb004e3367"),
  IntentSignaled: BigInt("0x3a2f5bef6fbd9dcf62178b6f685d182f67d0298126853de4887f732894c9923"),
  IntentCancelled: BigInt("0x240b647cb9cbd3e4835973c6f458f28b8292db2031046eb20b287ef4f0ca587"),
};

const sdk = new StarkSDK({ network: "sepolia" });

const policies = [
  { target: STRK.address, method: "transfer" },
  { target: STRK.address, method: "approve" },
  { target: ESCROW_ADDRESS, method: "deposit" },
  { target: ESCROW_ADDRESS, method: "claim_funds" },
  { target: ESCROW_ADDRESS, method: "withdraw" },
  { target: ESCROW_ADDRESS, method: "signal_intent" },
  { target: ESCROW_ADDRESS, method: "cancel_intent" },
];

function feltToString(felt) {
  try { return shortString.decodeShortString(felt); } catch { return felt; }
}

function u256FromParts(low, high) {
  return BigInt(low) + (BigInt(high) << 128n);
}

function formatStrk(wei) {
  const val = Number(wei) / 1e18;
  if (val === 0) return "0";
  return val % 1 === 0 ? val.toString() : val.toFixed(4);
}

function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function normalizeAddr(addr) {
  if (!addr) return "";
  try { return "0x" + BigInt(addr).toString(16).padStart(64, "0"); } catch { return addr; }
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "Expired";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

async function fetchContractEvents() {
  const provider = new RpcProvider({ nodeUrl: SEPOLIA_RPC });
  const latestBlock = await provider.getBlock("latest");
  const toBlock = latestBlock.block_number;

  let continuationToken = undefined;
  const allEvents = [];

  do {
    const result = await provider.getEvents({
      address: ESCROW_ADDRESS,
      from_block: { block_number: START_BLOCK },
      to_block: { block_number: toBlock },
      chunk_size: 100,
      continuation_token: continuationToken,
    });
    allEvents.push(...result.events);
    continuationToken = result.continuation_token;
  } while (continuationToken);

  const deposits = new Map();
  const claims = new Map();
  const withdrawals = new Set();
  const intentMap = new Map();

  for (const event of allEvents) {
    const key0 = BigInt(event.keys[0] || "0x0");

    if (key0 === EV.Deposit) {
      const depositId = Number(BigInt(event.keys[1]));
      deposits.set(depositId, {
        depositId,
        depositor: event.data[0],
        upiId: feltToString(event.data[1]),
        amountStrk: u256FromParts(event.data[2], event.data[3]),
        pricePerStrk: u256FromParts(event.data[4], event.data[5]),
        claimed: false,
        withdrawn: false,
        txHash: event.transaction_hash,
        claimTxHash: null,
        intent: null,
      });
    } else if (key0 === EV.Claim) {
      claims.set(Number(BigInt(event.keys[1])), event.transaction_hash);
    } else if (key0 === EV.Withdraw) {
      withdrawals.add(Number(BigInt(event.keys[1])));
    } else if (key0 === EV.IntentSignaled) {
      const depositId = Number(BigInt(event.keys[1]));
      intentMap.set(depositId, {
        buyer: event.data[0],
        expiresAt: Number(BigInt(event.data[1])),
      });
    } else if (key0 === EV.IntentCancelled) {
      intentMap.delete(Number(BigInt(event.keys[1])));
    }
  }

  for (const [id, claimTxHash] of claims) {
    if (deposits.has(id)) {
      deposits.get(id).claimed = true;
      deposits.get(id).claimTxHash = claimTxHash;
      intentMap.delete(id);
    }
  }

  for (const id of withdrawals) {
    if (deposits.has(id)) {
      deposits.get(id).withdrawn = true;
      intentMap.delete(id);
    }
  }

  for (const [id, intent] of intentMap) {
    if (deposits.has(id)) {
      deposits.get(id).intent = intent;
    }
  }

  return Array.from(deposits.values()).sort((a, b) => b.depositId - a.depositId);
}

function Countdown({ expiresAt }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = remaining <= 0;
  return (
    <span className={`countdown ${expired ? "countdown-expired" : ""}`}>
      {expired ? "Expired" : formatCountdown(remaining)}
    </span>
  );
}

function App() {
  const [wallet, setWallet] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [txStatus, setTxStatus] = useState(null);
  const [lastTxHash, setLastTxHash] = useState(null);
  const [txForOrder, setTxForOrder] = useState(null);

  const [tab, setTab] = useState("buy");
  const [upiId, setUpiId] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [pricePerStrk, setPricePerStrk] = useState("");

  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [actionId, setActionId] = useState(null);

  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [transferAmt, setTransferAmt] = useState("");
  const [transferring, setTransferring] = useState(false);

  const [verifyModal, setVerifyModal] = useState(null);
  const [verifyStep, setVerifyStep] = useState(1);
  const [verifyUsername, setVerifyUsername] = useState("");
  const [verifyPassword, setVerifyPassword] = useState("");
  const [verifyOtp, setVerifyOtp] = useState("");
  const [verifySessionId, setVerifySessionId] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState(null);
  const [claimTxPending, setClaimTxPending] = useState(false);

  const [strkPrice, setStrkPrice] = useState(null);

  const tickRef = useRef(null);
  const [, tick] = useState(0);

  useEffect(() => {
    tickRef.current = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=starknet&vs_currencies=ngn"
        );
        const data = await res.json();
        setStrkPrice(data.starknet?.ngn ?? null);
      } catch {
        /* ignore */
      }
    };
    fetchPrice();
    const id = setInterval(fetchPrice, 60_000);
    return () => clearInterval(id);
  }, []);

  const myAddr = wallet ? normalizeAddr(wallet.address) : "";

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const onboard = await sdk.onboard({
        strategy: OnboardStrategy.Cartridge,
        cartridge: { policies },
        deploy: "if_needed",
      });
      setWallet(onboard.wallet);
      setBalance(await onboard.wallet.balanceOf(STRK));
    } catch (err) {
      setError(err?.message || "Connection failed");
      setWallet(null);
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!wallet) return;
    try { setBalance(await wallet.balanceOf(STRK)); } catch {}
  }, [wallet]);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try { setOrders(await fetchContractEvents()); } catch (err) {
      console.error("Failed to fetch orders:", err);
    } finally { setOrdersLoading(false); }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  const createSellOrder = useCallback(
    async (e) => {
      e.preventDefault();
      if (!wallet || !upiId.trim() || !sellAmount.trim() || !pricePerStrk.trim()) return;
      setLoading(true);
      setError(null);
      setTxStatus(null);
      setLastTxHash(null);
      try {
        const parsedAmount = Amount.parse(sellAmount, STRK);
        const amountU256 = uint256.bnToUint256(parsedAmount.toBase());
        const priceU256 = uint256.bnToUint256(BigInt(pricePerStrk));
        const upiIdFelt = shortString.encodeShortString(upiId.trim());

        const approveCall = wallet
          .erc20(STRK)
          .populateApprove(ESCROW_ADDRESS, parsedAmount);
        const depositCall = {
          contractAddress: ESCROW_ADDRESS,
          entrypoint: "deposit",
          calldata: [
            upiIdFelt,
            amountU256.low.toString(),
            amountU256.high.toString(),
            priceU256.low.toString(),
            priceU256.high.toString(),
          ],
        };

        const tx = await wallet.execute([approveCall, depositCall]);
        setTxStatus("Order submitted...");
        setTxForOrder("sell");
        await tx.wait();
        setTxStatus("Sell order created!");
        setLastTxHash(tx.hash);
        setUpiId("");
        setSellAmount("");
        setPricePerStrk("");
        await refreshBalance();
        await loadOrders();
        setTimeout(() => { setTxStatus(null); setLastTxHash(null); setTxForOrder(null); }, 3000);
      } catch (err) {
        setError(err?.message || "Order creation failed");
      } finally {
        setLoading(false);
      }
    },
    [wallet, upiId, sellAmount, pricePerStrk, refreshBalance, loadOrders],
  );

  const signalIntent = useCallback(
    async (order) => {
      if (!wallet) return;
      setActionId(order.depositId);
      setError(null);
      setTxStatus(null);
      setLastTxHash(null);
      try {
        const tx = await wallet.execute([
          {
            contractAddress: ESCROW_ADDRESS,
            entrypoint: "signal_intent",
            calldata: [String(order.depositId)],
          },
        ]);
        setTxStatus("Signaling intent...");
        setTxForOrder(order.depositId);
        await tx.wait();
        setTxStatus("Intent signaled! You have 1 hour to pay & claim.");
        setLastTxHash(tx.hash);
        await loadOrders();
        setTimeout(() => { setTxStatus(null); setLastTxHash(null); setTxForOrder(null); }, 3000);
      } catch (err) {
        setError(err?.message || "Signal intent failed");
      } finally {
        setActionId(null);
      }
    },
    [wallet, loadOrders],
  );

  const cancelIntent = useCallback(
    async (order) => {
      if (!wallet) return;
      setActionId(order.depositId);
      setError(null);
      setTxStatus(null);
      try {
        const tx = await wallet.execute([
          {
            contractAddress: ESCROW_ADDRESS,
            entrypoint: "cancel_intent",
            calldata: [String(order.depositId)],
          },
        ]);
        setTxStatus("Cancelling intent...");
        setTxForOrder(order.depositId);
        await tx.wait();
        setTxStatus("Intent cancelled.");
        setLastTxHash(tx.hash);
        await loadOrders();
        setTimeout(() => { setTxStatus(null); setLastTxHash(null); setTxForOrder(null); }, 3000);
      } catch (err) {
        setError(err?.message || "Cancel intent failed");
      } finally {
        setActionId(null);
      }
    },
    [wallet, loadOrders],
  );

  const openVerifyModal = useCallback((order) => {
    setVerifyModal(order);
    setVerifyStep(1);
    setVerifyUsername("");
    setVerifyPassword("");
    setVerifyOtp("");
    setVerifySessionId(null);
    setVerifyResult(null);
    setVerifyLoading(false);
    setVerifyError(null);
    setClaimTxPending(false);
  }, []);

  const closeVerifyModal = useCallback(() => {
    setVerifyModal(null);
    setVerifyStep(1);
    setVerifyUsername("");
    setVerifyPassword("");
    setVerifyOtp("");
    setVerifySessionId(null);
    setVerifyResult(null);
    setVerifyLoading(false);
    setVerifyError(null);
    setClaimTxPending(false);
  }, []);

  // Single-step: buyer pastes their Paystack/bank transfer reference
  const handleVerifyStep1 = useCallback(async (e) => {
    e.preventDefault();
    if (!verifyUsername.trim()) return; // reusing verifyUsername field for reference
    setVerifyLoading(true);
    setVerifyError(null);
    try {
      const res = await fetch(`${TEE_SERVER}/api/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: verifyUsername.trim() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Verification failed");
      const txn = data.transaction;
      const sig = data.signature;
      setVerifyResult({
        signature_r: sig.signature_r,
        signature_s: sig.signature_s,
        payment_status_title: txn.paymentStatusTitle,
        payment_total_amount: String(txn.paymentTotalAmount),
        receiver_upi_id: txn.receiverUpiId,
        upi_transaction_id: txn.upiTransactionId,
      });
      setVerifyStep(3);
    } catch (err) {
      setVerifyError(err?.message || "Verification failed");
    } finally {
      setVerifyLoading(false);
    }
  }, [verifyUsername]);

  const handleClaimFunds = useCallback(async () => {
    if (!wallet || !verifyResult || !verifyModal) return;
    setClaimTxPending(true);
    setVerifyError(null);
    try {
      const paymentAmountU256 = uint256.bnToUint256(BigInt(verifyResult.payment_total_amount));
      const tx = await wallet.execute([{
        contractAddress: ESCROW_ADDRESS,
        entrypoint: "claim_funds",
        calldata: [
          verifyResult.signature_r,
          verifyResult.signature_s,
          verifyResult.payment_status_title.toString(),
          paymentAmountU256.low.toString(),
          paymentAmountU256.high.toString(),
          verifyResult.receiver_upi_id,
          verifyResult.upi_transaction_id,
          String(verifyModal.depositId),
        ],
      }]);
      setVerifyStep(4);
      await tx.wait();
      setLastTxHash(tx.hash);
      setTxStatus("STRK claimed successfully!");
      setTxForOrder("claim");
      await refreshBalance();
      await loadOrders();
      closeVerifyModal();
      setTimeout(() => { setTxStatus(null); setLastTxHash(null); setTxForOrder(null); }, 5000);
    } catch (err) {
      setVerifyError(err?.message || "Claim failed");
      setClaimTxPending(false);
    }
  }, [wallet, verifyResult, verifyModal, refreshBalance, loadOrders, closeVerifyModal]);

  const withdrawDeposit = useCallback(
    async (order) => {
      if (!wallet) return;
      setActionId(order.depositId);
      setError(null);
      setTxStatus(null);
      setLastTxHash(null);
      try {
        const tx = await wallet.execute([
          {
            contractAddress: ESCROW_ADDRESS,
            entrypoint: "withdraw",
            calldata: [String(order.depositId)],
          },
        ]);
        setTxStatus("Withdrawing...");
        setTxForOrder(order.depositId);
        await tx.wait();
        setTxStatus("Funds withdrawn!");
        setLastTxHash(tx.hash);
        await refreshBalance();
        await loadOrders();
        setTimeout(() => { setTxStatus(null); setLastTxHash(null); setTxForOrder(null); }, 3000);
      } catch (err) {
        setError(err?.message || "Withdraw failed");
      } finally {
        setActionId(null);
      }
    },
    [wallet, refreshBalance, loadOrders],
  );

  const sendTransfer = useCallback(
    async (e) => {
      e.preventDefault();
      if (!wallet || !transferTo.trim() || !transferAmt.trim()) return;
      setTransferring(true);
      setError(null);
      setTxStatus(null);
      setLastTxHash(null);
      try {
        const parsedAmount = Amount.parse(transferAmt, STRK);
        const amountU256 = uint256.bnToUint256(parsedAmount.toBase());
        const tx = await wallet.execute([
          {
            contractAddress: STRK.address,
            entrypoint: "transfer",
            calldata: [transferTo.trim(), amountU256.low.toString(), amountU256.high.toString()],
          },
        ]);
        setTxStatus("Sending STRK...");
        setTxForOrder("transfer");
        await tx.wait();
        setTxStatus("Transfer complete!");
        setLastTxHash(tx.hash);
        setShowTransfer(false);
        setTransferTo("");
        setTransferAmt("");
        await refreshBalance();
        setTimeout(() => { setTxStatus(null); setLastTxHash(null); setTxForOrder(null); }, 3000);
      } catch (err) {
        setError(err?.message || "Transfer failed");
      } finally {
        setTransferring(false);
      }
    },
    [wallet, transferTo, transferAmt, refreshBalance],
  );

  const disconnect = useCallback(() => {
    wallet?.disconnect?.();
    setWallet(null);
    setBalance(null);
    setError(null);
    setTxStatus(null);
    setLastTxHash(null);
    setTxForOrder(null);
  }, [wallet]);

  const now = Math.floor(Date.now() / 1000);
  const open = orders.filter((o) => !o.claimed && !o.withdrawn);
  const settled = orders.filter((o) => o.claimed || o.withdrawn);
  const myDeposits = open.filter((o) => normalizeAddr(o.depositor) === myAddr);
  const mySettled = settled.filter((o) => normalizeAddr(o.depositor) === myAddr);
  const buyable = open.filter((o) => normalizeAddr(o.depositor) !== myAddr);

  function intentState(order) {
    if (!order.intent) return "none";
    const remaining = order.intent.expiresAt - now;
    if (remaining <= 0) return "expired";
    if (normalizeAddr(order.intent.buyer) === myAddr) return "mine";
    return "other";
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">S</span>
          <div>
            <h1 className="brand-name">STRK / NGN</h1>
            <p className="brand-tag">P2P Marketplace</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {strkPrice !== null && (
            <span className="network-pill" style={{ background: "var(--bg-input)" }}>
              ₦{strkPrice.toFixed(2)} / STRK
            </span>
          )}
          <span className="network-pill">Sepolia</span>
        </div>
      </header>

      {!wallet ? (
        <main className="hero">
          <div className="hero-content">
            <h2>Buy and sell STRK with Naira</h2>
            <p>
              Peer-to-peer marketplace with TEE-verified bank transfer payments and
              instant onchain settlement. No intermediaries.
            </p>
            <div className="hero-steps">
              <div className="step">
                <span className="step-num">1</span>
                <div>
                  <strong>Lock STRK</strong>
                  <span>Sellers deposit STRK into escrow</span>
                </div>
              </div>
              <div className="step">
                <span className="step-num">2</span>
                <div>
                  <strong>Signal Intent</strong>
                  <span>Buyer reserves order for 1 hour</span>
                </div>
              </div>
              <div className="step">
                <span className="step-num">3</span>
                <div>
                  <strong>Pay &amp; Claim</strong>
                  <span>Send ₦ via bank transfer, TEE verifies, STRK released</span>
                </div>
              </div>
            </div>
            {error && <p className="error-msg">{error}</p>}
            <button className="btn-connect" onClick={connect} disabled={loading}>
              {loading ? "Connecting..." : "Connect Wallet"}
            </button>
            <p className="connect-hint">Powered by Cartridge Controller</p>
          </div>
        </main>
      ) : (
        <main className="dashboard">
          <div className="wallet-bar">
            <div className="wallet-info">
              <code
                className="wallet-addr wallet-addr-copy"
                title="Click to copy address"
                onClick={() => {
                  navigator.clipboard.writeText(wallet.address);
                  setTxStatus("Address copied!");
                  setTimeout(() => setTxStatus(null), 2000);
                }}
              >
                {shortAddr(wallet.address)}
              </code>
              <button
                className="wallet-bal wallet-bal-btn"
                onClick={() => setShowTransfer(true)}
                title="Click to transfer STRK"
              >
                {balance ? balance.toFormatted(true) : "\u2014"}
              </button>
              <button
                className="btn-refresh-bal"
                onClick={refreshBalance}
                title="Refresh balance"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M13.65 2.35A7.96 7.96 0 008 0C3.58 0 .01 3.58.01 8S3.58 16 8 16c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 018 14 6 6 0 012 8a6 6 0 016-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor"/>
                </svg>
              </button>
            </div>
            <button className="btn-disconnect" onClick={disconnect}>
              Disconnect
            </button>
          </div>

          {txForOrder === "transfer" && (txStatus || lastTxHash) && (
            <div className="tx-inline">
              {txStatus && <p className="success-msg">{txStatus}</p>}
              {lastTxHash && (
                <a
                  className="tx-pill"
                  href={`https://sepolia.starkscan.co/tx/${lastTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Voyager &rarr;
                </a>
              )}
            </div>
          )}

          {showTransfer && (
            <div className="modal-overlay" onClick={() => !transferring && setShowTransfer(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <h2>Transfer STRK</h2>
                  <button
                    className="modal-close"
                    onClick={() => !transferring && setShowTransfer(false)}
                  >
                    &times;
                  </button>
                </div>
                <p className="modal-sub">
                  Send STRK to any Starknet address
                </p>
                <form className="sell-form" onSubmit={sendTransfer}>
                  <div className="field">
                    <label htmlFor="transfer-to">Recipient address</label>
                    <input
                      id="transfer-to"
                      type="text"
                      placeholder="0x..."
                      value={transferTo}
                      onChange={(e) => setTransferTo(e.target.value)}
                      disabled={transferring}
                      autoFocus
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="transfer-amt">Amount</label>
                    <div className="input-suffix">
                      <input
                        id="transfer-amt"
                        type="text"
                        placeholder="1.5"
                        value={transferAmt}
                        onChange={(e) => setTransferAmt(e.target.value)}
                        disabled={transferring}
                      />
                      <span className="suffix">STRK</span>
                    </div>
                    {balance && (
                      <button
                        type="button"
                        className="btn-max"
                        onClick={() => setTransferAmt(balance.toFormatted(false))}
                        disabled={transferring}
                      >
                        MAX
                      </button>
                    )}
                  </div>
                  {error && <p className="error-msg">{error}</p>}
                  <button
                    type="submit"
                    className="btn-submit"
                    disabled={transferring || !transferTo.trim() || !transferAmt.trim()}
                  >
                    {transferring ? "Sending..." : "Send STRK"}
                  </button>
                </form>
              </div>
            </div>
          )}

          <div className="tab-bar">
            <button
              className={`tab-btn ${tab === "buy" ? "tab-active" : ""}`}
              onClick={() => { setTab("buy"); setError(null); setTxStatus(null); }}
            >
              Buy STRK
            </button>
            <button
              className={`tab-btn ${tab === "sell" ? "tab-active" : ""}`}
              onClick={() => { setTab("sell"); setError(null); setTxStatus(null); }}
            >
              Sell STRK
            </button>
            <button
              className={`tab-btn ${tab === "deposits" ? "tab-active" : ""}`}
              onClick={() => { setTab("deposits"); setError(null); setTxStatus(null); }}
            >
              My Deposits
            </button>
          </div>

          {tab === "buy" && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Open Orders</h2>
                  <p className="panel-sub">
                    Signal intent, pay seller via bank transfer, then claim STRK
                  </p>
                </div>
                <button
                  className="btn-refresh"
                  onClick={loadOrders}
                  disabled={ordersLoading}
                >
                  {ordersLoading ? (
                    <span className="spinner" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M13.65 2.35A7.96 7.96 0 008 0C3.58 0 .01 3.58.01 8S3.58 16 8 16c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 018 14 6 6 0 012 8a6 6 0 016-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor"/>
                    </svg>
                  )}
                </button>
              </div>

              {ordersLoading && orders.length === 0 && (
                <div className="loading-state">
                  <span className="spinner" />
                  <span>Loading orders from Starknet...</span>
                </div>
              )}

              {!ordersLoading && buyable.length === 0 && open.length === 0 && (
                <div className="empty-state">
                  <p>No orders yet</p>
                  <span>Be the first to create a sell order</span>
                </div>
              )}

              {!ordersLoading && buyable.length === 0 && open.length > 0 && (
                <div className="empty-state">
                  <p>No orders from other sellers</p>
                  <span>Only your own deposits are open right now</span>
                </div>
              )}

              {buyable.length > 0 && (
                <div className="order-list">
                  {buyable.map((o) => {
                    const state = intentState(o);
                    const isMyIntent = state === "mine";
                    const isOtherIntent = state === "other";
                    const isLocked = isMyIntent || isOtherIntent;
                    return (
                      <div key={o.depositId} className={`order-card ${isLocked ? "order-locked" : ""}`}>
                        <div className="order-top">
                          <div className="order-amount">
                            {formatStrk(o.amountStrk)}{" "}
                            <span className="order-token">STRK</span>
                          </div>
                          {!isLocked && <span className="badge badge-open">Open</span>}
                          {isMyIntent && <span className="badge badge-intent">Your Intent</span>}
                          {isOtherIntent && <span className="badge badge-reserved">Reserved</span>}
                        </div>
                        <div className="order-meta">
                          <div className="meta-row">
                            <span className="meta-label">Rate</span>
                            <span className="meta-value">
                              ₦{o.pricePerStrk.toString()} / STRK
                            </span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Total</span>
                            <span className="meta-value meta-total">
                              ₦{((Number(o.amountStrk) / 1e18) * Number(o.pricePerStrk)).toFixed(2)}
                            </span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Pay to</span>
                            <span className="meta-value meta-upi">{o.upiId}</span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Seller</span>
                            <span className="meta-value meta-addr">
                              {shortAddr(o.depositor)}
                            </span>
                          </div>
                          {isLocked && o.intent && (
                            <div className="meta-row">
                              <span className="meta-label">Time left</span>
                              <Countdown expiresAt={o.intent.expiresAt} />
                            </div>
                          )}
                        </div>

                        {!isLocked && (
                          <button
                            className="btn-intent"
                            onClick={() => signalIntent(o)}
                            disabled={actionId !== null}
                          >
                            {actionId === o.depositId ? "Signaling..." : "Signal Intent"}
                          </button>
                        )}

                        {isMyIntent && (
                          <div className="intent-actions">
                            <button
                              className="btn-buy"
                              onClick={() => openVerifyModal(o)}
                              disabled={actionId !== null}
                            >
                              {`I've Paid — Claim ${formatStrk(o.amountStrk)} STRK`}
                            </button>
                            <button
                              className="btn-cancel-intent"
                              onClick={() => cancelIntent(o)}
                              disabled={actionId !== null}
                            >
                              Cancel Intent
                            </button>
                          </div>
                        )}

                        {isOtherIntent && (
                          <p className="reserved-note">
                            Another buyer has reserved this order
                          </p>
                        )}

                        {txForOrder === o.depositId && (txStatus || lastTxHash) && (
                          <div className="tx-inline">
                            {txStatus && <p className="success-msg">{txStatus}</p>}
                            {lastTxHash && (
                              <a
                                className="tx-pill"
                                href={`https://sepolia.starkscan.co/tx/${lastTxHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                View on Voyager &rarr;
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {txForOrder === "claim" && (txStatus || lastTxHash) && (
                <div className="tx-inline" style={{ marginTop: "0.75rem" }}>
                  {txStatus && <p className="success-msg">{txStatus}</p>}
                  {lastTxHash && (
                    <a
                      className="tx-pill"
                      href={`https://sepolia.starkscan.co/tx/${lastTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on Voyager &rarr;
                    </a>
                  )}
                </div>
              )}

              {error && <p className="error-msg">{error}</p>}

              {settled.length > 0 && (
                <>
                  <h3 className="section-divider">History</h3>
                  <div className="order-list">
                    {settled.map((o) => (
                      <a
                        key={o.depositId}
                        className="order-card order-settled"
                        href={`https://sepolia.starkscan.co/tx/${o.claimTxHash || o.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="order-top">
                          <div className="order-amount">
                            {formatStrk(o.amountStrk)}{" "}
                            <span className="order-token">STRK</span>
                          </div>
                          <span className={`badge ${o.withdrawn ? "badge-withdrawn" : "badge-settled"}`}>
                            {o.withdrawn ? "Withdrawn" : "Settled"}
                          </span>
                        </div>
                        <div className="order-meta">
                          <div className="meta-row">
                            <span className="meta-label">Rate</span>
                            <span className="meta-value">
                              ₦{o.pricePerStrk.toString()} / STRK
                            </span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Total</span>
                            <span className="meta-value">
                              ₦{((Number(o.amountStrk) / 1e18) * Number(o.pricePerStrk)).toFixed(2)}
                            </span>
                          </div>
                        </div>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === "sell" && (
            <section className="panel">
              <h2>Create Sell Order</h2>
              <p className="panel-sub">
                Lock STRK in escrow. Buyers signal intent, pay you via bank transfer,
                then claim with TEE-verified proof. You can withdraw anytime
                if no buyer has an active intent.
              </p>

              <form className="sell-form" onSubmit={createSellOrder}>
                <div className="field">
                  <label htmlFor="sell-upi">Your Account Number</label>
                  <input
                    id="sell-upi"
                    type="text"
                    placeholder="0123456789"
                    value={upiId}
                    onChange={(e) => setUpiId(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="sell-amount">Amount</label>
                    <div className="input-suffix">
                      <input
                        id="sell-amount"
                        type="text"
                        placeholder="2"
                        value={sellAmount}
                        onChange={(e) => setSellAmount(e.target.value)}
                        disabled={loading}
                      />
                      <span className="suffix">STRK</span>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="sell-price">Price per STRK</label>
                    <div className="input-suffix">
                      <input
                        id="sell-price"
                        type="text"
                        placeholder="5"
                        value={pricePerStrk}
                        onChange={(e) => setPricePerStrk(e.target.value)}
                        disabled={loading}
                      />
                      <span className="suffix">NGN</span>
                    </div>
                  </div>
                </div>

                {sellAmount && pricePerStrk && (
                  <div className="sell-summary">
                    <span>You will receive</span>
                    <strong>
                      ₦{(parseFloat(sellAmount || 0) * parseFloat(pricePerStrk || 0)).toFixed(2)} NGN
                    </strong>
                    <span>when a buyer claims</span>
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-submit"
                  disabled={loading || !upiId.trim() || !sellAmount.trim() || !pricePerStrk.trim()}
                >
                  {loading ? "Locking STRK..." : "Lock STRK & Create Order"}
                </button>
              </form>

              {error && <p className="error-msg">{error}</p>}
              {txForOrder === "sell" && txStatus && <p className="success-msg">{txStatus}</p>}
              {txForOrder === "sell" && lastTxHash && (
                <a
                  className="tx-pill"
                  href={`https://sepolia.starkscan.co/tx/${lastTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Voyager &rarr;
                </a>
              )}
            </section>
          )}

          {tab === "deposits" && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>My Deposits</h2>
                  <p className="panel-sub">
                    Your escrowed STRK. Withdraw anytime if no buyer has an active intent.
                  </p>
                </div>
                <button
                  className="btn-refresh"
                  onClick={loadOrders}
                  disabled={ordersLoading}
                >
                  {ordersLoading ? (
                    <span className="spinner" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M13.65 2.35A7.96 7.96 0 008 0C3.58 0 .01 3.58.01 8S3.58 16 8 16c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 018 14 6 6 0 012 8a6 6 0 016-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor"/>
                    </svg>
                  )}
                </button>
              </div>

              {ordersLoading && myDeposits.length === 0 && mySettled.length === 0 && (
                <div className="loading-state">
                  <span className="spinner" />
                  <span>Loading your deposits...</span>
                </div>
              )}

              {!ordersLoading && myDeposits.length === 0 && mySettled.length === 0 && (
                <div className="empty-state">
                  <p>No deposits yet</p>
                  <span>Create a sell order to deposit STRK into escrow</span>
                </div>
              )}

              {myDeposits.length > 0 && (
                <div className="order-list">
                  {myDeposits.map((o) => {
                    const state = intentState(o);
                    const hasActiveIntent = state === "mine" || state === "other";
                    return (
                      <div key={o.depositId} className={`order-card ${hasActiveIntent ? "order-locked" : ""}`}>
                        <div className="order-top">
                          <div className="order-amount">
                            {formatStrk(o.amountStrk)}{" "}
                            <span className="order-token">STRK</span>
                          </div>
                          {hasActiveIntent ? (
                            <span className="badge badge-reserved">Locked</span>
                          ) : (
                            <span className="badge badge-open">Open</span>
                          )}
                        </div>
                        <div className="order-meta">
                          <div className="meta-row">
                            <span className="meta-label">Rate</span>
                            <span className="meta-value">
                              ₦{o.pricePerStrk.toString()} / STRK
                            </span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Total NGN</span>
                            <span className="meta-value meta-total">
                              ₦{((Number(o.amountStrk) / 1e18) * Number(o.pricePerStrk)).toFixed(2)}
                            </span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Account No.</span>
                            <span className="meta-value meta-upi">{o.upiId}</span>
                          </div>
                          {hasActiveIntent && o.intent && (
                            <>
                              <div className="meta-row">
                                <span className="meta-label">Buyer</span>
                                <span className="meta-value meta-addr">
                                  {shortAddr(o.intent.buyer)}
                                </span>
                              </div>
                              <div className="meta-row">
                                <span className="meta-label">Expires</span>
                                <Countdown expiresAt={o.intent.expiresAt} />
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          className="btn-withdraw"
                          onClick={() => withdrawDeposit(o)}
                          disabled={actionId !== null || hasActiveIntent}
                          title={hasActiveIntent ? "Cannot withdraw while a buyer has an active intent" : ""}
                        >
                          {actionId === o.depositId
                            ? "Withdrawing..."
                            : hasActiveIntent
                              ? "Locked by buyer"
                              : "Withdraw"}
                        </button>

                        {txForOrder === o.depositId && (txStatus || lastTxHash) && (
                          <div className="tx-inline">
                            {txStatus && <p className="success-msg">{txStatus}</p>}
                            {lastTxHash && (
                              <a
                                className="tx-pill"
                                href={`https://sepolia.starkscan.co/tx/${lastTxHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                View on Voyager &rarr;
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {typeof txForOrder === "number" && !myDeposits.some(o => o.depositId === txForOrder) && (txStatus || lastTxHash) && (
                <div className="tx-inline" style={{ marginTop: "0.75rem" }}>
                  {txStatus && <p className="success-msg">{txStatus}</p>}
                  {lastTxHash && (
                    <a
                      className="tx-pill"
                      href={`https://sepolia.starkscan.co/tx/${lastTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on Voyager &rarr;
                    </a>
                  )}
                </div>
              )}

              {error && <p className="error-msg">{error}</p>}

              {mySettled.length > 0 && (
                <>
                  <h3 className="section-divider">Settled / Withdrawn</h3>
                  <div className="order-list">
                    {mySettled.map((o) => (
                      <a
                        key={o.depositId}
                        className="order-card order-settled"
                        href={`https://sepolia.starkscan.co/tx/${o.claimTxHash || o.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <div className="order-top">
                          <div className="order-amount">
                            {formatStrk(o.amountStrk)}{" "}
                            <span className="order-token">STRK</span>
                          </div>
                          <span className={`badge ${o.withdrawn ? "badge-withdrawn" : "badge-settled"}`}>
                            {o.withdrawn ? "Withdrawn" : "Settled"}
                          </span>
                        </div>
                        <div className="order-meta">
                          <div className="meta-row">
                            <span className="meta-label">Rate</span>
                            <span className="meta-value">
                              ₦{o.pricePerStrk.toString()} / STRK
                            </span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Total</span>
                            <span className="meta-value">
                              ₦{((Number(o.amountStrk) / 1e18) * Number(o.pricePerStrk)).toFixed(2)}
                            </span>
                          </div>
                        </div>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {verifyModal && (
            <div className="modal-overlay" onClick={closeVerifyModal}>
              <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
                <div className="modal-head">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span className="logo">₦</span>
                    <div>
                      <h2 style={{ marginBottom: 0 }}>Verify Bank Transfer</h2>
                      <p className="modal-sub" style={{ margin: 0 }}>Paste your Paystack transaction reference</p>
                    </div>
                  </div>
                  <button className="modal-close" onClick={closeVerifyModal}>&times;</button>
                </div>

                <div style={{ padding: "1.25rem" }}>
                  {verifyStep === 1 && (
                    <form className="sell-form" style={{ marginTop: 0 }} onSubmit={handleVerifyStep1}>
                      <p className="modal-sub" style={{ marginTop: 0 }}>
                        After sending Naira to the seller, paste the transaction reference from your bank app (Opay, PalmPay, Kuda, Moniepoint, GTBank, etc.)
                      </p>
                      <div className="field">
                        <label>Transaction Reference</label>
                        <input
                          type="text"
                          value={verifyUsername}
                          onChange={(e) => setVerifyUsername(e.target.value)}
                          required
                          disabled={verifyLoading}
                          placeholder="e.g. T2024112512345678"
                          autoFocus
                        />
                      </div>
                      {verifyError && <p className="error-msg">{verifyError}</p>}
                      <button type="submit" className="btn-submit" disabled={verifyLoading}>
                        {verifyLoading ? "Verifying..." : "Verify Payment"}
                      </button>
                    </form>
                  )}

                  {verifyStep === 2 && null /* unused step */}

                  {verifyStep === 3 && verifyResult && (
                    <div>
                      <p className="success-msg" style={{ marginTop: 0 }}>
                        <strong>Payment Verified</strong> — {feltToString(verifyResult.payment_status_title)}
                      </p>

                      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden", marginBottom: "0.75rem" }}>
                        <div style={{ padding: "0.5rem 0.75rem", fontSize: "0.78rem", fontWeight: 600, background: "var(--bg-input)", borderBottom: "1px solid var(--border)" }}>
                          Transaction
                        </div>
                        <div style={{ padding: "0.75rem" }}>
                          <div className="meta-row" style={{ marginBottom: "0.3rem" }}>
                            <span className="meta-label">Amount</span>
                            <span className="meta-value">₦ {(verifyResult.payment_total_amount / 1e18).toFixed(2)}</span>
                          </div>
                          <div className="meta-row" style={{ marginBottom: "0.3rem" }}>
                            <span className="meta-label">Receiver Acct</span>
                            <span className="meta-value meta-upi">{feltToString(verifyResult.receiver_upi_id)}</span>
                          </div>
                          <div className="meta-row">
                            <span className="meta-label">Txn ID</span>
                            <span className="meta-value meta-upi">{feltToString(verifyResult.upi_transaction_id)}</span>
                          </div>
                        </div>
                      </div>

                      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden", marginBottom: "0.85rem" }}>
                        <div style={{ padding: "0.5rem 0.75rem", fontSize: "0.78rem", fontWeight: 600, background: "var(--bg-input)", borderBottom: "1px solid var(--border)" }}>
                          Signature
                        </div>
                        <div style={{ padding: "0.75rem" }}>
                          <code style={{ display: "block", fontSize: "0.7rem", wordBreak: "break-all", color: "var(--text-muted)" }}>
                            r: {verifyResult.signature_r}
                          </code>
                          <code style={{ display: "block", fontSize: "0.7rem", wordBreak: "break-all", color: "var(--text-muted)", marginTop: "0.3rem" }}>
                            s: {verifyResult.signature_s}
                          </code>
                        </div>
                      </div>

                      {verifyError && <p className="error-msg">{verifyError}</p>}
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          className="btn-cancel-intent"
                          style={{ flex: 1, padding: "0.65rem" }}
                          onClick={closeVerifyModal}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn-submit"
                          style={{ flex: 1 }}
                          onClick={handleClaimFunds}
                          disabled={claimTxPending}
                        >
                          {claimTxPending ? "Claiming..." : `Claim ${formatStrk(verifyModal.amountStrk)} STRK`}
                        </button>
                      </div>
                    </div>
                  )}

                  {verifyStep === 4 && (
                    <div className="loading-state">
                      <span className="spinner" />
                      <span>Claiming funds — waiting for confirmation...</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      )}
      <HelpBot />
    </div>
  );
}

export default App;
