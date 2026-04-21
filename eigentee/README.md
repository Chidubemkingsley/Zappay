# Eigen TEE Service

Headless browser service running inside an **Eigen Trusted Execution Environment (TEE)**. It verifies UPI payments via Amazon Pay and signs payment receipts for the Starknet escrow contract.

## What it does

1. **Login flow** – Accepts Amazon credentials and OTP; uses Playwright to log into Amazon Pay.
2. **Transaction verification** – Navigates to the payment history and extracts the latest UPI transaction.
3. **Signing** – Computes the Pedersen hash of the payment data (matching the Cairo contract) and signs it with the TEE’s Starknet key.
4. **Response** – Returns `signature_r`, `signature_s`, and transaction fields for the buyer to call `claim_funds` on-chain.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tee-address` | Returns the TEE’s Starknet public key |
| GET | `/gm` | Signs a test message (for attestation checks) |
| GET | `/health` | Health check (for load balancers) |
| POST | `/api/login/step1` | Login with email/password; returns `sessionId` |
| POST | `/api/login/step2` | Submit OTP; returns signed transaction data |

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `MNEMONIC` | Yes | BIP-39 mnemonic used to derive the TEE signing key |
| `APP_PORT` | No | Port (default: 3000) |

## Build & Run

```bash
npm install
npm run build
npm start
```

## Docker (Eigen TEE deployment)

```bash
docker build -t strk-upi-tee .
docker run -p 3000:3000 -e MNEMONIC="your mnemonic" strk-upi-tee
```

## Key derivation

- EVM key: `mnemonicToAccount(mnemonic)` → private key
- Starknet key: `ec.starkCurve.grindKey(evmPrivateKeyHex)` → used for signing

The hash algorithm matches the Cairo contract’s `_compute_payment_hash` (Pedersen over `payment_status_title`, `payment_total_amount`, `receiver_upi_id`, `upi_transaction_id`, and domain separator `5`).
