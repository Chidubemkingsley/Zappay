# Zappay ↔ UPI Escrow Frontend

React + Vite frontend for the STRK/UPI P2P escrow. Uses **StarkZap** for wallet connection and **Starknet.js** for contract calls.

## Features

- **Deposit** – Sellers lock STRK with UPI ID and price per STRK (NGN)
- **Browse listings** – View active deposits from contract events
- **Buy flow** – Signal intent → Pay UPI → Verify via TEE → Claim STRK
- **Withdraw** – Sellers withdraw if no active intent or after intent expiry

## Environment

Create `.env` in `frontend/`:

| Variable | Description |
|----------|-------------|
| `VITE_ESCROW_ADDRESS` | Starknet escrow contract address |
| `VITE_TEE_SERVER` | TEE API base URL (e.g. `https://your-tee.eigencloud.xyz`) |

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Tech stack

- React 19
- Vite 7
- Starknet.js
- StarkZap (wallet onboarding)
