// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IKYAVerifier} from "../interfaces/IKYAVerifierLike.sol";

/// @dev snarkjs-style Groth16 verifier with 17 public signals (zk/circuits/kya_predicate_count_v1.circom).
interface IGroth16Verifier17 {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[17] calldata input)
        external
        view
        returns (bool);
}

/// @title Groth16PredicateKYAVerifierAdapter
/// @notice FOGA's IKYAVerifier for the predicate-pattern scheme `kya-predicate-count-v1` (ERC-8419 section 5):
///         the scheme is a decision rule — "at least K accepted task completions about the subject inside
///         [t0, t1], signed by a source from the committed source set" — and the proof says the rule holds. The
///         chain learns the subject, the rule's parameters and the result bit; never the records.
///
///         publicInputs = abi.encode(bytes32 subjectKey, bytes32 nullifier, bytes32 challenge, uint64 t0,
///                                   uint64 t1, uint16 k, bytes32 sourceSetRoot, uint64 epoch, uint8 result)
///         proof        = abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)
///
///         signals (17), in snarkjs order (circuit outputs first, then public inputs):
///           [0] nullifier.hi      [1] nullifier.lo      [2] result
///           [3] subjectKey.hi     [4] subjectKey.lo
///           [5] challenge.hi      [6] challenge.lo      — the relying party's freshness value; the nullifier
///                                                         is derived from it, so a proof answers one challenge
///           [7] t0  [8] t1  [9] k                       — the rule's parameters, committed in claimDigest
///          [10] sourceSetRoot.hi [11] sourceSetRoot.lo  — the trust anchor; optionally pinned here
///          [12] schemeId.hi      [13] schemeId.lo       — from the `schemeId` argument: the proof is bound to the rule
///          [14] epoch                                   — enforced against block time (below)
///          [15] admissionDomain.hi [16] admissionDomain.lo — from the `admissionDomain` argument, computed by the
///                                                         calling registry and never accepted from the prover
///
///         Mapping to framework fields: a verified proof with result == 1 is level 1 (ORDERED_LEVEL; level 0 is
///         declared by the scheme and never issued by this adapter: a proof that the rule does NOT hold is
///         rejected, not recorded); claimDigest = keccak256(abi.encode(challenge, t0, t1, k, sourceSetRoot));
///         expiresAt = block.timestamp + validity (0 when validity == 0); anchor = sourceSetRoot.
///
///         Time-window rule (enforced here, not trusted from the prover), as in the upstream credential adapter:
///           epochLength == 0  → epoch MUST be 0
///           epochLength  > 0  → current = block.timestamp / epochLength; epoch MUST be in [current - grace, current]
contract Groth16PredicateKYAVerifierAdapter is IKYAVerifier {
    error SourceSetRootMismatch(bytes32 expected, bytes32 actual);
    error EpochOutOfWindow(uint64 current, uint64 grace, uint64 actual);
    error PredicateNotSatisfied();
    error InvalidResult(uint8 result);
    error EmptyWindow(uint64 t0, uint64 t1);

    IGroth16Verifier17 public immutable groth16;
    bytes32 public immutable requiredSourceSetRoot; // 0x0 = any
    uint64 public immutable epochLength; // seconds; 0 = epoch must be 0
    uint64 public immutable epochGrace; // how many past epochs remain acceptable
    uint64 public immutable validity; // seconds an assertion issued from a proof stays valid; 0 = no expiry

    constructor(address groth16_, bytes32 requiredSourceSetRoot_, uint64 epochLength_, uint64 epochGrace_, uint64 validity_) {
        groth16 = IGroth16Verifier17(groth16_);
        requiredSourceSetRoot = requiredSourceSetRoot_;
        epochLength = epochLength_;
        epochGrace = epochGrace_;
        validity = validity_;
    }

    struct Pub {
        bytes32 subjectKey;
        bytes32 nullifier;
        bytes32 challenge;
        uint64 t0;
        uint64 t1;
        uint16 k;
        bytes32 sourceSetRoot;
        uint64 epoch;
        uint8 result;
    }

    /// @notice The epoch a prover MUST use right now (0 when epochLength == 0).
    function currentEpoch() public view returns (uint64) {
        return epochLength == 0 ? 0 : uint64(block.timestamp / epochLength);
    }

    function verify(bytes32 schemeId, bytes32 admissionDomain, bytes calldata publicInputs, bytes calldata proof)
        external
        view
        returns (bool ok, bytes32 subjectKey, bytes32 nullifier, uint8 level, bytes32 claimDigest, uint64 expiresAt, bytes32 anchor)
    {
        Pub memory p = decode(publicInputs);
        if (requiredSourceSetRoot != bytes32(0) && p.sourceSetRoot != requiredSourceSetRoot) {
            revert SourceSetRootMismatch(requiredSourceSetRoot, p.sourceSetRoot);
        }
        if (p.result > 1) revert InvalidResult(p.result);
        if (p.result == 0) revert PredicateNotSatisfied();
        if (p.t1 < p.t0) revert EmptyWindow(p.t0, p.t1);
        _checkEpoch(p.epoch);
        ok = _verifyGroth16(schemeId, admissionDomain, p, proof);
        if (!ok) return (false, bytes32(0), bytes32(0), 0, bytes32(0), 0, bytes32(0));
        return (true, p.subjectKey, p.nullifier, 1, claimDigestOf(p), _expiry(), p.sourceSetRoot);
    }

    /// @notice The commitment to the disclosed rule parameters recorded as the assertion's claimDigest.
    function claimDigestOf(Pub memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.challenge, p.t0, p.t1, p.k, p.sourceSetRoot));
    }

    function _expiry() internal view returns (uint64) {
        return validity == 0 ? 0 : uint64(block.timestamp) + validity;
    }

    function _checkEpoch(uint64 epoch) internal view {
        uint64 cur = currentEpoch();
        uint64 low = cur > epochGrace ? cur - epochGrace : 0;
        if (epoch > cur || epoch < low) revert EpochOutOfWindow(cur, epochGrace, epoch);
    }

    /// @notice Decodes the scheme's public-input layout. Exposed for tooling.
    function decode(bytes calldata publicInputs) public pure returns (Pub memory p) {
        (p.subjectKey, p.nullifier, p.challenge, p.t0, p.t1, p.k, p.sourceSetRoot, p.epoch, p.result) =
            abi.decode(publicInputs, (bytes32, bytes32, bytes32, uint64, uint64, uint16, bytes32, uint64, uint8));
    }

    function _verifyGroth16(bytes32 schemeId, bytes32 admissionDomain, Pub memory p, bytes calldata proof) internal view returns (bool) {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        return groth16.verifyProof(a, b, c, signals(schemeId, admissionDomain, p));
    }

    /// @notice Public-signal vector for (schemeId, admissionDomain, p), in the circuit's order. Exposed for tooling.
    function signals(bytes32 schemeId, bytes32 admissionDomain, Pub memory p) public pure returns (uint256[17] memory input) {
        (input[0], input[1]) = _split(p.nullifier);
        input[2] = p.result;
        (input[3], input[4]) = _split(p.subjectKey);
        (input[5], input[6]) = _split(p.challenge);
        input[7] = p.t0;
        input[8] = p.t1;
        input[9] = p.k;
        (input[10], input[11]) = _split(p.sourceSetRoot);
        (input[12], input[13]) = _split(schemeId);
        input[14] = p.epoch;
        (input[15], input[16]) = _split(admissionDomain);
    }

    function _split(bytes32 v) internal pure returns (uint256 hi, uint256 lo) {
        hi = uint256(v) >> 128;
        lo = uint256(v) & ((uint256(1) << 128) - 1);
    }
}
