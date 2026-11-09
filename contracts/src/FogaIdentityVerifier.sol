// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title  FogaIdentityVerifier — the ERC-8489 `identity` predicate leaf (kind 7) as FOGA reads it
/// @notice A predicate verifier (`IAIFPPredicateVerifier`) a paradigm names for the admission of a role: the subject
///         is an account that owns an ERC-8004 identity, and — by the required state — whose ERC-8434 anchor is
///         ACTIVE, or bound to that very identity. The two registries are fixed at deployment (the locked world's),
///         never taken from the caller: a predicate whose `ref` names another registry is UNDETERMINABLE here, not
///         judged. The subject is bound first: the evidence names an account and an agent id, and the account's
///         subject reference (`eip155-address:<chainId>:<account>`, ERC-8489 section 3) must be the subject being
///         admitted — a cell admits itself through its account, so the subject is the account, never the operator's
///         key and never an `erc8004:` reference.
///
///         Outcomes, as the ERC asks (section 2.5): SATISFIED when every condition holds; NOT_SATISFIED when a
///         condition is shown not to hold (evidence for another subject, an identity owned by someone else or not at
///         all, an anchor that is not ACTIVE, a binding to another identity); UNDETERMINABLE when the question cannot
///         be answered here (another kind, another registry, missing or malformed evidence or parameters);
///         VERIFIER_ERROR when a registry this verifier depends on does not answer. The verifier never reverts to
///         say no, and never reads the content of anything.
///
///         requiredState (the kind-7 parameter): 0 registered — the account owns the agent; 1 active — and its
///         anchor is ACTIVE; 2 bound — and the anchor's binding names this registry and this agent.
interface IERC8004OwnerOfLike {
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IAIDRegistryStateLike {
    struct Binding {
        address registry;
        uint256 agentId;
        uint64 boundAt;
    }

    function state(address anchor) external view returns (uint8);
    function bindingOf(address anchor) external view returns (Binding memory);
}

contract FogaIdentityVerifier {
    uint8 public constant SATISFIED = 0;
    uint8 public constant NOT_SATISFIED = 1;
    uint8 public constant UNDETERMINABLE = 2;
    uint8 public constant VERIFIER_ERROR = 3;

    /// @notice The predicate kind this verifier answers (ERC-8489 section 6.2).
    uint8 public constant KIND_IDENTITY = 7;
    uint8 public constant STATE_REGISTERED = 0;
    uint8 public constant STATE_ACTIVE = 1;
    uint8 public constant STATE_BOUND = 2;
    /// @dev ERC-8434 `State.ACTIVE`.
    uint8 public constant AID_ACTIVE = 1;

    bytes4 private constant IERC165_ID = 0x01ffc9a7;
    /// @dev `IAIFPPredicateVerifier` (ERC-8489 test cases).
    bytes4 private constant IAIFP_PREDICATE_VERIFIER_ID = 0xe7a501b7;
    bytes16 private constant HEX = "0123456789abcdef";

    /// @notice The ERC-8004 identity registry whose agents this verifier recognizes.
    address public immutable identityRegistry;
    /// @notice The ERC-8434 registry whose anchors it reads.
    address public immutable aidRegistry;

    error ZeroAddress();

    constructor(address identityRegistry_, address aidRegistry_) {
        if (identityRegistry_ == address(0) || aidRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        aidRegistry = aidRegistry_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == IERC165_ID || interfaceId == IAIFP_PREDICATE_VERIFIER_ID;
    }

    /// @notice `IAIFPPredicateVerifier.verify`. `evidence` is `abi.encode(address account, uint256 agentId)`.
    function verify(
        bytes32, /* channelId */
        bytes32 subject,
        uint16, /* role */
        bytes32, /* scopeRef */
        uint8 kind,
        bytes32 ref,
        bytes calldata params,
        bytes calldata evidence
    ) external view returns (uint8) {
        if (kind != KIND_IDENTITY) return UNDETERMINABLE; // another vocabulary: not this verifier's to judge
        if (ref != bytes32(uint256(uint160(identityRegistry)))) return UNDETERMINABLE; // another registry: not known here
        if (params.length != 32) return UNDETERMINABLE;
        uint256 required = abi.decode(params, (uint256));
        if (required > STATE_BOUND) return UNDETERMINABLE;
        if (evidence.length != 64) return UNDETERMINABLE; // no proof offered: nothing is shown either way
        (address account, uint256 agentId) = abi.decode(evidence, (address, uint256));
        // the subject is bound first: evidence about another account proves nothing about this subject
        if (subjectOf(account) != subject) return NOT_SATISFIED;

        // registered: the account owns the agent in the locked registry (a token that does not exist is nobody's)
        (bool ok, bytes memory ret) = identityRegistry.staticcall(abi.encodeWithSelector(IERC8004OwnerOfLike.ownerOf.selector, agentId));
        if (!ok || ret.length != 32) return NOT_SATISFIED;
        if (abi.decode(ret, (address)) != account) return NOT_SATISFIED;
        if (required == STATE_REGISTERED) return SATISFIED;

        // active: the account's anchor is ACTIVE in the locked ERC-8434 registry
        (ok, ret) = aidRegistry.staticcall(abi.encodeWithSelector(IAIDRegistryStateLike.state.selector, account));
        if (!ok || ret.length != 32) return VERIFIER_ERROR; // the registry this verifier depends on did not answer
        if (abi.decode(ret, (uint256)) != AID_ACTIVE) return NOT_SATISFIED;
        if (required == STATE_ACTIVE) return SATISFIED;

        // bound: the anchor's binding names this registry and this very agent
        (ok, ret) = aidRegistry.staticcall(abi.encodeWithSelector(IAIDRegistryStateLike.bindingOf.selector, account));
        if (!ok || ret.length != 96) return VERIFIER_ERROR;
        (address boundRegistry, uint256 boundAgent,) = abi.decode(ret, (address, uint256, uint64));
        if (boundRegistry != identityRegistry || boundAgent != agentId) return NOT_SATISFIED;
        return SATISFIED;
    }

    /// @notice The ERC-8489 subject reference of an account on this chain: keccak256("eip155-address:<chainId>:<0x lowercase hex>").
    function subjectOf(address account) public view returns (bytes32) {
        return keccak256(abi.encodePacked("eip155-address:", _decimal(block.chainid), ":", _hexAddress(account)));
    }

    function _decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _hexAddress(address account) private pure returns (string memory) {
        bytes memory buffer = new bytes(42);
        buffer[0] = "0";
        buffer[1] = "x";
        uint160 value = uint160(account);
        for (uint256 i = 41; i > 1; i--) {
            buffer[i] = HEX[value & 0xf];
            value >>= 4;
        }
        return string(buffer);
    }
}
