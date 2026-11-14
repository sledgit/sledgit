//! Minimal NEP-141 token for sandbox tests only. Never deploy to mainnet.
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    symbol: String,
    decimals: u8,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, symbol: String, decimals: u8) -> Self {
        let mut this = Self { token: FungibleToken::new(b"t".to_vec()), symbol, decimals };
        this.token.internal_register_account(&owner_id);
        this.token.internal_deposit(&owner_id, total_supply.into());
        this
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_contract_standards::fungible_token::core::FungibleTokenCore::ft_transfer(&mut self.token, receiver_id, amount, memo)
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        near_contract_standards::fungible_token::core::FungibleTokenCore::ft_transfer_call(&mut self.token, receiver_id, amount, memo, msg)
    }

    pub fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }

    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        near_contract_standards::fungible_token::resolver::FungibleTokenResolver::ft_resolve_transfer(&mut self.token, sender_id, receiver_id, amount)
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds { self.token.storage_balance_bounds() }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> { self.token.storage_balance_of(account_id) }
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool { self.token.storage_unregister(force) }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata { spec: FT_METADATA_SPEC.to_string(), name: self.symbol.clone(), symbol: self.symbol.clone(),
            icon: None, reference: None, reference_hash: None, decimals: self.decimals }
    }
}

