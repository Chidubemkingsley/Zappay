import express from "express";
import { mnemonicToAccount } from "viem/accounts";
import cors from "cors";
import dotenv from "dotenv";
import { ec, hash, shortString, uint256 } from "starknet";
dotenv.config();

const app = express();
const port = process.env.APP_PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Key derivation ────────────────────────────────────────────────────────────

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) throw new Error("MNEMONIC not found in environment");

const evmAccount = mnemonicToAccount(mnemonic);
const evmHdKey = evmAccount.getHdKey();
if (!evmHdKey.privateKey) throw new Error("Unable to derive private key from mnemonic");

const evmPrivateKeyHex = `0x${Buffer.from(evmHdKey.privateKey).toString("hex")}`;
const starkPrivateKey = ec.starkCurve.grindKey(evmPrivateKeyHex);
const starkPublicKey = ec.starkCurve.getStarkKey("0x" + starkPrivateKey);

const STARK_CURVE_ORDER =
  3618502788666131106986593281521497120414687020801267626233049500247285301248n;

// ── Crypto helpers ────────────────────────────────────────────────────────────

function computePaymentHash(
  paymentStatusTitle: string,
  paymentTotalAmount: string,
  receiverAccountId: string,
  transactionId: string,
) {
  const { low, high } = uint256.bnToUint256(BigInt(paymentTotalAmount));
  const toBn = (x: string | number | bigint) =>
    typeof x === "string" && x.startsWith("0x") ? BigInt(x) : BigInt(x);
  let h = 0n;
  h = toBn(ec.starkCurve.pedersen(h, BigInt(paymentStatusTitle)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(low)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(high)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(receiverAccountId)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(transactionId)));
  h = toBn(ec.starkCurve.pedersen(h, 5n));
  h = h % STARK_CURVE_ORDER;
  return "0x" + h.toString(16).padStart(64, "0");
}

function signPaymentData(
  privateKey: string,
  paymentStatusTitle: string,
  paymentTotalAmount: string,
  receiverAccountId: string,
  transactionId: string,
) {
  const messageHashHex = computePaymentHash(
    paymentStatusTitle,
    paymentTotalAmount,
    receiverAccountId,
    transactionId,
  );
  const signature = ec.starkCurve.sign(messageHashHex, privateKey);
  return {
    signature_r: signature.r.toString(),
    signature_s: signature.s.toString(),
  };
}

// ── Paystack verification ─────────────────────────────────────────────────────
// Verifies a Nigerian bank transfer using the Paystack transaction reference.
// Works with any bank: Opay, PalmPay, Kuda, Moniepoint, GTBank, Access, etc.
// The buyer gets the reference from their bank app after sending money.

async function verifyPaystackTransaction(reference: string) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY not set in environment");

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!res.ok) throw new Error(`Paystack API error: ${res.status}`);
  const json = await res.json() as any;

  if (!json.status) throw new Error(json.message || "Paystack verification failed");

  const data = json.data;
  // amount from Paystack is in kobo (1 NGN = 100 kobo), convert to NGN then to 18 decimals
  const amountNgn = data.amount / 100;
  const paymentTotalAmount = BigInt(Math.round(amountNgn * 1e18)).toString();
  const paymentStatus = data.status; // "success" | "failed" | "abandoned"
  // recipient account number from transfer metadata or customer email as fallback
  const receiverAccount = data.metadata?.receiver_account || data.recipient?.details?.account_number || data.customer?.email || "";

  return {
    paymentStatus,        // "success"
    paymentTotalAmount,   // in 18-decimal wei-like units
    receiverAccount,      // account number / identifier of who received
    transactionId: reference,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// TEE public key
app.get("/tee-address", (_req, res) => {
  res.json({
    starkPublicKey,
    message: "This is the TEE public address derived from the mnemonic",
  });
});

// Health check
app.get("/health", (_req, res) => res.status(200).send("OK"));

// Signed gm (attestation test)
app.get("/gm", async (_req, res) => {
  const timestamp = Date.now();
  const message = `gm${timestamp}`;
  try {
    const msgHash = BigInt(hash.starknetKeccak(Buffer.from(message).toString("utf8")));
    const signature = ec.starkCurve.sign(msgHash.toString(16), "0x" + starkPrivateKey);
    res.json({
      message,
      timestamp,
      signature_r: "0x" + signature.r.toString(16),
      signature_s: "0x" + signature.s.toString(16),
      starkPublicKey,
    });
  } catch {
    res.status(500).json({ error: "Failed to sign message" });
  }
});

// Verify a Nigerian bank transfer and return a signed receipt
// Buyer calls this with the Paystack transaction reference after paying
app.post("/api/verify", async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, error: "Transaction reference is required" });
  }

  try {
    const { paymentStatus, paymentTotalAmount, receiverAccount, transactionId } =
      await verifyPaystackTransaction(reference);

    if (paymentStatus !== "success") {
      return res.status(400).json({ success: false, error: `Payment status is '${paymentStatus}', not success` });
    }

    const STATUS_SUCCESS = shortString.encodeShortString("SUCCESS");
    const receiverEncoded = shortString.encodeShortString(receiverAccount);
    const txnEncoded = shortString.encodeShortString(transactionId);

    const { signature_r, signature_s } = signPaymentData(
      "0x" + starkPrivateKey,
      STATUS_SUCCESS,
      paymentTotalAmount,
      receiverEncoded,
      txnEncoded,
    );

    return res.json({
      success: true,
      transaction: {
        paymentStatusTitle: STATUS_SUCCESS,
        paymentTotalAmount,
        receiverUpiId: receiverEncoded,
        upiTransactionId: txnEncoded,
      },
      signature: { signature_r, signature_s },
      message: "Payment verified successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Verification failed",
    });
  }
});

app.listen(port, () => {
  console.log(`Zappay TEE server listening on port ${port}`);
});
