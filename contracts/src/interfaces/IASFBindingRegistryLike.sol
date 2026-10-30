// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title  ASF types and the Binding Registry surface FogaCellAccount consumes
/// @notice Mirrors the ABI of agent-safety-framework (ERC-8468 reference implementation, commit a76071c):
///         `ASFTypes.RequirementSet / Clause / Intervener / Verdict / Reason` and
///         `IASFBindingRegistry.check / requirementId`. Only the ABI shape matters here; the semantics
///         live in the registry.
library ASFLike {
    enum Verdict {
        Unknown,
        Satisfied,
        NotSatisfied
    }

    enum Reason {
        None,
        NoBinding,
        Terminated,
        Suspended,
        NotYetValid,
        Expired,
        SpecMismatch,
        VersionMismatch,
        AdopterMismatch,
        SubjectMismatch,
        ScopeMismatch,
        EnforcementMismatch,
        ParentNotSatisfied,
        SpecRegistryUnavailable,
        IntervenerMismatch,
        StoppedByIntervener
    }

    enum Combinator {
        All,
        Any,
        KOf
    }

    struct Intervener {
        address account;
        uint8 rights;
    }

    struct Clause {
        address specRegistry;
        bytes32 specId;
        uint32[] versions;
        address adopter;
        bytes32 subjectKey;
        bytes32 scopeKey;
        uint16 enforcement;
        Intervener[] interveners;
    }

    struct RequirementSet {
        Combinator combinator;
        uint16 k;
        Clause[] clauses;
    }

    /// @dev `ASFTypes.BindingInput`: what an adopter hands to `adopt`.
    struct BindingInput {
        bytes32 subjectKey;
        bytes32 scopeKey;
        address specRegistry;
        bytes32 specId;
        uint32 version;
        bytes32 contentHash;
        bytes32 paramsHash;
        string paramsLocator;
        bytes32 authorityRef;
        uint16 enforcement;
        uint64 validFrom;
        uint64 validUntil;
        bytes32 parentBindingId;
        bytes32 salt;
        Intervener[] interveners;
    }

    uint8 internal constant RESTRICT_DERISK_ONLY = 8;
    uint8 internal constant RESTRICT_FULL_STOP = 16;
}

interface IASFBindingRegistryLike {
    function adopt(ASFLike.BindingInput calldata input) external returns (bytes32 bindingId);

    function check(ASFLike.RequirementSet calldata requirement, bytes32[] calldata bindingIds)
        external
        view
        returns (ASFLike.Verdict verdict, ASFLike.Reason[] memory reasons, uint8[] memory restrictions);

    function requirementId(ASFLike.RequirementSet calldata requirement) external pure returns (bytes32);
}

/// @notice ERC-8434 AIDRegistry surface used by the AID-state clause gate (aid-standard commit 1ff7215).
interface IAIDRegistryLike {
    enum State {
        DORMANT,
        ACTIVE,
        STALE,
        RETIRED
    }

    function state(address anchor) external view returns (State);
}
