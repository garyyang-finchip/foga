// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title  The ERC-8419 verifier surface a ZK-KYA adapter implements
/// @notice Mirrors `IKYAVerifier` of kya-standard (ERC-8419 reference implementation, the vendored commit):
///         `verify(schemeId, admissionDomain, publicInputs, proof)` maps a proof and its public inputs to the
///         framework's assertion fields. The KYA registry calls it from `attestWithProof`, computes
///         `admissionDomain` from its own state, enforces the subject binding and the nullifier, and records
///         `level / claimDigest / expiresAt / anchor`. MUST be side-effect free; MUST enforce the scheme's
///         time-window rule for the nullifier scope it implements.
interface IKYAVerifier {
    function verify(bytes32 schemeId, bytes32 admissionDomain, bytes calldata publicInputs, bytes calldata proof)
        external
        view
        returns (
            bool ok,
            bytes32 subjectKey,
            bytes32 nullifier,
            uint8 level,
            bytes32 claimDigest,
            uint64 expiresAt,
            bytes32 anchor
        );
}
