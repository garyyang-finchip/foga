// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {FogaCellAccount} from "../src/FogaCellAccount.sol";
import {ASFLike, IASFBindingRegistryLike, IAIDRegistryLike} from "../src/interfaces/IASFBindingRegistryLike.sol";

interface Vm {
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert() external;
    function deal(address account, uint256 newBalance) external;
}

/// A safety registry stand-in: the test chooses the verdict the gate sees.
contract ToggleSafetyRegistry is IASFBindingRegistryLike {
    ASFLike.Verdict public verdict = ASFLike.Verdict.Satisfied;
    ASFLike.Reason public reason = ASFLike.Reason.None;
    uint8 public restrictions;

    function set(ASFLike.Verdict v, ASFLike.Reason r, uint8 restr) external {
        verdict = v;
        reason = r;
        restrictions = restr;
    }

    function check(ASFLike.RequirementSet calldata requirement, bytes32[] calldata)
        external
        view
        returns (ASFLike.Verdict, ASFLike.Reason[] memory reasons, uint8[] memory sets)
    {
        uint256 n = requirement.clauses.length;
        reasons = new ASFLike.Reason[](n);
        sets = new uint8[](n);
        for (uint256 i = 0; i < n; i++) {
            reasons[i] = reason;
            sets[i] = restrictions;
        }
        return (verdict, reasons, sets);
    }

    function requirementId(ASFLike.RequirementSet calldata requirement) external pure returns (bytes32) {
        require(requirement.clauses.length > 0, "empty requirement");
        return keccak256(abi.encode(requirement));
    }

    address public lastAdopter;

    function adopt(ASFLike.BindingInput calldata input) external returns (bytes32 bindingId) {
        lastAdopter = msg.sender;
        return keccak256(abi.encode(msg.sender, input.specId, input.salt));
    }
}

contract ToggleAID is IAIDRegistryLike {
    mapping(address => State) public states;

    function setState(address anchor, State s) external {
        states[anchor] = s;
    }

    function state(address anchor) external view returns (State) {
        return states[anchor];
    }
}

contract Target {
    uint256 public hits;
    uint256 public received;

    function poke() external payable {
        hits += 1;
        received += msg.value;
    }

    function deliver(uint256) external {
        hits += 1;
    }

    function fail() external pure {
        revert("Target: no");
    }
}

contract FogaCellAccountTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant STRANGER_PK = 0x0C;
    address owner;
    address operator;
    address stranger;
    address guardian = address(0x6A);

    ToggleSafetyRegistry safety;
    ToggleAID aid;
    Target target;
    FogaCellAccount acct;

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        stranger = vm.addr(STRANGER_PK);
        safety = new ToggleSafetyRegistry();
        aid = new ToggleAID();
        target = new Target();
        acct = new FogaCellAccount(safety, owner, operator, guardian, address(0), _requirement());
        vm.deal(address(acct), 10 ether);
        vm.prank(owner);
        acct.adoptBinding(_bindingInput(), 0);
    }

    function _bindingInput() internal pure returns (ASFLike.BindingInput memory input) {
        input.subjectKey = keccak256("eip155:31337:0xcell");
        input.scopeKey = keccak256("{\"ref\":\"eip155:31337:0xcell\"}");
        input.specRegistry = address(0x5EC);
        input.specId = keccak256("FOGA-Cell-v1");
        input.version = 1;
        input.contentHash = keccak256("spec");
        input.enforcement = 2 | 16;
        input.salt = bytes32(uint256(1));
        input.interveners = new ASFLike.Intervener[](1);
        input.interveners[0] = ASFLike.Intervener({account: address(0x6A), rights: 3});
    }

    function _requirement() internal pure returns (ASFLike.RequirementSet memory req) {
        req.combinator = ASFLike.Combinator.All;
        req.clauses = new ASFLike.Clause[](1);
        req.clauses[0].specRegistry = address(0x5EC);
        req.clauses[0].specId = keccak256("FOGA-Cell-v1");
        req.clauses[0].versions = new uint32[](1);
        req.clauses[0].versions[0] = 1;
        req.clauses[0].adopter = address(0);
        req.clauses[0].enforcement = 2;
    }

    function testConstructorFixesRequirementAndRoles() public view {
        require(acct.owner() == owner && acct.operator() == operator && acct.guardian() == guardian, "roles");
        require(acct.recovery() == owner, "recovery defaults to owner");
        require(acct.requirementId() == keccak256(abi.encode(_requirement())), "requirement id");
        ASFLike.RequirementSet memory r = acct.requirement();
        require(r.clauses.length == 1 && r.clauses[0].specId == keccak256("FOGA-Cell-v1"), "requirement round-trips");
    }

    function testNothingExecutesBeforeBindingsArePresented() public {
        FogaCellAccount fresh = new FogaCellAccount(safety, owner, operator, guardian, address(0), _requirement());
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.BindingsNotPresented.selector, uint256(0), uint256(1)));
        fresh.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        // the owner is gated the same way: the bootstrap is adoptBinding, not a privileged execute
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.BindingsNotPresented.selector, uint256(0), uint256(1)));
        fresh.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
    }

    function testAdoptBindingIsOwnerOnlyAndPresentsTheBinding() public {
        FogaCellAccount fresh = new FogaCellAccount(safety, owner, operator, guardian, address(0), _requirement());
        vm.prank(operator);
        vm.expectRevert(FogaCellAccount.NotOwner.selector);
        fresh.adoptBinding(_bindingInput(), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.ClauseIndexOutOfRange.selector, uint256(1), uint256(1)));
        fresh.adoptBinding(_bindingInput(), 1);
        vm.prank(owner);
        bytes32 id = fresh.adoptBinding(_bindingInput(), 0);
        require(safety.lastAdopter() == address(fresh), "the account is the adopter");
        require(fresh.presentedBindings().length == 1 && fresh.presentedBindings()[0] == id, "presented in slot 0");
        vm.prank(operator);
        fresh.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        require(target.hits() == 1, "executes once bound");
    }

    function testOperatorExecutesWhenSatisfied() public {
        vm.prank(operator);
        acct.execute(address(target), 1 ether, abi.encodeWithSelector(Target.poke.selector));
        require(target.hits() == 1 && target.received() == 1 ether, "executed with value");
    }

    function testOwnerExecutesStrangerCannot() public {
        vm.prank(owner);
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        require(target.hits() == 1, "owner executed");
        vm.prank(stranger);
        vm.expectRevert(FogaCellAccount.NotOperatorOrOwner.selector);
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
    }

    function testGateBlocksWhenNotSatisfied() public {
        safety.set(ASFLike.Verdict.NotSatisfied, ASFLike.Reason.Suspended, 16); // full stop
        vm.prank(operator);
        vm.expectRevert();
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        // direct RPC-style call by the owner is gated too: no path skips the check
        vm.prank(owner);
        vm.expectRevert();
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
    }

    function testDeriskAllowedUnderDeriskOnlySuspension() public {
        vm.prank(owner);
        acct.setDeriskAllowed(address(target), Target.poke.selector, true);
        safety.set(ASFLike.Verdict.NotSatisfied, ASFLike.Reason.Suspended, 9); // no-new-risk | derisk-only
        vm.prank(operator);
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.poke.selector));
        require(target.hits() == 1, "de-risk action went through");
        // a non-allowlisted selector still stops
        vm.prank(operator);
        vm.expectRevert();
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        // and a full stop blocks even the allow-listed one
        safety.set(ASFLike.Verdict.NotSatisfied, ASFLike.Reason.Suspended, 16);
        vm.prank(operator);
        vm.expectRevert();
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.poke.selector));
    }

    function testUnknownVerdictBlocks() public {
        safety.set(ASFLike.Verdict.Unknown, ASFLike.Reason.SpecRegistryUnavailable, 0);
        vm.prank(operator);
        vm.expectRevert();
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
    }

    function testCommitmentClassRequiresActiveAnchor() public {
        vm.prank(owner);
        acct.setAIDRegistry(aid);
        vm.prank(owner);
        acct.setCommitmentClass(address(target), Target.deliver.selector, true);
        // DORMANT anchor: commitment-class call refused, other calls fine
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.AnchorNotActive.selector, IAIDRegistryLike.State.DORMANT));
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        vm.prank(operator);
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.poke.selector));
        // ACTIVE anchor: allowed
        aid.setState(address(acct), IAIDRegistryLike.State.ACTIVE);
        vm.prank(operator);
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
        require(target.hits() == 2, "both executed");
        // STALE again refuses
        aid.setState(address(acct), IAIDRegistryLike.State.STALE);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.AnchorNotActive.selector, IAIDRegistryLike.State.STALE));
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.deliver.selector, 1));
    }

    function testOperatorScopeExpiryAndDailyCap() public {
        // Absolute timestamps are used on purpose: with via-IR the compiler may cache block.timestamp within a
        // call, so `block.timestamp + x` after a warp can still read the pre-warp value.
        vm.warp(1000);
        vm.prank(owner);
        acct.setOperator(operator, 1100, 2 ether);
        vm.prank(operator);
        acct.execute(address(target), 1.5 ether, abi.encodeWithSelector(Target.poke.selector));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.DailyValueCapExceeded.selector, uint128(2 ether), uint128(1.5 ether), uint256(1 ether)));
        acct.execute(address(target), 1 ether, abi.encodeWithSelector(Target.poke.selector));
        // the cap resets on the next day
        vm.warp(1000 + 1 days);
        vm.prank(owner);
        acct.setOperator(operator, uint64(1000 + 1 days + 100), 2 ether);
        vm.prank(operator);
        acct.execute(address(target), 1 ether, abi.encodeWithSelector(Target.poke.selector));
        // expiry
        vm.warp(1000 + 1 days + 101);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FogaCellAccount.OperatorExpired.selector, uint64(1000 + 1 days + 100)));
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.poke.selector));
        // the owner is not scoped
        vm.prank(owner);
        acct.execute(address(target), 3 ether, abi.encodeWithSelector(Target.poke.selector));
        require(target.hits() == 3, "three executions went through");
    }

    function testCallFailureBubbles() public {
        vm.prank(operator);
        vm.expectRevert();
        acct.execute(address(target), 0, abi.encodeWithSelector(Target.fail.selector));
    }

    function testErc1271OperatorAndOwner() public {
        bytes32 digest = keccak256("message");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_PK, digest);
        require(acct.isValidSignature(digest, abi.encodePacked(r, s, v)) == bytes4(0x1626ba7e), "operator signature valid");
        (v, r, s) = vm.sign(OWNER_PK, digest);
        require(acct.isValidSignature(digest, abi.encodePacked(r, s, v)) == bytes4(0x1626ba7e), "owner signature valid");
        (v, r, s) = vm.sign(STRANGER_PK, digest);
        require(acct.isValidSignature(digest, abi.encodePacked(r, s, v)) == bytes4(0), "stranger invalid");
        // expired operator no longer signs for the account
        vm.warp(5000);
        vm.prank(owner);
        acct.setOperator(operator, 5010, 0);
        vm.warp(5011);
        (v, r, s) = vm.sign(OPERATOR_PK, digest);
        require(acct.isValidSignature(digest, abi.encodePacked(r, s, v)) == bytes4(0), "expired operator invalid");
    }

    function testSweepByOwnerOrRecoveryOnly() public {
        uint256 before = owner.balance;
        vm.prank(owner);
        acct.sweep(address(0), 1 ether);
        require(owner.balance == before + 1 ether, "swept to owner");
        vm.prank(stranger);
        vm.expectRevert(FogaCellAccount.NotOwnerOrRecovery.selector);
        acct.sweep(address(0), 1 ether);
        // sweep stays open under a full stop
        safety.set(ASFLike.Verdict.NotSatisfied, ASFLike.Reason.Suspended, 16);
        vm.prank(owner);
        acct.sweep(address(0), 1 ether);
    }

    function testReceiversAndInterfaces() public view {
        require(acct.onERC721Received(address(0), address(0), 1, "") == bytes4(0x150b7a02), "721");
        require(acct.onERC1155Received(address(0), address(0), 1, 1, "") == bytes4(0xf23a6e61), "1155");
        require(acct.supportsInterface(0x1626ba7e) && acct.supportsInterface(0x150b7a02) && acct.supportsInterface(0x4e2312e0), "165");
    }

    function testOwnerOnlyAdministration() public {
        vm.prank(stranger);
        vm.expectRevert(FogaCellAccount.NotOwner.selector);
        acct.setOperator(stranger, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(FogaCellAccount.NotOwner.selector);
        acct.setDeriskAllowed(address(target), Target.poke.selector, true);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256("binding");
        vm.prank(owner);
        acct.presentBindings(ids);
        require(acct.presentedBindings().length == 1, "presented");
    }
}
