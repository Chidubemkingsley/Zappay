# Zappay Frontend


![image](../Zappay.png)
React + Vite frontend for the Zappay P2P STRK/NGN escrow marketplace.

Uses **StarkZap** for wallet connection (Cartridge Controller) and **Starknet.js** for on-chain contract calls. Payment verification is handled by the Eigen TEE via Paystack API.

---

## Features

- **Connect wallet** – Cartridge Controller via StarkZap, deploys automatically if needed
- **Buy STRK** – Browse open orders, signal intent, send Naira via any Nigerian bank, paste Paystack reference to verify and claim
- **Sell STRK** – Lock STRK in escrow with your bank account number and NGN price
- **My Deposits** – View and manage your active escrow deposits, withdraw anytime if no active intent
- **Live STRK/NGN rate** – Fetched from CoinGecko every 60 seconds
- **Help bot** – Built-in `?` assistant that answers questions about how the app works
- **Transfer STRK** – Send STRK to any Starknet address directly from the wallet bar

---

## Supported Banks

Any Nigerian bank that processes through Paystack — Opay, PalmPay, Kuda, Moniepoint, GTBank, Access, Zenith, First Bank, UBA, and all NIBSS-connected banks.

---

## Environment

Create `.env` in `frontend/` (copy from `.env.example`):

| Variable | Description |
|----------|-------------|
| `VITE_ESCROW_ADDRESS` | Starknet escrow contract address |
| `VITE_TEE_SERVER` | TEE API base URL (e.g. `https://your-tee.eigencloud.xyz`) |

Current Sepolia contract: `0x045f0dda5b49e8c994aceeb74f08dcbd47da88cd1ab2085221e76e3f78466c45`

---

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

## Build

```bash
npm run build
```

> HTTPS dev server certs (`localhost+2-key.pem` / `localhost+2.pem`) are optional — the build works without them.

---

## Tech Stack

- React 19
- Vite 7
- Starknet.js
- StarkZap (`starkzap`) — wallet onboarding and session policies
- Sepolia testnet
