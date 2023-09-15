use hash::HashStateTrait;
use pedersen::PedersenTrait;
use starknet::{ContractAddress, get_tx_info, get_contract_address, account::Call};

const ERC165_OUTSIDE_EXECUTION_INTERFACE_ID: felt252 =
    0x68cfd18b92d1907b8ba3cc324900277f5a3622099431ea85dd8089255e4181;

/// Interface ID: 0x68cfd18b92d1907b8ba3cc324900277f5a3622099431ea85dd8089255e4181
// get_outside_execution_message_hash is not part of the standard interface
#[starknet::interface]
trait IOutsideExecution<TContractState> {
    /// @notice This method allows anyone to submit a transaction on behalf of the account as long as they have the relevant signatures
    /// @param outside_execution The parameters of the transaction to execute
    /// @param signature A valid signature on the Eip712 message encoding of `outside_execution`
    /// @notice This method allows reentrancy. A call to `__execute__` or `execute_from_outside` can trigger another nested transaction to `execute_from_outside`.
    fn execute_from_outside(
        ref self: TContractState, outside_execution: OutsideExecution, signature: Array<felt252>
    ) -> Array<Span<felt252>>;

    /// Get the status of a given nonce, true if the nonce is available to use
    fn is_valid_outside_execution_nonce(self: @TContractState, nonce: felt252) -> bool;

    /// Get the message hash for some `OutsideExecution` following Eip712. Can be used to know what needs to be signed
    fn get_outside_execution_message_hash(
        self: @TContractState, outside_execution: OutsideExecution
    ) -> felt252;
}

// H('StarkNetDomain(name:felt,version:felt,chainId:felt)')
const STARKNET_DOMAIN_TYPE_HASH: felt252 =
    0x1bfc207425a47a5dfa1a50a4f5241203f50624ca5fdf5e18755765416b8e288;

#[derive(Drop)]
struct StarkNetDomain {
    name: felt252,
    version: felt252,
    chain_id: felt252,
}

// H('OutsideExecution(caller:felt,nonce:felt,execute_after:felt,execute_before:felt,calls_len:felt,calls:Call*)')
const OUTSIDE_EXECUTION_TYPE_HASH: felt252 =
    0x11ff76fe3f640fa6f3d60bbd94a3b9d47141a2c96f87fdcfbeb2af1d03f7050;

#[derive(Copy, Drop, Serde)]
struct OutsideExecution {
    /// @notice Only the address specified here will be allowed to call `execute_from_outside`
    /// As an exception, to opt-out of this check, the value 'ANY_CALLER' can be used
    caller: ContractAddress,
    /// It can be any value as long as it's unique. Prevents signature reuse
    nonce: felt252,
    /// `execute_from_outside` only succeeds if executing after this time
    execute_after: u64,
    /// `execute_from_outside` only succeeds if executing before this time
    execute_before: u64,
    /// The calls that will be executed by the Account
    calls: Span<Call>
}

// H('OutsideCall(to:felt,selector:felt,calldata_len:felt,calldata:felt*)')
const OUTSIDE_CALL_TYPE_HASH: felt252 =
    0xf00de1fccbb286f9a020ba8821ee936b1deea42a5c485c11ccdc82c8bebb3a;

#[derive(Drop, Serde)]
struct OutsideCall {
    to: ContractAddress,
    selector: felt252,
    calldata: Array<felt252>,
}

#[inline(always)]
fn hash_domain(domain: @StarkNetDomain) -> felt252 {
    PedersenTrait::new(0)
        .update(STARKNET_DOMAIN_TYPE_HASH)
        .update(*domain.name)
        .update(*domain.version)
        .update(*domain.chain_id)
        .finalize()
}

fn hash_outside_call(outside_call: @Call) -> felt252 {
    let calldata_len = outside_call.calldata.len().into();
    let mut data_span = outside_call.calldata.span();

    let calldata_state = PedersenTrait::new(0);
    loop {
        match data_span.pop_front() {
            Option::Some(item) => {
                calldata_state.update(*item);
            },
            Option::None => {
                calldata_state.update(calldata_len);
                break;
            },
        };
    };

    PedersenTrait::new(0)
        .update(OUTSIDE_CALL_TYPE_HASH)
        .update((*outside_call.to).into())
        .update(*outside_call.selector)
        .update(calldata_len)
        .update(calldata_state.finalize())
        .finalize()
}

fn hash_outside_execution(outside_execution: @OutsideExecution) -> felt252 {
    let calls_len = (*outside_execution.calls).len().into();
    let mut calls_span = *outside_execution.calls;

    let outside_calls_state = PedersenTrait::new(0);
    loop {
        match calls_span.pop_front() {
            Option::Some(call) => {
                outside_calls_state.update(hash_outside_call(call));
            },
            Option::None => {
                outside_calls_state.update(calls_len);
                break;
            },
        };
    };

    PedersenTrait::new(0)
        .update(OUTSIDE_EXECUTION_TYPE_HASH)
        .update((*outside_execution.caller).into())
        .update(*outside_execution.nonce)
        .update((*outside_execution.execute_after).into())
        .update((*outside_execution.execute_before).into())
        .update(calls_len)
        .update(outside_calls_state.finalize())
        .finalize()
}

#[inline(always)]
fn hash_outside_execution_message(outside_execution: @OutsideExecution) -> felt252 {
    let domain = StarkNetDomain {
        name: 'Account.execute_from_outside', version: 1, chain_id: get_tx_info().unbox().chain_id,
    };

    PedersenTrait::new(0)
        .update('StarkNet Message')
        .update(hash_domain(@domain))
        .update(get_contract_address().into())
        .update(hash_outside_execution(outside_execution))
        .update(4)
        .finalize()
}
