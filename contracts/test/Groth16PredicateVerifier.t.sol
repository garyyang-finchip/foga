// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Groth16PredicateVerifier} from "../src/zk/Groth16PredicateVerifier.sol";
import {Groth16PredicateKYAVerifierAdapter} from "../src/zk/Groth16PredicateKYAVerifierAdapter.sol";

/// Minimal cheatcode surface so the test needs no external library.
interface Vm {
    function warp(uint256 newTimestamp) external;
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
}

/// The generated verifier and FOGA's adapter against a real proof made with the development proving key
/// (test/fixtures/predicate-proof.json, produced by prover/run.cjs). The circuit, the ceremony and this fixture
/// must move together: a change to either regenerates the fixture.
contract Groth16PredicateVerifierTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint64 constant EPOCH_LENGTH = 2_592_000;
    uint256 constant NOW = 1_799_000_000; // inside epoch 694, the epoch the fixture was proved for

    Groth16PredicateVerifier verifier;
    Groth16PredicateKYAVerifierAdapter adapter;
    bytes32 schemeId;
    bytes32 domain;
    bytes32 root;
    bytes publicInputs;
    bytes proof;

    function setUp() public {
        vm.warp(NOW);
        string memory json = vm.readFile("test/fixtures/predicate-proof.json");
        schemeId = vm.parseJsonBytes32(json, ".schemeId");
        domain = vm.parseJsonBytes32(json, ".admissionDomain");
        root = vm.parseJsonBytes32(json, ".sourceSetRoot");
        publicInputs = vm.parseJsonBytes(json, ".publicInputs");
        proof = vm.parseJsonBytes(json, ".proof");
        verifier = new Groth16PredicateVerifier();
        adapter = new Groth16PredicateKYAVerifierAdapter(address(verifier), root, EPOCH_LENGTH, 1, 30 days);
    }

    function testRealProofVerifiesThroughTheAdapter() public view {
        (bool ok, bytes32 subjectKey, bytes32 nullifier, uint8 level, bytes32 claimDigest, uint64 expiresAt, bytes32 anchor) =
            adapter.verify(schemeId, domain, publicInputs, proof);
        require(ok, "the development proving key's proof verifies");
        Groth16PredicateKYAVerifierAdapter.Pub memory p = adapter.decode(publicInputs);
        require(subjectKey == p.subjectKey && nullifier == p.nullifier, "subject and nullifier");
        require(level == 1 && p.result == 1 && p.k == 1, "level 1 for a satisfied rule");
        require(claimDigest == adapter.claimDigestOf(p), "claim digest");
        require(expiresAt == uint64(NOW) + 30 days && anchor == root, "expiry and anchor");
        require(p.epoch == 694 && adapter.currentEpoch() == 694, "epoch");
    }

    function testProofIsBoundToSchemeAndDomain() public view {
        (bool otherScheme,,,,,,) = adapter.verify(keccak256("another scheme"), domain, publicInputs, proof);
        require(!otherScheme, "another scheme rejects the proof");
        (bool otherDomain,,,,,,) = adapter.verify(schemeId, keccak256("another registry"), publicInputs, proof);
        require(!otherDomain, "another admission domain rejects the proof");
    }

    function testTamperedProofOrInputsFail() public view {
        bytes memory bad = proof;
        bad[40] = bytes1(uint8(bad[40]) ^ 0x01);
        (bool okBad,,,,,,) = adapter.verify(schemeId, domain, publicInputs, bad);
        require(!okBad, "a changed proof byte fails");
        Groth16PredicateKYAVerifierAdapter.Pub memory p = adapter.decode(publicInputs);
        p.k = 2; // claim a rule the proof did not establish
        bytes memory inputs = abi.encode(p.subjectKey, p.nullifier, p.challenge, p.t0, p.t1, p.k, p.sourceSetRoot, p.epoch, p.result);
        (bool okK,,,,,,) = adapter.verify(schemeId, domain, inputs, proof);
        require(!okK, "k changed outside the proof fails");
    }
}
