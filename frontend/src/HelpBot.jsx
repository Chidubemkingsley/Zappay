import { useState, useRef, useEffect } from "react";

const QA = [
  {
    q: ["how does this work", "what is this", "explain", "what is zappay", "how do i use"],
    a: "Zappay is a P2P marketplace to buy and sell STRK with Naira. Sellers lock STRK in escrow, buyers send Naira via any Nigerian bank, and a TEE verifies the payment before releasing the STRK on-chain.",
  },
  {
    q: ["how do i buy", "buy strk", "purchase strk", "i want to buy"],
    a: "To buy STRK: 1) Connect your wallet. 2) Go to the Buy STRK tab. 3) Pick an open order and click Signal Intent — this locks the order for 1 hour. 4) Send Naira to the seller's account number via any Nigerian bank (Opay, PalmPay, Kuda, Moniepoint, GTBank etc.). 5) Copy the transaction reference from your bank app, click 'I've Paid — Claim STRK', paste the reference and verify. Your STRK will be released instantly.",
  },
  {
    q: ["how do i sell", "sell strk", "create order", "list strk"],
    a: "To sell STRK: 1) Connect your wallet. 2) Go to the Sell STRK tab. 3) Enter your account number, the amount of STRK, and your price in NGN. 4) Click 'Lock STRK & Create Order'. Your STRK goes into escrow and buyers can find your order.",
  },
  {
    q: ["signal intent", "what is intent", "reserve order"],
    a: "Signaling intent reserves an order for you for 1 hour. No one else can claim it during that time. You must pay the seller and claim the STRK before the timer runs out, or the order becomes available again.",
  },
  {
    q: ["tee", "what is tee", "how is payment verified", "verification"],
    a: "TEE stands for Trusted Execution Environment. It's a secure enclave that calls the Paystack API to verify your Nigerian bank transfer receipt and cryptographically signs it. The signature is submitted on-chain to prove the payment happened — without anyone being able to fake it.",
  },
  {
    q: ["withdraw", "get my strk back", "cancel sell order"],
    a: "Go to My Deposits tab. If no buyer has an active intent on your order, you can click Withdraw to get your STRK back at any time.",
  },
  {
    q: ["wallet", "connect wallet", "cartridge", "how to connect"],
    a: "Click 'Connect Wallet' on the home screen. Zappay uses Cartridge Controller — a smart wallet that works in your browser. It will be created automatically if you don't have one.",
  },
  {
    q: ["cancel intent", "change my mind", "undo intent"],
    a: "If you signaled intent but don't want to proceed, click 'Cancel Intent' on the order card. This frees the order for other buyers.",
  },
  {
    q: ["price", "rate", "ngn", "naira", "strk price"],
    a: "Each seller sets their own NGN price per STRK. The live market rate shown at the top is fetched from CoinGecko so you can compare before trading.",
  },
  {
    q: ["safe", "secure", "trust", "scam", "can i get scammed"],
    a: "The escrow contract holds the STRK on-chain — the seller can't run off with it. The TEE verifies the payment independently, so the buyer can't fake a payment. Nullifiers prevent the same receipt being reused. No intermediary touches the funds.",
  },
  {
    q: ["sepolia", "testnet", "test", "real money"],
    a: "Zappay is currently running on Starknet Sepolia testnet. STRK here has no real value — it's for testing. You can get free Sepolia STRK from the Starknet faucet at faucet.starknet.io.",
  },
  {
    q: ["faucet", "get strk", "free strk", "test strk"],
    a: "Get free Sepolia STRK at https://faucet.starknet.io — connect your wallet and request test tokens.",
  },
  {
    q: ["history", "past orders", "settled", "completed"],
    a: "Completed trades appear in the History section at the bottom of the Buy STRK tab, and in the Settled/Withdrawn section of My Deposits. Click any settled order to view it on Starkscan.",
  },
  {
    q: ["transfer", "send strk", "send to friend"],
    a: "Click your STRK balance in the top bar to open the Transfer modal. Enter a Starknet address and amount, then confirm.",
  },
];

function getAnswer(input) {
  const lower = input.toLowerCase().trim();
  if (!lower) return null;
  for (const item of QA) {
    if (item.q.some((kw) => lower.includes(kw))) return item.a;
  }
  return "I'm not sure about that. Try asking about buying, selling, signaling intent, the TEE verification, or how to connect your wallet.";
}

export default function HelpBot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    { from: "bot", text: "Hi! I can help you understand how Zappay works. Ask me anything." },
  ]);
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const send = () => {
    const q = input.trim();
    if (!q) return;
    const answer = getAnswer(q);
    setMessages((m) => [
      ...m,
      { from: "user", text: q },
      { from: "bot", text: answer },
    ]);
    setInput("");
  };

  const handleKey = (e) => {
    if (e.key === "Enter") send();
  };

  return (
    <div className="helpbot-wrap">
      {open && (
        <div className="helpbot-panel">
          <div className="helpbot-head">
            <span>Zappay Helper</span>
            <button className="helpbot-close" onClick={() => setOpen(false)}>&times;</button>
          </div>
          <div className="helpbot-messages">
            {messages.map((m, i) => (
              <div key={i} className={`helpbot-msg helpbot-msg-${m.from}`}>
                {m.text}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="helpbot-input-row">
            <input
              className="helpbot-input"
              placeholder="Ask a question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              autoFocus
            />
            <button className="helpbot-send" onClick={send}>Send</button>
          </div>
        </div>
      )}
      <button className="helpbot-fab" onClick={() => setOpen((o) => !o)} title="Help">
        {open ? "✕" : "?"}
      </button>
    </div>
  );
}
