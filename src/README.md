# Cairo Smart Contracts

Starknet escrow contract for STRK ↔ UPI P2P trades.

## `escrow.cairo`

Main escrow contract with:

- **Deposit** – Lock STRK with UPI ID and price per STRK (INR)
- **Withdraw** – Reclaim STRK if no active intent or after intent expiry
- **Signal intent** – Buyer locks a 1-hour window to complete payment
- **Cancel intent** – Buyer cancels before paying
- **Claim funds** – Buyer submits TEE-signed UPI receipt; STRK is released

### Signature verification

The contract verifies ECDSA signatures over a Pedersen hash of:

```
hash(payment_status_title, payment_total_amount, receiver_upi_id, upi_transaction_id, 5)
```

The TEE computes the same hash and signs it; the contract checks against `signer_public_key`.

### Nullifiers

Each `upi_transaction_id` is stored as a nullifier to prevent double-spend.

## Build & Test

```bash
scarb build
scarb test
```

## Dependencies

- `openzeppelin_interfaces` 2.1.0
- `openzeppelin_token` 3.0.0
- `starknet` 2.16.0
