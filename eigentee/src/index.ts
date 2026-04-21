import express from "express";
import { mnemonicToAccount } from "viem/accounts";
import cors from "cors";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { ec, hash, shortString, uint256 } from "starknet";
dotenv.config();

const app = express();
const port = process.env.APP_PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory session store to keep browser instances alive
const sessions = new Map();

// Cleanup old sessions after 10 minutes
const SESSION_TIMEOUT = 10 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      if (session.browser) {
        session.browser.close().catch(() => {});
      }
      sessions.delete(sessionId);
    }
  }
}, 60000); // Check every 10 seconds

// Get the TEE mnemonic from environment
const mnemonic = process.env.MNEMONIC;

if (!mnemonic) {
  throw new Error("MNEMONIC not found in environment");
}

// Derive EVM account and StarkNet keys from mnemonic
const evmAccount = mnemonicToAccount(mnemonic);

const evmHdKey = evmAccount.getHdKey();
if (!evmHdKey.privateKey) {
  throw new Error("Unable to derive private key from mnemonic");
}
const evmPrivateKeyHex = `0x${Buffer.from(evmHdKey.privateKey).toString("hex")}`;

const starkPrivateKey = ec.starkCurve.grindKey(evmPrivateKeyHex);
const starkPublicKey = ec.starkCurve.getStarkKey("0x" + starkPrivateKey);

const STARK_CURVE_ORDER =
  3618502788666131106986593281521497120414687020801267626233049500247285301248n;

function computePaymentHash(
  paymentStatusTitle: string,
  paymentTotalAmount: string,
  receiverUpiId: string,
  upiTransactionId: string,
) {
  const { low, high } = uint256.bnToUint256(BigInt(paymentTotalAmount));
  const toBn = (x: string | number | bigint) =>
    typeof x === "string" && x.startsWith("0x") ? BigInt(x) : BigInt(x);
  let h = 0n;
  h = toBn(ec.starkCurve.pedersen(h, BigInt(paymentStatusTitle)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(low)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(high)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(receiverUpiId)));
  h = toBn(ec.starkCurve.pedersen(h, BigInt(upiTransactionId)));
  h = toBn(ec.starkCurve.pedersen(h, 5n));
  h = h % STARK_CURVE_ORDER;
  return "0x" + h.toString(16).padStart(64, "0");
}

function signPaymentData(
  privateKey: string,
  paymentStatusTitle: string,
  paymentTotalAmount: string,
  receiverUpiId: string,
  upiTransactionId: string,
) {
  const messageHashHex = computePaymentHash(
    paymentStatusTitle,
    paymentTotalAmount,
    receiverUpiId,
    upiTransactionId,
  );
  const signature = ec.starkCurve.sign(messageHashHex, privateKey);
  return {
    signature_r: signature.r.toString(),
    signature_s: signature.s.toString(),
  };
}

// Route 1: Return TEE public address
app.get("/tee-address", (req, res) => {
  res.json({
    starkPublicKey,
    message: "This is the TEE public address derived from the mnemonic",
  });
});

// Route 2: Return signed "gm" message
app.get("/gm", async (req, res) => {
  const timestamp = Date.now();
  const message = `gm${timestamp}`;

  try {
    const msgHash = BigInt(
      hash.starknetKeccak(Buffer.from(message).toString("utf8")),
    );
    const signature = ec.starkCurve.sign(
      msgHash.toString(16),
      "0x" + starkPrivateKey,
    );

    res.json({
      message,
      timestamp,
      signature_r: "0x" + signature.r.toString(16),
      signature_s: "0x" + signature.s.toString(16),
      starkPublicKey,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to sign message" });
  }
});

// Step 1: Login to Amazon Pay with email and password
app.post("/api/login/step1", async (req, res) => {
  const { username, password } = req.body;

  // Validate required fields
  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: "Email and password are required",
    });
  }

  let browser;
  let sessionId;

  try {
    sessionId = uuidv4();

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to Amazon Pay history page (will redirect to login)
    await page.goto("https://amazon.in/pay/history", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Fill email and click continue
    await page.waitForSelector("#ap_email_login", { timeout: 10000 });
    await page.fill("#ap_email_login", username);
    await page.press("#ap_email_login", "Enter");

    // Wait for password field
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("#ap_password", { timeout: 10000 });

    // Fill password and submit
    await page.fill("#ap_password", password);
    await page.press("#ap_password", "Enter");

    // Check if confirmation code needs to be sent
    try {
      await page.waitForSelector("#auth-send-code", { timeout: 5000 });
      await page.click("#auth-send-code");
    } catch (e) {
    }

    // Wait for 2FA OTP field
    await page.waitForSelector("#auth-mfa-otpcode", { timeout: 10000 });


    // Store session data
    sessions.set(sessionId, {
      browser,
      context,
      page,
      email: username,
      createdAt: Date.now(),
    });

    return res.json({
      success: true,
      sessionId: sessionId,
      message: "Login successful. Please enter the OTP sent to your device.",
    });
  } catch (error) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "An error occurred during login",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// Step 2: Submit OTP and retrieve transaction data
app.post("/api/login/step2", async (req, res) => {
  const { sessionId, otp } = req.body;

  // Validate required fields
  if (!sessionId || !otp) {
    return res.status(400).json({
      success: false,
      error: "Session ID and OTP are required",
    });
  }

  // Retrieve session
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Invalid or expired session. Please start over.",
    });
  }

  const { browser, page } = session;

  try {
    // Fill in 2FA OTP
    await page.fill("#auth-mfa-otpcode", otp);
    await page.press("#auth-mfa-otpcode", "Enter");

    // Wait for /pay/history page to load after authentication
    await page.waitForURL("**/pay/history", { timeout: 15000 });
    await page.waitForSelector(".mb-nano.tux-bg-base.transaction-item", {
      timeout: 20000,
    });

    // Navigate to first transaction
    try {
      // Click first element with class "mb-nano tux-bg-base transaction-item"
      const firstTransaction = page
        .locator(".mb-nano.tux-bg-base.transaction-item")
        .first();
      await firstTransaction.click();

    } catch (e) {
      throw new Error("Could not find or click transaction item");
    }

    // Wait for transaction receipt to load and extract data
    try {
      await page.waitForSelector("#payui-transaction-receipt-id", {
        timeout: 10000,
      });

      const dataValue = await page
        .locator("#payui-transaction-receipt-id")
        .getAttribute("data");


      if (!dataValue) {
        throw new Error("Transaction receipt data not found");
      }

      const data = JSON.parse(dataValue);

      // Extract transaction details
      const paymentAmount = data.paymentStatusDetails.paymentAmount;
      const paymentTotalAmount = paymentAmount * 1e18;
      const paymentStatusTitle = data.paymentStatusDetails.status;

      const receiverUpiId =
        data.paymentEntityOfTypePaymentMethodEntity.paymentMethodInstruments[0]
          .unmaskedVpaId;

      const upiTransactionId =
        data.identifierEntities[0].identifierValues[0].ctaTitle;

      const receiverUpiIdEncoded = shortString.encodeShortString(receiverUpiId);
      const upiTransactionIdEncoded =
        shortString.encodeShortString(upiTransactionId);

      const PAYMENT_STATUS_SUCCESS =
        shortString.encodeShortString(paymentStatusTitle);

      const { signature_r, signature_s } = signPaymentData(
        "0x" + starkPrivateKey,
        PAYMENT_STATUS_SUCCESS,
        paymentTotalAmount.toString(),
        receiverUpiIdEncoded,
        upiTransactionIdEncoded,
      );

      // Cleanup
      await browser.close();
      sessions.delete(sessionId);

      return res.json({
        success: true,
        transaction: {
          paymentStatusTitle: shortString.encodeShortString(paymentStatusTitle),
          paymentTotalAmount: paymentTotalAmount.toString(),
          receiverUpiId: shortString.encodeShortString(receiverUpiId),
          upiTransactionId: shortString.encodeShortString(upiTransactionId),
        },
        signature: {
          signature_r: signature_r,
          signature_s: signature_s,
        },
        message: "Transaction data retrieved successfully!",
      });
    } catch (e) {
      throw new Error(
        "Failed to extract transaction data: " + (e as Error).message,
      );
    }
  } catch (error) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    sessions.delete(sessionId);

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "An error occurred during OTP submission",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// Health check endpoint for Caddy
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`EigenX TEE Express app listening on port ${port}`);
});
