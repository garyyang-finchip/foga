// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {FogaIdentityVerifier} from "../src/FogaIdentityVerifier.sol";
import {Identity8004Stub} from "../src/Identity8004Stub.sol";

/// Minimal cheatcode surface so the test needs no external library.
interface Vm {
    function prank(address msgSender) external;
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
}

/// An ERC-8434 registry surface with settable state and binding (the reference registry's semantics are not under test here).
contract AIDMock {
    struct Binding {
        address registry;
        uint256 agentId;
        uint64 boundAt;
    }

    mapping(address => uint8) private _state;
    mapping(address => Binding) private _binding;

    function set(address anchor, uint8 state_, address registry, uint256 agentId) external {
        _state[anchor] = state_;
        _binding[anchor] = Binding(registry, agentId, uint64(block.timestamp));
    }

    function state(address anchor) external view returns (uint8) {
        return _state[anchor];
    }

    function bindingOf(address anchor) external view returns (Binding memory) {
        return _binding[anchor];
    }
}

/// A registry whose `state` reverts: the verifier's dependency failing.
contract AIDBroken {
    function state(address) external pure returns (uint8) {
        revert("down");
    }

    function bindingOf(address) external pure returns (AIDMock.Binding memory) {
        revert("down");
    }
}

contract FogaIdentityVerifierTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint8 constant SATISFIED = 0;
    uint8 constant NOT_SATISFIED = 1;
    uint8 constant UNDETERMINABLE = 2;
    uint8 constant VERIFIER_ERROR = 3;

    Identity8004Stub identity;
    AIDMock aid;
    FogaIdentityVerifier verifier;

    address cell = address(0xCE11);
    address operator = address(0x0bE4);
    address other = address(0x07e8);
    uint256 agentId;
    uint256 otherAgent;
    bytes32 ref;

    function setUp() public {
        identity = new Identity8004Stub();
        aid = new AIDMock();
        verifier = new FogaIdentityVerifier(address(identity), address(aid));
        vm.prank(cell);
        agentId = identity.register();
        vm.prank(other);
        otherAgent = identity.register();
        aid.set(cell, 1, address(identity), agentId); // ACTIVE, bound to its own identity
        ref = bytes32(uint256(uint160(address(identity))));
    }

    function _verify(bytes32 subject, bytes32 ref_, uint8 required, bytes memory evidence) internal view returns (uint8) {
        return verifier.verify(bytes32(0), subject, 4, bytes32(0), 7, ref_, abi.encode(required), evidence);
    }

    function _evidence(address account, uint256 id) internal pure returns (bytes memory) {
        return abi.encode(account, id);
    }

    function testSubjectReferenceIsTheCanonicalString() public view {
        // ERC-8489 section 3: keccak256("eip155-address:<chainId>:<0x lowercase hex>"); the chain id is decimal
        bytes32 expected = keccak256(abi.encodePacked("eip155-address:31337:0x000000000000000000000000000000000000ce11"));
        require(verifier.subjectOf(cell) == expected, "subject reference");
    }

    function testVectorSubjectReference() public {
        // the ERC's own vector: eip155-address:1:0x0000000000000000000000000000000000000001
        vm.chainId(1);
        require(verifier.subjectOf(address(1)) == 0x3e4e98887f2ee7b0b3a5a889a1a8a1d840c24613f5cbf173aa7119b38e1b0736, "vector");
        vm.chainId(31337);
    }

    function testSatisfiedForEveryStateWhenActiveAndBound() public view {
        bytes32 subject = verifier.subjectOf(cell);
        require(_verify(subject, ref, 0, _evidence(cell, agentId)) == SATISFIED, "registered");
        require(_verify(subject, ref, 1, _evidence(cell, agentId)) == SATISFIED, "active");
        require(_verify(subject, ref, 2, _evidence(cell, agentId)) == SATISFIED, "bound");
    }

    function testOperatorKeyIsNotTheSubject() public view {
        // the operator's own address as the subject, with the cell's evidence: the proof is about another account
        require(_verify(verifier.subjectOf(operator), ref, 1, _evidence(cell, agentId)) == NOT_SATISFIED, "operator subject");
        // and the operator's address as the account: it owns no agent
        require(_verify(verifier.subjectOf(operator), ref, 0, _evidence(operator, agentId)) == NOT_SATISFIED, "operator account");
    }

    function testSomeoneElsesAgentIsNotSatisfied() public view {
        require(_verify(verifier.subjectOf(cell), ref, 0, _evidence(cell, otherAgent)) == NOT_SATISFIED, "other's agent");
    }

    function testUnknownAgentIsNotSatisfied() public view {
        require(_verify(verifier.subjectOf(cell), ref, 0, _evidence(cell, 999)) == NOT_SATISFIED, "no such agent");
    }

    function testAnotherRegistryIsUndeterminable() public view {
        bytes32 forged = bytes32(uint256(uint160(address(0xBAD))));
        require(_verify(verifier.subjectOf(cell), forged, 0, _evidence(cell, agentId)) == UNDETERMINABLE, "forged registry");
    }

    function testIdentityTransferredAwayIsNotSatisfied() public {
        vm.prank(cell);
        identity.transferFrom(cell, other, agentId);
        require(_verify(verifier.subjectOf(cell), ref, 0, _evidence(cell, agentId)) == NOT_SATISFIED, "transferred");
    }

    function testStaleAnchorFailsActiveButNotRegistered() public {
        aid.set(cell, 2, address(identity), agentId); // STALE
        bytes32 subject = verifier.subjectOf(cell);
        require(_verify(subject, ref, 0, _evidence(cell, agentId)) == SATISFIED, "registered holds");
        require(_verify(subject, ref, 1, _evidence(cell, agentId)) == NOT_SATISFIED, "active fails");
        require(_verify(subject, ref, 2, _evidence(cell, agentId)) == NOT_SATISFIED, "bound fails");
    }

    function testBoundToAnotherIdentityIsNotSatisfied() public {
        aid.set(cell, 1, address(identity), otherAgent);
        bytes32 subject = verifier.subjectOf(cell);
        require(_verify(subject, ref, 1, _evidence(cell, agentId)) == SATISFIED, "active holds");
        require(_verify(subject, ref, 2, _evidence(cell, agentId)) == NOT_SATISFIED, "bound to another agent");
        aid.set(cell, 1, address(0x1234), agentId);
        require(_verify(subject, ref, 2, _evidence(cell, agentId)) == NOT_SATISFIED, "bound in another registry");
    }

    function testMalformedInputsAreUndeterminable() public view {
        bytes32 subject = verifier.subjectOf(cell);
        require(_verify(subject, ref, 0, "") == UNDETERMINABLE, "no evidence");
        require(_verify(subject, ref, 0, abi.encode(cell)) == UNDETERMINABLE, "short evidence");
        require(_verify(subject, ref, 3, _evidence(cell, agentId)) == UNDETERMINABLE, "unknown state");
        require(verifier.verify(bytes32(0), subject, 4, bytes32(0), 5, ref, abi.encode(uint8(1)), _evidence(cell, agentId)) == UNDETERMINABLE, "another kind");
        require(verifier.verify(bytes32(0), subject, 4, bytes32(0), 7, ref, "", _evidence(cell, agentId)) == UNDETERMINABLE, "no params");
    }

    function testRegistryDownIsVerifierError() public {
        FogaIdentityVerifier broken = new FogaIdentityVerifier(address(identity), address(new AIDBroken()));
        bytes32 subject = broken.subjectOf(cell);
        require(broken.verify(bytes32(0), subject, 4, bytes32(0), 7, ref, abi.encode(uint8(0)), _evidence(cell, agentId)) == SATISFIED, "registered needs no anchor");
        require(broken.verify(bytes32(0), subject, 4, bytes32(0), 7, ref, abi.encode(uint8(1)), _evidence(cell, agentId)) == VERIFIER_ERROR, "active: the registry did not answer");
        // a registry address without code answers nothing either
        FogaIdentityVerifier noCode = new FogaIdentityVerifier(address(identity), address(0xDEAD));
        require(noCode.verify(bytes32(0), noCode.subjectOf(cell), 4, bytes32(0), 7, ref, abi.encode(uint8(1)), _evidence(cell, agentId)) == VERIFIER_ERROR, "no code");
    }

    function testInterfaceIds() public view {
        require(verifier.supportsInterface(0x01ffc9a7), "erc165");
        require(verifier.supportsInterface(0xe7a501b7), "IAIFPPredicateVerifier");
        require(!verifier.supportsInterface(0xffffffff), "not everything");
    }
}
