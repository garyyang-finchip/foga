// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ASFLike, IASFBindingRegistryLike, IAIDRegistryLike} from "./interfaces/IASFBindingRegistryLike.sol";

/// @title  FogaCellAccount — the body of a FOGA cell
/// @notice A contract account that is, at the same time, the cell's ERC-8434 anchor, its ERC-8004 owner, the
///         holder of its assets and the fulfiller of record on task tenders. It carries the execution-gate
///         semantics of agent-safety-framework's `ASFGuardedAccount` (an ERC-8468 requirement fixed at
///         deployment, bindings presented by the owner, de-risk allow-list under suspension) and adds what a
///         cell needs on top:
///         * roles: `owner` (cold principal), `operator` (the node's hot signer, scoped), `guardian`
///           (informational: the intervener named in the cell's safety binding), `recovery`;
///         * operator scope (revision 2): an allow-list of target x selector the operator may call, an expiry
///           and a per-day native-value cap; asset-moving selectors (transfers, approvals, allowances) are never
///           open to the operator, whatever the allow-list says — moving assets is the owner's act; the owner
///           may also act directly;
///         * ERC-1271: a signature by the owner is the account's signature; a signature by the operator counts
///           only when the owner has enabled operator signing, the operator is in scope and the safety gate is
///           satisfied at the time of the check — so a suspended cell signs nothing through its operator;
///         * an AID-state clause gate: selectors marked as commitment-class require the anchor to be ACTIVE in
///           the configured ERC-8434 registry, so "no delivery while not ACTIVE" is enforced, not promised;
///         * ERC-721 / ERC-1155 receiver hooks;
///         * `sweep` to the owner, open to the owner and the recovery address at all times (a de-risking
///           action by construction: it only reduces the account's exposure).
///         There is no execution path that skips the safety gate, and none that lets the operator act outside
///         the allow-list.
contract FogaCellAccount {
    /// @notice Revision of the account's authorization model (2: operator allow-list, asset selectors closed to
    ///         the operator, operator signing off by default). Accounts of revision 1 cannot be upgraded.
    uint8 public constant ACCOUNT_VERSION = 2;

    // ---------------------------------------------------------------------------- roles and config

    IASFBindingRegistryLike public immutable safety;
    address public owner;
    address public operator;
    address public guardian;
    address public recovery;
    IAIDRegistryLike public aid;

    uint64 public operatorValidUntil; // 0 = no expiry
    uint128 public operatorDailyValueCap; // 0 = unlimited
    uint64 private _spentDay;
    uint128 private _spentToday;
    /// @notice Whether a signature by the operator is accepted as the account's (ERC-1271). Off by default.
    bool public operatorMaySign;

    bytes private _requirementEncoded;
    bytes32 public immutable requirementId;
    bytes32[] private _bindingIds;

    mapping(address => mapping(bytes4 => bool)) public deriskAllowed;
    mapping(address => mapping(bytes4 => bool)) public commitmentClass;
    /// @notice What the operator may call through `execute`: target x selector. A plain value transfer is
    ///         selector 0x00000000. Set by the owner, widened and narrowed deliberately.
    mapping(address => mapping(bytes4 => bool)) public operatorAllowed;

    // ---------------------------------------------------------------------------- events and errors

    event OperatorSet(address indexed operator, uint64 validUntil, uint128 dailyValueCap);
    event OperatorAllowedSet(address indexed target, bytes4 selector, bool allowed);
    event OperatorSigningSet(bool allowed);
    event GuardianSet(address indexed guardian);
    event RecoverySet(address indexed recovery);
    event AIDRegistrySet(address indexed registry);
    event BindingsPresented(bytes32[] bindingIds);
    event BindingAdopted(bytes32 indexed bindingId, uint256 clauseIndex);
    event DeriskAllowedSet(address indexed target, bytes4 selector, bool allowed);
    event CommitmentClassSet(address indexed target, bytes4 selector, bool required);
    event Executed(address indexed caller, address indexed target, uint256 value, bytes4 selector, bool underDerisk);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotOperatorOrOwner();
    error NotOwnerOrRecovery();
    error OperatorExpired(uint64 validUntil);
    error OperatorNotAllowed(address target, bytes4 selector);
    error OperatorAssetSelector(address target, bytes4 selector);
    error LengthMismatch();
    error DailyValueCapExceeded(uint128 cap, uint128 spent, uint256 requested);
    error BindingNotSatisfied(ASFLike.Verdict verdict, ASFLike.Reason[] reasons);
    error BindingsNotPresented(uint256 presented, uint256 required);
    error ClauseIndexOutOfRange(uint256 clauseIndex, uint256 clauses);
    error AnchorNotActive(IAIDRegistryLike.State state);
    error CallFailed(bytes data);
    error ZeroAddress();

    constructor(
        IASFBindingRegistryLike safety_,
        address owner_,
        address operator_,
        address guardian_,
        address recovery_,
        ASFLike.RequirementSet memory requirement_
    ) {
        if (address(safety_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        requirementId = safety_.requirementId(requirement_); // reverts for malformed requirement sets
        safety = safety_;
        owner = owner_;
        operator = operator_;
        guardian = guardian_;
        recovery = recovery_ == address(0) ? owner_ : recovery_;
        _requirementEncoded = abi.encode(requirement_);
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------- owner administration

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setOperator(address operator_, uint64 validUntil, uint128 dailyValueCap) external onlyOwner {
        operator = operator_;
        operatorValidUntil = validUntil;
        operatorDailyValueCap = dailyValueCap;
        emit OperatorSet(operator_, validUntil, dailyValueCap);
    }

    /// @notice Open or close one target x selector to the operator. Asset-moving selectors cannot be opened.
    function setOperatorAllowed(address target, bytes4 selector, bool allowed) external onlyOwner {
        _setOperatorAllowed(target, selector, allowed);
    }

    /// @notice The same for a list (one transaction configures a cell's whole scope).
    function setOperatorAllowedBatch(address[] calldata targets, bytes4[] calldata selectors, bool allowed) external onlyOwner {
        if (targets.length != selectors.length) revert LengthMismatch();
        for (uint256 i = 0; i < targets.length; i++) _setOperatorAllowed(targets[i], selectors[i], allowed);
    }

    /// @notice Let the operator's ECDSA signatures count as the account's (ERC-1271) while in scope and
    ///         while the safety gate is satisfied. Off by default: a cell that never relays signed actions
    ///         through third parties has no reason to open it.
    function setOperatorMaySign(bool allowed) external onlyOwner {
        operatorMaySign = allowed;
        emit OperatorSigningSet(allowed);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setRecovery(address recovery_) external onlyOwner {
        if (recovery_ == address(0)) revert ZeroAddress();
        recovery = recovery_;
        emit RecoverySet(recovery_);
    }

    function setAIDRegistry(IAIDRegistryLike registry) external onlyOwner {
        aid = registry;
        emit AIDRegistrySet(address(registry));
    }

    function presentBindings(bytes32[] calldata bindingIds) external onlyOwner {
        _bindingIds = bindingIds;
        emit BindingsPresented(bindingIds);
    }

    /// @notice Adopt a safety binding as the account (the registry records `address(this)` as adopter) and
    ///         present it for clause `clauseIndex` of the fixed requirement. This is the bootstrap path: nothing
    ///         passes `execute` until every clause has a presented binding, and adopting is an owner-level act,
    ///         never the operator's. Re-adopting (after a termination) overwrites the slot.
    function adoptBinding(ASFLike.BindingInput calldata input, uint256 clauseIndex)
        external
        onlyOwner
        returns (bytes32 bindingId)
    {
        uint256 clauses = abi.decode(_requirementEncoded, (ASFLike.RequirementSet)).clauses.length;
        if (clauseIndex >= clauses) revert ClauseIndexOutOfRange(clauseIndex, clauses);
        bindingId = safety.adopt(input);
        while (_bindingIds.length <= clauseIndex) _bindingIds.push(bytes32(0));
        _bindingIds[clauseIndex] = bindingId;
        emit BindingAdopted(bindingId, clauseIndex);
        emit BindingsPresented(_bindingIds);
    }

    function setDeriskAllowed(address target, bytes4 selector, bool allowed) external onlyOwner {
        deriskAllowed[target][selector] = allowed;
        emit DeriskAllowedSet(target, selector, allowed);
    }

    function setCommitmentClass(address target, bytes4 selector, bool required) external onlyOwner {
        commitmentClass[target][selector] = required;
        emit CommitmentClassSet(target, selector, required);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ---------------------------------------------------------------------------- execution

    /// @notice Act as the cell. The operator (within its allow-list, expiry and daily value cap) or the owner may
    ///         call; every call passes the safety gate and, for commitment-class selectors, the AID-state gate.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory ret) {
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (msg.sender == operator) {
            _checkOperatorScope(target, selector, value);
        } else if (msg.sender != owner) {
            revert NotOperatorOrOwner();
        }
        bool underDerisk = _gate(target, selector);
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(msg.sender, target, value, selector, underDerisk);
    }

    /// @notice Move value out of the account to the owner. Open to the owner and the recovery address, and not
    ///         gated: it can only reduce the account's exposure (RESTRICT_DERISK_ONLY keeps recovery open).
    function sweep(address token, uint256 amount) external {
        if (msg.sender != owner && msg.sender != recovery) revert NotOwnerOrRecovery();
        if (token == address(0)) {
            (bool ok,) = owner.call{value: amount}("");
            if (!ok) revert CallFailed("");
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, owner, amount)); // transfer(address,uint256)
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert CallFailed(ret);
        }
        emit Swept(token, owner, amount);
    }

    // ---------------------------------------------------------------------------- views

    function requirement() external view returns (ASFLike.RequirementSet memory) {
        return abi.decode(_requirementEncoded, (ASFLike.RequirementSet));
    }

    function presentedBindings() external view returns (bytes32[] memory) {
        return _bindingIds;
    }

    /// @notice The registry's current verdict on the presented bindings.
    function status() external view returns (ASFLike.Verdict, ASFLike.Reason[] memory, uint8[] memory) {
        return safety.check(abi.decode(_requirementEncoded, (ASFLike.RequirementSet)), _bindingIds);
    }

    function spentToday() external view returns (uint64 day, uint128 spent) {
        return (_spentDay, _spentToday);
    }

    // ---------------------------------------------------------------------------- ERC-1271

    /// @notice A 65-byte ECDSA signature by the owner counts as the account's signature. One by the operator
    ///         counts only when operator signing is enabled, the operator has not expired and the safety gate is
    ///         satisfied now (a suspension that stops `execute` stops the relayed, signed path too).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        address signer = _recover(hash, signature);
        if (signer == address(0)) return bytes4(0);
        if (signer == owner) return 0x1626ba7e;
        if (
            signer == operator && operatorMaySign && (operatorValidUntil == 0 || block.timestamp <= operatorValidUntil)
                && _satisfied()
        ) return 0x1626ba7e;
        return bytes4(0);
    }

    // ---------------------------------------------------------------------------- receivers / ERC-165

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x1626ba7e // ERC-1271
            || interfaceId == 0x150b7a02 // ERC-721 receiver
            || interfaceId == 0x4e2312e0; // ERC-1155 receiver
    }

    // ---------------------------------------------------------------------------- internal

    function _setOperatorAllowed(address target, bytes4 selector, bool allowed) private {
        if (allowed && _isAssetSelector(selector)) revert OperatorAssetSelector(target, selector);
        operatorAllowed[target][selector] = allowed;
        emit OperatorAllowedSet(target, selector, allowed);
    }

    /// Selectors that move or encumber assets: ERC-20 / ERC-721 / ERC-1155 transfers and approvals. Closed to
    /// the operator by construction; the owner moves assets (and may `sweep`).
    function _isAssetSelector(bytes4 selector) private pure returns (bool) {
        return selector == 0xa9059cbb // transfer(address,uint256)
            || selector == 0x23b872dd // transferFrom(address,address,uint256)
            || selector == 0x42842e0e // safeTransferFrom(address,address,uint256)
            || selector == 0xb88d4fde // safeTransferFrom(address,address,uint256,bytes)
            || selector == 0xf242432a // safeTransferFrom(address,address,uint256,uint256,bytes)
            || selector == 0x2eb2c2d6 // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
            || selector == 0x095ea7b3 // approve(address,uint256)
            || selector == 0xa22cb465 // setApprovalForAll(address,bool)
            || selector == 0x39509351 // increaseAllowance(address,uint256)
            || selector == 0xd505accf; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
    }

    /// The safety gate as a yes/no (for the signature path): bindings presented and the verdict Satisfied.
    function _satisfied() private view returns (bool) {
        ASFLike.RequirementSet memory req = abi.decode(_requirementEncoded, (ASFLike.RequirementSet));
        if (_bindingIds.length != req.clauses.length) return false;
        (ASFLike.Verdict verdict,,) = safety.check(req, _bindingIds);
        return verdict == ASFLike.Verdict.Satisfied;
    }

    function _checkOperatorScope(address target, bytes4 selector, uint256 value) private {
        if (operatorValidUntil != 0 && block.timestamp > operatorValidUntil) revert OperatorExpired(operatorValidUntil);
        if (_isAssetSelector(selector)) revert OperatorAssetSelector(target, selector);
        if (!operatorAllowed[target][selector]) revert OperatorNotAllowed(target, selector);
        if (operatorDailyValueCap != 0 && value != 0) {
            uint64 day = uint64(block.timestamp / 1 days);
            if (day != _spentDay) {
                _spentDay = day;
                _spentToday = 0;
            }
            if (value > type(uint128).max || _spentToday + uint128(value) > operatorDailyValueCap) {
                revert DailyValueCapExceeded(operatorDailyValueCap, _spentToday, value);
            }
            _spentToday += uint128(value);
        }
    }

    function _gate(address target, bytes4 selector) private view returns (bool underDerisk) {
        ASFLike.RequirementSet memory req = abi.decode(_requirementEncoded, (ASFLike.RequirementSet));
        if (_bindingIds.length != req.clauses.length) revert BindingsNotPresented(_bindingIds.length, req.clauses.length);
        (ASFLike.Verdict verdict, ASFLike.Reason[] memory reasons, uint8[] memory sets) = safety.check(req, _bindingIds);
        if (verdict == ASFLike.Verdict.Satisfied) {
            underDerisk = false;
        } else if (
            verdict == ASFLike.Verdict.NotSatisfied && deriskAllowed[target][selector] && _onlyDeriskSuspensions(reasons, sets)
        ) {
            underDerisk = true;
        } else {
            revert BindingNotSatisfied(verdict, reasons);
        }
        if (!underDerisk && commitmentClass[target][selector] && address(aid) != address(0)) {
            IAIDRegistryLike.State s = aid.state(address(this));
            if (s != IAIDRegistryLike.State.ACTIVE) revert AnchorNotActive(s);
        }
    }

    /// Mirrors ASFGuardedAccount: every failing clause is a suspension (own, ancestor, or a standing stop by a
    /// named intervener) whose response set keeps de-risking open and does not stop everything.
    function _onlyDeriskSuspensions(ASFLike.Reason[] memory reasons, uint8[] memory sets) private pure returns (bool) {
        if (reasons.length != sets.length) return false;
        for (uint256 i = 0; i < reasons.length; i++) {
            if (reasons[i] == ASFLike.Reason.None) continue;
            if (
                reasons[i] != ASFLike.Reason.Suspended && reasons[i] != ASFLike.Reason.ParentNotSatisfied
                    && reasons[i] != ASFLike.Reason.StoppedByIntervener
            ) return false;
            uint8 r = sets[i];
            if (r & ASFLike.RESTRICT_DERISK_ONLY == 0 || r & ASFLike.RESTRICT_FULL_STOP != 0) return false;
        }
        return true;
    }

    function _recover(bytes32 hash, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
