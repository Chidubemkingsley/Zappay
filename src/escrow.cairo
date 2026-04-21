//! P2P Onramp/Offramp Escrow Contract
//!
//! Flow: Seller deposits STRK → Buyer signals intent (1hr lock) → Buyer pays UPI
//! off-chain → Buyer claims with valid signature while intent is active.
//! Seller can withdraw if no active intent exists.

use core::ecdsa::check_ecdsa_signature;
use core::pedersen::pedersen;
use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
use starknet::storage::{
    StoragePointerReadAccess, StoragePointerWriteAccess, StorageMapReadAccess,
    StorageMapWriteAccess,
};
use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};

const INTENT_DURATION: u64 = 3600; // 1 hour

#[starknet::interface]
pub trait IEscrow<TContractState> {
    fn deposit(
        ref self: TContractState,
        upi_id: felt252,
        amount_strk: u256,
        price_per_strk_inr: u256,
    ) -> u64;

    fn withdraw(ref self: TContractState, deposit_id: u64);

    fn signal_intent(ref self: TContractState, deposit_id: u64);

    fn cancel_intent(ref self: TContractState, deposit_id: u64);

    fn claim_funds(
        ref self: TContractState,
        signature_r: felt252,
        signature_s: felt252,
        payment_status_title: felt252,
        payment_total_amount: u256,
        receiver_upi_id: felt252,
        upi_transaction_id: felt252,
        deposit_id: u64,
    );

    fn get_deposit(
        self: @TContractState, deposit_id: u64,
    ) -> (felt252, u256, u256, ContractAddress, bool);
    fn get_next_deposit_id(self: @TContractState) -> u64;
    fn get_signer_public_key(self: @TContractState) -> felt252;
    fn get_token_address(self: @TContractState) -> ContractAddress;
    fn get_intent(self: @TContractState, deposit_id: u64) -> (ContractAddress, u64);
}

#[starknet::contract]
mod Escrow {
    use super::{
        check_ecdsa_signature, pedersen, get_caller_address, get_block_timestamp, IEscrow,
        INTENT_DURATION,
    };
    use starknet::get_contract_address;
    use super::{
        StoragePointerReadAccess, StoragePointerWriteAccess, StorageMapReadAccess,
        StorageMapWriteAccess,
    };
    use super::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::ContractAddress;
    use core::num::traits::{OverflowingAdd, OverflowingSub};

    #[storage]
    struct Storage {
        signer_public_key: felt252,
        token_address: ContractAddress,
        next_deposit_id: u64,
        total_locked: u256,
        deposits: starknet::storage::Map<u64, (felt252, u256, u256, ContractAddress, bool)>,
        nullifiers: starknet::storage::Map<felt252, bool>,
        intents: starknet::storage::Map<u64, (ContractAddress, u64)>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Deposit: Deposit,
        Claim: Claim,
        Withdraw: Withdraw,
        IntentSignaled: IntentSignaled,
        IntentCancelled: IntentCancelled,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        #[key]
        deposit_id: u64,
        depositor: ContractAddress,
        upi_id: felt252,
        amount_strk: u256,
        price_per_strk_inr: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct Claim {
        #[key]
        deposit_id: u64,
        claimer: ContractAddress,
        upi_transaction_id: felt252,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct Withdraw {
        #[key]
        deposit_id: u64,
        depositor: ContractAddress,
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentSignaled {
        #[key]
        deposit_id: u64,
        buyer: ContractAddress,
        expires_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentCancelled {
        #[key]
        deposit_id: u64,
        buyer: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, signer_public_key: felt252, token_address: ContractAddress,
    ) {
        self.signer_public_key.write(signer_public_key);
        self.token_address.write(token_address);
        self.next_deposit_id.write(0);
        self.total_locked.write(0_u256);
    }

    #[abi(embed_v0)]
    impl EscrowImpl of IEscrow<ContractState> {
        fn deposit(
            ref self: ContractState,
            upi_id: felt252,
            amount_strk: u256,
            price_per_strk_inr: u256,
        ) -> u64 {
            let caller = get_caller_address();
            let mut token = IERC20Dispatcher { contract_address: self.token_address.read() };
            token.transfer_from(caller, get_contract_address(), amount_strk);

            let deposit_id = self.next_deposit_id.read();
            self.next_deposit_id.write(deposit_id + 1);

            let (total_locked, _) = self.total_locked.read().overflowing_add(amount_strk);
            self.total_locked.write(total_locked);

            self
                .deposits
                .write(
                    deposit_id, (upi_id, amount_strk, price_per_strk_inr, caller, false),
                );

            self
                .emit(
                    Deposit {
                        deposit_id, depositor: caller, upi_id, amount_strk, price_per_strk_inr,
                    },
                );
            deposit_id
        }

        fn withdraw(ref self: ContractState, deposit_id: u64) {
            let (upi_id, amount_strk, price_per_strk_inr, depositor, claimed) = self
                .deposits
                .read(deposit_id);
            assert(amount_strk > 0, 'Deposit does not exist');
            assert(!claimed, 'Deposit already claimed');

            let caller = get_caller_address();
            assert(caller == depositor, 'Only depositor can withdraw');

            let (_, intent_time) = self.intents.read(deposit_id);
            if intent_time > 0 {
                let now = get_block_timestamp();
                assert(now >= intent_time + INTENT_DURATION, 'Active intent exists');
            }

            self
                .deposits
                .write(
                    deposit_id, (upi_id, amount_strk, price_per_strk_inr, depositor, true),
                );

            let (new_total, underflow) = self.total_locked.read().overflowing_sub(amount_strk);
            assert(!underflow, 'Total locked underflow');
            self.total_locked.write(new_total);

            let mut token = IERC20Dispatcher { contract_address: self.token_address.read() };
            token.transfer(caller, amount_strk);

            self.emit(Withdraw { deposit_id, depositor: caller, amount: amount_strk });
        }

        fn signal_intent(ref self: ContractState, deposit_id: u64) {
            let (_, amount_strk, _, _, claimed) = self.deposits.read(deposit_id);
            assert(amount_strk > 0, 'Deposit does not exist');
            assert(!claimed, 'Deposit already claimed');

            let now = get_block_timestamp();
            let (_, intent_time) = self.intents.read(deposit_id);
            if intent_time > 0 {
                assert(now >= intent_time + INTENT_DURATION, 'Intent already active');
            }

            let caller = get_caller_address();
            let expires_at = now + INTENT_DURATION;
            self.intents.write(deposit_id, (caller, now));

            self.emit(IntentSignaled { deposit_id, buyer: caller, expires_at });
        }

        fn cancel_intent(ref self: ContractState, deposit_id: u64) {
            let (intent_buyer, _) = self.intents.read(deposit_id);
            let caller = get_caller_address();
            assert(caller == intent_buyer, 'Not your intent');

            let zero_addr: ContractAddress = 0.try_into().unwrap();
            self.intents.write(deposit_id, (zero_addr, 0));

            self.emit(IntentCancelled { deposit_id, buyer: caller });
        }

        fn claim_funds(
            ref self: ContractState,
            signature_r: felt252,
            signature_s: felt252,
            payment_status_title: felt252,
            payment_total_amount: u256,
            receiver_upi_id: felt252,
            upi_transaction_id: felt252,
            deposit_id: u64,
        ) {
            let (upi_id, amount_strk, price_per_strk_inr, depositor, claimed) = self
                .deposits
                .read(deposit_id);
            assert(amount_strk > 0, 'Deposit does not exist');
            assert(!claimed, 'Deposit already claimed');

            let caller = get_caller_address();
            let (intent_buyer, intent_time) = self.intents.read(deposit_id);
            assert(caller == intent_buyer, 'No intent from caller');
            let now = get_block_timestamp();
            assert(now < intent_time + INTENT_DURATION, 'Intent expired');

            let message_hash = InternalImpl::_compute_payment_hash(
                payment_status_title,
                payment_total_amount,
                receiver_upi_id,
                upi_transaction_id,
            );
            let signer_pk = self.signer_public_key.read();
            let is_valid = check_ecdsa_signature(
                message_hash, signer_pk, signature_r, signature_s,
            );
            assert(is_valid, 'Invalid signature');

            let success_felt = 0x53554343455353;
            assert(payment_status_title == success_felt, 'Payment status must be SUCCESS');

            assert(!self.nullifiers.read(upi_transaction_id), 'UPI txn already used');
            self.nullifiers.write(upi_transaction_id, true);

            assert(receiver_upi_id == upi_id, 'UPI ID mismatch');

            let required_amount = amount_strk * price_per_strk_inr;
            assert(payment_total_amount >= required_amount, 'Insufficient payment amount');

            self
                .deposits
                .write(
                    deposit_id, (upi_id, amount_strk, price_per_strk_inr, depositor, true),
                );

            let zero_addr: ContractAddress = 0.try_into().unwrap();
            self.intents.write(deposit_id, (zero_addr, 0));

            let (new_total, underflow) = self.total_locked.read().overflowing_sub(amount_strk);
            assert(!underflow, 'Total locked underflow');
            self.total_locked.write(new_total);

            let mut token = IERC20Dispatcher { contract_address: self.token_address.read() };
            token.transfer(caller, amount_strk);

            self
                .emit(
                    Claim {
                        deposit_id, claimer: caller, upi_transaction_id, amount: amount_strk,
                    },
                );
        }

        fn get_deposit(
            self: @ContractState, deposit_id: u64,
        ) -> (felt252, u256, u256, ContractAddress, bool) {
            self.deposits.read(deposit_id)
        }

        fn get_next_deposit_id(self: @ContractState) -> u64 {
            self.next_deposit_id.read()
        }

        fn get_signer_public_key(self: @ContractState) -> felt252 {
            self.signer_public_key.read()
        }

        fn get_token_address(self: @ContractState) -> ContractAddress {
            self.token_address.read()
        }

        fn get_intent(self: @ContractState, deposit_id: u64) -> (ContractAddress, u64) {
            self.intents.read(deposit_id)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _compute_payment_hash(
            payment_status_title: felt252,
            payment_total_amount: u256,
            receiver_upi_id: felt252,
            upi_transaction_id: felt252,
        ) -> felt252 {
            let amount_low: felt252 = payment_total_amount.low.into();
            let amount_high: felt252 = payment_total_amount.high.into();
            let h0 = pedersen(0, payment_status_title);
            let h1 = pedersen(h0, amount_low);
            let h2 = pedersen(h1, amount_high);
            let h3 = pedersen(h2, receiver_upi_id);
            let h4 = pedersen(h3, upi_transaction_id);
            pedersen(h4, 5)
        }
    }
}
